import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { auth } from "@/lib/auth";
import { getOrgMembership } from "@/lib/organizations";
import { OAUTH_NONCE_COOKIE, createOAuthState } from "@/lib/shopify/state";
import { isValidShopDomain } from "@/lib/shopify/shop-domain";

export async function GET(req: NextRequest) {
  const shop = req.nextUrl.searchParams.get("shop");
  const orgSlug = req.nextUrl.searchParams.get("org");

  if (!isValidShopDomain(shop)) {
    return jsonError("Invalid shop domain", 400);
  }
  if (!orgSlug) {
    return jsonError("Missing org", 400);
  }

  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.redirect(new URL("/sign-in", req.url));
  }

  const membership = await getOrgMembership(orgSlug, userId);
  if (!membership) {
    return jsonError("Not a member of this organization", 403);
  }

  const apiKey = process.env.SHOPIFY_API_KEY;
  const scopes = process.env.SHOPIFY_SCOPES;
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!apiKey || !scopes || !appUrl) {
    throw new Error("Shopify app env vars are not configured");
  }

  const { state, nonce } = createOAuthState(membership.org.id);

  const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizeUrl.searchParams.set("client_id", apiKey);
  authorizeUrl.searchParams.set("scope", scopes);
  authorizeUrl.searchParams.set("redirect_uri", `${appUrl}/api/shopify/callback`);
  authorizeUrl.searchParams.set("state", state);

  const res = NextResponse.redirect(authorizeUrl);
  res.cookies.set(OAUTH_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 600,
    path: "/api/shopify",
  });
  return res;
}
