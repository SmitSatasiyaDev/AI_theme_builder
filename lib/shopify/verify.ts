import { createHmac, timingSafeEqual } from "crypto";

// Verifies Shopify's HMAC signature on OAuth callback query params.
// https://shopify.dev/docs/apps/build/authentication-authorization/get-access-tokens/authorization-code-grant#step-3-confirm-installation
export function verifyShopifyHmac(params: URLSearchParams, secret: string): boolean {
  const hmac = params.get("hmac");
  if (!hmac) return false;

  const message = Array.from(params.entries())
    .filter(([key]) => key !== "hmac" && key !== "signature")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

  const digest = createHmac("sha256", secret).update(message).digest("hex");
  const digestBuf = Buffer.from(digest, "utf8");
  const hmacBuf = Buffer.from(hmac, "utf8");
  return digestBuf.length === hmacBuf.length && timingSafeEqual(digestBuf, hmacBuf);
}
