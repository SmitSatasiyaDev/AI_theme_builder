"use client";

import { Field } from "@base-ui/react/field";

interface ChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  placeholder: string;
  disabled: boolean;
}

/** Single-line chat composer with a Send button, shared by the generate and edit chats. */
export function ChatInput({ value, onChange, onSubmit, placeholder, disabled }: ChatInputProps) {
  return (
    <form onSubmit={onSubmit} className="flex gap-2">
      <Field.Root className="flex-1">
        <Field.Control
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          disabled={disabled}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50"
        />
      </Field.Root>
      <button
        type="submit"
        disabled={disabled || !value.trim()}
        className="rounded-md bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
      >
        Send
      </button>
    </form>
  );
}
