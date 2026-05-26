import { describe, expect, it } from "vitest";
import { cliModelArg } from "./claudeCliTransport";

describe("cliModelArg", () => {
  it("maps the four claude-cli model ids to CLI --model args", () => {
    expect(cliModelArg("claude-cli-opus-4-7")).toBe("claude-opus-4-7");
    expect(cliModelArg("claude-cli-opus-4-7-1m")).toBe("claude-opus-4-7[1m]");
    expect(cliModelArg("claude-cli-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(cliModelArg("claude-cli-haiku-4-5")).toBe("claude-haiku-4-5");
  });

  it("returns undefined for the standard anthropic model ids", () => {
    expect(cliModelArg("claude-opus-4-7")).toBeUndefined();
    expect(cliModelArg("claude-sonnet-4-6")).toBeUndefined();
  });

  it("returns undefined for unknown ids and the empty string", () => {
    expect(cliModelArg("")).toBeUndefined();
    expect(cliModelArg(undefined)).toBeUndefined();
    expect(cliModelArg("gpt-4.1-mini")).toBeUndefined();
  });
});
