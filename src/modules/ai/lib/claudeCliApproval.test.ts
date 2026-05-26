import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  checkClaudeToolDenyList,
  forgetClaudeCliApproval,
  nextApprovalId,
  registerClaudeCliApproval,
  tryRespondClaudeCli,
} from "./claudeCliApproval";

describe("checkClaudeToolDenyList", () => {
  it("blocks Read on .env paths", () => {
    const r = checkClaudeToolDenyList("Read", { file_path: "/home/me/.env" });
    expect(r).toMatchObject({ denied: true });
  });

  it("blocks Write on .ssh paths", () => {
    const r = checkClaudeToolDenyList("Write", { path: "/home/me/.ssh/known_hosts" });
    expect(r).toMatchObject({ denied: true });
  });

  it("allows Read on a regular file", () => {
    const r = checkClaudeToolDenyList("Read", { file_path: "/home/me/notes.md" });
    expect(r).toEqual({ denied: false });
  });

  it("blocks Bash with rm -rf /", () => {
    const r = checkClaudeToolDenyList("Bash", { command: "rm -rf /" });
    expect(r).toMatchObject({ denied: true });
  });

  it("normalizes tool names with underscores or spaces", () => {
    const r1 = checkClaudeToolDenyList("multi_edit", { path: "/home/me/.env" });
    expect(r1).toMatchObject({ denied: true });
    const r2 = checkClaudeToolDenyList("Multi Edit", { path: "/home/me/.env" });
    expect(r2).toMatchObject({ denied: true });
  });
});

describe("registry", () => {
  it("nextApprovalId is unique per call", () => {
    const a = nextApprovalId();
    const b = nextApprovalId();
    expect(a).not.toEqual(b);
  });

  it("tryRespondClaudeCli returns false for unknown approvals", async () => {
    const ok = await tryRespondClaudeCli("nope-not-real", true);
    expect(ok).toBe(false);
  });

  it("tryRespondClaudeCli invokes ai_claude_cli_approve and clears registry", async () => {
    const id = "test-approval-id";
    registerClaudeCliApproval(id, "session-1", "tool-1");
    const mocked = invoke as unknown as ReturnType<typeof vi.fn>;
    mocked.mockClear();
    const ok = await tryRespondClaudeCli(id, true);
    expect(ok).toBe(true);
    expect(mocked).toHaveBeenCalledWith("ai_claude_cli_approve", {
      sessionId: "session-1",
      toolUseId: "tool-1",
      approved: true,
    });
    const ok2 = await tryRespondClaudeCli(id, true);
    expect(ok2).toBe(false);
  });

  it("forgetClaudeCliApproval drops the mapping", async () => {
    const id = "test-approval-forget";
    registerClaudeCliApproval(id, "s", "t");
    forgetClaudeCliApproval(id);
    const ok = await tryRespondClaudeCli(id, false);
    expect(ok).toBe(false);
  });
});
