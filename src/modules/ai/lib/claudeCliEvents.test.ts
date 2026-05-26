import { describe, expect, it } from "vitest";
import { ClaudeCliEventTranslator } from "./claudeCliEvents";

describe("ClaudeCliEventTranslator", () => {
  it("emits text-start, text-delta, and finish on assistant text + result", () => {
    const t = new ClaudeCliEventTranslator();
    const r1 = t.process({
      type: "assistant",
      message: { type: "text", text: "hello" },
    });
    expect(r1.chunks[0]).toMatchObject({ type: "text-start" });
    expect(r1.chunks[1]).toMatchObject({ type: "text-delta", delta: "hello" });
    const r2 = t.process({ type: "result", session_id: "sess-123" });
    expect(r2.sides[0]).toEqual({ kind: "claude_session_id", id: "sess-123" });
    const tail = t.finalize();
    expect(tail.chunks.some((c) => c.type === "text-end")).toBe(true);
    expect(tail.chunks.some((c) => c.type === "finish")).toBe(true);
  });

  it("translates streaming tool input through start/delta/stop", () => {
    const t = new ClaudeCliEventTranslator();
    t.process({
      type: "content_block_start",
      content_block: { type: "tool_use", id: "tu_1", name: "Read" },
    });
    t.process({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    });
    t.process({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: '"/x"}' },
    });
    const r = t.process({ type: "content_block_stop" });
    const available = r.chunks.find((c) => c.type === "tool-input-available");
    expect(available).toMatchObject({
      type: "tool-input-available",
      toolCallId: "tu_1",
      toolName: "Read",
      input: { path: "/x" },
    });
  });

  it("surfaces permission_request as a side, not a chunk", () => {
    const t = new ClaudeCliEventTranslator();
    const r = t.process({
      type: "permission_request",
      tool_use_id: "tu_perm",
      tool_name: "Write",
      input: { path: "/tmp/foo" },
      description: "Write /tmp/foo?",
    });
    expect(r.chunks).toHaveLength(0);
    expect(r.sides[0]).toEqual({
      kind: "permission_request",
      toolUseId: "tu_perm",
      toolName: "Write",
      input: { path: "/tmp/foo" },
      description: "Write /tmp/foo?",
    });
  });

  it("maps tool_result via the user event onto tool-output-available", () => {
    const t = new ClaudeCliEventTranslator();
    const r = t.process({
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "result text",
          },
        ],
      },
    });
    expect(r.chunks[0]).toEqual({
      type: "tool-output-available",
      toolCallId: "tu_1",
      output: "result text",
    });
  });

  it("emits an error chunk on Claude error events", () => {
    const t = new ClaudeCliEventTranslator();
    const r = t.process({ type: "error", text: "boom" });
    expect(r.chunks[0]).toEqual({ type: "error", errorText: "boom" });
  });

  it("captures terax_exit as an exit side", () => {
    const t = new ClaudeCliEventTranslator();
    const r = t.process({ type: "terax_exit", code: 0, stderr_tail: "" });
    expect(r.sides[0]).toMatchObject({ kind: "exit", code: 0 });
  });

  it("surfaces compact events as a compact side", () => {
    const t = new ClaudeCliEventTranslator();
    const r = t.process({ type: "system", subtype: "compact" });
    expect(r.sides[0]).toEqual({ kind: "compact" });
  });
});
