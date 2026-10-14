// Shared by the OAuth install/callback routes and the store-connect form's `pattern`
// attribute, so client- and server-side validation can never disagree.
export const SHOP_DOMAIN_PATTERN = "^[a-z0-9][a-z0-9-]*\\.myshopify\\.com$";

const SHOP_DOMAIN_RE = new RegExp(SHOP_DOMAIN_PATTERN);

export function isValidShopDomain(shop: string | null | undefined): shop is string {
  return !!shop && SHOP_DOMAIN_RE.test(shop);
}
