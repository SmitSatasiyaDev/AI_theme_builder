import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgMembership } from "@/lib/organizations";
import { getStoreForOrg } from "@/lib/shopify/client";
import { decryptSecret } from "@/lib/crypto";
import { errorMessage } from "@/lib/errors";
import { loadSchemas } from "@/lib/ai-schema/ai-client";
import { buildThemeState, composeThemeStateId } from "@/lib/ai-schema/theme-state";
import { composeSessionId, parseSessionId } from "@/lib/ai-schema/conversation-session";
import { runConversationalEdit } from "@/lib/ai-schema/conversational-edit";

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
  const templateName = typeof body?.templateName === "string" && body.templateName ? body.templateName : "index";

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

  // The real theme files on disk are the single source of truth for the
  // current live theme — every edit turn rebuilds ThemeState fresh here
  // rather than reading a cached snapshot, so the AI is always resolving
  // against (and the edit pipeline is always validating against) what's
  // actually there right now, never a stale copy from before some other
  // apply (a generation, or another session's edit) changed it.
  const themeState = await buildThemeState({
    shopDomain: store.shopDomain,
    accessToken,
    themeId: store.activeThemeId,
    schemas: fullSchemas,
    context: { requestId: sessionId }
  });
  themeState.themeId = themeCompositeId;

  try {
    const result = await runConversationalEdit(message, {
      sessionId,
      themeId: themeCompositeId,
      themeState,
      schemas: fullSchemas,
      templateName,
      autoApply: false,
      requestId: sessionId
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: errorMessage(error) }, { status: 502 });
  }
}
