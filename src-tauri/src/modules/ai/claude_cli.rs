//! Spawn and stream a Claude Code CLI subprocess per terax chat session.
//!
//! One process per session. Stdout JSON lines are forwarded verbatim to
//! the frontend `Channel`; synthetic events for raw lines, errors, and
//! process exit are wrapped with a `terax_` prefix on the `type` field
//! to avoid collision with Claude's own event schema.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::ipc::Channel;
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{Mutex, Notify, RwLock};

use super::mcp_listener;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Cap stderr capture so a misbehaving CLI cannot exhaust memory.
const STDERR_TAIL_CAP: usize = 8 * 1024;

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct SpawnOpts {
    pub model_arg: Option<String>,
    pub cwd: Option<String>,
    pub add_dirs: Vec<String>,
    pub resume_claude_session_id: Option<String>,
    pub binary_path: Option<String>,
    pub enable_mcp: Option<bool>,
    pub skip_permissions: Option<bool>,
    /// Extra content appended to Claude's system prompt for this run.
    /// Used to carry TERAX.md, the user's custom instructions, and any
    /// other terax-side context Claude doesn't pick up automatically.
    pub system_prompt: Option<String>,
}

impl SpawnOpts {
    fn mcp_enabled(&self) -> bool {
        self.enable_mcp.unwrap_or(true)
    }

    fn skip_permissions(&self) -> bool {
        // v1 default: skip claude's permission prompts. Without this,
        // claude's stream-json mode blocks waiting for a permission
        // decision schema we don't yet match 1:1 (open question in the
        // spec). Surface as a setting later for the strict-deny-list path.
        self.skip_permissions.unwrap_or(true)
    }
}

fn mcp_config_path(session_id: &str) -> Option<PathBuf> {
    let cache = dirs::cache_dir()?;
    let dir = cache.join("terax").join("mcp");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(format!("{session_id}.json")))
}

fn build_mcp_config(binary_path: &str, port: u16, token: &str) -> Value {
    json!({
        "mcpServers": {
            "terax": {
                "command": binary_path,
                "args": ["--mcp-stdio"],
                "env": {
                    "TERAX_MCP_PORT": port.to_string(),
                    "TERAX_MCP_TOKEN": token,
                }
            }
        }
    })
}

fn write_mcp_config(
    path: &PathBuf,
    binary_path: &str,
    port: u16,
    token: &str,
) -> std::io::Result<()> {
    let cfg = build_mcp_config(binary_path, port, token);
    std::fs::write(path, serde_json::to_vec_pretty(&cfg)?)
}

async fn build_mcp_for_session(
    app: &AppHandle,
    session_id: &str,
) -> Result<(tokio::task::JoinHandle<()>, PathBuf), String> {
    let exe = std::env::current_exe()
        .map_err(|e| format!("current_exe: {e}"))?
        .to_string_lossy()
        .into_owned();
    let cfg_path = mcp_config_path(session_id)
        .ok_or_else(|| "no cache dir available for MCP config".to_string())?;
    let (listener, port) = mcp_listener::bind()
        .await
        .map_err(|e| format!("mcp bind: {e}"))?;
    let token = mcp_listener::random_token();
    write_mcp_config(&cfg_path, &exe, port, &token)
        .map_err(|e| format!("write mcp config: {e}"))?;
    let app_clone = app.clone();
    let handle = tokio::spawn(async move {
        mcp_listener::serve(app_clone, listener, token).await;
    });
    Ok((handle, cfg_path))
}

struct Inner {
    stdin: Mutex<Option<ChildStdin>>,
    cancel: Notify,
}

#[derive(Default)]
pub struct ClaudeCliState {
    sessions: RwLock<HashMap<String, Arc<Inner>>>,
}

impl ClaudeCliState {
    async fn insert(&self, id: String, inner: Arc<Inner>) {
        self.sessions.write().await.insert(id, inner);
    }

    async fn take(&self, id: &str) -> Option<Arc<Inner>> {
        self.sessions.write().await.remove(id)
    }

    async fn get(&self, id: &str) -> Option<Arc<Inner>> {
        self.sessions.read().await.get(id).cloned()
    }
}

fn binary(opts: &SpawnOpts) -> String {
    match opts.binary_path.as_deref().map(str::trim) {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => "claude".to_string(),
    }
}

fn user_message(prompt: &str) -> String {
    json!({
        "type": "user",
        "message": { "role": "user", "content": prompt },
        "parent_tool_use_id": null,
        "session_id": null,
    })
    .to_string()
}

fn permission_decision(tool_use_id: &str, approved: bool) -> String {
    // Schema is provisional and confirmed on first run; spec lists this
    // as an open question.
    json!({
        "type": "permission_decision",
        "tool_use_id": tool_use_id,
        "approved": approved,
    })
    .to_string()
}

fn tool_result_message(tool_use_id: &str, content: &str, is_error: bool) -> String {
    // stream-json shape for handing a tool result back to the CLI. Used for
    // interactive tools like AskUserQuestion where the model is paused
    // waiting on a host-side response.
    json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{
                "type": "tool_result",
                "tool_use_id": tool_use_id,
                "content": content,
                "is_error": is_error,
            }]
        },
        "parent_tool_use_id": null,
        "session_id": null,
    })
    .to_string()
}

async fn write_line(stdin: &Mutex<Option<ChildStdin>>, line: String) -> Result<(), String> {
    let mut guard = stdin.lock().await;
    let Some(w) = guard.as_mut() else {
        return Err("Claude CLI stdin is closed".into());
    };
    w.write_all(line.as_bytes())
        .await
        .map_err(|e| format!("stdin write: {e}"))?;
    w.write_all(b"\n")
        .await
        .map_err(|e| format!("stdin newline: {e}"))?;
    w.flush().await.map_err(|e| format!("stdin flush: {e}"))?;
    Ok(())
}

pub async fn start(
    state: &ClaudeCliState,
    app: AppHandle,
    session_id: String,
    prompt: String,
    opts: SpawnOpts,
    channel: Channel<Value>,
) -> Result<(), String> {
    if let Some(prev) = state.take(&session_id).await {
        prev.cancel.notify_one();
    }

    let (mcp_listener_handle, mcp_config_file) = if opts.mcp_enabled() {
        match build_mcp_for_session(&app, &session_id).await {
            Ok(pair) => (Some(pair.0), Some(pair.1)),
            Err(e) => {
                log::warn!("claude-cli mcp setup failed: {e}; continuing without terax tools");
                (None, None)
            }
        }
    } else {
        (None, None)
    };

    let mut cmd = Command::new(binary(&opts));
    // Argument order mirrors clauke's known-good invocation:
    //   --output-format / --verbose first, then permission/resume/dir flags,
    //   then -p --input-format, then --model. The CLI's argparse is lenient
    //   but staying close to a tested order avoids edge-case regressions.
    cmd.args(["--output-format", "stream-json", "--verbose"]);
    if opts.skip_permissions() {
        cmd.arg("--dangerously-skip-permissions");
    }
    if let Some(sp) = opts.system_prompt.as_deref().filter(|s| !s.trim().is_empty()) {
        cmd.args(["--append-system-prompt", sp]);
    }
    if let Some(resume) = opts
        .resume_claude_session_id
        .as_deref()
        .filter(|s| !s.is_empty())
    {
        cmd.args(["--resume", resume]);
    }
    for dir in opts.add_dirs.iter().filter(|s| !s.is_empty()) {
        cmd.args(["--add-dir", dir]);
    }
    if let Some(ref mcp) = mcp_config_file {
        cmd.args(["--mcp-config", &mcp.to_string_lossy()]);
    }
    cmd.args(["-p", "--input-format", "stream-json"]);
    if let Some(model) = opts.model_arg.as_deref().filter(|s| !s.is_empty()) {
        cmd.args(["--model", model]);
    }
    if let Some(cwd) = opts.cwd.as_deref().filter(|s| !s.is_empty()) {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let bin = binary(&opts);
    let mut child = cmd.spawn().map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!(
            "Claude Code CLI not found (looked for `{bin}`). Install it or set the path in Settings."
        ),
        _ => format!("spawn claude: {e}"),
    })?;

    #[cfg(windows)]
    let job = child.id().and_then(|pid| {
        match crate::modules::job::PtyJob::create_for(pid) {
            Ok(j) => Some(j),
            Err(e) => {
                log::warn!("claude-cli job-object setup failed for pid={pid}: {e}");
                None
            }
        }
    });

    let stdin_handle = child.stdin.take().ok_or("failed to capture stdin")?;
    let stdout = child.stdout.take().ok_or("failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("failed to capture stderr")?;

    let inner = Arc::new(Inner {
        stdin: Mutex::new(Some(stdin_handle)),
        cancel: Notify::new(),
    });
    state.insert(session_id.clone(), inner.clone()).await;

    write_line(&inner.stdin, user_message(&prompt)).await?;
    // stdin stays open so steer() / approve() / AskUserQuestion responses
    // can be written. End-of-turn is detected on the frontend via the
    // top-level `result` event in stdout; the transport then calls
    // ai_claude_cli_stop, which closes stdin here and lets the CLI exit.

    let drive_inner = inner;
    tokio::spawn(async move {
        // Drain stderr concurrently. A full stderr pipe blocks the child's
        // writes and therefore stalls stdout, so this task must run for the
        // process's lifetime.
        let stderr_task = tokio::spawn(async move {
            let mut reader = BufReader::new(stderr).lines();
            let mut buf = String::new();
            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if buf.len() + trimmed.len() + 1 > STDERR_TAIL_CAP {
                    break;
                }
                if !buf.is_empty() {
                    buf.push('\n');
                }
                buf.push_str(trimmed);
            }
            buf
        });

        let mut reader = BufReader::new(stdout).lines();
        let mut cancelled = false;
        loop {
            tokio::select! {
                line = reader.next_line() => {
                    match line {
                        Ok(Some(line)) => {
                            let trimmed = line.trim();
                            if trimmed.is_empty() { continue; }
                            let event = match serde_json::from_str::<Value>(trimmed) {
                                Ok(v) => v,
                                Err(_) => json!({ "type": "terax_raw", "text": trimmed }),
                            };
                            if channel.send(event).is_err() {
                                cancelled = true;
                                break;
                            }
                        }
                        Ok(None) => break,
                        Err(e) => {
                            let _ = channel.send(json!({
                                "type": "terax_error",
                                "text": format!("stdout read: {e}"),
                            }));
                            break;
                        }
                    }
                }
                _ = drive_inner.cancel.notified() => {
                    cancelled = true;
                    break;
                }
            }
        }

        // Drop stdin so any pending writer wakes via broken pipe before we
        // wait on the child. Without this, kill() can race with an in-flight
        // write_line and leave the writer hung on the mutex.
        let _ = drive_inner.stdin.lock().await.take();
        if cancelled {
            let _ = child.kill().await;
        }
        let status = child.wait().await.ok();
        let stderr_tail = stderr_task.await.unwrap_or_default();
        let code = status.and_then(|s| s.code()).unwrap_or(-1);
        let _ = channel.send(json!({
            "type": "terax_exit",
            "code": code,
            "stderr_tail": stderr_tail,
        }));

        // MCP cleanup. Aborting the listener is safe: it owns its TCP
        // socket and any in-flight tool call short-circuits at the next
        // I/O boundary.
        if let Some(h) = mcp_listener_handle {
            h.abort();
        }
        if let Some(p) = mcp_config_file {
            let _ = std::fs::remove_file(&p);
        }

        #[cfg(windows)]
        drop(job);
    });

    Ok(())
}

pub async fn steer(
    state: &ClaudeCliState,
    session_id: &str,
    message: &str,
) -> Result<(), String> {
    let inner = state
        .get(session_id)
        .await
        .ok_or("no active Claude CLI session")?;
    write_line(&inner.stdin, user_message(message)).await
}

pub async fn approve(
    state: &ClaudeCliState,
    session_id: &str,
    tool_use_id: &str,
    approved: bool,
) -> Result<(), String> {
    let inner = state
        .get(session_id)
        .await
        .ok_or("no active Claude CLI session")?;
    write_line(&inner.stdin, permission_decision(tool_use_id, approved)).await
}

pub async fn tool_result(
    state: &ClaudeCliState,
    session_id: &str,
    tool_use_id: &str,
    content: &str,
    is_error: bool,
) -> Result<(), String> {
    let inner = state
        .get(session_id)
        .await
        .ok_or("no active Claude CLI session")?;
    write_line(
        &inner.stdin,
        tool_result_message(tool_use_id, content, is_error),
    )
    .await
}

pub async fn stop(state: &ClaudeCliState, session_id: &str) {
    if let Some(inner) = state.take(session_id).await {
        let _ = inner.stdin.lock().await.take();
        inner.cancel.notify_one();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_message_shape() {
        let s = user_message("hi");
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["type"], "user");
        assert_eq!(v["message"]["role"], "user");
        assert_eq!(v["message"]["content"], "hi");
        assert!(v["parent_tool_use_id"].is_null());
    }

    #[test]
    fn permission_decision_shape() {
        let s = permission_decision("tool_abc", true);
        let v: Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["type"], "permission_decision");
        assert_eq!(v["tool_use_id"], "tool_abc");
        assert_eq!(v["approved"], true);
    }

    #[test]
    fn mcp_config_shape() {
        let v = build_mcp_config("/usr/bin/terax", 54321, "tok-abc");
        assert_eq!(v["mcpServers"]["terax"]["command"], "/usr/bin/terax");
        assert_eq!(v["mcpServers"]["terax"]["args"][0], "--mcp-stdio");
        assert_eq!(v["mcpServers"]["terax"]["env"]["TERAX_MCP_PORT"], "54321");
        assert_eq!(v["mcpServers"]["terax"]["env"]["TERAX_MCP_TOKEN"], "tok-abc");
    }

    #[test]
    fn binary_defaults_to_claude() {
        let o = SpawnOpts::default();
        assert_eq!(binary(&o), "claude");
        let o = SpawnOpts {
            binary_path: Some("   ".into()),
            ..Default::default()
        };
        assert_eq!(binary(&o), "claude");
        let o = SpawnOpts {
            binary_path: Some("/opt/claude/bin/claude".into()),
            ..Default::default()
        };
        assert_eq!(binary(&o), "/opt/claude/bin/claude");
    }
}
