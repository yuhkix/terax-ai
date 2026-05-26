//! Terax-only MCP tools exposed to the Claude Code CLI.
//!
//! v1 ships two working tools (`terax_suggest_command`,
//! `terax_open_preview`) that emit Tauri events the frontend already
//! handles via the `live` bridge. The remaining six (`terax_get_terminal_output`,
//! `terax_attach_terminal_context`, `terax_bash_background`,
//! `terax_bash_logs`, `terax_bash_kill`, `terax_bash_list`) are listed
//! so Claude can discover them, but `tools/call` returns
//! "not yet implemented" until v1.1 wires them to the existing
//! `PtyState` and `ShellState` plumbing.

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use super::mcp_protocol::codes;

pub fn tool_list() -> Value {
    json!([
        {
            "name": "terax_suggest_command",
            "description": "Insert a shell command into the user's active terminal. Use when the most useful answer is a single command the user should run themselves.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string", "description": "The shell command to insert." }
                },
                "required": ["command"]
            }
        },
        {
            "name": "terax_open_preview",
            "description": "Open the terax in-app web preview tab for a local dev-server URL.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string", "description": "Localhost URL to preview." }
                },
                "required": ["url"]
            }
        },
        {
            "name": "terax_get_terminal_output",
            "description": "Read the last 300 lines of the user's active terminal buffer.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "terax_attach_terminal_context",
            "description": "Return the active terminal cwd plus the last 300 lines, formatted as a context block.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "terax_bash_background",
            "description": "Start a long-running background process (dev server, watcher) tracked by terax.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "command": { "type": "string" },
                    "cwd": { "type": "string" }
                },
                "required": ["command"]
            }
        },
        {
            "name": "terax_bash_logs",
            "description": "Read the buffered output of a terax-tracked background process.",
            "inputSchema": {
                "type": "object",
                "properties": { "handle": { "type": "integer" } },
                "required": ["handle"]
            }
        },
        {
            "name": "terax_bash_kill",
            "description": "Stop a terax-tracked background process.",
            "inputSchema": {
                "type": "object",
                "properties": { "handle": { "type": "integer" } },
                "required": ["handle"]
            }
        },
        {
            "name": "terax_bash_list",
            "description": "List terax-tracked background processes started in this session.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

pub async fn call(app: &AppHandle, params: Value) -> Result<Value, (i32, String)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((codes::INVALID_PARAMS, "missing 'name'".into()))?;
    let arguments = params.get("arguments").cloned().unwrap_or(Value::Null);

    match name {
        "terax_suggest_command" => suggest_command(app, &arguments).await,
        "terax_open_preview" => open_preview(app, &arguments).await,
        "terax_get_terminal_output"
        | "terax_attach_terminal_context"
        | "terax_bash_background"
        | "terax_bash_logs"
        | "terax_bash_kill"
        | "terax_bash_list" => Err((
            codes::INTERNAL_ERROR,
            format!("{name}: not yet implemented (v1.1)"),
        )),
        _ => Err((
            codes::METHOD_NOT_FOUND,
            format!("unknown terax MCP tool: {name}"),
        )),
    }
}

async fn suggest_command(app: &AppHandle, args: &Value) -> Result<Value, (i32, String)> {
    let cmd = args
        .get("command")
        .and_then(Value::as_str)
        .ok_or((codes::INVALID_PARAMS, "missing 'command'".into()))?;
    app.emit("terax:mcp:suggest-command", json!({ "command": cmd }))
        .map_err(|e| (codes::INTERNAL_ERROR, format!("emit: {e}")))?;
    Ok(content(format!("Inserted into terminal: {cmd}")))
}

async fn open_preview(app: &AppHandle, args: &Value) -> Result<Value, (i32, String)> {
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .ok_or((codes::INVALID_PARAMS, "missing 'url'".into()))?;
    app.emit("terax:mcp:open-preview", json!({ "url": url }))
        .map_err(|e| (codes::INTERNAL_ERROR, format!("emit: {e}")))?;
    Ok(content(format!("Opened preview: {url}")))
}

fn content(text: String) -> Value {
    json!({
        "content": [{"type": "text", "text": text}]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_list_includes_all_eight_names() {
        let tools = tool_list();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.get("name").and_then(Value::as_str))
            .collect();
        assert_eq!(names.len(), 8);
        assert!(names.contains(&"terax_suggest_command"));
        assert!(names.contains(&"terax_open_preview"));
        assert!(names.contains(&"terax_get_terminal_output"));
        assert!(names.contains(&"terax_attach_terminal_context"));
        assert!(names.contains(&"terax_bash_background"));
        assert!(names.contains(&"terax_bash_logs"));
        assert!(names.contains(&"terax_bash_kill"));
        assert!(names.contains(&"terax_bash_list"));
    }

    #[test]
    fn content_wraps_text() {
        let v = content("hi".into());
        assert_eq!(v["content"][0]["type"], "text");
        assert_eq!(v["content"][0]["text"], "hi");
    }
}
