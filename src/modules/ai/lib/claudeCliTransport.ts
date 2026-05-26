import { invoke, Channel } from "@tauri-apps/api/core";
import {
  createUIMessageStream,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { ClaudeCliEventTranslator, type Side } from "./claudeCliEvents";

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
};

export type ClaudeCliDeps = {
  getTeraxSessionId: () => string | null;
  getLive: () => ClaudeCliLive;
  getModelId: () => string | undefined;
  getBinaryPath: () => string | undefined;
  getExtraAddDirs: () => string[];
  getClaudeSessionId: (sessionId: string) => string | undefined;
  setClaudeSessionId: (sessionId: string, claudeId: string) => void;
  clearClaudeSessionId: (sessionId: string) => void;
  onPermissionRequest: (info: {
    sessionId: string;
    toolUseId: string;
    toolName: string;
    input: Record<string, unknown>;
    description?: string;
  }) => void;
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
};

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

export function createClaudeCliTransport(deps: ClaudeCliDeps): ChatTransport<UIMessage> {
  return {
    async sendMessages(options) {
      const sessionId = deps.getTeraxSessionId();
      if (!sessionId) throw new Error("No active terax session");
      const text = lastUserText(options.messages);
      const live = deps.getLive();
      const claudeSessionId = deps.getClaudeSessionId(sessionId);

      const stream = await runOne(deps, sessionId, text, live, claudeSessionId, options.messages);
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
          if (side.kind === "exit") {
            sidesAcc.push(side);
            staleSession = isStaleSession(side.stderrTail);
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
            deps.onPermissionRequest({
              sessionId,
              toolUseId: side.toolUseId,
              toolName: side.toolName,
              input: side.input,
              description: side.description,
            });
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
      };

      try {
        await invoke("ai_claude_cli_start", { sessionId, prompt: text, opts, channel });
      } catch (e) {
        writer.write({ type: "error", errorText: e instanceof Error ? e.message : String(e) });
        const tail = translator.finalize();
        for (const c of tail.chunks) writer.write(c);
        return;
      }

      await new Promise<Side[]>((resolve) => {
        if (finished) {
          resolve(sidesAcc.slice());
          return;
        }
        resolveExit = resolve;
      });

      // Resume retry: a stale --resume id manifests as a CLI exit with a
      // recognizable stderr message. Clear the stored id and replay once.
      if (staleSession && resumeClaudeSessionId) {
        deps.clearClaudeSessionId(sessionId);
        writer.write({ type: "error", errorText: "Claude session expired; retrying with a fresh session." });
        const retry = await runOne(deps, sessionId, text, live, undefined, originalMessages);
        writer.merge(retry);
        return;
      }

      const tail = translator.finalize();
      for (const c of tail.chunks) writer.write(c);
    },
  });
}
