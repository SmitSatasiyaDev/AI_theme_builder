"use client";

export type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

/** The transcript bubbles shared by the generate and edit chats. */
export function ChatMessageList({ messages }: { messages: ChatMessage[] }) {
  return (
    <>
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
    </>
  );
}

/** An assistant-side "working on it" bubble with a pulsing dot and the current stage label. */
export function ThinkingBubble({ label }: { label: string }) {
  return (
    <div className="max-w-[85%] self-start rounded-md bg-gray-100 px-3 py-2 text-sm text-gray-500">
      <span className="inline-flex items-center gap-1.5">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-gray-400" />
        {label}
      </span>
    </div>
  );
}
