// Shopify object drops, shaped the way the real Base Theme's Liquid reads them. Ported from
// the Shopforge preview renderer: that version converts a scraped/imported `NormalizedProduct`
// into this shape, since Shopforge projects aren't necessarily linked to a live store. This app
// is always linked to a connected Shopify store (generation is prompt-driven, not imported from
// a product URL — see lib/ai-schema/generation.ts's rule 9, "do not invent product handles"),
// so `buildProductDrop` here converts a real product fetched via Admin GraphQL
// (lib/shopify/client.ts's `getRepresentativeProductForOrg`) instead.

import { toCents } from "./money";
import type { ShopifyPreviewProduct } from "@/lib/shopify/client";

export interface SectionBlockDrop {
  id: string;
  type: string;
  settings: Record<string, unknown>;
  blocks: SectionBlockDrop[];
  shopify_attributes: string;
}

/** A block instance as it appears in template JSON, before it becomes a drop. */
export interface BlockInstance {
  id: string;
  type: string;
  settings: Record<string, unknown>;
  blocks?: BlockInstance[];
}

export interface SectionDrop {
  id: string;
  type: string;
  settings: Record<string, unknown>;
  blocks: SectionBlockDrop[];
  index: number;
  index0: number;
  location: string;
  shopify_attributes: string;
}

function imageDrop(url: string, altText: string | null, position: number) {
  return {
    id: `image-${position}`,
    src: url,
    url,
    alt: altText ?? "",
    width: 1200,
    height: 1200,
    aspect_ratio: 1,
    position,
    media_type: "image",
    preview_image: { src: url, url, width: 1200, height: 1200, aspect_ratio: 1 },
  };
}

function parsePrice(value: string | null | undefined): number | null {
  if (!value) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Real Shopify product -> `product` Liquid drop. Mirrors Shopforge's NormalizedProduct
 * conversion, but every field already comes straight from the store via Admin GraphQL, so
 * there's no "partial import" fallback story to account for.
 */
export function buildProductDrop(product: ShopifyPreviewProduct | null) {
  if (!product) return null;

  const images = product.images.edges.map((edge, i) => imageDrop(edge.node.url, edge.node.altText, i + 1));
  const featured = images[0] ?? null;

  const variants = product.variants.edges.map((edge, i) => {
    const v = edge.node;
    const price = toCents(parsePrice(v.price)) ?? 0;
    const compareAt = toCents(parsePrice(v.compareAtPrice));
    const image = v.image ? imageDrop(v.image.url, v.image.altText, i + 1) : featured;
    const options = v.selectedOptions.map((o) => o.value);
    return {
      id: i + 1,
      title: v.title,
      name: `${product.title} - ${v.title}`,
      price,
      compare_at_price: compareAt,
      available: v.availableForSale,
      inventory_quantity: v.availableForSale ? 10 : 0,
      inventory_management: null,
      inventory_policy: "deny",
      sku: v.sku ?? "",
      barcode: "",
      weight: 0,
      requires_shipping: true,
      taxable: true,
      options,
      option1: options[0] ?? null,
      option2: options[1] ?? null,
      option3: options[2] ?? null,
      featured_image: image,
      featured_media: image,
      image,
      url: `/products/${product.handle}?variant=${i + 1}`,
      selling_plan_allocations: [],
    };
  });

  const firstAvailable = variants.find((v) => v.available) ?? variants[0] ?? null;
  const prices = variants.map((v) => v.price);
  const options = product.options.length
    ? product.options
    : [{ name: "Title", values: ["Default Title"] }];

  return {
    id: 1,
    title: product.title,
    handle: product.handle,
    description: product.descriptionHtml ?? "",
    content: product.descriptionHtml ?? "",
    vendor: product.vendor ?? "",
    type: "",
    tags: product.tags ?? [],
    url: `/products/${product.handle}`,
    available: variants.some((v) => v.available),
    price: firstAvailable?.price ?? prices[0] ?? 0,
    price_min: prices.length ? Math.min(...prices) : 0,
    price_max: prices.length ? Math.max(...prices) : 0,
    price_varies: new Set(prices).size > 1,
    compare_at_price: firstAvailable?.compare_at_price ?? null,
    compare_at_price_min: prices.length ? Math.min(...prices) : null,
    compare_at_price_max: prices.length ? Math.max(...prices) : null,
    compare_at_price_varies: false,
    images,
    media: images,
    featured_image: featured,
    featured_media: featured,
    variants,
    first_available_variant: firstAvailable,
    selected_variant: variants.length === 1 ? variants[0] : null,
    selected_or_first_available_variant: firstAvailable,
    has_only_default_variant: product.options.length === 0,
    options: options.map((o) => o.name),
    options_with_values: options.map((option, i) => ({
      name: option.name,
      position: i + 1,
      values: option.values,
      selected_value: option.values[0] ?? null,
    })),
    requires_selling_plan: false,
    selling_plan_groups: [],
    metafields: {},
    published_at: null,
    created_at: null,
  };
}

/** `data-shopify-editor-*` is what the theme emits for Shopify's own editor; the preview keeps it inert. */
function shopifyAttributes(kind: "section" | "block", id: string): string {
  return `data-shopify-editor-${kind}="${id}"`;
}

/** Theme blocks nest arbitrarily deep, so the drop is built recursively. */
export function buildBlockDrop(block: BlockInstance): SectionBlockDrop {
  return {
    id: block.id,
    type: block.type,
    settings: block.settings,
    blocks: (block.blocks ?? []).map(buildBlockDrop),
    shopify_attributes: shopifyAttributes("block", block.id),
  };
}

export function buildSectionDrop(
  id: string,
  type: string,
  settings: Record<string, unknown>,
  blocks: BlockInstance[],
  index: number,
): SectionDrop {
  return {
    id,
    type,
    settings,
    index: index + 1,
    index0: index,
    location: "template",
    shopify_attributes: shopifyAttributes("section", id),
    blocks: blocks.map(buildBlockDrop),
  };
}

/**
 * The storefront globals every section can reach. The preview has no cart, no customer and no
 * collections behind it, so those are present-but-empty rather than absent — the theme guards
 * on `.size`/`.first`, which an empty array answers correctly and `undefined` does not. `product`
 * is not set here — the caller (template-renderer.ts) overrides it with `buildProductDrop(...)`
 * once it has fetched a real product for the template being rendered.
 */
export function buildGlobalContext(opts: {
  storeName: string;
  currency?: string | null;
  settings: Record<string, unknown>;
  locale: Record<string, unknown>;
}) {
  const currency = opts.currency ?? "USD";
  return {
    shop: {
      name: opts.storeName,
      description: "",
      url: "",
      permanent_domain: "",
      domain: "",
      email: "",
      currency,
      money_format: "${{amount}}",
      enabled_payment_types: ["visa", "master", "american_express", "paypal"],
      // A real storefront has accounts on by default; without this the header drops its
      // account icon entirely.
      customer_accounts_enabled: true,
      accepts_gift_cards: false,
      published_locales: [],
      privacy_policy: null,
      refund_policy: null,
      terms_of_service: null,
      shipping_policy: null,
      contact_information: null,
    },
    settings: opts.settings,
    routes: {
      root_url: "/",
      account_url: "/account",
      account_login_url: "/account/login",
      account_logout_url: "/account/logout",
      account_register_url: "/account/register",
      account_addresses_url: "/account/addresses",
      collections_url: "/collections",
      all_products_collection_url: "/collections/all",
      search_url: "/search",
      predictive_search_url: "/search/suggest",
      cart_url: "/cart",
      cart_add_url: "/cart/add",
      cart_change_url: "/cart/change",
      cart_update_url: "/cart/update",
      product_recommendations_url: "/recommendations/products",
    },
    cart: { item_count: 0, items: [], total_price: 0, original_total_price: 0, currency, note: "", attributes: {} },
    customer: null,
    collections: {},
    linklists: {},
    localization: {
      language: { iso_code: "en", endonym_name: "English" },
      country: { iso_code: "US", currency: { iso_code: currency } },
      available_languages: [],
      available_countries: [],
    },
    request: { page_type: "index", path: "/", host: "", design_mode: false, locale: { iso_code: "en" } },
    template: { name: "index", suffix: null, directory: null },
    canonical_url: "",
    page_title: opts.storeName,
    page_description: "",
    powered_by_link: "",
    content_for_header: "",
    additional_checkout_buttons: false,
  };
}
