import { and, eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { generationJobs } from "@/db/schema/generation";
import { organizationMembers } from "@/db/schema/organizations";
import { shopifyStores } from "@/db/schema/shopify";
import { decryptSecret } from "@/lib/crypto";

const { applyThemeState } = require("@/lib/ai-schema/apply");

type MergeSummary = { changedTemplates: string[]; changedSettings: string[] };
type GenerationResult = { mergedThemeState: unknown; mergeSummary: MergeSummary };

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const jobId = body?.jobId as string | undefined;
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required" }, { status: 400 });
  }

  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).limit(1);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const [membership] = await db
    .select()
    .from(organizationMembers)
    .where(and(eq(organizationMembers.orgId, job.orgId), eq(organizationMembers.userId, userId)))
    .limit(1);
  if (!membership) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }

  if (job.status !== "completed" || !job.resultJson) {
    return NextResponse.json({ error: "Job has not completed successfully yet" }, { status: 400 });
  }

  const [store] = await db.select().from(shopifyStores).where(eq(shopifyStores.id, job.storeId)).limit(1);
  if (!store || !store.activeThemeId) {
    return NextResponse.json({ error: "Connected store is missing an active theme" }, { status: 400 });
  }

  const { mergedThemeState, mergeSummary } = job.resultJson as GenerationResult;
  const accessToken = decryptSecret(store.accessTokenEncrypted);

  const [applyJob] = await db
    .insert(generationJobs)
    .values({
      orgId: job.orgId,
      storeId: job.storeId,
      userId,
      type: "apply",
      status: "running",
      inputPrompt: JSON.stringify({ appliedFromJobId: jobId })
    })
    .returning();

  try {
    const result = await applyThemeState(mergedThemeState, {
      shopDomain: store.shopDomain,
      accessToken,
      themeId: store.activeThemeId,
      changedTemplates: mergeSummary.changedTemplates,
      writeGlobalSettings: mergeSummary.changedSettings.length > 0,
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
