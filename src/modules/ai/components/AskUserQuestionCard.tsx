import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/modules/ai/store/chatStore";
import {
  CheckmarkCircle02Icon,
  HelpCircleIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { invoke } from "@tauri-apps/api/core";
import { memo, useMemo, useState } from "react";

type Option = {
  label: string;
  description?: string;
  preview?: string;
};

type Question = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Option[];
};

type Props = {
  toolUseId: string;
  input: Record<string, unknown>;
  /** When set, the user already responded — render answers read-only. */
  output?: unknown;
};

function parseQuestions(input: Record<string, unknown>): Question[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  const out: Question[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const q = r as Record<string, unknown>;
    const question = typeof q.question === "string" ? q.question : "";
    if (!question) continue;
    const header = typeof q.header === "string" ? q.header : undefined;
    const multiSelect = q.multiSelect === true;
    const optsRaw = Array.isArray(q.options) ? q.options : [];
    const options: Option[] = [];
    for (const o of optsRaw) {
      if (!o || typeof o !== "object") continue;
      const op = o as Record<string, unknown>;
      const label = typeof op.label === "string" ? op.label : null;
      if (!label) continue;
      options.push({
        label,
        description:
          typeof op.description === "string" ? op.description : undefined,
        preview: typeof op.preview === "string" ? op.preview : undefined,
      });
    }
    if (options.length === 0) continue;
    out.push({ question, header, multiSelect, options });
  }
  return out;
}

function parseSubmittedAnswers(
  output: unknown,
): Record<string, string | string[]> | null {
  if (output === null || output === undefined) return null;
  let parsed: unknown = output;
  if (typeof output === "string") {
    try {
      parsed = JSON.parse(output);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  const answers = p.answers && typeof p.answers === "object" ? p.answers : null;
  if (!answers) return null;
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(answers)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out[k] = v as string[];
    }
  }
  return out;
}

function AskUserQuestionCardImpl({ toolUseId, input, output }: Props) {
  const sessionId = useChatStore((s) => s.activeSessionId);
  const questions = useMemo(() => parseQuestions(input), [input]);
  const submitted = useMemo(() => parseSubmittedAnswers(output), [output]);
  const [selections, setSelections] = useState<
    Record<string, string | string[] | undefined>
  >({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState<Record<string, string>>({});

  if (questions.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-[12px] text-muted-foreground">
        AskUserQuestion: malformed input
      </div>
    );
  }

  const isAnswered = submitted !== null;

  const toggle = (q: Question, value: string) => {
    if (q.multiSelect) {
      setSelections((s) => {
        const cur = Array.isArray(s[q.question]) ? (s[q.question] as string[]) : [];
        const next = cur.includes(value)
          ? cur.filter((v) => v !== value)
          : [...cur, value];
        return { ...s, [q.question]: next };
      });
    } else {
      setSelections((s) => ({ ...s, [q.question]: value }));
    }
  };

  const allAnswered = questions.every((q) => {
    const v = selections[q.question];
    if (q.multiSelect) return Array.isArray(v) && v.length > 0;
    return typeof v === "string" && v.length > 0;
  });

  const submit = async () => {
    if (!sessionId || submitting || !allAnswered) return;
    setSubmitting(true);
    setError(null);
    const answers: Record<string, string | string[]> = {};
    for (const q of questions) {
      const sel = selections[q.question];
      if (sel == null) continue;
      answers[q.question] = sel;
    }
    const payload = JSON.stringify({ answers });
    try {
      await invoke("ai_claude_cli_tool_result", {
        sessionId,
        toolUseId,
        content: payload,
        isError: false,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <HugeiconsIcon
          icon={isAnswered ? CheckmarkCircle02Icon : HelpCircleIcon}
          size={13}
          strokeWidth={1.75}
          className={cn(
            "shrink-0",
            isAnswered
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-amber-500",
          )}
        />
        <span className="text-[12px] font-medium text-foreground">
          {isAnswered ? "Answered" : "Claude is asking"}
        </span>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {questions.length} question{questions.length === 1 ? "" : "s"}
        </span>
      </div>

      <div className="divide-y divide-border/40">
        {questions.map((q) => {
          const answeredValue = submitted?.[q.question];
          const sel = selections[q.question];
          return (
            <div key={q.question} className="px-3 py-2.5 space-y-2">
              {q.header ? (
                <div className="inline-flex rounded bg-muted/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                  {q.header}
                </div>
              ) : null}
              <div className="text-[12.5px] text-foreground">{q.question}</div>
              <div className="grid gap-1.5">
                {q.options.map((o) => {
                  const isPicked = q.multiSelect
                    ? Array.isArray(sel) && sel.includes(o.label)
                    : sel === o.label;
                  const isAnsweredHere = q.multiSelect
                    ? Array.isArray(answeredValue) &&
                      answeredValue.includes(o.label)
                    : answeredValue === o.label;
                  const showAsActive = isAnswered ? isAnsweredHere : isPicked;
                  return (
                    <button
                      key={o.label}
                      type="button"
                      disabled={isAnswered || submitting}
                      onClick={() => toggle(q, o.label)}
                      className={cn(
                        "group flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors",
                        showAsActive
                          ? "border-foreground/50 bg-accent/50"
                          : "border-border/60 hover:border-border hover:bg-muted/40",
                        (isAnswered || submitting) && "cursor-default",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border",
                          showAsActive
                            ? "border-foreground/70 bg-foreground/80"
                            : "border-muted-foreground/40",
                        )}
                      >
                        {showAsActive ? (
                          <HugeiconsIcon
                            icon={Tick02Icon}
                            size={9}
                            strokeWidth={3}
                            className="text-background"
                          />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="text-[12px] font-medium text-foreground">
                          {o.label}
                        </span>
                        {o.description ? (
                          <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                            {o.description}
                          </span>
                        ) : null}
                        {o.preview ? (
                          <pre className="mt-1 overflow-auto rounded bg-muted/40 p-2 font-mono text-[10.5px] leading-snug text-foreground/90 whitespace-pre-wrap">
                            {o.preview}
                          </pre>
                        ) : null}
                      </span>
                    </button>
                  );
                })}
              </div>
              {!isAnswered ? (
                <div>
                  <input
                    type="text"
                    value={custom[q.question] ?? ""}
                    placeholder="Or type your own answer…"
                    onChange={(e) =>
                      setCustom((c) => ({ ...c, [q.question]: e.target.value }))
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        const v = (custom[q.question] ?? "").trim();
                        if (!v) return;
                        if (q.multiSelect) {
                          setSelections((s) => {
                            const cur = Array.isArray(s[q.question])
                              ? (s[q.question] as string[])
                              : [];
                            return {
                              ...s,
                              [q.question]: cur.includes(v) ? cur : [...cur, v],
                            };
                          });
                        } else {
                          setSelections((s) => ({ ...s, [q.question]: v }));
                        }
                        setCustom((c) => ({ ...c, [q.question]: "" }));
                      }
                    }}
                    className="mt-1 h-7 w-full rounded-md border border-border bg-background px-2 text-[11.5px] outline-none focus:border-foreground/40"
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      {!isAnswered ? (
        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
          <span className="text-[10.5px] text-muted-foreground">
            {error ? (
              <span className="text-destructive">{error}</span>
            ) : (
              "Claude is waiting on your answer."
            )}
          </span>
          <Button
            size="sm"
            onClick={() => void submit()}
            disabled={submitting || !allAnswered}
            className="h-7 gap-1.5 text-[11px]"
          >
            <HugeiconsIcon icon={Tick02Icon} size={12} strokeWidth={2} />
            {submitting ? "Sending…" : "Submit"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export const AskUserQuestionCard = memo(AskUserQuestionCardImpl);
