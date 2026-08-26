import type { Liquid } from "liquidjs";
import { createShopifyLiquid } from "@/lib/shopify-compat/engine";
import { BlockInstance, buildGlobalContext, buildSectionDrop } from "@/lib/shopify-compat/drops";
import { TemplateReader } from "./template-loader";
import { applyPreviewShims } from "./preview-shims";
import { loadThemeSettings } from "./theme-settings";
import { extractSectionSchema, ShopifySettingDef } from "./section-schema";
import { ResolveContext, defaultResolveContext, resolveSettings } from "@/lib/shopify-compat/resolve-settings";
import { defaultLinkLists } from "@/lib/shopify-compat/setting-drops";
import { normalizeRenderTagArgs } from "@/lib/shopify-compat/render-args";
import type { GenerationConfig, SectionInstance } from "@/lib/ai-schema/types";

/**
 * Renders a Shopify-native template JSON — the same shape `GenerationConfig` already is
 * (lib/ai-schema/types.ts) — through the real Base Theme's layout, using LiquidJS plus the
 * shopify-compat shim layer. Ported from Shopforge's template-renderer.ts: that version also
 * threads a scraped `NormalizedProduct` through the render (Shopforge imports real product
 * data); this app has no product data source, so there is no `product` option here — the
 * theme's own `{% if product %}` guards just take the empty branch, same as any page without
 * one (see shopify-compat/drops.ts).
 */
export interface RenderTemplateOptions {
  /** The template JSON to render — a completed generation job's config, or the current on-disk state. */
  config: GenerationConfig;
  storeName: string;
  readTemplate: TemplateReader;
  /** Which Shopify template this is, so `request.page_type` and `template.name` are right. */
  templateName?: string;
}

async function readJson<T>(readTemplate: TemplateReader, path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readTemplate(path)) as T;
  } catch {
    return fallback;
  }
}

/**
 * Section render order. Falls back to key order when `order` is absent; ids in `order` with
 * no matching section are skipped rather than rendered empty, which is what makes a
 * partially-generated template still previewable.
 */
function orderedSections(config: GenerationConfig): [string, SectionInstance][] {
  const ids = config.order?.length ? config.order : Object.keys(config.sections);
  return ids
    .filter((id) => config.sections[id])
    .map((id) => [id, config.sections[id]] as [string, SectionInstance]);
}

/**
 * Template JSON keys blocks by id and orders them with `block_order`; the drop layer wants
 * an ordered list. Nested blocks (a column inside a container) recurse through the same shape.
 */
function collectBlocks(
  blocks: Record<string, unknown> | undefined,
  order: string[] | undefined,
): BlockInstance[] {
  if (!blocks) return [];
  const ids = order ?? Object.keys(blocks);
  return ids
    .filter((id) => blocks[id])
    .map((id) => {
      const block = blocks[id] as {
        type: string;
        settings?: Record<string, unknown>;
        blocks?: Record<string, unknown>;
        block_order?: string[];
      };
      return {
        id,
        type: block.type,
        settings: block.settings ?? {},
        blocks: collectBlocks(block.blocks, block.block_order),
      };
    });
}

/**
 * Resolves each block's settings against whichever schema declares them: a block type listed
 * in the section's own `{% schema %}`, or — for Online Store 2.0 theme blocks — the schema
 * inside `blocks/<type>.liquid`.
 */
async function resolveBlockSettings(
  blocks: BlockInstance[],
  sectionBlockSchemas: Map<string, ShopifySettingDef[] | undefined>,
  readTemplate: TemplateReader,
  ctx: ResolveContext,
): Promise<BlockInstance[]> {
  return Promise.all(
    blocks.map(async (block) => {
      let schema = sectionBlockSchemas.get(block.type);
      if (!schema) {
        try {
          schema = extractSectionSchema(await readTemplate(`blocks/${block.type}.liquid`))?.settings;
        } catch {
          schema = undefined;
        }
      }
      return {
        ...block,
        settings: resolveSettings(block.settings, schema, ctx),
        blocks: await resolveBlockSettings(block.blocks ?? [], sectionBlockSchemas, readTemplate, ctx),
      };
    }),
  );
}

/**
 * Renders one section instance, wrapped in a marker element (section-level identification —
 * useful for future "which section is the chat talking about" affordances, harmless today).
 */
async function renderSection(
  engine: Liquid,
  readTemplate: TemplateReader,
  id: string,
  instance: SectionInstance,
  index: number,
  globals: Record<string, unknown>,
  ctx: ResolveContext,
): Promise<string> {
  let source: string;
  try {
    source = await readTemplate(`sections/${instance.type}.liquid`);
  } catch {
    return `<!-- preview: section type "${instance.type}" is not in this theme -->`;
  }

  // The section's own {% schema %} declares each setting's type, which is what turns the raw
  // values in template JSON into Color/Image/LinkList objects the theme can read.
  const schema = extractSectionSchema(source);
  const blockSchemas = new Map((schema?.blocks ?? []).map((b) => [b.type, b.settings]));

  const section = buildSectionDrop(
    id,
    instance.type,
    resolveSettings(instance.settings, schema?.settings, ctx),
    await resolveBlockSettings(
      collectBlocks(instance.blocks, instance.block_order),
      blockSchemas,
      readTemplate,
      ctx,
    ),
    index,
  );

  let inner: string;
  try {
    // Passed as `globals`, not as the render scope. LiquidJS isolates `{% render %}` from the
    // caller's scope but propagates globals into it, and the theme's snippets read `shop`,
    // `settings`, `section` and `product` directly via `{% render %}`. Shopify's own
    // `{% render %}` behaves the same: outer *variables* are hidden, global objects are not.
    inner = await engine.parseAndRender(source, {}, { globals: { ...globals, section } });
  } catch (error) {
    // One broken section must not blank the whole page — the preview degrades to a visible
    // marker so every other section still renders.
    const message = error instanceof Error ? error.message : String(error);
    inner = `<!-- preview: "${instance.type}" failed to render: ${message.replace(/-->/g, "")} -->`;
  }

  return `<div data-preview-section-id="${id}" data-preview-section-type="${instance.type}">${inner}</div>`;
}

/** Renders a section group file (`sections/<name>.json`) — header-group / footer-group. */
async function renderSectionGroup(
  engine: Liquid,
  readTemplate: TemplateReader,
  name: string,
  globals: Record<string, unknown>,
  ctx: ResolveContext,
): Promise<string> {
  const group = await readJson<GenerationConfig | null>(readTemplate, `sections/${name}.json`, null);
  if (!group) return "";
  const parts = await Promise.all(
    orderedSections(group).map(([id, instance], i) =>
      renderSection(engine, readTemplate, id, instance, i, globals, ctx),
    ),
  );
  return parts.join("\n");
}

/**
 * Renders a Shopify-native template JSON through the real Base Theme's layout. Always a fresh
 * render — there is no partial DOM patching here (unlike Shopforge's editor, this app's
 * editing flow is chat-driven, not click-to-select, so nothing needs the finer-grained
 * incremental-swap machinery Shopforge's PreviewFrame has for inline text editing).
 */
export async function renderTemplate(opts: RenderTemplateOptions): Promise<string> {
  const { config, storeName } = opts;
  const templateName = opts.templateName ?? "index";

  // Every .liquid source — sections, snippets (via the engine's fs), and the layout — gets
  // Shopify's bare `{% render 'x', section %}` shorthand rewritten to `section: section`;
  // LiquidJS would otherwise pass `section: undefined` and shadow the global (render-args.ts).
  const readTemplate: TemplateReader = async (path) => {
    const raw = await opts.readTemplate(path);
    return path.endsWith(".liquid") ? normalizeRenderTagArgs(raw) : raw;
  };

  const [locale, settings] = await Promise.all([
    readJson<Record<string, unknown>>(readTemplate, "locales/en.default.json", {}),
    loadThemeSettings(readTemplate),
  ]);

  const engine = createShopifyLiquid({ readTemplate, locale, currency: null });

  const ctx = defaultResolveContext();
  // Theme settings are typed by config/settings_schema.json the same way section settings are
  // typed by their own {% schema %} — `settings.logo` is an image, the colour settings are
  // Color objects, `type_body_font` is a font.
  const schemaGroups = await readJson<{ settings?: ShopifySettingDef[] }[]>(
    readTemplate,
    "config/settings_schema.json",
    [],
  );
  const themeSettings = resolveSettings(
    settings,
    schemaGroups.flatMap((group) => group.settings ?? []),
    ctx,
  );

  const globals: Record<string, unknown> = {
    ...buildGlobalContext({
      storeName,
      currency: null,
      settings: themeSettings,
      locale,
    }),
    linklists: defaultLinkLists(),
  };
  (globals.request as Record<string, unknown>).page_type = templateName;
  (globals.template as Record<string, unknown>).name = templateName;

  const sections = orderedSections(config);
  const [body, headerGroup, footerGroup] = await Promise.all([
    Promise.all(
      sections.map(([id, instance], i) => renderSection(engine, readTemplate, id, instance, i, globals, ctx)),
    ).then((parts) => parts.join("\n")),
    renderSectionGroup(engine, readTemplate, "header-group", globals, ctx),
    renderSectionGroup(engine, readTemplate, "footer-group", globals, ctx),
  ]);

  const layout = await readTemplate("layout/theme.liquid");
  const page = await engine.parseAndRender(
    layout,
    {},
    {
      globals: {
        ...globals,
        content_for_layout: body,
        content_for_header_group: headerGroup,
        content_for_footer_group: footerGroup,
      },
    },
  );

  // The iframe runs the theme without its JavaScript, so anything the theme's own scripts
  // would have revealed on load has to be pinned open here.
  return applyPreviewShims(page);
}
