import { ShopifySettingDef } from "@/lib/preview/section-schema";
import { ColorDrop, FontDrop, ImageDrop, LinkListDrop, defaultLinkLists } from "./setting-drops";

// Turns the raw values stored in template JSON / settings_data.json into the objects the
// theme's Liquid expects, using the `type` each setting declares in its own `{% schema %}`.
// Anything whose type needs no resolution passes through untouched. Ported from the Shopforge
// preview renderer (only the asset path below differs — see filters.ts's ASSET_BASE/IMAGE_BASE
// comment for why).

/** `shopify://shop_images/<file>` is a merchant upload; the theme's are vendored locally. */
function resolveImageUrl(raw: string): string {
  const uploaded = raw.match(/^shopify:\/\/(?:shop_images|files)\/(.+)$/);
  if (uploaded) return `/api/theme-assets/images/${uploaded[1]}`;
  if (raw.startsWith("shopify:")) return "";
  return raw;
}

export interface ResolveContext {
  linklists: Record<string, LinkListDrop>;
}

export function defaultResolveContext(): ResolveContext {
  return { linklists: defaultLinkLists() };
}

function resolveOne(type: string, value: unknown, ctx: ResolveContext): unknown {
  // An unset setting must stay falsy so the theme's `!= blank` guards take the empty branch.
  if (value === "" || value === null || value === undefined) {
    return type === "checkbox" ? false : "";
  }

  switch (type) {
    case "color":
      return new ColorDrop(String(value));

    case "image_picker": {
      const url = resolveImageUrl(String(value));
      return url ? new ImageDrop(url) : "";
    }

    case "link_list":
      return ctx.linklists[String(value)] ?? { handle: String(value), title: "", levels: 0, links: [] };

    case "font_picker":
      return new FontDrop(String(value));

    // Objects the preview has no store to resolve against. Returning null (not the raw
    // handle) is what makes the theme's `{% if section.settings.x %}` guards take the empty
    // branch instead of reading properties off a string.
    case "collection":
    case "product":
    case "blog":
    case "page":
    case "article":
      return null;
    case "collection_list":
    case "product_list":
      return [];

    // `color_background` holds a CSS gradient, `video`/`video_url` hold URLs — all strings.
    default:
      return value;
  }
}

/** Resolves one settings object against the schema that declares its types. */
export function resolveSettings(
  raw: Record<string, unknown> | undefined,
  schema: ShopifySettingDef[] | undefined,
  ctx: ResolveContext,
): Record<string, unknown> {
  const values = { ...(raw ?? {}) };
  if (!schema) return values;

  const resolved: Record<string, unknown> = { ...values };
  for (const setting of schema) {
    if (!setting.id) continue;
    const value = setting.id in values ? values[setting.id] : setting.default;
    resolved[setting.id] = resolveOne(setting.type, value, ctx);
  }
  return resolved;
}
