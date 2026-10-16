import type { TemplateReader } from "./template-loader";

// The preview reads each section's own `{% schema %}` block — the real Shopify schema that
// ships inside the .liquid file — to know how to resolve its settings for rendering (see
// shopify-compat/resolve-settings.ts). Ported verbatim from the Shopforge preview renderer.

export interface ShopifySettingDef {
  id?: string;
  type: string;
  label?: string;
  default?: unknown;
  info?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  placeholder?: string;
}

export interface ShopifySectionSchema {
  name?: string;
  tag?: string;
  class?: string;
  limit?: number;
  settings: ShopifySettingDef[];
  blocks?: { type: string; name?: string; settings?: ShopifySettingDef[] }[];
  presets?: unknown[];
}

const SCHEMA_BLOCK = /{%-?\s*schema\s*-?%}([\s\S]*?){%-?\s*endschema\s*-?%}/;

/** Setting types that are labels/dividers in the Inspector rather than editable fields. */
export const PRESENTATIONAL_TYPES = new Set(["header", "paragraph"]);

export function extractSectionSchema(source: string): ShopifySectionSchema | null {
  const match = source.match(SCHEMA_BLOCK);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Partial<ShopifySectionSchema>;
    return { ...parsed, settings: parsed.settings ?? [] };
  } catch {
    // A section whose schema block is not valid JSON is still renderable — it just cannot
    // be inspected, so the panel shows nothing rather than the whole editor failing.
    return null;
  }
}

const cache = new Map<string, Promise<ShopifySectionSchema | null>>();

export function loadSectionSchema(
  readTemplate: TemplateReader,
  sectionType: string,
): Promise<ShopifySectionSchema | null> {
  let entry = cache.get(sectionType);
  if (!entry) {
    entry = readTemplate(`sections/${sectionType}.liquid`)
      .then(extractSectionSchema)
      .catch(() => null);
    cache.set(sectionType, entry);
  }
  return entry;
}

const blockCache = new Map<string, Promise<ShopifySectionSchema | null>>();

/** Schema of an Online Store 2.0 theme block (`blocks/<type>.liquid`) — same `{% schema %}` format. */
export function loadBlockSchema(
  readTemplate: TemplateReader,
  blockType: string,
): Promise<ShopifySectionSchema | null> {
  let entry = blockCache.get(blockType);
  if (!entry) {
    entry = readTemplate(`blocks/${blockType}.liquid`)
      .then(extractSectionSchema)
      .catch(() => null);
    blockCache.set(blockType, entry);
  }
  return entry;
}

/**
 * Shopify localises schema labels with `t:` keys pointing into the theme's locale files.
 * Resolves them where it can and otherwise shows the trailing segment, which is far more
 * readable than the raw key.
 */
export function resolveSchemaLabel(
  label: string | undefined,
  schemaLocale: Record<string, unknown>,
): string {
  if (!label) return "";
  if (!label.startsWith("t:")) return label;
  const path = label.slice(2);
  const value = path.split(".").reduce<unknown>((node, segment) => {
    if (node && typeof node === "object") return (node as Record<string, unknown>)[segment];
    return undefined;
  }, schemaLocale);
  if (typeof value === "string") return value;
  const tail = path.split(".").pop() ?? path;
  return tail.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}
