"use client";

import { useState } from "react";
import { errorMessage } from "@/lib/errors";
import { useThinkingStage } from "./use-thinking-stage";
import { ChatInput } from "./chat-input";
import { ChatMessageList, ThinkingBubble, type ChatMessage } from "./chat-messages";

type EditTurnResult = {
  sessionId: string;
  status: string;
  questions?: string[];
  candidates?: { sectionId?: string; blockId?: string; type: string }[];
  changeSummary?: unknown;
  changeSummaries?: unknown[];
  targetSummary?: TargetSummary | null;
  targetSummaries?: TargetSummary[];
  errors?: { message: string }[];
  message?: string;
  operation?: { operation: string };
  operations?: { operation: string }[];
  error?: string;
};

type TargetSummary = {
  templateName: string;
  sectionId: string;
  sectionType?: string;
  position?: number;
  totalSections?: number;
  preview?: string;
};

const APPLIABLE_STATUSES = new Set(["PROPOSED", "COMPLETED"]);

// runOperationProposalStage (edit-pipeline.ts) has no intermediate progress events — it's one
// request/response — so this is a client-side approximation of the pipeline's real stages
// (resolve target -> pick/propose a section op -> validate against the schema), cycled on a
// timer purely so the chat doesn't sit blank while the request is in flight.
const THINKING_STAGES = ["Reading your theme…", "Deciding on a section…", "Generating the change…", "Checking it fits…"];

// Surfaces edit-pipeline.ts's existing add_section operation, which most merchants have no way
// to know exists — nothing in the chat hints that "add a section" is a supported request. A
// small, fixed set by default rather than a dynamic catalog listing: enough to make the
// capability discoverable without turning the chat into a full section picker up front. The rest
// of the catalog (allowed_on index/product, so it's visible on the Home/Product preview tabs) is
// one click away via "+ More sections" for merchants who want to browse everything.
const ADD_SECTION_SUGGESTIONS: SectionSuggestion[] = [
  { label: "+ Testimonials", message: "Add a customer testimonials section" },
  { label: "+ Newsletter signup", message: "Add a newsletter signup section" },
  { label: "+ Featured products", message: "Add a featured collection section" },
  { label: "+ Comparison table", message: "Add a comparison table section" }
];

// Excludes: footer / main-product (structural singletons, not merchant-addable extras),
// custom-columns (superseded by custom-columns-new), and contact-form / track-order /
// email-signup-banner (allowed only on page/password templates, which the preview doesn't show).
const MORE_SECTION_SUGGESTIONS: SectionSuggestion[] = [
  { label: "+ Slideshow", message: "Add a slideshow section" },
  { label: "+ Image with text", message: "Add an image with text section" },
  { label: "+ Image/video slider", message: "Add an image/video slider section" },
  { label: "+ Collage", message: "Add a collage section" },
  { label: "+ Rich text", message: "Add a rich text section" },
  { label: "+ Content tabs", message: "Add a content tabs section" },
  { label: "+ Collapsible content", message: "Add a collapsible content section" },
  { label: "+ Custom columns", message: "Add a custom columns section" },
  { label: "+ Icon bar", message: "Add an icon bar section" },
  { label: "+ Section divider", message: "Add a section divider" },
  { label: "+ Facebook testimonials", message: "Add a Facebook testimonials section" },
  { label: "+ Results", message: "Add a results section" },
  { label: "+ Horizontal ticker", message: "Add a horizontal ticker section" },
  { label: "+ Vertical ticker", message: "Add a vertical ticker section" },
  { label: "+ Related products", message: "Add a related products section", onlyOn: "product" },
  { label: "+ Shoppable image", message: "Add a shoppable image section", onlyOn: "product" },
  { label: "+ Store colors changer", message: "Add a store colors changer section" }
];

// Names WHICH section a proposal actually resolved to (position on the page
// + its current visible text) so a wrong target-resolution guess is
// something the merchant can catch here, before "Apply to store" — rather
// than only discoverable afterwards by comparing the live preview.
function describeTarget(target: TargetSummary): string {
  const templateLabel = target.templateName === "index" ? "Home" : target.templateName;
  const positionLabel = target.position && target.totalSections
    ? `, section ${target.position} of ${target.totalSections} on ${templateLabel}`
    : `, on ${templateLabel}`;
  const typeLabel = target.sectionType ? ` (${target.sectionType})` : "";
  const previewLabel = target.preview ? ` — currently shows: "${target.preview}"` : "";
  return `"${target.sectionId}"${typeLabel}${positionLabel}${previewLabel}`;
}

function summarizeResult(result: EditTurnResult): string {
  if (result.error) return `Something went wrong: ${result.error}`;

  switch (result.status) {
    case "NEEDS_CLARIFICATION":
      return (result.questions || []).join(" ") || "Could you clarify what you'd like to change?";
    case "PROPOSED": {
      const ops = result.operations
        ? result.operations.map((o) => o.operation).join(", ")
        : result.operation?.operation;
      const targets = result.targetSummaries && result.targetSummaries.length > 0
        ? result.targetSummaries
        : result.targetSummary
          ? [result.targetSummary]
          : [];
      const targetText = targets.length > 0 ? ` to ${targets.map(describeTarget).join("; ")}` : "";
      return `Proposed change (${ops})${targetText}. Ready to apply — use "Apply to store" below when you're happy with it.`;
    }
    case "APPLIED":
      return "Applied directly to your store.";
    case "FAILED":
      return `That didn't work: ${(result.errors || []).map((e) => e.message).join("; ") || "unknown error"}`;
    case "IDLE":
      return result.message || "Okay — cleared.";
    case "INITIAL_GENERATION":
      return "That sounds like a full redesign — switching over to build it fresh…";
    case "TOO_MANY_OPERATIONS":
      return result.message || "That includes several changes — let's handle them one at a time.";
    default:
      return `Status: ${result.status}`;
  }
}

type SectionSuggestion = { label: string; message: string; onlyOn?: string };

function SuggestionButton({
  suggestion,
  disabled,
  onPick,
}: {
  suggestion: SectionSuggestion;
  disabled: boolean;
  onPick: (message: string) => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(suggestion.message)}
      className="rounded-full border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50"
    >
      {suggestion.label}
    </button>
  );
}

interface EditChatPanelProps {
  orgSlug: string;
  /** Which preview tab ("index"/"product") is active — sent as the edit's default target template, so "add a section" et al. land on the page the merchant is actually looking at. */
  templateName: string;
  /** Fired once "Apply to store" succeeds, so the parent workspace refreshes the live preview. */
  onApplied?: () => void;
  /** Fired when the edit backend classifies a message as a full redesign request, not a targeted edit — the parent workspace switches to the generate chat, carrying the message over. */
  onRequestFullGeneration?: (message: string) => void;
}

export function EditChatPanel({ orgSlug, templateName, onApplied, onRequestFullGeneration }: EditChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [canApply, setCanApply] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showMoreSections, setShowMoreSections] = useState(false);
  const [thinkingStage, resetThinkingStage] = useThinkingStage(sending, THINKING_STAGES.length);

  async function submitMessage(text: string) {
    if (!text || sending) return;

    setError(null);
    setApplyMessage(null);
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    resetThinkingStage();
    setSending(true);

    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org: orgSlug, message: text, sessionId, templateName })
      });
      const result: EditTurnResult = await res.json();
      if (!res.ok) throw new Error(result.error || "Edit request failed");

      setSessionId(result.sessionId);
      setCanApply(APPLIABLE_STATUSES.has(result.status));
      setMessages((prev) => [...prev, { role: "assistant", text: summarizeResult(result) }]);
      if (result.status === "INITIAL_GENERATION") {
        onRequestFullGeneration?.(text);
      }
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      setMessages((prev) => [...prev, { role: "assistant", text: `Error: ${message}` }]);
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    submitMessage(input.trim());
  }

  async function handleApply() {
    if (!sessionId) return;
    setApplying(true);
    setApplyMessage(null);
    try {
      const res = await fetch("/api/edit/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org: orgSlug, sessionId })
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || "Failed to apply");
      setApplyMessage(`Applied — updated ${body.filesWritten?.length ?? 0} file(s) on your live theme.`);
      setCanApply(false);
      onApplied?.();
    } catch (err) {
      setApplyMessage(`Error: ${errorMessage(err)}`);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div className="flex min-h-40 flex-col gap-3 rounded-md border border-gray-200 p-4">
        {messages.length === 0 && (
          <p className="text-sm text-gray-500">
            Describe a change, e.g. &ldquo;Change the hero heading to Healthy nutrition for every
            dog.&rdquo;
          </p>
        )}
        <ChatMessageList messages={messages} />
        {sending && <ThinkingBubble label={THINKING_STAGES[thinkingStage]} />}
      </div>

      {canApply && (
        <button
          type="button"
          onClick={handleApply}
          disabled={applying}
          className="self-start rounded-md bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {applying ? "Applying…" : "Apply to store"}
        </button>
      )}
      {applyMessage && <p className="text-sm text-gray-600">{applyMessage}</p>}

      <div className="flex flex-wrap gap-1.5">
        {ADD_SECTION_SUGGESTIONS.map((suggestion) => (
          <SuggestionButton key={suggestion.label} suggestion={suggestion} disabled={sending} onPick={submitMessage} />
        ))}
        {showMoreSections &&
          MORE_SECTION_SUGGESTIONS.filter((s) => !s.onlyOn || s.onlyOn === templateName).map((suggestion) => (
            <SuggestionButton key={suggestion.label} suggestion={suggestion} disabled={sending} onPick={submitMessage} />
          ))}
        <button
          type="button"
          onClick={() => setShowMoreSections((v) => !v)}
          className="rounded-full border border-dashed border-gray-300 px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-100"
        >
          {showMoreSections ? "Show fewer sections" : "+ More sections"}
        </button>
      </div>

      <ChatInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        placeholder="What would you like to change?"
        disabled={sending}
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
