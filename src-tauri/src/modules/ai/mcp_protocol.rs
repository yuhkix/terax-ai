//! JSON-RPC 2.0 envelope types plus MCP-specific tool descriptors.
//!
//! Wire format is one JSON message per line on both the helper-stdio and
//! the loopback socket. MCP-specific calls use the methods documented in
//! the Model Context Protocol spec (`initialize`, `tools/list`,
//! `tools/call`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: Value,
    pub method: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<Value>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcResponse {
    pub fn ok(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn err(id: Value, code: i32, message: impl Into<String>) -> Self {
        Self {
            jsonrpc: "2.0".into(),
            id,
            result: None,
            error: Some(JsonRpcError {
                code,
                message: message.into(),
                data: None,
            }),
        }
    }
}

/// JSON-RPC error codes (subset used by the listener).
pub mod codes {
    pub const PARSE_ERROR: i32 = -32700;
    pub const INVALID_REQUEST: i32 = -32600;
    pub const METHOD_NOT_FOUND: i32 = -32601;
    pub const INVALID_PARAMS: i32 = -32602;
    pub const INTERNAL_ERROR: i32 = -32603;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trip_request() {
        let raw = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        let req: JsonRpcRequest = serde_json::from_str(raw).unwrap();
        assert_eq!(req.method, "tools/list");
        assert_eq!(req.id, json!(1));
    }

    #[test]
    fn build_ok_response() {
        let r = JsonRpcResponse::ok(json!(2), json!({"x": 1}));
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains(r#""jsonrpc":"2.0""#));
        assert!(s.contains(r#""x":1"#));
        assert!(!s.contains("error"));
    }

    #[test]
    fn build_err_response() {
        let r = JsonRpcResponse::err(json!(3), codes::METHOD_NOT_FOUND, "no such method");
        let s = serde_json::to_string(&r).unwrap();
        assert!(s.contains(r#""code":-32601"#));
        assert!(s.contains("no such method"));
        assert!(!s.contains(r#""result""#));
    }
}
