"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { Field } from "@base-ui/react/field";
import { fetcher } from "@/lib/fetcher";
import type { PreviewConfigByTemplate } from "./theme-preview-panel";

type GenerationConfig = { sections: Record<string, unknown>; order: string[] };

type TemplateResult = {
  plan: { order: string[]; sections: Record<string, { type: string; blockTypes?: string[] }> };
  config: GenerationConfig;
  warnings: string[];
};

const TEMPLATE_LABELS: Record<string, string> = { index: "Home", product: "Product" };

type GenerateJob = {
  id: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed";
  resultJson: {
    // Both templates always generate together — see scripts/worker.ts.
    templates: { index: TemplateResult; product: TemplateResult };
    mergeSummary: {
      addedSections: string[];
      updatedSections: string[];
      removedSections: string[];
      changedSettings: string[];
    };
  } | null;
  errorMessage: string | null;
};

type IntakeTurnResult = {
  status: "NEEDS_INFO" | "GENERATING";
  sessionId: string;
  question?: string;
  jobId?: string;
  error?: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

// Neither turn has real intermediate progress events — the intake POST is one request/response,
// and the job's own status only ever moves queued -> running -> completed/failed with no
// sub-stage field. Both of these are client-side approximations, cycled on a timer purely so the
// chat doesn't sit blank/static while work is happening.
const INTAKE_THINKING_STAGES = ["Reading your answer…", "Thinking it through…"];
const JOB_THINKING_STAGES = ["Deciding on sections…", "Generating section content…", "Assembling your homepage…"];
const THINKING_STAGE_INTERVAL_MS = 1400;

function useThinkingStage(active: boolean, stageCount: number): [number, () => void] {
  const [stage, setStage] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (active) {
      timer.current = setInterval(() => setStage((i) => (i + 1) % stageCount), THINKING_STAGE_INTERVAL_MS);
    } else if (timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return [stage, () => setStage(0)];
}

function StatusBadge({ status }: { status: GenerateJob["status"] }) {
  const styles: Record<GenerateJob["status"], string> = {
    queued: "bg-gray-100 text-gray-700",
    running: "bg-blue-100 text-blue-700",
    completed: "bg-green-100 text-green-700",
    failed: "bg-red-100 text-red-700"
  };
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[status]}`}>
      {status}
    </span>
  );
}

interface GenerateChatPanelProps {
  orgSlug: string;
  /** Fired once a job's `config`s are available — the parent workspace previews them. */
  onResultConfig?: (config: PreviewConfigByTemplate) => void;
  /** Fired once "Apply to store" succeeds, so the parent workspace refreshes the live preview. */
  onApplied?: () => void;
  /** Prefills the input — used when the edit chat hands off a "build me a whole new X" request here. */
  initialMessage?: string;
  /**
   * Resumes an existing job instead of starting a fresh chat — e.g. a job that finished (or is
   * still running) from before a page refresh, which otherwise becomes invisible: the chat
   * transcript and jobId only ever lived in this component's state, never persisted, so a
   * refresh mid-generation (or before clicking "Apply to store") stranded the completed job
   * with no way back to it. Seeding jobId here re-attaches the SWR poll/job-status panel
   * immediately, skipping the intake form.
   */
  initialJobId?: string;
}

export function GenerateChatPanel({
  orgSlug,
  onResultConfig,
  onApplied,
  initialMessage,
  initialJobId
}: GenerateChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState(initialMessage ?? "");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [jobId, setJobId] = useState<string | null>(initialJobId ?? null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ applied: boolean; filesWritten: string[] } | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const { data: job } = useSWR<GenerateJob>(
    jobId ? `/api/generate/${jobId}` : null,
    fetcher,
    {
      refreshInterval: (latest) =>
        latest && (latest.status === "completed" || latest.status === "failed") ? 0 : 2000
    }
  );

  const [intakeStage, resetIntakeStage] = useThinkingStage(sending, INTAKE_THINKING_STAGES.length);
  const jobRunning = job?.status === "queued" || job?.status === "running";
  const [jobStage] = useThinkingStage(jobRunning, JOB_THINKING_STAGES.length);

  useEffect(() => {
    if (job?.status === "completed" && job.resultJson?.templates) {
      const { index, product } = job.resultJson.templates;
      onResultConfig?.({ index: index.config, product: product.config });
    }
    // job is a fresh SWR-fetched object each poll, so this only actually reruns the callback
    // when the job's own identity/content changes, not on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    setError(null);
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    resetIntakeStage();
    setSending(true);

    try {
      const res = await fetch("/api/generate/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org: orgSlug, message: text, sessionId })
      });
      const result: IntakeTurnResult = await res.json();
      if (!res.ok) throw new Error(result.error || "Request failed");

      setSessionId(result.sessionId);
      if (result.status === "GENERATING") {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: "Got it — generating your homepage now…" }
        ]);
        setJobId(result.jobId!);
      } else {
        setMessages((prev) => [
          ...prev,
          { role: "assistant", text: result.question || "Could you tell me a bit more?" }
        ]);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setMessages((prev) => [...prev, { role: "assistant", text: `Error: ${message}` }]);
    } finally {
      setSending(false);
    }
  }

  async function handleApply() {
    if (!jobId) return;
    setApplying(true);
    setApplyError(null);
    try {
      const res = await fetch("/api/theme/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to apply theme");
      setApplyResult(body);
      onApplied?.();
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div className="flex min-h-40 flex-col gap-3 rounded-md border border-gray-200 p-4">
        {messages.length === 0 && jobId && (
          <p className="text-sm text-gray-500">
            Resumed your in-progress generation — the chat transcript from before isn&rsquo;t
            saved, but the job below picked up right where it left off.
          </p>
        )}
        {messages.length === 0 && !jobId && (
          <p className="text-sm text-gray-500">
            Tell me about your store — e.g. &ldquo;A premium pet supplement brand for new dog
            owners.&rdquo; I&rsquo;ll ask a couple of questions, then build your homepage.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`max-w-[85%] rounded-md px-3 py-2 text-sm ${
              m.role === "user" ? "self-end bg-black text-white" : "self-start bg-gray-100 text-gray-800"
            }`}
          >
            {m.text}
          </div>
        ))}
        {sending && (
          <div className="max-w-[85%] self-start rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-gray-400" />
              {INTAKE_THINKING_STAGES[intakeStage]}
            </span>
          </div>
        )}
        {jobRunning && (
          <div className="max-w-[85%] self-start rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-500">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-gray-400" />
              {JOB_THINKING_STAGES[jobStage]}
            </span>
          </div>
        )}
      </div>

      {!jobId && (
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Field.Root className="flex-1">
            <Field.Control
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Describe your store…"
              disabled={sending}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
            />
          </Field.Root>
          <button
            type="submit"
            disabled={sending || !input.trim()}
            className="rounded-md bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
          >
            Send
          </button>
        </form>
      )}
      {error && <p className="text-sm text-red-600">{error}</p>}

      {job && (
        <div className="flex flex-col gap-3 rounded-md border border-gray-200 p-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Generation job</span>
            <StatusBadge status={job.status} />
          </div>

          {job.status === "failed" && <p className="text-sm text-red-600">{job.errorMessage}</p>}

          {job.status === "completed" && job.resultJson && (
            <div className="flex flex-col gap-3">
              {(["index", "product"] as const).map((templateName) => {
                // Optional chaining, not a bare index: a job completed before this app
                // generated both templates has an old-shaped resultJson with no `templates`
                // key at all, and would otherwise throw here instead of just showing nothing.
                const result = job.resultJson!.templates?.[templateName];
                if (!result) return null;
                return (
                  <div key={templateName}>
                    <p className="text-sm font-medium">{TEMPLATE_LABELS[templateName]} — proposed sections</p>
                    <ul className="mt-1 list-inside list-disc text-sm text-gray-600">
                      {result.plan.order.map((id) => (
                        <li key={id}>{result.plan.sections[id]?.type ?? id}</li>
                      ))}
                    </ul>
                    {result.warnings.length > 0 && (
                      <ul className="mt-1 list-inside list-disc text-sm text-amber-700">
                        {result.warnings.map((w, i) => (
                          <li key={i}>{w}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                );
              })}

              {!applyResult && (
                <button
                  type="button"
                  onClick={handleApply}
                  disabled={applying}
                  className="self-start rounded-md bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
                >
                  {applying ? "Applying…" : "Apply to store"}
                </button>
              )}

              {applyError && <p className="text-sm text-red-600">{applyError}</p>}

              {applyResult && (
                <p className="text-sm text-green-700">
                  Applied — updated {applyResult.filesWritten.length} file(s) on your live theme.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
