import type { UIMessageChunk } from "ai";

export type Side =
  | { kind: "permission_request"; toolUseId: string; toolName: string; input: Record<string, unknown>; description?: string }
  | { kind: "claude_session_id"; id: string }
  | { kind: "compact" }
  | { kind: "complete"; subtype: string | null }
  | { kind: "exit"; code: number; stderrTail: string };

export type TranslateResult = {
  chunks: UIMessageChunk[];
  sides: Side[];
};

type ClaudeEvent = Record<string, unknown>;

const RAW_BLOCK = "_raw_";
const ERROR_BLOCK = "_error_";

function getString(value: unknown, key: string): string | undefined {
  if (value && typeof value === "object" && key in (value as object)) {
    const v = (value as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  }
  return undefined;
}

function getRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && key in (value as object)) {
    const v = (value as Record<string, unknown>)[key];
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  }
  return undefined;
}

function getArray(value: unknown, key: string): unknown[] | undefined {
  if (value && typeof value === "object" && key in (value as object)) {
    const v = (value as Record<string, unknown>)[key];
    return Array.isArray(v) ? v : undefined;
  }
  return undefined;
}

export class ClaudeCliEventTranslator {
  private textId: string | null = null;
  private thinkingId: string | null = null;
  private agentStack: string[] = [];
  private pendingToolInputs = new Map<string, { toolName: string; rawJson: string }>();
  private seq = 0;

  process(event: ClaudeEvent): TranslateResult {
    const out: TranslateResult = { chunks: [], sides: [] };
    const type = typeof event.type === "string" ? (event.type as string) : "";

    switch (type) {
      case "system":
        this.handleSystem(event, out);
        break;
      case "assistant":
        this.handleAssistant(event, out);
        break;
      case "content_block_start":
        this.handleContentBlockStart(event, out);
        break;
      case "content_block_delta":
        this.handleContentBlockDelta(event, out);
        break;
      case "content_block_stop":
        this.handleContentBlockStop(event, out);
        break;
      case "user":
        this.handleUser(event, out);
        break;
      case "tool_result":
      case "tool":
        this.handleToolResult(event, out, getString(event, "tool_use_id") ?? getString(event, "id") ?? "");
        break;
      case "result":
        this.handleResult(event, out);
        break;
      case "permission_request":
      case "tool_use_permission":
        this.handlePermissionRequest(event, out);
        break;
      case "error":
        this.handleError(event, out);
        break;
      case "terax_raw":
        this.handleRaw(event, out);
        break;
      case "terax_error":
        this.handleError(event, out);
        break;
      case "terax_exit":
        this.handleExit(event, out);
        break;
      default:
        break;
    }
    return out;
  }

  finalize(): TranslateResult {
    const out: TranslateResult = { chunks: [], sides: [] };
    this.closeText(out);
    this.closeThinking(out);
    out.chunks.push({ type: "finish-step" });
    out.chunks.push({ type: "finish" });
    return out;
  }

  private id(prefix: string): string {
    return `${prefix}-${++this.seq}`;
  }

  private openText(out: TranslateResult): string {
    if (this.thinkingId) this.closeThinking(out);
    if (this.textId) return this.textId;
    const id = this.id("text");
    this.textId = id;
    out.chunks.push({ type: "text-start", id });
    return id;
  }

  private closeText(out: TranslateResult): void {
    if (!this.textId) return;
    out.chunks.push({ type: "text-end", id: this.textId });
    this.textId = null;
  }

  private openThinking(out: TranslateResult): string {
    if (this.textId) this.closeText(out);
    if (this.thinkingId) return this.thinkingId;
    const id = this.id("thinking");
    this.thinkingId = id;
    out.chunks.push({ type: "reasoning-start", id });
    return id;
  }

  private closeThinking(out: TranslateResult): void {
    if (!this.thinkingId) return;
    out.chunks.push({ type: "reasoning-end", id: this.thinkingId });
    this.thinkingId = null;
  }

  private emitText(delta: string, out: TranslateResult): void {
    if (!delta) return;
    const id = this.openText(out);
    out.chunks.push({ type: "text-delta", id, delta });
  }

  private emitThinking(delta: string, out: TranslateResult): void {
    if (!delta) return;
    const id = this.openThinking(out);
    out.chunks.push({ type: "reasoning-delta", id, delta });
  }

  private startTool(toolCallId: string, toolName: string, out: TranslateResult): void {
    this.closeText(out);
    this.closeThinking(out);
    out.chunks.push({ type: "tool-input-start", toolCallId, toolName, dynamic: true });
    this.pendingToolInputs.set(toolCallId, { toolName, rawJson: "" });
  }

  private finishTool(toolCallId: string, input: Record<string, unknown>, out: TranslateResult): void {
    const pending = this.pendingToolInputs.get(toolCallId);
    const toolName = pending?.toolName ?? "unknown";
    out.chunks.push({
      type: "tool-input-available",
      toolCallId,
      toolName,
      input,
      dynamic: true,
    });
    this.pendingToolInputs.delete(toolCallId);
    if (toolName.trim().toLowerCase() === "agent") {
      this.agentStack.push(toolCallId);
    }
  }

  private handleSystem(event: ClaudeEvent, out: TranslateResult): void {
    const subtype = getString(event, "subtype");
    if (subtype === "compact" || subtype === "auto_compact") {
      out.sides.push({ kind: "compact" });
    }
  }

  private handleAssistant(event: ClaudeEvent, out: TranslateResult): void {
    const message = getRecord(event, "message");
    if (!message) return;
    const messageType = getString(message, "type");
    if (messageType === "text") {
      this.emitText(getString(message, "text") ?? "", out);
      return;
    }
    if (messageType === "thinking") {
      this.emitThinking(getString(message, "thinking") ?? getString(message, "text") ?? "", out);
      return;
    }
    if (messageType === "tool_use") {
      const id = getString(message, "id") ?? this.id("tool");
      const name = getString(message, "name") ?? "unknown";
      const input = getRecord(message, "input") ?? {};
      this.startTool(id, name, out);
      this.finishTool(id, input, out);
      return;
    }
    const content = getArray(message, "content");
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        const bt = getString(b, "type");
        if (bt === "text") this.emitText(getString(b, "text") ?? "", out);
        else if (bt === "thinking")
          this.emitThinking(getString(b, "thinking") ?? getString(b, "text") ?? "", out);
        else if (bt === "tool_use") {
          const id = getString(b, "id") ?? this.id("tool");
          const name = getString(b, "name") ?? "unknown";
          const input = getRecord(b, "input") ?? {};
          this.startTool(id, name, out);
          this.finishTool(id, input, out);
        } else if (bt === "tool_result") {
          this.handleToolResult(b, out, getString(b, "tool_use_id") ?? "");
        }
      }
    }
  }

  private handleContentBlockStart(event: ClaudeEvent, out: TranslateResult): void {
    const block = getRecord(event, "content_block");
    if (!block) return;
    const bt = getString(block, "type");
    if (bt === "text") {
      this.openText(out);
    } else if (bt === "thinking") {
      this.openThinking(out);
    } else if (bt === "tool_use") {
      const id = getString(block, "id") ?? this.id("tool");
      const name = getString(block, "name") ?? "unknown";
      this.startTool(id, name, out);
    }
  }

  private handleContentBlockDelta(event: ClaudeEvent, out: TranslateResult): void {
    const delta = getRecord(event, "delta");
    if (!delta) return;
    const dt = getString(delta, "type");
    if (dt === "text_delta") {
      this.emitText(getString(delta, "text") ?? "", out);
    } else if (dt === "thinking_delta") {
      this.emitThinking(getString(delta, "thinking") ?? "", out);
    } else if (dt === "input_json_delta") {
      const partial = getString(delta, "partial_json") ?? "";
      if (!partial) return;
      const last = [...this.pendingToolInputs.keys()].pop();
      if (last) {
        const entry = this.pendingToolInputs.get(last);
        if (entry) {
          entry.rawJson += partial;
          out.chunks.push({ type: "tool-input-delta", toolCallId: last, inputTextDelta: partial });
        }
      }
    }
  }

  private handleContentBlockStop(_event: ClaudeEvent, out: TranslateResult): void {
    const last = [...this.pendingToolInputs.keys()].pop();
    if (!last) return;
    const entry = this.pendingToolInputs.get(last);
    if (!entry) return;
    let input: Record<string, unknown> = {};
    if (entry.rawJson) {
      try {
        const parsed = JSON.parse(entry.rawJson);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          input = parsed as Record<string, unknown>;
        }
      } catch {
        // partial JSON; surface what we have
        input = { _raw: entry.rawJson };
      }
    }
    this.finishTool(last, input, out);
  }

  private handleUser(event: ClaudeEvent, out: TranslateResult): void {
    const message = getRecord(event, "message");
    const content = message ? getArray(message, "content") : undefined;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      const b = block as Record<string, unknown>;
      if (getString(b, "type") === "tool_result") {
        this.handleToolResult(b, out, getString(b, "tool_use_id") ?? "");
      }
    }
  }

  private handleToolResult(event: ClaudeEvent, out: TranslateResult, toolUseId: string): void {
    if (!toolUseId) return;
    const isError = event.is_error === true;
    const rawContent = event.content ?? event.output;
    let output: unknown = "";
    if (typeof rawContent === "string") {
      output = rawContent;
    } else if (Array.isArray(rawContent)) {
      output = rawContent
        .map((c) => (c && typeof c === "object" && "text" in c ? (c as { text?: unknown }).text : null))
        .filter((t): t is string => typeof t === "string")
        .join("\n");
    } else if (rawContent && typeof rawContent === "object") {
      output = (rawContent as Record<string, unknown>).text ?? rawContent;
    }
    if (isError) {
      out.chunks.push({
        type: "tool-output-error",
        toolCallId: toolUseId,
        errorText: typeof output === "string" ? output : JSON.stringify(output),
      });
    } else {
      out.chunks.push({ type: "tool-output-available", toolCallId: toolUseId, output });
    }
    const idx = this.agentStack.indexOf(toolUseId);
    if (idx !== -1) this.agentStack.splice(idx, 1);
  }

  private handleResult(event: ClaudeEvent, out: TranslateResult): void {
    const subtype = getString(event, "subtype");
    const toolUseId = getString(event, "tool_use_id");
    if (subtype === "tool_result" || subtype === "tool_use_result" || toolUseId) {
      this.handleToolResult(event, out, toolUseId ?? "");
      return;
    }
    const sessionId = getString(event, "session_id");
    if (sessionId) out.sides.push({ kind: "claude_session_id", id: sessionId });
    const resultText = getString(event, "result") ?? getString(event, "text");
    if (resultText && !this.textId) this.emitText(resultText, out);
    this.agentStack = [];
    // Top-level `result` event = end of this turn. The CLI is now idle on
    // stdin waiting for more input. Signal the transport so it can stop the
    // session (closing stdin lets the process exit cleanly).
    out.sides.push({ kind: "complete", subtype: subtype ?? null });
  }

  private handlePermissionRequest(event: ClaudeEvent, out: TranslateResult): void {
    const toolUseId =
      getString(event, "tool_use_id") ?? getString(event, "id") ?? `pending-${++this.seq}`;
    const toolName = getString(event, "tool_name") ?? getString(event, "tool") ?? "unknown";
    const input = getRecord(event, "input") ?? getRecord(event, "tool_input") ?? {};
    const description = getString(event, "description") ?? getString(event, "message");
    out.sides.push({ kind: "permission_request", toolUseId, toolName, input, description });
  }

  private handleError(event: ClaudeEvent, out: TranslateResult): void {
    const text =
      getString(event, "text") ??
      getString(getRecord(event, "error") ?? {}, "message") ??
      (typeof event.message === "string" ? (event.message as string) : "Unknown error");
    this.closeText(out);
    this.closeThinking(out);
    out.chunks.push({ type: "error", errorText: text });
    void ERROR_BLOCK;
  }

  private handleRaw(event: ClaudeEvent, out: TranslateResult): void {
    this.emitText(getString(event, "text") ?? "", out);
    void RAW_BLOCK;
  }

  private handleExit(event: ClaudeEvent, out: TranslateResult): void {
    const code = typeof event.code === "number" ? (event.code as number) : -1;
    const stderrTail = getString(event, "stderr_tail") ?? "";
    out.sides.push({ kind: "exit", code, stderrTail });
  }
}
