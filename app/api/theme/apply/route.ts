import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { generationJobs } from "@/db/schema/generation";
import { isOrgMember } from "@/lib/organizations";
import { shopifyStores } from "@/db/schema/shopify";
import { decryptSecret } from "@/lib/crypto";
import { errorMessage } from "@/lib/errors";
import { completeJob, failJob } from "@/lib/jobs";
import type { ThemeState } from "@/lib/ai-schema/types";
// apply.js stays plain CommonJS (out of scope — Shopify-facing apply path).
const { applyThemeState } = require("@/lib/ai-schema/apply");

type MergeSummary = { changedTemplates: string[]; changedSettings: string[] };
type GenerationResult = { mergedThemeState: ThemeState; mergeSummary: MergeSummary };

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return jsonError("Not signed in", 401);
  }

  const body = await req.json().catch(() => null);
  const jobId = body?.jobId as string | undefined;
  if (!jobId) {
    return jsonError("jobId is required", 400);
  }

  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).limit(1);
  if (!job) {
    return jsonError("Job not found", 404);
  }

  if (!(await isOrgMember(job.orgId, userId))) {
    return jsonError("Not authorized", 403);
  }

  if (job.status !== "completed" || !job.resultJson) {
    return jsonError("Job has not completed successfully yet", 400);
  }

  const [store] = await db.select().from(shopifyStores).where(eq(shopifyStores.id, job.storeId)).limit(1);
  if (!store || !store.activeThemeId) {
    return jsonError("Connected store is missing an active theme", 400);
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

    await completeJob(applyJob.id, result);

    return NextResponse.json({ applyJobId: applyJob.id, ...result });
  } catch (error) {
    const message = errorMessage(error);
    await failJob(applyJob.id, message);

    return jsonError(message, 502);
  }
}
