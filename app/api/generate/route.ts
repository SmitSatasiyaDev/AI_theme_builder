import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { requireOrgMembership } from "@/lib/actions/organizations";
import { getStoreForOrg } from "@/lib/shopify/client";
import { db } from "@/db";
import { generationJobs } from "@/db/schema/generation";
import { getBoss, GENERATE_THEME_QUEUE } from "@/lib/queue";

export async function POST(req: NextRequest) {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const orgSlug = body?.org as string | undefined;
  const businessType = String(body?.businessType ?? "").trim();
  const prompt = String(body?.prompt ?? "").trim();

  if (!orgSlug || !businessType || !prompt) {
    return NextResponse.json({ error: "org, businessType, and prompt are required" }, { status: 400 });
  }

  const membership = await requireOrgMembership(orgSlug, userId);
  if (!membership) {
    return NextResponse.json({ error: "Not a member of this organization" }, { status: 403 });
  }

  const store = await getStoreForOrg(membership.org.id);
  if (!store) {
    return NextResponse.json({ error: "Connect a Shopify store first" }, { status: 400 });
  }

  const [job] = await db
    .insert(generationJobs)
    .values({
      orgId: membership.org.id,
      storeId: store.id,
      userId,
      type: "initial_generation",
      status: "queued",
      inputPrompt: JSON.stringify({ businessType, prompt })
    })
    .returning();

  const boss = await getBoss();
  await boss.send(GENERATE_THEME_QUEUE, { jobId: job.id });

  return NextResponse.json({ jobId: job.id });
}
