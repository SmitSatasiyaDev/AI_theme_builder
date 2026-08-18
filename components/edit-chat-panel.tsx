"use client";

import { useState } from "react";
import { Field } from "@base-ui/react/field";

type EditTurnResult = {
  sessionId: string;
  status: string;
  questions?: string[];
  candidates?: { sectionId?: string; blockId?: string; type: string }[];
  changeSummary?: unknown;
  changeSummaries?: unknown[];
  errors?: { message: string }[];
  message?: string;
  operation?: { operation: string };
  operations?: { operation: string }[];
  error?: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

const APPLIABLE_STATUSES = new Set(["PROPOSED", "COMPLETED"]);

function summarizeResult(result: EditTurnResult): string {
  if (result.error) return `Something went wrong: ${result.error}`;

  switch (result.status) {
    case "NEEDS_CLARIFICATION":
      return (result.questions || []).join(" ") || "Could you clarify what you'd like to change?";
    case "PROPOSED": {
      const ops = result.operations
        ? result.operations.map((o) => o.operation).join(", ")
        : result.operation?.operation;
      return `Proposed change (${ops}). Ready to apply — use "Apply to store" below when you're happy with it.`;
    }
    case "APPLIED":
      return "Applied directly to your store.";
    case "FAILED":
      return `That didn't work: ${(result.errors || []).map((e) => e.message).join("; ") || "unknown error"}`;
    case "IDLE":
      return result.message || "Okay — cleared.";
    case "INITIAL_GENERATION":
      return "That sounds like a full redesign — use the Generate tab for that instead.";
    case "TOO_MANY_OPERATIONS":
      return result.message || "That includes several changes — let's handle them one at a time.";
    default:
      return `Status: ${result.status}`;
  }
}

export function EditChatPanel({ orgSlug }: { orgSlug: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [canApply, setCanApply] = useState(false);
  const [applying, setApplying] = useState(false);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || sending) return;

    setError(null);
    setApplyMessage(null);
    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    setSending(true);

    try {
      const res = await fetch("/api/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ org: orgSlug, message: text, sessionId })
      });
      const result: EditTurnResult = await res.json();
      if (!res.ok) throw new Error(result.error || "Edit request failed");

      setSessionId(result.sessionId);
      setCanApply(APPLIABLE_STATUSES.has(result.status));
      setMessages((prev) => [...prev, { role: "assistant", text: summarizeResult(result) }]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setMessages((prev) => [...prev, { role: "assistant", text: `Error: ${message}` }]);
    } finally {
      setSending(false);
    }
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
    } catch (err) {
      setApplyMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="flex max-w-xl flex-col gap-4">
      <div className="flex min-h-[10rem] flex-col gap-3 rounded-md border border-gray-200 p-4">
        {messages.length === 0 && (
          <p className="text-sm text-gray-500">
            Describe a change, e.g. &ldquo;Change the hero heading to Healthy nutrition for every
            dog.&rdquo;
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

      <form onSubmit={handleSubmit} className="flex gap-2">
        <Field.Root className="flex-1">
          <Field.Control
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="What would you like to change?"
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
      {error && <p className="text-sm text-red-600">{error}</p>}
    </div>
  );
}
