import type { Liquid } from "liquidjs";
import { formatMoney } from "./money";
import { colorExtract, colorModify } from "./color";

// Shopify Liquid compatibility shim, ported from the Shopforge preview renderer. Scoped to
// what the real Base Theme actually calls: LiquidJS natively covers the string/array/math
// filter set, and the ones registered here are the Shopify-only remainder. Behaviour is the
// smallest compatible implementation, not a reimplementation of Shopify's CDN — there is no
// image resizing service, no font service, and no address-format database behind the preview.

/** LiquidJS passes Shopify-style named filter args (`width: 800`) as `[key, value]` pairs. */
function namedArgs(args: unknown[]): Record<string, unknown> {
  const hash: Record<string, unknown> = {};
  for (const arg of args) {
    if (Array.isArray(arg) && arg.length === 2 && typeof arg[0] === "string") {
      hash[arg[0]] = arg[1];
    }
  }
  return hash;
}

function readLocalePath(locale: Record<string, unknown>, key: string): string | null {
  const value = key.split(".").reduce<unknown>((node, segment) => {
    if (node && typeof node === "object") return (node as Record<string, unknown>)[segment];
    return undefined;
  }, locale);
  return typeof value === "string" ? value : null;
}

function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function attrs(hash: Record<string, unknown>, keys: string[]): string {
  return keys
    .filter((k) => hash[k] !== undefined && hash[k] !== null && hash[k] !== "")
    .map((k) => ` ${k}="${esc(hash[k])}"`)
    .join("");
}

function handle(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// The theme's static files live on disk under LOCAL_THEME_ROOT, not under this app's own
// public/ — served through app/api/theme-assets/[...path]/route.ts instead of a static path.
const ASSET_BASE = "/api/theme-assets/assets";
/** The theme's vendored demo uploads, standing in for a store's Files/shop_images library. */
const IMAGE_BASE = "/api/theme-assets/images";

export interface FilterOptions {
  locale: Record<string, unknown>;
  currency?: string | null;
}

export function registerShopifyFilters(
  engine: Liquid,
  options: FilterOptions | Record<string, unknown>,
) {
  // Back-compat with the original two-arg (engine, locale) call shape.
  const opts: FilterOptions =
    "locale" in options ? (options as FilterOptions) : { locale: options as Record<string, unknown> };
  const locale = opts.locale ?? {};
  const currency = opts.currency ?? "USD";

  // --- Money -------------------------------------------------------------------
  engine.registerFilter("money", (v) => formatMoney(v, { currency }));
  engine.registerFilter("money_with_currency", (v) => formatMoney(v, { currency, withCode: true }));
  engine.registerFilter("money_without_currency", (v) => formatMoney(v, { currency, symbol: false }));
  engine.registerFilter("money_without_trailing_zeros", (v) =>
    formatMoney(v, { currency, trailingZeros: false }),
  );

  // --- Translation -------------------------------------------------------------
  engine.registerFilter("t", (key: unknown, ...args: unknown[]) => {
    const path = String(key);
    const translated = readLocalePath(locale, path);
    if (translated === null) return path; // missing key: fall back to the key itself, not silent garbage
    const vars = namedArgs(args);
    return translated.replace(/%\{(\w+)\}/g, (_m, name) => String(vars[name] ?? ""));
  });

  // --- URLs --------------------------------------------------------------------
  // Product images are absolute URLs and theme images are local files; neither goes through
  // a resizing service, so width/height are accepted for syntax compatibility and
  // deliberately not applied.
  const resolveImage = (value: unknown): string => {
    if (!value) return "";
    if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      const src = record.src ?? record.url;
      return typeof src === "string" ? resolveImage(src) : "";
    }
    const str = String(value);
    // Merchant-uploaded files are referenced as `shopify://shop_images/<file>`, which only
    // resolves against a real store's CDN. The theme's own demo uploads are vendored under
    // LOCAL_THEME_ROOT/images, so the reference is rewritten to point at the asset route.
    const uploaded = str.match(/^shopify:\/\/(?:shop_images|files)\/(.+)$/);
    if (uploaded) return `${IMAGE_BASE}/${uploaded[1]}`;
    // Any other shopify:// URL (a collection, a product, a route) has no local equivalent;
    // returning "" lets the theme's own `{% if %}` guards fall back to a placeholder rather
    // than emitting a broken <img>.
    if (str.startsWith("shopify:")) return "";
    if (/^(https?:|data:|\/)/.test(str)) return str;
    return `${ASSET_BASE}/${str}`;
  };

  engine.registerFilter("image_url", resolveImage);
  engine.registerFilter("img_url", resolveImage);
  engine.registerFilter("asset_url", (v) => `${ASSET_BASE}/${v}`);
  engine.registerFilter("asset_img_url", (v) => `${ASSET_BASE}/${v}`);
  engine.registerFilter("file_url", (v) => `${ASSET_BASE}/${v}`);
  engine.registerFilter("file_img_url", (v) => `${ASSET_BASE}/${v}`);
  engine.registerFilter("shopify_asset_url", (v) => `${ASSET_BASE}/${v}`);
  engine.registerFilter("link_to", (label: unknown, url: unknown) => `<a href="${esc(url)}">${label}</a>`);
  engine.registerFilter("within", (url: unknown) => url);
  engine.registerFilter("handleize", (v) => handle(v));
  engine.registerFilter("handle", (v) => handle(v));

  // --- Tag-emitting filters ----------------------------------------------------
  engine.registerFilter("image_tag", (value: unknown, ...args: unknown[]) => {
    const hash = namedArgs(args);
    const src = resolveImage(value);
    if (!src) return "";
    const keys = ["alt", "class", "width", "height", "loading", "sizes", "srcset"];
    return `<img src="${esc(src)}"${attrs(hash, keys)}>`;
  });

  engine.registerFilter("stylesheet_tag", (value: unknown) =>
    value ? `<link rel="stylesheet" href="${esc(value)}">` : "",
  );
  engine.registerFilter("script_tag", (value: unknown) =>
    value ? `<script src="${esc(value)}"></script>` : "",
  );

  // Shopify serves a library of illustrated placeholders (`lifestyle-2`, `product-1`, …).
  // There is no equivalent behind the preview, so this renders one neutral placeholder that
  // fills whatever box the theme puts it in — a hero placeholder must not collapse to an icon.
  engine.registerFilter("placeholder_svg_tag", (_value: unknown, ...args: unknown[]) => {
    const cls = typeof args[0] === "string" ? args[0] : "placeholder-svg";
    return [
      `<svg class="${esc(cls)}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"`,
      ` width="100%" height="100%" preserveAspectRatio="xMidYMid slice" aria-hidden="true">`,
      `<rect width="200" height="200" fill="#e8e5e0"/>`,
      `<path d="M40 140l34-44 24 30 20-24 42 38z" fill="#cfcac2"/>`,
      `<circle cx="68" cy="66" r="14" fill="#cfcac2"/></svg>`,
    ].join("");
  });

  engine.registerFilter("time_tag", (value: unknown) => {
    const iso = String(value ?? "");
    return `<time datetime="${esc(iso)}">${esc(iso)}</time>`;
  });

  // Video and payment-icon services do not exist behind the preview; they render an
  // inert, correctly-shaped placeholder rather than throwing.
  engine.registerFilter("video_tag", (value: unknown) => {
    const src = resolveImage(value);
    return src ? `<video src="${esc(src)}" controls playsinline></video>` : "";
  });
  engine.registerFilter("external_video_url", (value: unknown) => resolveImage(value));
  engine.registerFilter("external_video_tag", (value: unknown) => {
    const src = resolveImage(value);
    return src ? `<iframe src="${esc(src)}" loading="lazy" allowfullscreen></iframe>` : "";
  });
  engine.registerFilter("media_tag", (value: unknown) => {
    const src = resolveImage(value);
    return src ? `<img src="${esc(src)}" alt="">` : "";
  });
  engine.registerFilter("payment_type_svg_tag", () => "");

  // --- Colors ------------------------------------------------------------------
  engine.registerFilter("color_extract", colorExtract);
  engine.registerFilter("color_modify", colorModify);
  engine.registerFilter("color_to_rgb", (v) => String(v ?? ""));
  engine.registerFilter("color_lighten", (v, amount) =>
    colorModify(v, "lightness", Number(colorExtract(v, "lightness")) + Number(amount ?? 0)),
  );
  engine.registerFilter("color_darken", (v, amount) =>
    colorModify(v, "lightness", Number(colorExtract(v, "lightness")) - Number(amount ?? 0)),
  );

  // --- Fonts -------------------------------------------------------------------
  // The preview uses system fonts; the theme's font settings are accepted and ignored
  // rather than pulling Shopify's font service into the iframe.
  engine.registerFilter("font_face", () => "");
  engine.registerFilter("font_url", () => "");
  engine.registerFilter("font_modify", (value: unknown) => value);

  // --- Misc storefront ---------------------------------------------------------
  engine.registerFilter("format_address", (address: unknown) => {
    if (!address || typeof address !== "object") return "";
    const a = address as Record<string, unknown>;
    return ["address1", "address2", "city", "province", "zip", "country"]
      .map((k) => a[k])
      .filter(Boolean)
      .map((line) => `<div>${esc(line)}</div>`)
      .join("");
  });
  engine.registerFilter("item_count_for_variant", () => 0);
  engine.registerFilter("weight_with_unit", (v, unit) => `${Number(v ?? 0) / 1000} ${unit ?? "kg"}`);
  engine.registerFilter("default_pagination", () => "");
  engine.registerFilter("highlight", (value: unknown) => value);
  engine.registerFilter("structured_data", () => "");
}
