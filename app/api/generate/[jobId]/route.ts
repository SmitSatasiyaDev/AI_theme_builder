import { eq } from "drizzle-orm";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { generationJobs } from "@/db/schema/generation";
import { isOrgMember } from "@/lib/organizations";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).limit(1);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  if (!(await isOrgMember(job.orgId, userId))) {
    return NextResponse.json({ error: "Not authorized to view this job" }, { status: 403 });
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
