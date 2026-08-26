"use client";

import { useState } from "react";
import { GenerateChatPanel } from "./generate-chat-panel";
import { EditChatPanel } from "./edit-chat-panel";
import { ThemePreviewPanel, type PreviewConfigByTemplate } from "./theme-preview-panel";

export interface PendingJob {
  id: string;
  // Keyed by template name ("index"/"product") — both generate together, see scripts/worker.ts.
  config: PreviewConfigByTemplate | null;
}

/**
 * Single two-pane workspace for both the initial generation and every edit after it: live
 * preview on the left, one chat on the right whose flavor depends on whether a theme already
 * exists. There used to be separate Generate/Edit sidebar pages — merged because once a
 * merchant has generated a homepage, every further interaction is naturally "update this",
 * not a different tool, and the two chat backends already hand off to each other:
 *   - after a fresh generation is applied, mode flips to "edit" — no more starting from scratch
 *   - if the edit chat classifies a message as a full redesign, mode flips back to "generate"
 *     (lib/ai-schema/edit-pipeline.ts's INITIAL_GENERATION classification), carrying the
 *     merchant's message over so they don't have to retype it
 *
 * pendingJob: the page (server component) looks up the most recent generation job for this
 * store and passes it here when it's an unapplied/in-progress "initial_generation" — otherwise
 * a page refresh strands that job (the chat's jobId only ever lived in component state) with
 * no way to see or apply it. When present, opens straight into the resumed job instead of a
 * fresh intake conversation.
 */
export function ThemeWorkspace({
  orgSlug,
  hasTheme,
  pendingJob
}: {
  orgSlug: string;
  hasTheme: boolean;
  pendingJob?: PendingJob | null;
}) {
  const [mode, setMode] = useState<"generate" | "edit">(pendingJob || !hasTheme ? "generate" : "edit");
  const [previewConfig, setPreviewConfig] = useState<PreviewConfigByTemplate | null>(pendingJob?.config ?? null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [handoffMessage, setHandoffMessage] = useState<string | undefined>(undefined);
  // Which preview tab ("index"/"product") is showing — shared with the edit chat so it targets
  // whichever page the merchant is actually looking at, instead of always defaulting to "index".
  const [activeTemplate, setActiveTemplate] = useState("index");

  return (
    <div className="flex h-[calc(100vh-10rem)] min-h-128 gap-4">
      <div className="min-w-0 flex-1">
        <ThemePreviewPanel
          orgSlug={orgSlug}
          previewConfig={previewConfig}
          refreshToken={refreshToken}
          activeTemplate={activeTemplate}
          onActiveTemplateChange={setActiveTemplate}
        />
      </div>
      <div className="w-96 shrink-0 overflow-y-auto">
        {mode === "generate" ? (
          <GenerateChatPanel
            orgSlug={orgSlug}
            initialMessage={handoffMessage}
            initialJobId={pendingJob?.id}
            onResultConfig={setPreviewConfig}
            onApplied={() => {
              // The applied config now matches disk — drop the "not yet applied" candidate,
              // let the panel re-fetch current state, and switch to editing from here on.
              setPreviewConfig(null);
              setRefreshToken((n) => n + 1);
              setMode("edit");
            }}
          />
        ) : (
          <EditChatPanel
            orgSlug={orgSlug}
            templateName={activeTemplate}
            onApplied={() => setRefreshToken((n) => n + 1)}
            onRequestFullGeneration={(message) => {
              setHandoffMessage(message);
              setMode("generate");
            }}
          />
        )}
      </div>
    </div>
  );
}
