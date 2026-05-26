import { invoke } from "@tauri-apps/api/core";
import { checkReadable, checkShellCommand, checkWritable } from "./security";

export type DenyCheck =
  | { denied: true; reason: string }
  | { denied: false };

function pathFrom(input: Record<string, unknown>): string | null {
  for (const key of ["path", "file_path", "filepath", "file"]) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function commandFrom(input: Record<string, unknown>): string | null {
  for (const key of ["command", "cmd"]) {
    const v = input[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

const READS_PATH = new Set(["read", "readfile", "view"]);
const WRITES_PATH = new Set(["write", "writefile", "edit", "multiedit", "createfile"]);
const SHELL_TOOLS = new Set(["bash", "bashrun", "run", "shell", "shellrun", "execute"]);

export function checkClaudeToolDenyList(
  toolName: string,
  input: Record<string, unknown>,
): DenyCheck {
  const n = normalize(toolName);
  const path = pathFrom(input);
  const command = commandFrom(input);

  if (READS_PATH.has(n) && path) {
    const r = checkReadable(path);
    if (!r.ok) return { denied: true, reason: r.reason };
  }
  if (WRITES_PATH.has(n) && path) {
    const w = checkWritable(path);
    if (!w.ok) return { denied: true, reason: w.reason };
    const r = checkReadable(path);
    if (!r.ok) return { denied: true, reason: r.reason };
  }
  if (SHELL_TOOLS.has(n) && command) {
    const s = checkShellCommand(command);
    if (!s.ok) return { denied: true, reason: s.reason };
  }
  return { denied: false };
}

type Pending = { sessionId: string; toolUseId: string };

const pending = new Map<string, Pending>();

export function registerClaudeCliApproval(
  approvalId: string,
  sessionId: string,
  toolUseId: string,
): void {
  pending.set(approvalId, { sessionId, toolUseId });
}

export function forgetClaudeCliApproval(approvalId: string): void {
  pending.delete(approvalId);
}

export async function tryRespondClaudeCli(
  approvalId: string,
  approved: boolean,
): Promise<boolean> {
  const entry = pending.get(approvalId);
  if (!entry) return false;
  pending.delete(approvalId);
  try {
    await invoke("ai_claude_cli_approve", {
      sessionId: entry.sessionId,
      toolUseId: entry.toolUseId,
      approved,
    });
  } catch {
    // Session may have already ended; nothing useful to do.
  }
  return true;
}

export async function approveDirectly(
  sessionId: string,
  toolUseId: string,
  approved: boolean,
): Promise<void> {
  try {
    await invoke("ai_claude_cli_approve", { sessionId, toolUseId, approved });
  } catch {
    // Ignore: session may be gone.
  }
}

let counter = 0;
export function nextApprovalId(): string {
  counter += 1;
  return `cli-approval-${Date.now().toString(36)}-${counter}`;
}
