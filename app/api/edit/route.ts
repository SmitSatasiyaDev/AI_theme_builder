import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgMembership } from "@/lib/actions/organizations";
import { getStoreForOrg } from "@/lib/shopify/client";
import { decryptSecret } from "@/lib/crypto";

const { loadSchemas } = require("@/lib/ai-schema/ai-client");
const { buildThemeState, loadThemeState, composeThemeStateId } = require("@/lib/ai-schema/theme-state");
const { composeSessionId, parseSessionId } = require("@/lib/ai-schema/conversation-session");
const { runConversationalEdit } = require("@/lib/ai-schema/conversational-edit");

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const orgSlug = body?.org as string | undefined;
  const message = String(body?.message ?? "").trim();
  const requestedSessionId = body?.sessionId as string | undefined;

  if (!orgSlug || !message) {
    return NextResponse.json({ error: "org and message are required" }, { status: 400 });
  }

  const membership = await requireOrgMembership(orgSlug, userId);
  if (!membership) {
    return NextResponse.json({ error: "Not a member of this organization" }, { status: 403 });
  }

  const store = await getStoreForOrg(membership.org.id);
  if (!store || !store.activeThemeId) {
    return NextResponse.json({ error: "Connect a Shopify store first" }, { status: 400 });
  }

  let sessionId = requestedSessionId;
  if (sessionId) {
    const { storeId } = parseSessionId(sessionId);
    if (storeId !== store.id) {
      return NextResponse.json({ error: "Session does not belong to this store" }, { status: 403 });
    }
  } else {
    sessionId = composeSessionId(store.id, userId);
  }

  const accessToken = decryptSecret(store.accessTokenEncrypted);
  const fullSchemas = await loadSchemas();
  const themeCompositeId = composeThemeStateId(store.id, store.activeThemeId);

  let themeState = await loadThemeState(themeCompositeId);
  if (!themeState) {
    themeState = await buildThemeState({
      shopDomain: store.shopDomain,
      accessToken,
      themeId: store.activeThemeId,
      schemas: fullSchemas,
      context: { requestId: sessionId }
    });
    // Rekey to the composite storage id — see theme-state.js's comment on
    // saveThemeState/loadThemeState for why this is safe (nothing reads
    // .themeId to make a Shopify API call; real calls always take
    // shopDomain/accessToken/themeId as explicit options).
    themeState.themeId = themeCompositeId;
  }

  try {
    const result = await runConversationalEdit(message, {
      sessionId,
      themeId: themeCompositeId,
      themeState,
      schemas: fullSchemas,
      templateName: "index",
      autoApply: false,
      requestId: sessionId
    });

    return NextResponse.json({ sessionId, ...result });
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: messageText }, { status: 502 });
  }
}
