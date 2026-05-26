//! Stdio MCP server invoked by the Claude Code CLI.
//!
//! The Claude CLI spawns this binary in MCP mode (`terax --mcp-stdio`).
//! Acts as a pure relay between stdin/stdout (Claude side) and a loopback
//! TCP socket bound by the main terax process (`TERAX_MCP_PORT`). All
//! protocol decisions live in the main process; the helper just forwards
//! bytes.
//!
//! Lives in the same binary as the main GUI; the dispatch happens in
//! `main.rs` before Tauri initializes.

use std::env;
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::sync::{Arc, Mutex};
use std::thread;

const HANDSHAKE_PREFIX: &str = "terax_handshake";

pub fn run() {
    let port: u16 = match env::var("TERAX_MCP_PORT").ok().and_then(|s| s.parse().ok()) {
        Some(p) if p > 0 => p,
        _ => {
            eprintln!("terax --mcp-stdio: TERAX_MCP_PORT not set");
            std::process::exit(2);
        }
    };
    let token = match env::var("TERAX_MCP_TOKEN") {
        Ok(t) if !t.is_empty() => t,
        _ => {
            eprintln!("terax --mcp-stdio: TERAX_MCP_TOKEN not set");
            std::process::exit(2);
        }
    };

    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let stream = match TcpStream::connect(addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("terax --mcp-stdio: connect {addr}: {e}");
            std::process::exit(2);
        }
    };
    let _ = stream.set_nodelay(true);

    let read_stream = match stream.try_clone() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("terax --mcp-stdio: try_clone: {e}");
            std::process::exit(2);
        }
    };
    let write_stream = Arc::new(Mutex::new(stream));

    // Handshake first so the listener can map the connection to a session
    // before any MCP traffic flows.
    {
        let mut guard = write_stream.lock().unwrap();
        let line = format!("{{\"{HANDSHAKE_PREFIX}\":\"{token}\"}}\n");
        if guard.write_all(line.as_bytes()).is_err() || guard.flush().is_err() {
            std::process::exit(2);
        }
    }

    let socket_to_stdout = {
        let read_stream = read_stream;
        thread::spawn(move || pipe_lines(read_stream, std::io::stdout()))
    };
    let stdin_to_socket = {
        let write_stream = Arc::clone(&write_stream);
        thread::spawn(move || pipe_stdin(std::io::stdin(), write_stream))
    };

    // Exit when either side closes.
    let _ = socket_to_stdout.join();
    let _ = stdin_to_socket.join();
}

fn pipe_lines<R: Read, W: Write>(src: R, dst: W) {
    let mut reader = BufReader::new(src);
    let mut writer = BufWriter::new(dst);
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf) {
            Ok(0) => break,
            Ok(_) => {
                if writer.write_all(buf.as_bytes()).is_err() {
                    break;
                }
                if writer.flush().is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

fn pipe_stdin<R: Read>(src: R, dst: Arc<Mutex<TcpStream>>) {
    let mut reader = BufReader::new(src);
    let mut buf = String::new();
    loop {
        buf.clear();
        match reader.read_line(&mut buf) {
            Ok(0) => break,
            Ok(_) => {
                let mut guard = match dst.lock() {
                    Ok(g) => g,
                    Err(_) => break,
                };
                if guard.write_all(buf.as_bytes()).is_err() {
                    break;
                }
                if guard.flush().is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}
