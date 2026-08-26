// Shopify object drops, shaped the way the real Base Theme's Liquid reads them. Ported from
// the Shopforge preview renderer, minus buildProductDrop's body: this app has no product data
// source (generation is prompt-driven, not imported from a real product URL — see
// lib/ai-schema/generation.ts's rule 9, "do not invent product handles"), so `product` is
// always null here rather than carrying Shopforge's NormalizedProduct conversion logic.

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
 * The storefront globals every section can reach. The preview has no cart, no customer, no
 * collections and no products behind it, so those are present-but-empty rather than absent —
 * the theme guards on `.size`/`.first`, which an empty array answers correctly and `undefined`
 * does not.
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
    // Always null: this app has no product/store data source (see file header). The theme's
    // own `{% if product %}` guards take the empty branch, same as any page without one.
    product: null,
  };
}
