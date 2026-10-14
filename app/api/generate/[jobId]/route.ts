import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/http";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { generationJobs } from "@/db/schema/generation";
import { isOrgMember } from "@/lib/organizations";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return jsonError("Not signed in", 401);
  }

  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).limit(1);
  if (!job) {
    return jsonError("Job not found", 404);
  }

  if (!(await isOrgMember(job.orgId, userId))) {
    return jsonError("Not authorized to view this job", 403);
  }

  return NextResponse.json({
    id: job.id,
    type: job.type,
    status: job.status,
    resultJson: job.status === "completed" ? job.resultJson : null,
    errorMessage: job.errorMessage,
    createdAt: job.createdAt,
    completedAt: job.completedAt
  });
}
