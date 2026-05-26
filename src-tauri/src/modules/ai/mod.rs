//! AI subprocess wrappers. Hosts the Claude Code CLI session manager
//! plus the MCP (Model Context Protocol) bridge that exposes a small
//! set of terax-only tools to the CLI.

pub mod claude_cli;
pub mod mcp_helper;
mod mcp_listener;
mod mcp_protocol;
mod mcp_tools;

use serde_json::Value;
use tauri::ipc::Channel;

pub use claude_cli::ClaudeCliState;

#[tauri::command]
pub async fn ai_claude_cli_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, ClaudeCliState>,
    session_id: String,
    prompt: String,
    opts: claude_cli::SpawnOpts,
    channel: Channel<Value>,
) -> Result<(), String> {
    claude_cli::start(&state, app, session_id, prompt, opts, channel).await
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

#[tauri::command]
pub async fn ai_claude_cli_tool_result(
    state: tauri::State<'_, ClaudeCliState>,
    session_id: String,
    tool_use_id: String,
    content: String,
    is_error: Option<bool>,
) -> Result<(), String> {
    claude_cli::tool_result(
        &state,
        &session_id,
        &tool_use_id,
        &content,
        is_error.unwrap_or(false),
    )
    .await
}
