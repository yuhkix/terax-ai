//! Per-session TCP loopback listener for the MCP helper.
//!
//! Each Claude CLI session spawns its own listener bound to 127.0.0.1:0
//! (kernel-assigned port). The helper subprocess connects, sends a
//! handshake line with the per-session token, and from there all traffic
//! is MCP JSON-RPC newline-delimited.
//!
//! TCP loopback is a deliberate v1 simplification over Unix sockets /
//! named pipes. Threat surface stays local-only: bind address is
//! `127.0.0.1`, never an external interface. The token gates connection
//! acceptance against any other process on the same machine.

use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::AppHandle;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;

use super::mcp_protocol::{codes, JsonRpcRequest, JsonRpcResponse};
use super::mcp_tools;

const HANDSHAKE_KEY: &str = "terax_handshake";

pub async fn bind() -> std::io::Result<(TcpListener, u16)> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    Ok((listener, port))
}

pub fn random_token() -> String {
    // Loopback-only listener; this token gates same-machine processes,
    // not network attackers. A non-cryptographic source seeded from
    // wall-clock + PID + an internal counter is sufficient and avoids
    // pulling in a dedicated RNG crate.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    let counter = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let mut state = nanos ^ pid.rotate_left(17) ^ counter.rotate_left(31);
    let mut buf = [0u8; 32];
    for b in buf.iter_mut() {
        state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        *b = (state >> 33) as u8;
    }
    hex(&buf)
}

fn hex(bytes: &[u8]) -> String {
    const TABLE: &[u8] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(TABLE[(b >> 4) as usize] as char);
        s.push(TABLE[(b & 0xf) as usize] as char);
    }
    s
}

/// Accept a single helper connection, validate the handshake, and serve
/// JSON-RPC until the helper disconnects. Designed to be spawned once per
/// claude-cli session.
pub async fn serve(app: AppHandle, listener: TcpListener, expected_token: String) {
    let (stream, _) = match listener.accept().await {
        Ok(s) => s,
        Err(e) => {
            log::warn!("mcp listener accept failed: {e}");
            return;
        }
    };
    let _ = stream.set_nodelay(true);
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half).lines();

    let first = match reader.next_line().await {
        Ok(Some(line)) => line,
        _ => return,
    };
    let authorized = serde_json::from_str::<Value>(first.trim())
        .ok()
        .and_then(|v| v.get(HANDSHAKE_KEY).and_then(Value::as_str).map(str::to_string))
        .map(|t| t == expected_token)
        .unwrap_or(false);
    if !authorized {
        let _ = write_half
            .write_all(b"{\"error\":\"unauthorized\"}\n")
            .await;
        return;
    }

    while let Ok(Some(line)) = reader.next_line().await {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<JsonRpcRequest>(trimmed) {
            Ok(req) => handle_request(&app, req).await,
            Err(_) => JsonRpcResponse::err(
                Value::Null,
                codes::PARSE_ERROR,
                "invalid JSON-RPC request",
            ),
        };
        let Ok(mut out) = serde_json::to_string(&response) else {
            break;
        };
        out.push('\n');
        if write_half.write_all(out.as_bytes()).await.is_err() {
            break;
        }
    }
}

async fn handle_request(app: &AppHandle, req: JsonRpcRequest) -> JsonRpcResponse {
    if req.jsonrpc != "2.0" {
        return JsonRpcResponse::err(req.id, codes::INVALID_REQUEST, "jsonrpc must be \"2.0\"");
    }
    match req.method.as_str() {
        "initialize" => JsonRpcResponse::ok(
            req.id,
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "terax", "version": env!("CARGO_PKG_VERSION") },
            }),
        ),
        "notifications/initialized" | "ping" => JsonRpcResponse::ok(req.id, json!({})),
        "tools/list" => JsonRpcResponse::ok(req.id, json!({ "tools": mcp_tools::tool_list() })),
        "tools/call" => match mcp_tools::call(app, req.params.unwrap_or(Value::Null)).await {
            Ok(result) => JsonRpcResponse::ok(req.id, result),
            Err((code, msg)) => JsonRpcResponse::err(req.id, code, msg),
        },
        _ => JsonRpcResponse::err(
            req.id,
            codes::METHOD_NOT_FOUND,
            format!("method not found: {}", req.method),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_hex_64() {
        let t = random_token();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn tokens_differ() {
        let a = random_token();
        let b = random_token();
        assert_ne!(a, b);
    }
}
