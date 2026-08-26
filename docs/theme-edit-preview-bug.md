# Bug: "Apply to store" reports success but the wrong section gets edited

## Symptom

1. User asks the theme-edit chat to change the "Why Choose Us" section.
2. AI doesn't recognize that name, asks for clarification.
3. User replies: "In the Home page this is second section, and its after slider."
4. AI proposes an `update_section` change and says it's ready to apply.
5. User clicks **Apply to store** → "Applied — updated 1 file(s) on your live theme."
6. Preview pane still shows the old "Why Choose Us" content.

## Root cause

**Not a preview/caching bug.** The write path and the preview refresh path were traced end-to-end and are both correct:

- `Apply to store` → `app/api/edit/apply/route.ts` → `lib/ai-schema/apply.js` → `lib/ai-schema/local-theme-fs.ts` writes straight to `theme_base/theme/templates/index.json` on disk.
- `app/api/theme/preview/route.ts` reads that exact same file fresh on every request (no cache), and `theme-workspace.tsx` bumps a `refreshToken` on apply that forces the preview iframe to refetch and remount.

So when Apply says "updated 1 file(s)," the preview genuinely re-renders that file's current content — the file just doesn't contain the edit the user asked for.

**The real bug is in target resolution** (`lib/ai-schema/operations.ts` `resolveSectionTarget`, and the AI-assisted fallback in `lib/ai-schema/edit-pipeline.ts`):

- The "second section, right after the slider" on the Home template is `templates/index.json` → `order: ["hero-forced", "value-props", ...]` → **`value-props`** (an `icon-bar` section whose `settings.title` is literally `"<p>Why Choose Us</p>"`).
- The deterministic resolver in `operations.ts:171-196` matches purely on keyword overlap against each section's `id`/`type.id`/`type.label`/`type.category`/`type.tags` — it never looks at `template.raw.order` (page position) or `section.settings` (actual on-page text). The word "content" alone ties across **5 different sections** that share `category: "content"` (`brand-story`, `value-props`, `collection-tabs`, `product-collage`, `lifestyle-editorial`), so resolution is ambiguous.
- On the ambiguous/not-found path, `edit-pipeline.ts` hands the decision to the AI via `buildSectionListingAcrossTemplates` (`edit-pipeline.ts:207-221`), which lists sections in **JSON key-insertion order**, not `order`-array (render) order, and includes no section content/title/position — so the AI has no actual way to map "second section after the slider" to `value-props`.
- The clarification reply ("second section... after slider") also fails to match anything, because `slideshow`'s `tags` is empty and there's no positional signal anywhere in the candidate list the AI is shown.
- `validateTargetResolution` / `validateOperation` only check that the AI's guessed `sectionId` exists in the template — not that it's semantically or positionally the one the user described. So a wrong-but-real section (e.g. `brand-story` or another `content`-category section) is accepted, edited, and applied cleanly, producing a real diff and a real "success" message — just on the wrong section.

## Fix direction (not yet implemented)

Target resolution needs two additional signals it currently lacks:
1. **Page order** — expose `template.raw.order` (index position, "after X") to both the deterministic resolver and the AI candidate listing, instead of/alongside JSON key order.
2. **Rendered content** — expose each section's actual `settings` text (titles, headings) to the resolver/AI listing, not just its id/type/category/tags, so "Why Choose Us" can match the section whose title literally contains that string.

Without at least #2, any user referring to a section by its visible heading text (the most natural way to describe a section) will keep failing to resolve correctly, and Apply will keep silently "succeeding" against the wrong section.

## Files involved

- `components/theme-preview-panel.tsx`, `components/edit-chat-panel.tsx`, `components/theme-workspace.tsx` — chat UI, apply trigger, preview refresh trigger.
- `app/api/edit/route.ts`, `app/api/edit/apply/route.ts` — chat/apply API routes.
- `lib/ai-schema/conversational-edit.ts`, `lib/ai-schema/edit-pipeline.ts`, `lib/ai-schema/operations.ts` — target resolution + operation validation (bug is here).
- `lib/ai-schema/apply.js`, `lib/ai-schema/local-theme-fs.ts` — file write.
- `app/api/theme/preview/route.ts`, `lib/preview/template-renderer.ts` — preview read/render (confirmed correct).
- `theme_base/theme/templates/index.json` — the actual theme data; `order` array vs. `sections` key order is the source of the mismatch.
