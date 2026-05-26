// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Secondary entry point: when the Claude Code CLI spawns this binary as
    // its MCP server (--mcp-config points back at terax with --mcp-stdio),
    // run the stdio proxy and exit before Tauri initializes.
    if std::env::args().skip(1).any(|a| a == "--mcp-stdio") {
        terax_lib::modules::ai::mcp_helper::run();
        return;
    }
    terax_lib::run()
}
