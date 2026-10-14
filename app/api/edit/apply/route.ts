import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { auth } from "@/lib/auth";
import { getOrgMembership } from "@/lib/organizations";
import { getStoreForOrg } from "@/lib/shopify/client";
import { decryptSecret } from "@/lib/crypto";
import { errorMessage } from "@/lib/errors";
import { completeJob, failJob } from "@/lib/jobs";
import { db } from "@/db";
import { generationJobs } from "@/db/schema/generation";
import { loadSchemas } from "@/lib/ai-schema/ai-client";
import { buildThemeState } from "@/lib/ai-schema/theme-state";
import { loadSession, parseSessionId } from "@/lib/ai-schema/conversation-session";
import { applyOperationsToThemeState, applyTargetsForOperations } from "@/lib/ai-schema/operations";
import type { Operation } from "@/lib/ai-schema/types";
// apply.js stays plain CommonJS (out of scope — Shopify-facing apply path).
const { applyThemeState } = require("@/lib/ai-schema/apply");

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return jsonError("Not signed in", 401);
  }

  const body = await req.json().catch(() => null);
  const orgSlug = body?.org as string | undefined;
  const sessionId = body?.sessionId as string | undefined;
  if (!orgSlug || !sessionId) {
    return jsonError("org and sessionId are required", 400);
  }

  const membership = await getOrgMembership(orgSlug, userId);
  if (!membership) {
    return jsonError("Not a member of this organization", 403);
  }

  const { storeId } = parseSessionId(sessionId);

  const store = await getStoreForOrg(membership.org.id);
  if (!store || store.id !== storeId || !store.activeThemeId) {
    return jsonError("Session does not belong to this store", 403);
  }

  const editSession = await loadSession(sessionId);
  if (!editSession) {
    return jsonError("Session not found", 404);
  }

  // Older sessions saved before operations were tracked as an array only
  // have `lastOperation` (singular) — fall back to that so an in-flight
  // session isn't broken by this change.
  const operations: Operation[] = editSession.lastOperations?.length
    ? editSession.lastOperations
    : editSession.lastOperation
      ? [editSession.lastOperation]
      : [];

  if (operations.length === 0) {
    return jsonError("Nothing to apply for this session yet", 400);
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
    const schemas = await loadSchemas();

    // The real theme files on disk are the single source of truth — rebuild
    // fresh here rather than reusing whatever ThemeState the propose step
    // mutated in memory, then re-run the SAME already-validated operation(s)
    // against this fresh state. applyOperationToThemeState()/
    // applyOperationsToThemeState() are pure and deterministic (operations.ts),
    // so replaying them reproduces the exact same result when nothing else
    // has touched the theme since — and correctly re-validates (rather than
    // blindly overwriting) if something has, e.g. the target section was
    // removed by a different edit in the meantime.
    const themeState = await buildThemeState({
      shopDomain: store.shopDomain,
      accessToken,
      themeId: store.activeThemeId,
      schemas,
      context: { requestId: applyJob.id }
    });

    const executed = applyOperationsToThemeState(themeState, operations, {
      themeState,
      schemas,
      knownMerchantData: {},
      requestId: applyJob.id
    });

    if (!executed.valid) {
      const message = executed.errors.map((e) => e.message).join("; ");
      await failJob(applyJob.id, message);
      return jsonError(`This change no longer applies to the current theme (it may have changed since you proposed this edit): ${message}`, 409);
    }

    const { changedTemplates, writeGlobalSettings } = applyTargetsForOperations(operations);

    const result = await applyThemeState(executed.themeState, {
      shopDomain: store.shopDomain,
      accessToken,
      themeId: store.activeThemeId,
      changedTemplates,
      writeGlobalSettings,
      requestId: applyJob.id
    });

    await completeJob(applyJob.id, result);

    return NextResponse.json({ applyJobId: applyJob.id, ...result });
  } catch (error) {
    const message = errorMessage(error);
    await failJob(applyJob.id, message);

    return jsonError(message, 502);
  }
}
