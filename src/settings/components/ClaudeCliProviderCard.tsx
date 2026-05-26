import { Input } from "@/components/ui/input";
import { usePreferencesStore } from "@/modules/settings/preferences";
import {
  setClaudeCliBinaryPath,
  setClaudeCliExtraAddDirs,
} from "@/modules/settings/store";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useState } from "react";
import { ProviderIcon } from "./ProviderIcon";

const DOCS_URL = "https://docs.anthropic.com/en/docs/claude-code";

function parseAddDirs(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function ClaudeCliProviderCard() {
  const binaryPath = usePreferencesStore((s) => s.claudeCliBinaryPath);
  const extraAddDirs = usePreferencesStore((s) => s.claudeCliExtraAddDirs);

  const [binaryDraft, setBinaryDraft] = useState(binaryPath);
  const [dirsDraft, setDirsDraft] = useState(extraAddDirs.join("\n"));

  useEffect(() => setBinaryDraft(binaryPath), [binaryPath]);
  useEffect(() => setDirsDraft(extraAddDirs.join("\n")), [extraAddDirs]);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-card/60 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <ProviderIcon provider="claude-cli" size={15} />
        <span className="text-[12.5px] font-medium">Claude Code (CLI)</span>
        <button
          type="button"
          onClick={() => void openUrl(DOCS_URL)}
          className="ml-auto inline-flex items-center gap-0.5 text-[10.5px] text-muted-foreground transition-colors hover:text-foreground"
        >
          Docs
          <HugeiconsIcon icon={ArrowUpRight01Icon} size={11} strokeWidth={1.75} />
        </button>
      </div>

      <span className="text-[10.5px] leading-relaxed text-muted-foreground">
        Routes Claude through the local <span className="font-mono">claude</span> binary so your
        subscription auth is reused. No API key needed.
      </span>

      <div className="mt-0.5 flex flex-col gap-2.5">
        <div className="flex items-center gap-3">
          <span className="w-20 shrink-0 text-[11px] tracking-tight text-muted-foreground">
            Binary path
          </span>
          <Input
            value={binaryDraft}
            placeholder="claude (on PATH)"
            onChange={(e) => setBinaryDraft(e.target.value)}
            onBlur={() => {
              const v = binaryDraft.trim();
              if (v !== binaryPath) void setClaudeCliBinaryPath(v);
            }}
            className="h-7 flex-1 text-[12px]"
          />
        </div>
        <div className="flex items-start gap-3">
          <span className="mt-1.5 w-20 shrink-0 text-[11px] tracking-tight text-muted-foreground">
            Extra dirs
          </span>
          <div className="flex flex-1 flex-col gap-1">
            <textarea
              value={dirsDraft}
              placeholder="One path per line. workspace_root is always added."
              onChange={(e) => setDirsDraft(e.target.value)}
              onBlur={() => {
                const next = parseAddDirs(dirsDraft);
                const same =
                  next.length === extraAddDirs.length &&
                  next.every((v, i) => v === extraAddDirs[i]);
                if (!same) void setClaudeCliExtraAddDirs(next);
              }}
              className="min-h-[60px] w-full rounded-md border border-border/60 bg-background px-2 py-1.5 text-[12px] focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
            <span className="text-[10px] leading-relaxed text-muted-foreground/80">
              Additional roots passed as <span className="font-mono">--add-dir</span> so Claude can
              read them without prompting.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
