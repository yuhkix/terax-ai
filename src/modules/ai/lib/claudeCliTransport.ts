import { invoke, Channel } from "@tauri-apps/api/core";
import {
  createUIMessageStream,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import {
  approveDirectly,
  checkClaudeToolDenyList,
  nextApprovalId,
  registerClaudeCliApproval,
} from "./claudeCliApproval";
import { ClaudeCliEventTranslator, type Side } from "./claudeCliEvents";
import { readTeraxMd } from "./projectMemory";

const CLI_MODEL_ARG: Record<string, string> = {
  "claude-cli-opus-4-7": "claude-opus-4-7",
  "claude-cli-opus-4-7-1m": "claude-opus-4-7[1m]",
  "claude-cli-sonnet-4-6": "claude-sonnet-4-6",
  "claude-cli-haiku-4-5": "claude-haiku-4-5",
};

export function cliModelArg(modelId: string | undefined): string | undefined {
  if (!modelId) return undefined;
  return CLI_MODEL_ARG[modelId];
}

export type ClaudeCliLive = {
  cwd: string | null;
  workspaceRoot: string | null;
  activeFile: string | null;
  terminalPrivate: boolean;
};

export type ClaudeCliDeps = {
  getTeraxSessionId: () => string | null;
  getLive: () => ClaudeCliLive;
  getModelId: () => string | undefined;
  getBinaryPath: () => string | undefined;
  getExtraAddDirs: () => string[];
  getCustomInstructions: () => string;
  getClaudeSessionId: (sessionId: string) => string | undefined;
  setClaudeSessionId: (sessionId: string, claudeId: string) => void;
  clearClaudeSessionId: (sessionId: string) => void;
  onCompact?: () => void;
  onStep?: (label: string | null) => void;
};

type SpawnOptsPayload = {
  modelArg?: string;
  cwd?: string;
  addDirs: string[];
  resumeClaudeSessionId?: string;
  binaryPath?: string;
  enableMcp: boolean;
  systemPrompt?: string;
};

function buildSystemPrompt(
  teraxMd: string | null,
  customInstructions: string,
): string | undefined {
  const blocks: string[] = [];
  if (teraxMd && teraxMd.trim().length > 0) {
    blocks.push(`## PROJECT — TERAX.md\n${teraxMd.trim()}`);
  }
  const ci = customInstructions.trim();
  if (ci.length > 0) {
    blocks.push(`## USER INSTRUCTIONS\n${ci}`);
  }
  return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}

function buildEnvBlock(live: ClaudeCliLive): string | null {
  const lines: string[] = [];
  if (live.workspaceRoot) lines.push(`workspace_root: ${live.workspaceRoot}`);
  if (live.cwd) lines.push(`active_terminal_cwd: ${live.cwd}`);
  if (live.activeFile) lines.push(`active_file: ${live.activeFile}`);
  if (live.terminalPrivate) lines.push("active_terminal_mode: private");
  if (lines.length === 0) return null;
  return `<env>\n${lines.join("\n")}\n</env>`;
}

function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = m.parts as ReadonlyArray<{ type: string; text?: string }>;
    return parts
      .filter((p) => p.type === "text" && typeof p.text === "string")
      .map((p) => p.text ?? "")
      .join("\n");
  }
  return "";
}

function dedupAddDirs(workspaceRoot: string | null, extras: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (s: string | null) => {
    if (!s) return;
    const t = s.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  push(workspaceRoot);
  for (const d of extras) push(d);
  return out;
}

function isStaleSession(stderrTail: string): boolean {
  const t = stderrTail.toLowerCase();
  return t.includes("session not found") || t.includes("session id") && t.includes("invalid");
}

function handlePermissionRequest(
  sessionId: string,
  side: Extract<Side, { kind: "permission_request" }>,
  writer: { write: (chunk: UIMessageChunk) => void },
): void {
  // Surface a complete tool input first so the existing AiToolApproval card
  // has something to attach itself to. The Claude CLI emits the matching
  // tool_use block only after approval lands, so we synthesize it here.
  writer.write({
    type: "tool-input-start",
    toolCallId: side.toolUseId,
    toolName: side.toolName,
    dynamic: true,
  });
  writer.write({
    type: "tool-input-available",
    toolCallId: side.toolUseId,
    toolName: side.toolName,
    input: side.input,
    dynamic: true,
  });

  const verdict = checkClaudeToolDenyList(side.toolName, side.input);
  if (verdict.denied) {
    writer.write({
      type: "tool-output-error",
      toolCallId: side.toolUseId,
      errorText: `terax blocked: ${verdict.reason}`,
    });
    void approveDirectly(sessionId, side.toolUseId, false);
    return;
  }

  const approvalId = nextApprovalId();
  registerClaudeCliApproval(approvalId, sessionId, side.toolUseId);
  writer.write({
    type: "tool-approval-request",
    approvalId,
    toolCallId: side.toolUseId,
  });
}

export function createClaudeCliTransport(deps: ClaudeCliDeps): ChatTransport<UIMessage> {
  return {
    async sendMessages(options) {
      const sessionId = deps.getTeraxSessionId();
      if (!sessionId) throw new Error("No active terax session");
      const rawText = lastUserText(options.messages);
      const live = deps.getLive();
      const claudeSessionId = deps.getClaudeSessionId(sessionId);
      const envBlock = buildEnvBlock(live);
      const text = envBlock ? `${envBlock}\n\n${rawText}` : rawText;
      const teraxMd = await readTeraxMd(live.workspaceRoot);
      const systemPrompt = buildSystemPrompt(teraxMd, deps.getCustomInstructions());

      const stream = await runOne(
        deps,
        sessionId,
        text,
        live,
        claudeSessionId,
        systemPrompt,
        options.messages,
      );
      return stream;
    },
    async reconnectToStream() {
      return null;
    },
  };
}

async function runOne(
  deps: ClaudeCliDeps,
  sessionId: string,
  text: string,
  live: ClaudeCliLive,
  resumeClaudeSessionId: string | undefined,
  systemPrompt: string | undefined,
  originalMessages: UIMessage[],
): Promise<ReadableStream<UIMessageChunk>> {
  return createUIMessageStream<UIMessage>({
    originalMessages,
    onError: (e) => `Claude CLI error: ${e instanceof Error ? e.message : String(e)}`,
    async execute({ writer }) {
      const translator = new ClaudeCliEventTranslator();
      writer.write({ type: "start" });
      writer.write({ type: "start-step" });

      let staleSession = false;
      let finished = false;
      const channel = new Channel<Record<string, unknown>>();
      let resolveExit: ((sides: Side[]) => void) | null = null;
      const sidesAcc: Side[] = [];

      channel.onmessage = (event) => {
        const { chunks, sides } = translator.process(event);
        for (const chunk of chunks) writer.write(chunk);
        for (const side of sides) {
          if (side.kind === "exit" || side.kind === "complete") {
            sidesAcc.push(side);
            if (side.kind === "exit") {
              staleSession = isStaleSession(side.stderrTail);
            }
            finished = true;
            if (resolveExit) {
              resolveExit(sidesAcc.slice());
              resolveExit = null;
            }
            continue;
          }
          sidesAcc.push(side);
          if (side.kind === "claude_session_id") {
            deps.setClaudeSessionId(sessionId, side.id);
          } else if (side.kind === "permission_request") {
            handlePermissionRequest(sessionId, side, writer);
          } else if (side.kind === "compact") {
            deps.onCompact?.();
          }
        }
      };

      const opts: SpawnOptsPayload = {
        modelArg: cliModelArg(deps.getModelId()),
        cwd: live.cwd ?? live.workspaceRoot ?? undefined,
        addDirs: dedupAddDirs(live.workspaceRoot, deps.getExtraAddDirs()),
        resumeClaudeSessionId,
        binaryPath: deps.getBinaryPath(),
        enableMcp: true,
        systemPrompt,
      };

      try {
        await invoke("ai_claude_cli_start", { sessionId, prompt: text, opts, channel });
      } catch (e) {
        writer.write({ type: "error", errorText: e instanceof Error ? e.message : String(e) });
        const tail = translator.finalize();
        for (const c of tail.chunks) writer.write(c);
        return;
      }

      const finalSides = await new Promise<Side[]>((resolve) => {
        if (finished) {
          resolve(sidesAcc.slice());
          return;
        }
        resolveExit = resolve;
      });

      // If we resolved on `complete` (turn done, CLI still idle on stdin),
      // tell Rust to drop stdin so the process exits. On a real exit side
      // this is a no-op.
      const sawComplete = finalSides.some((s) => s.kind === "complete");
      if (sawComplete) {
        try {
          await invoke("ai_claude_cli_stop", { sessionId });
        } catch {
          // best-effort
        }
      }

      // Resume retry: a stale --resume id manifests as a CLI exit with a
      // recognizable stderr message. Clear the stored id and replay once.
      if (staleSession && resumeClaudeSessionId) {
        deps.clearClaudeSessionId(sessionId);
        writer.write({ type: "error", errorText: "Claude session expired; retrying with a fresh session." });
        const retry = await runOne(
          deps,
          sessionId,
          text,
          live,
          undefined,
          systemPrompt,
          originalMessages,
        );
        writer.merge(retry);
        return;
      }

      const tail = translator.finalize();
      for (const c of tail.chunks) writer.write(c);
    },
  });
}
