"use client";

import useSWR from "swr";
import { errorMessage } from "@/lib/errors";
import { PreviewFrame } from "./preview-frame";

/** The template JSON shape the preview renders — client-side mirror of lib/ai-schema GenerationConfig. */
export type GenerationConfig = { sections: Record<string, unknown>; order: string[] };
export type PreviewConfigByTemplate = Partial<Record<string, GenerationConfig>>;

interface ThemePreviewPanelProps {
  orgSlug: string;
  /** Keyed by template name ("index"/"product") — a just-completed generation job's proposed result for whichever tab is active. Both templates generate together (see scripts/worker.ts), so this can carry a candidate for either or both. */
  previewConfig?: PreviewConfigByTemplate | null;
  /** Bump to force a refetch — used after "Apply to store" succeeds, once the on-disk state has changed. */
  refreshToken?: number;
  /** Which template tab is showing ("index"/"product") — lifted to the parent so the edit chat can target whichever page the merchant is actually looking at instead of always defaulting to "index". */
  activeTemplate: string;
  onActiveTemplateChange: (templateName: string) => void;
}

const TABS: { key: string; label: string }[] = [
  { key: "index", label: "Home" },
  { key: "product", label: "Product" }
];

type PreviewKey = [string, string, string, GenerationConfig | null, number];

async function fetchPreview([, orgSlug, templateName, previewConfig]: PreviewKey): Promise<{ html: string | null }> {
  const res = previewConfig
    ? await fetch("/api/theme/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org: orgSlug, templateName, config: previewConfig })
      })
    : await fetch(
        `/api/theme/preview?org=${encodeURIComponent(orgSlug)}&template=${encodeURIComponent(templateName)}`
      );
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Failed to render preview");
  return body;
}

/**
 * Fetches rendered HTML from /api/theme/preview and displays it, with a Home/Product tab
 * switcher. Renders the tab's explicit candidate from previewConfig when one exists — the
 * common case right after a generation job completes, before the merchant applies it —
 * otherwise renders whatever is currently on disk for the selected tab's template.
 */
export function ThemePreviewPanel({
  orgSlug,
  previewConfig = null,
  refreshToken = 0,
  activeTemplate,
  onActiveTemplateChange
}: ThemePreviewPanelProps) {
  const effectiveConfig = previewConfig?.[activeTemplate] ?? null;

  const { data, error, isLoading } = useSWR<{ html: string | null }>(
    ["theme-preview", orgSlug, activeTemplate, effectiveConfig, refreshToken],
    fetchPreview
  );

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-md border border-gray-200">
      <div className="flex items-center justify-between border-b border-gray-200 bg-gray-50 px-2 py-1.5 text-xs text-gray-500">
        <div className="flex items-center gap-1">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => onActiveTemplateChange(tab.key)}
              className={`rounded px-2.5 py-1 font-medium ${
                activeTemplate === tab.key ? "bg-black text-white" : "text-gray-600 hover:bg-gray-200"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 pr-1">
          <span>{effectiveConfig ? "Preview — not yet applied" : "Preview — current store"}</span>
          {isLoading && <span>Rendering…</span>}
        </div>
      </div>
      {error ? (
        <div className="flex-1 overflow-auto p-4 text-sm text-red-600">
          {errorMessage(error)}
        </div>
      ) : (
        <div className="flex-1 overflow-hidden">
          <PreviewFrame html={data?.html ?? null} />
        </div>
      )}
    </div>
  );
}
