"use client";

/**
 * Static preview iframe — renders whatever HTML string it's given via `srcDoc`. Unlike
 * Shopforge's PreviewFrame (which supports click-to-select and in-place DOM patching for its
 * inline editor), this app's editing is chat-driven, not click-driven, so a full remount per
 * update is all that's needed: no section-level diffing, no selection state.
 */
export function PreviewFrame({ html }: { html: string | null }) {
  if (!html) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-50 text-sm text-gray-400">
        Nothing to preview yet
      </div>
    );
  }
  return (
    <iframe
      srcDoc={html}
      title="Store preview"
      sandbox="allow-same-origin"
      className="h-full w-full border-0 bg-white"
    />
  );
}
