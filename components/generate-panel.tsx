"use client";

import { useState } from "react";
import useSWR from "swr";
import { Field } from "@base-ui/react/field";
import { fetcher } from "@/lib/fetcher";

type GenerateJob = {
  id: string;
  type: string;
  status: "queued" | "running" | "completed" | "failed";
  resultJson: {
    templateName: string;
    plan: { order: string[]; sections: Record<string, { type: string; blockTypes?: string[] }> };
    warnings: string[];
    mergeSummary: {
      addedSections: string[];
      updatedSections: string[];
      removedSections: string[];
      changedSettings: string[];
    };
  } | null;
  errorMessage: string | null;
};

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

export function GeneratePanel({ orgSlug }: { orgSlug: string }) {
  const [businessType, setBusinessType] = useState("");
  const [prompt, setPrompt] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setApplyResult(null);
    setApplyError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org: orgSlug, businessType, prompt })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to start generation");
      setJobId(body.jobId);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSubmitting(false);
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
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  }

  const isBusy = job ? job.status === "queued" || job.status === "running" : false;

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Field.Root className="flex flex-col gap-1">
          <Field.Label className="text-sm font-medium">What kind of store is this?</Field.Label>
          <Field.Control
            required
            value={businessType}
            onChange={(e) => setBusinessType(e.target.value)}
            placeholder="e.g. Premium pet supplement store"
            disabled={isBusy}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
          />
        </Field.Root>

        <Field.Root className="flex flex-col gap-1">
          <Field.Label className="text-sm font-medium">Describe what you want on your homepage</Field.Label>
          <Field.Control
            render={<textarea rows={4} />}
            required
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="A warm, trustworthy hero, product highlights, customer reviews, and a newsletter signup."
            disabled={isBusy}
            className="rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
          />
        </Field.Root>

        {submitError && <p className="text-sm text-red-600">{submitError}</p>}

        <button
          type="submit"
          disabled={submitting || isBusy}
          className="self-start rounded-md bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {isBusy ? "Generating…" : "Generate homepage"}
        </button>
      </form>

      {job && (
        <div className="flex flex-col gap-3 rounded-md border border-gray-200 p-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Generation job</span>
            <StatusBadge status={job.status} />
          </div>

          {job.status === "failed" && (
            <p className="text-sm text-red-600">{job.errorMessage}</p>
          )}

          {job.status === "completed" && job.resultJson && (
            <div className="flex flex-col gap-3">
              <div>
                <p className="text-sm font-medium">Proposed sections</p>
                <ul className="mt-1 list-inside list-disc text-sm text-gray-600">
                  {job.resultJson.plan.order.map((id) => (
                    <li key={id}>{job.resultJson!.plan.sections[id]?.type ?? id}</li>
                  ))}
                </ul>
              </div>

              {job.resultJson.warnings.length > 0 && (
                <div>
                  <p className="text-sm font-medium text-amber-700">Warnings</p>
                  <ul className="mt-1 list-inside list-disc text-sm text-amber-700">
                    {job.resultJson.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

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
