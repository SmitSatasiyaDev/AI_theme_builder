import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgMembership } from "@/lib/organizations";
import { getStoreForOrg } from "@/lib/shopify/client";
import { db } from "@/db";
import { generationJobs } from "@/db/schema/generation";
import { getBoss, GENERATE_THEME_QUEUE } from "@/lib/queue";
import { composeSessionId, parseSessionId } from "@/lib/ai-schema/conversation-session";
import { createEmptyBrief } from "@/lib/ai-schema/brief-logic";
import { finalizeBrief, isIntakeComplete, runBriefIntakeTurn } from "@/lib/ai-schema/brief-intake";
import {
  createIntakeSession,
  loadBriefForSession,
  loadIntakeSession,
  saveBriefForSession,
  saveIntakeSession
} from "@/lib/ai-schema/generation-intake-session";

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
  if (!store) {
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

  let state = (await loadIntakeSession(sessionId)) ?? createIntakeSession(sessionId);

  // This session already handed off to the worker — replying again shouldn't
  // start a second generation job for the same intake conversation.
  if (state.status !== "COLLECTING") {
    return NextResponse.json({ status: "GENERATING", sessionId, jobId: state.jobId });
  }

  // brief.sessionId has a FK to conversation_session.id, so the session row
  // must exist before saveBriefForSession runs below — on a brand-new
  // session, createIntakeSession only built an in-memory state.
  state = await saveIntakeSession(state);

  const currentBrief = (await loadBriefForSession(sessionId)) ?? createEmptyBrief();

  let turn;
  try {
    turn = await runBriefIntakeTurn({ message, currentBrief, requestId: sessionId });
  } catch {
    // Nothing is persisted and turnCount isn't advanced, so the merchant's
    // next message retries against the same accreted brief.
    return NextResponse.json({
      status: "NEEDS_INFO",
      sessionId,
      question: "Sorry, I had trouble understanding that — could you rephrase it?"
    });
  }

  const turnCount = state.turnCount + 1;
  await saveBriefForSession(sessionId, turn.brief);

  if (!isIntakeComplete(turn.brief, turnCount)) {
    const question = turn.question ?? "Could you tell me a bit more about your store?";
    await saveIntakeSession({
      ...state,
      status: "COLLECTING",
      turnCount,
      lastQuestion: question,
      lastMessage: message
    });
    return NextResponse.json({ status: "NEEDS_INFO", sessionId, question });
  }

  const [job] = await db
    .insert(generationJobs)
    .values({
      orgId: membership.org.id,
      storeId: store.id,
      userId,
      type: "initial_generation",
      status: "queued",
      inputPrompt: JSON.stringify(finalizeBrief(turn.brief))
    })
    .returning();

  const boss = await getBoss();
  await boss.send(GENERATE_THEME_QUEUE, { jobId: job.id });

  await saveIntakeSession({
    ...state,
    status: "GENERATING",
    turnCount,
    lastQuestion: null,
    lastMessage: message,
    jobId: job.id
  });

  return NextResponse.json({ status: "GENERATING", sessionId, jobId: job.id });
}
