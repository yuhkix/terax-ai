//! AI subprocess wrappers. Currently hosts the Claude Code CLI session
//! manager and its IPC surface. MCP listener and helper land in a follow-up
//! commit.

pub mod claude_cli;

use serde_json::Value;
use tauri::ipc::Channel;

pub use claude_cli::ClaudeCliState;

#[tauri::command]
pub async fn ai_claude_cli_start(
    state: tauri::State<'_, ClaudeCliState>,
    session_id: String,
    prompt: String,
    opts: claude_cli::SpawnOpts,
    channel: Channel<Value>,
) -> Result<(), String> {
    claude_cli::start(&state, session_id, prompt, opts, channel).await
}

#[tauri::command]
pub async fn ai_claude_cli_steer(
    state: tauri::State<'_, ClaudeCliState>,
    session_id: String,
    message: String,
) -> Result<(), String> {
    claude_cli::steer(&state, &session_id, &message).await
}

#[tauri::command]
pub async fn ai_claude_cli_approve(
    state: tauri::State<'_, ClaudeCliState>,
    session_id: String,
    tool_use_id: String,
    approved: bool,
) -> Result<(), String> {
    claude_cli::approve(&state, &session_id, &tool_use_id, approved).await
}

#[tauri::command]
pub async fn ai_claude_cli_stop(
    state: tauri::State<'_, ClaudeCliState>,
    session_id: String,
) -> Result<(), String> {
    claude_cli::stop(&state, &session_id).await;
    Ok(())
}
