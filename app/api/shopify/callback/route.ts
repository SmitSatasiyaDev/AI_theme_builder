import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { shopifyStores } from "@/db/schema/shopify";
import { organizations } from "@/db/schema/organizations";
import { encryptSecret } from "@/lib/crypto";
import { verifyOAuthState } from "@/lib/shopify/state";
import { verifyShopifyHmac } from "@/lib/shopify/verify";
import { isValidShopDomain } from "@/lib/shopify/shop-domain";

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const shop = params.get("shop");
  const code = params.get("code");
  const state = params.get("state");
  const hmac = params.get("hmac");

  if (!isValidShopDomain(shop) || !code || !state || !hmac) {
    return NextResponse.json({ error: "Invalid callback request" }, { status: 400 });
  }

  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("Shopify app env vars are not configured");
  }

  if (!verifyShopifyHmac(params, apiSecret)) {
    return NextResponse.json({ error: "HMAC verification failed" }, { status: 401 });
  }

  const nonce = req.cookies.get("shopify_oauth_nonce")?.value;
  if (!nonce) {
    return NextResponse.json({ error: "Missing OAuth session" }, { status: 400 });
  }

  const verified = verifyOAuthState(state, nonce);
  if (!verified) {
    return NextResponse.json({ error: "Invalid OAuth state" }, { status: 400 });
  }

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
  });
  if (!tokenRes.ok) {
    return NextResponse.json({ error: "Failed to exchange code for token" }, { status: 502 });
  }
  const { access_token: accessToken, scope } = (await tokenRes.json()) as {
    access_token: string;
    scope: string;
  };

  await db
    .insert(shopifyStores)
    .values({
      orgId: verified.orgId,
      shopDomain: shop,
      accessTokenEncrypted: encryptSecret(accessToken),
      scopes: scope,
    })
    .onConflictDoUpdate({
      target: shopifyStores.shopDomain,
      set: {
        orgId: verified.orgId,
        accessTokenEncrypted: encryptSecret(accessToken),
        scopes: scope,
        uninstalledAt: null,
      },
    });

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, verified.orgId))
    .limit(1);

  const res = NextResponse.redirect(new URL(`/dashboard/${org?.slug ?? ""}/stores`, req.url));
  res.cookies.delete("shopify_oauth_nonce");
  return res;
}
