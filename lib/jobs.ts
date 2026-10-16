import { eq } from "drizzle-orm";
import { db } from "@/db";
import { generationJobs } from "@/db/schema/generation";

/** Marks a generation/apply job as successfully finished with its result. */
export async function completeJob(jobId: string, resultJson: unknown): Promise<void> {
  await db
    .update(generationJobs)
    .set({ status: "completed", resultJson, completedAt: new Date() })
    .where(eq(generationJobs.id, jobId));
}

/** Marks a generation/apply job as failed, recording why. */
export async function failJob(jobId: string, errorMessage: string): Promise<void> {
  await db
    .update(generationJobs)
    .set({ status: "failed", errorMessage, completedAt: new Date() })
    .where(eq(generationJobs.id, jobId));
}
