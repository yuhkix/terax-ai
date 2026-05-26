# Claude Code CLI provider — design

- Date: 2026-05-26
- Status: design, pre-discussion (per CONTRIBUTING.md, new AI providers need maintainer discussion before a PR)
- Roadmap anchor: ROADMAP.md "AI agent meta-orchestration (Terax agent spawning and managing external coding agents like Claude Code / OpenCode)"
- Scope: additive new AI provider. No changes to existing models, providers, components, or flows.

## Problem

Terax's AI subsystem is BYOK. Every Anthropic-backed model in `config.ts` requires an Anthropic API key in the OS keychain, billed per token by the user. Users who already pay for a Claude Code subscription must still buy a second API quota to use Anthropic models from inside Terax.

The Claude Code CLI handles auth on the user's machine independently of any API key. If Terax spawns `claude` and streams its events, the user gets the same Anthropic models they're already paying for, with no extra API key, no per-token billing visible to Terax.

This is the unique value the FAQ in CONTRIBUTING.md asks for: neither `openai-compatible` nor `openrouter` can reach Claude Code's subscription auth.

## Non-goals

- Not forwarding or storing Claude's auth tokens. We spawn the CLI; it manages its own credentials. The "Third-party subscription session bridges" exclusion in ROADMAP.md does not apply because we do not bridge auth.
- Not replacing the existing `anthropic` provider. The four existing Anthropic model entries (`claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`) stay in `config.ts` exactly as they are.
- Not adding plan mode, sub-agents, or autocomplete eligibility for this provider. Plan mode toggle is greyed out when a `claude-cli-*` model is active; `getAutocompleteEligibleModels()` explicitly excludes `claude-cli-*`.
- Not implementing message forking or per-message branching (clauke has this; out of scope for v1).

## Constraints honored

| Rule | How |
|---|---|
| CONTRIBUTING.md: "One PR = one logical change" | Single feature PR, split into ordered atomic commits per the Implementation order section below. |
| CONTRIBUTING.md: tests required for IPC command surface and AI tool surface | Rust unit tests on `claude_cli`, `mcp_listener`; TypeScript unit tests on `claudeCliEvents.ts` and the approval bridge. |
| ROADMAP.md theme 2: "Lightweight always" | No new crates added. Unix socket via `std::os::unix::net::UnixListener`, Windows named pipe via existing `windows-sys` features + `tokio::net::windows::named_pipe` (tokio already a dep). MCP JSON-RPC parsed with the existing `serde_json`. |
| ROADMAP.md theme 5: "Security by default" | Workspace authorization (`authorize_user_spawn_cwd`) on every CLI spawn. `lib/security.ts` deny-list enforced inside the MCP listener for bash tools and inside the approval bridge for Claude's native filesystem tools. No claude hooks installed (they would leak Terax policy into the user's other `claude` usage). |
| TERAX.md: no em-dashes, no emojis, default no comments, `@/...` imports, pnpm only | Applied throughout. |
| TERAX.md: production-grade | Per-platform job-object cleanup, stderr drained on background task, stdin lifecycle managed via `Arc<Mutex<Option<...>>>` (clauke pattern), session resume with one retry on stale id. |

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│ React (src/modules/ai/)                                                 │
│  AiMiniWindow / AiInputBar / ChatView / MessageBubble / AiToolApproval  │
│  (unchanged surfaces)                                                   │
│                                                                         │
│  chatStore.makeChat():                                                  │
│    provider === "claude-cli"                                            │
│      ? createClaudeCliTransport(deps)                                   │
│      : createContextAwareTransport(deps)                                │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ invoke / Channel<ClaudeCliEvent>
┌──────────────────────────────▼──────────────────────────────────────────┐
│ Rust (src-tauri/src/modules/ai/)                                        │
│  claude_cli.rs       spawn / steer / approve / stop                     │
│  claude_cli/state.rs RwLock<HashMap<SessionId, ClaudeCliSession>>       │
│  mcp_listener.rs     accepts socket connections from --mcp-stdio helper │
│  mcp_protocol.rs     internal JSON-RPC over the socket                  │
│  mcp_tools.rs        8 terax_* tools                                    │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ spawn
                               ▼
                          claude CLI
                               │ stdio (MCP)
                               ▼
                  terax --mcp-stdio (same binary,
                  second entry point in main.rs)
                               │ unix socket / named pipe
                               ▼
                       back to mcp_listener.rs
```

### Job module promotion

`src-tauri/src/modules/pty/job.rs` is renamed `src-tauri/src/modules/job.rs` and `pub` exposed at `crate::modules::job::PtyJob` (also re-exported under `pty::job::PtyJob` for source compatibility). Both `pty::session` and `ai::claude_cli` use the same `Job::create_for(pid)` helper. This is a separate commit.

## File layout

New files:

```
src-tauri/src/
├── main.rs                                  # MODIFIED: detect --mcp-stdio early, dispatch
├── lib.rs                                   # MODIFIED: register state + 4 IPC commands
└── modules/
    ├── job.rs                               # MOVED from pty/job.rs
    └── ai/
        ├── mod.rs                           # NEW: barrel
        ├── claude_cli.rs                    # NEW: ClaudeCliSession + spawn/stream/steer/kill/approve
        ├── claude_cli/state.rs              # NEW: ClaudeCliState
        ├── mcp_helper.rs                    # NEW: terax --mcp-stdio entry point
        ├── mcp_listener.rs                  # NEW: socket listener in main process
        ├── mcp_protocol.rs                  # NEW: JSON-RPC types
        └── mcp_tools.rs                     # NEW: 8 terax_* tool impls

src/modules/ai/
├── config.ts                                # MODIFIED: 4 model entries + 1 provider entry appended
├── lib/
│   ├── claudeCliTransport.ts                # NEW: ChatTransport adapter
│   ├── claudeCliEvents.ts                   # NEW: pure stream-json -> UIMessageChunk translator
│   ├── claudeCliEvents.test.ts              # NEW: unit tests
│   ├── claudeCliApproval.ts                 # NEW: permission_request bridge to AiToolApproval
│   └── sessions.ts                          # MODIFIED: optional claudeCliSessionId field
└── store/
    └── chatStore.ts                         # MODIFIED: one-line branch in makeChat()
```

## config.ts additions (full diff text)

```ts
export type ProviderId =
  | "openai" | "anthropic" | "google" | "xai" | "cerebras" | "groq"
  | "deepseek" | "mistral" | "openrouter" | "openai-compatible"
  | "lmstudio" | "mlx" | "ollama"
  | "claude-cli";

// Appended to PROVIDERS:
{
  id: "claude-cli",
  label: "Claude Code (CLI)",
  keyringAccount: "",
  keyPrefix: null,
  consoleUrl: "https://docs.anthropic.com/en/docs/claude-code",
}

// Appended to MODELS:
{
  id: "claude-cli-opus-4-7",
  provider: "claude-cli",
  label: "Claude Code · Opus 4.7",
  hint: "via CLI",
  description: "Anthropic Opus 4.7 via the local Claude Code CLI. No API key needed.",
  capabilities: { intelligence: 5, speed: 2, cost: 5 },
  tags: ["vision", "reasoning", "tools", "coding"],
},
{
  id: "claude-cli-opus-4-7-1m",
  provider: "claude-cli",
  label: "Claude Code · Opus 4.7 (1M)",
  hint: "1M ctx",
  description: "Opus 4.7 with 1M context window via the Claude Code CLI.",
  capabilities: { intelligence: 5, speed: 2, cost: 5 },
  tags: ["vision", "reasoning", "tools", "coding"],
},
{
  id: "claude-cli-sonnet-4-6",
  provider: "claude-cli",
  label: "Claude Code · Sonnet 4.6",
  hint: "via CLI",
  description: "Anthropic Sonnet 4.6 via the local Claude Code CLI. No API key needed.",
  capabilities: { intelligence: 4, speed: 4, cost: 5 },
  tags: ["vision", "tools", "coding"],
},
{
  id: "claude-cli-haiku-4-5",
  provider: "claude-cli",
  label: "Claude Code · Haiku 4.5",
  hint: "via CLI",
  description: "Anthropic Haiku 4.5 via the local Claude Code CLI. No API key needed.",
  capabilities: { intelligence: 3, speed: 5, cost: 5 },
  tags: ["vision", "tools"],
},

// Appended to MODEL_CONTEXT_LIMITS:
"claude-cli-opus-4-7":    200_000,
"claude-cli-opus-4-7-1m": 1_000_000,
"claude-cli-sonnet-4-6":  200_000,
"claude-cli-haiku-4-5":   200_000,

// Appended to KEYLESS_PROVIDERS:
"claude-cli",

// Appended to getAutocompleteEligibleModels filter:
//   filter out anything where provider === "claude-cli" (CLI startup latency)
```

`MODEL_PRICING` is NOT extended for these. `estimateCost()` returns `null` and the existing UI hides the cost label.

## Rust spawn pipeline (claude_cli.rs)

```rust
pub struct SpawnOpts {
    pub session_id: String,
    pub prompt: String,
    pub attachments: Vec<String>,
    pub cwd: Option<String>,
    pub add_dirs: Vec<String>,
    pub model_arg: Option<&'static str>,
    pub resume_claude_session_id: Option<String>,
    pub binary_path: Option<String>,
    pub mcp_socket: Option<String>,
}

pub struct ClaudeCliSession {
    child: tokio::process::Child,
    stdin: Arc<tokio::sync::Mutex<Option<tokio::process::ChildStdin>>>,
    cancel: Arc<tokio::sync::Notify>,
    pending_approvals: Arc<tokio::sync::Mutex<HashMap<String, ()>>>,
    #[cfg(windows)]
    _job: crate::modules::job::PtyJob,
}
```

CLI arguments assembled (no extra flags; --verbose only when log level is debug+):

```
<binary_path|"claude"> -p
  --input-format stream-json
  --output-format stream-json
  [--model claude-opus-4-7[1m]]      # mapped via cli_model_arg(modelId)
  [--resume <claude_session_id>]
  [--add-dir <workspace_root>]
  [--add-dir <extra>]*
  --mcp-config <path-to-mcp-config-json>
```

The `--mcp-config` JSON file is written to `dirs::cache_dir()/terax/mcp/<session>.json` per spawn (deleted on drop), with shape:

```json
{
  "mcpServers": {
    "terax": {
      "command": "<absolute-path-to-terax-binary>",
      "args": ["--mcp-stdio"],
      "env": {
        "TERAX_MCP_SOCK": "<absolute-path-to-unix-socket>",
        "TERAX_MCP_TOKEN": "<32-byte-base64-random>"
      }
    }
  }
}
```

`kill_on_drop(true)` and (Windows) a Job Object via promoted `crate::modules::job` ensure the CLI and any descendants die when the session is dropped.

### Stream loop invariants

- stderr is drained on a background task into a bounded 8 KiB buffer (clauke pattern; without it, a full stderr pipe deadlocks stdout)
- stdout JSON parse failures fall back to a `{ "type": "raw", "text": ... }` event
- On cancel via `Notify`, stdin is dropped first (so any pending writer task unblocks via broken pipe) before the child is killed
- Exit emits `ClaudeCliEvent::Exit { code, stderr_tail }` always; "Session not found" stderr triggers transport-level retry

### IPC commands (lib.rs)

```rust
ai_claude_cli_start(
    state: tauri::State<'_, ClaudeCliState>,
    registry: tauri::State<'_, WorkspaceRegistry>,
    session_id: String,
    prompt: String,
    attachments: Vec<String>,
    opts: SpawnOpts,
    channel: Channel<ClaudeCliEvent>,
) -> Result<(), String>

ai_claude_cli_stop(state: ..., session_id: String) -> Result<(), String>
ai_claude_cli_steer(state: ..., session_id: String, message: String) -> Result<(), String>
ai_claude_cli_approve(state: ..., session_id: String, approval_id: String, approved: bool) -> Result<(), String>
```

All four go through `authorize_user_spawn_cwd` (start) or session-membership check (others). No new permissions in `capabilities/default.json` — they piggyback on the existing IPC capability surface.

## MCP bridge (mcp_helper.rs / mcp_listener.rs / mcp_tools.rs)

### Helper entry point

`main.rs` early dispatch (before Tauri init):

```rust
fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--mcp-stdio") {
        terax_lib::modules::ai::mcp_helper::run();
        return;
    }
    terax_lib::run();
}
```

Helper reads MCP JSON-RPC frames from stdin, connects to `$TERAX_MCP_SOCK` with `$TERAX_MCP_TOKEN`, forwards tool calls, returns results to stdout. Pure proxy; no policy decisions in the helper.

### Listener

Bound on `ClaudeCliSession::spawn`. Socket path is `dirs::cache_dir()/terax/mcp-<session>-<random>.sock` (Unix) or named pipe `\\.\pipe\terax-mcp-<session>-<random>` (Windows), permissions `0600` (Unix) / current-user-only DACL (Windows). Single helper per session. Socket deleted on `ClaudeCliSession::drop`.

### Tools exposed

| MCP tool                       | Backing terax surface                         | Deny-list enforced |
|--------------------------------|-----------------------------------------------|--------------------|
| `terax_get_terminal_output`    | active PTY ringbuffer, last 300 lines         | n/a                |
| `terax_attach_terminal_context`| same buffer + cwd, formatted block            | n/a                |
| `terax_suggest_command`        | `injectIntoActivePty` bridge                  | n/a                |
| `terax_open_preview`           | `open_preview` IPC                            | n/a                |
| `terax_bash_background`        | `shell_bg_spawn`                              | yes (path args)    |
| `terax_bash_logs`              | `shell_bg_logs`                               | n/a                |
| `terax_bash_kill`              | `shell_bg_kill`                               | n/a                |
| `terax_bash_list`              | `shell_bg_list`                               | n/a                |

`read_file`, `write_file`, `edit`, `bash_run`, `grep`, `glob` are NOT re-exported — Claude's built-ins handle these. Avoiding double-tools.

## Frontend transport (claudeCliTransport.ts)

Conforms to `ChatTransport<UIMessage>` from `ai`. Returns a `createUIMessageStream` whose executor:

1. Reads the latest user message from `options.messages`
2. Resolves: model id, cwd, addDirs, claudeSessionId for resume, binary path
3. Opens a `Channel<ClaudeCliEvent>`
4. Invokes `ai_claude_cli_start` (does not await its completion — the channel is the completion signal)
5. Routes each event through the pure `processClaudeCliEvent(event, state)` translator
6. Writes resulting `UIMessageChunk`s through the writer
7. Handles `permission_request` side-effects (claudeCliApproval.ts)
8. Resolves when an `Exit` event arrives; rejects on `error` events

Steer (mid-turn user input) and stop are exposed on the chat hook via separate `invoke` calls that look up the session id through the existing `getChat(sessionId)` path.

## Event translation table (claudeCliEvents.ts)

| Claude stream-json event                            | UIMessageChunk(s) emitted                                                       |
|------------------------------------------------------|---------------------------------------------------------------------------------|
| `assistant.message.type == "text"`                   | `text-start` (on first text), `text-delta`, `text-end` (on next non-text block) |
| `content_block_delta.text_delta`                     | `text-delta`                                                                    |
| `assistant.message.type == "thinking"`               | `reasoning-start` / `reasoning-delta` / `reasoning-end`                         |
| `content_block_delta.thinking_delta`                 | `reasoning-delta`                                                               |
| `content_block_start.type == "tool_use"`             | `tool-input-start { toolCallId, toolName }`                                     |
| `content_block_delta.input_json_delta`               | `tool-input-delta { toolCallId, inputTextDelta }`                               |
| `content_block_stop` after tool_use                  | `tool-input-available { toolCallId, toolName, input }`                          |
| `user.content[].type == "tool_result"`               | `tool-output-available { toolCallId, output }`                                  |
| `result.subtype == "tool_result"`                    | same as above                                                                   |
| `permission_request` / `tool_use_permission`         | side-effect: route to AiToolApproval via claudeCliApproval.ts                   |
| `system.subtype == "compact"`                        | side-effect: `deps.onCompact?.({ droppedCount: 0 })`                            |
| `result` (final, no subtype)                         | `finish-step`, `finish`; stores `event.session_id` via `deps.setClaudeSessionId` |
| `error`                                              | abort stream with the error message                                             |
| `raw`                                                | `text-delta` with the raw text                                                  |

Agent nesting (clauke's `agentStacks` trick) is preserved: child tool calls under an active `Agent` get a `metadata.parentToolCallId` on their tool-input chunk; `MessageBubble` indents accordingly. This is the only existing-component change.

## Approval bridge (claudeCliApproval.ts)

```
Claude          Rust              Transport adapter          AiToolApproval card
emit permission ─▶ Channel  ───▶  check deny-list (security.ts)
  _request                          ↓
                                    deny-list hit?
                                    ├─ yes: invoke approve(false),
                                    │       emit synthetic tool-output
                                    │       "blocked by terax policy"
                                    └─ no:  emit tool-input-available
                                            with state "awaiting-approval"
                                            bump agentMeta.approvalsPending
                                                                ↓
                                                           user clicks approve
                                                                ↓
                                  ◀─── respondToApproval(id, true)
                                  invoke("ai_claude_cli_approve", ...)
                  ◀─ stdin write {"type":"permission_decision","tool_use_id":"...","approved":true}
◀─ resume
emit tool_use ──▶ ... ──▶ adapter emits tool-input chunks (normal path)
emit tool_result ──▶ ... ──▶ adapter emits tool-output-available
```

The deny-list interception means Claude's native filesystem tools cannot read or write `.env*`, `.ssh/`, credential paths — the approval-time check rejects before Claude executes. Documented limitation: a malicious user-prompted shell trick inside `Bash` (e.g. `cat .env`) is still subject to the same approval gate because Claude announces the command in the permission_request payload — but obfuscation via process substitution is theoretically possible. The deny-list is a strong default, not a sandbox.

## Sessions

```ts
// lib/sessions.ts SessionMeta
export type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  claudeCliSessionId?: string;   // NEW
};
```

- On first `result` event, transport captures `event.session_id`, calls `deps.setClaudeSessionId(sessionId, claudeId)`, which mutates the session in `useChatStore` and triggers `saveSessionsList`.
- On subsequent `sendMessages` for the same terax session, transport passes `--resume <claudeCliSessionId>`.
- If `ClaudeCliEvent::Exit` carries stderr matching `Session not found` (case-insensitive, also accepts `session id .* invalid`), transport clears `claudeCliSessionId` and retries once. Second failure surfaces as a normal error.
- Forking, multi-claude-session-per-terax-session: out of scope for v1.

## Edge cases

| Scenario | Behavior |
|---|---|
| `claude` not on PATH, no binary path set | Spawn fails synchronously, transport emits "Install Claude Code CLI or set its path in Settings → Models" with link to `consoleUrl`. |
| `claude` exists but not authenticated | Non-zero exit on start; stderr tail surfaced verbatim. |
| Workspace not authorized | `authorize_user_spawn_cwd` rejects; transport surfaces "Authorize this workspace in the picker before using AI." |
| MCP helper crashes | Claude continues without terax-only tools. Transport emits a banner ("Terax MCP tools unavailable, native tools still active"). Helper restart deferred to next turn. |
| Tauri channel disconnects | Rust drops session on Channel drop; emits Exit; transport flushes pending `text-end`, emits `finish`, marks `agentMeta.error`. |
| `claude-cli-*` model selected but no terax session active | Same guard as other providers: `sendMessage()` returns false. |
| Cost UI | `estimateCost()` returns null; no cost label rendered. |
| Plan mode toggle | Greyed out when `claude-cli-*` is active; tooltip "Plan mode is not supported with the Claude Code CLI provider." |
| Subagents (`run_subagent`) | Not exposed via MCP; Claude has its own Agent tool via stream-json nested blocks. |
| Voice input | Works as-is. |
| Inline autocomplete | `claude-cli-*` excluded from `getAutocompleteEligibleModels()`. |

## Test plan

### Rust (`cargo test --locked`)

- `claude_cli::cli_model_arg`: id-to-arg mapping is exhaustive
- `claude_cli::build_command`: argv assembly given various `SpawnOpts`; asserts `--resume` only present when claude session id supplied; asserts mcp-config path included
- `mcp_listener::handshake`: token mismatch rejects, correct token accepts
- `mcp_tools::deny_list`: bash background with `.env` path rejected; with `/tmp/x` accepted
- `mcp_protocol::roundtrip`: JSON-RPC parse + emit symmetry

### TypeScript (`pnpm test`)

- `claudeCliEvents.test.ts`: fixture-driven — for each event type in the translation table, assert the produced UIMessageChunk sequence
- `claudeCliEvents.test.ts`: agent nesting — emits parent Agent followed by child tool_use; child carries `metadata.parentToolCallId`
- `claudeCliApproval.test.ts`: deny-list path triggers auto-rejection without bumping `approvalsPending`; non-deny path bumps it and surfaces a tool-input-available with `awaiting-approval`
- `sessions.test.ts`: `claudeCliSessionId` optional, persists and reloads with full round-trip

### Manual smoke test (per PR template "Manual smoke-test of the affected feature")

1. Select `Claude Code · Sonnet 4.6` in model picker. Verify no key card appears in Settings.
2. Send a prompt that needs file reads. Verify Claude's `Read` tool calls render as cards in the same UI as terax's `read_file`.
3. Send a prompt that triggers a write to a non-deny-list path. Verify `AiToolApproval` card shows up; approve; verify Claude resumes and the file is written.
4. Send a prompt that asks Claude to read `.env`. Verify the approval card shows red "blocked by terax policy" and Claude is told no.
5. Send a prompt that asks Claude to use a terax-only tool (e.g. "open the preview for localhost:3000"). Verify the MCP-routed `terax_open_preview` runs and opens the preview tab.
6. Close the chat, restart Terax, reopen the same session. Verify Claude resumes via `--resume`.
7. Stop a running stream mid-turn. Verify the CLI is killed, the message shows a "stopped" state, no orphan processes.
8. Cross-platform: at minimum macOS and Windows, given Windows is where the named-pipe path is most likely to bite.

## Implementation order (atomic commits, in this order)

1. `chore(pty): promote job.rs to crate::modules::job` — pure move + re-export, no behavior change
2. `feat(ai): config entries for claude-cli provider and models` — `config.ts` additions only, no Rust
3. `feat(ai): ClaudeCliSession spawn + stream pipeline` — `claude_cli.rs`, no MCP yet, no transport wired
4. `feat(ai): MCP helper + listener + tools` — `--mcp-stdio` entry point, listener, 8 tools
5. `feat(ai): claudeCliTransport + event translator` — TS side, wires up the transport but leaves chatStore branch off
6. `feat(ai): approval bridge for permission_request` — claudeCliApproval.ts, deny-list interception
7. `feat(ai): wire claude-cli provider into chatStore + session resume` — the one-line branch in `makeChat()`, SessionMeta field, resume retry
8. `feat(ai): settings card for claude-cli binary path and extra add-dirs`
9. `test(ai): unit tests across Rust and TS surfaces`

Each commit compiles, type-checks, and clippy-passes on its own. Commit 7 is when the feature becomes user-visible. Commits 1-6 can be reviewed independently.

## Open questions (to confirm during implementation)

- Exact stdin schema for `permission_decision` — claude CLI's documented format may differ from the assumed `{"type":"permission_decision","tool_use_id":"...","approved":true}`. First run will validate; spec updated if wrong.
- `--continue` vs `--resume` semantics for "user starts a new turn in an existing terax session". Likely `--resume` with stored session id; falls back gracefully via the retry path.
- Whether MCP servers config file format has changed in current `claude` CLI versions. Will probe on first run.
- Whether the agent nesting (Section 5) needs `MessageBubble` changes at all, or whether the existing AI Elements `Tool` component already indents children when given a `parentToolCallId` metadata field. If the existing component handles it, no UI change at all.

## Follow-ups (deliberately out of scope for v1)

- Fork-from-message (clauke parity)
- Per-tool allowlist in Settings (Claude CLI supports `--allowedTools`)
- Cost estimation for subscription-quota awareness (would require parsing claude's `total_cost_usd` field, which is reported but optional)
- Multi-claude-session-per-terax-session (parallel sub-claudes)
- Streaming `claude` command output to a "Claude logs" panel for debugging

## References

- TERAX.md (architecture, AI subsystem, conventions)
- CONTRIBUTING.md (PR rules, quality bar, code style, branch + commit conventions)
- ROADMAP.md (theme alignment, line 103 anchor)
- clauke (`D:\2026 MISC\dev\rust\clauke`) — reference implementation of `claude` stream-json parsing, studied via Read tool only, never modified
- Claude Code CLI docs: https://docs.anthropic.com/en/docs/claude-code
