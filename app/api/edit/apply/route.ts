import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgMembership } from "@/lib/actions/organizations";
import { getStoreForOrg } from "@/lib/shopify/client";
import { decryptSecret } from "@/lib/crypto";
import { db } from "@/db";
import { generationJobs } from "@/db/schema/generation";
import { loadThemeState } from "@/lib/ai-schema/theme-state";
import { loadSession, parseSessionId } from "@/lib/ai-schema/conversation-session";
// apply.js stays plain CommonJS (out of scope — Shopify-facing apply path).
const { applyThemeState } = require("@/lib/ai-schema/apply");

type ResolvedTarget = { templateName?: string | null; type?: string | null } | null;

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const orgSlug = body?.org as string | undefined;
  const sessionId = body?.sessionId as string | undefined;
  if (!orgSlug || !sessionId) {
    return NextResponse.json({ error: "org and sessionId are required" }, { status: 400 });
  }

  const membership = await requireOrgMembership(orgSlug, userId);
  if (!membership) {
    return NextResponse.json({ error: "Not a member of this organization" }, { status: 403 });
  }

  const { storeId } = parseSessionId(sessionId);

  const store = await getStoreForOrg(membership.org.id);
  if (!store || store.id !== storeId || !store.activeThemeId) {
    return NextResponse.json({ error: "Session does not belong to this store" }, { status: 403 });
  }

  const editSession = await loadSession(sessionId);
  if (!editSession) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const resolvedTarget = editSession.resolvedTarget as ResolvedTarget;
  const writeGlobalSettings = resolvedTarget?.type === "globalSettings";
  const changedTemplates = !writeGlobalSettings && resolvedTarget?.templateName ? [resolvedTarget.templateName] : [];

  if (changedTemplates.length === 0 && !writeGlobalSettings) {
    return NextResponse.json({ error: "Nothing to apply for this session yet" }, { status: 400 });
  }

  const themeState = await loadThemeState(editSession.themeId);
  if (!themeState) {
    return NextResponse.json({ error: "No saved theme state for this session" }, { status: 400 });
  }

  const accessToken = decryptSecret(store.accessTokenEncrypted);

  const [applyJob] = await db
    .insert(generationJobs)
    .values({
      orgId: membership.org.id,
      storeId: store.id,
      userId,
      type: "apply",
      status: "running",
      inputPrompt: JSON.stringify({ appliedFromSessionId: sessionId })
    })
    .returning();

  try {
    const result = await applyThemeState(themeState, {
      shopDomain: store.shopDomain,
      accessToken,
      themeId: store.activeThemeId,
      changedTemplates,
      writeGlobalSettings,
      requestId: applyJob.id
    });

    await db.update(generationJobs).set({
      status: "completed",
      resultJson: result,
      completedAt: new Date()
    }).where(eq(generationJobs.id, applyJob.id));

    return NextResponse.json({ applyJobId: applyJob.id, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(generationJobs).set({
      status: "failed",
      errorMessage: message,
      completedAt: new Date()
    }).where(eq(generationJobs.id, applyJob.id));

    return NextResponse.json({ error: message }, { status: 502 });
  }
}
