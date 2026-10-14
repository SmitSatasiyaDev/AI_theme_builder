import Link from "next/link";
import { redirect } from "next/navigation";
import { desc, eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { getOrgMembership } from "@/lib/organizations";
import { getStoreForOrg } from "@/lib/shopify/client";
import { decryptSecret } from "@/lib/crypto";
import { getAsset, getMainThemeId } from "@/lib/ai-schema/local-theme-fs";
import { db } from "@/db";
import { generationJobs } from "@/db/schema/generation";
import { ThemeWorkspace, type PendingJob } from "@/components/theme-workspace";

export default async function GeneratePage({ params }: { params: Promise<{ org: string }> }) {
  const { org: orgSlug } = await params;
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect("/sign-in");
  }

  const membership = await getOrgMembership(orgSlug, userId);
  if (!membership) {
    redirect("/dashboard");
  }

  const store = await getStoreForOrg(membership.org.id);

  // Decides which chat the workspace opens with — Generate for a store with nothing on disk
  // yet, Edit for one that already has a homepage. See components/theme-workspace.tsx.
  let hasTheme = false;
  // The most recent job, when it's a still-queued/running/completed-but-unapplied
  // "initial_generation" — resumed instead of losing it to a chat transcript that only ever
  // lived in browser state (see PendingJob's doc comment in theme-workspace.tsx). If the
  // store's last job is an "apply" (i.e. that generation was already applied) or a
  // "targeted_edit", there's nothing pending and this stays null.
  let pendingJob: PendingJob | null = null;
  if (store) {
    const accessToken = decryptSecret(store.accessTokenEncrypted);
    const themeId = store.activeThemeId ?? (await getMainThemeId());
    const asset = await getAsset(store.shopDomain, accessToken, themeId, "templates/index.json");
    hasTheme = !!asset;

    const [latestJob] = await db
      .select()
      .from(generationJobs)
      .where(eq(generationJobs.storeId, store.id))
      .orderBy(desc(generationJobs.createdAt))
      .limit(1);

    // Both templates generate together (see scripts/worker.ts) — resultJson.templates has one
    // entry per template, each carrying its own proposed config. A job completed before that
    // change has the old single-template shape (no `templates` key) — the current UI can't
    // render it meaningfully (see generate-chat-panel.tsx), so it's treated as not-pending
    // rather than resumed into a chat panel that would show nothing useful. hasTheme (above)
    // already reflects whatever that old job actually wrote to disk, so nothing is lost —
    // the workspace just opens in Edit mode instead of resuming an unrenderable job card.
    const resultJson = latestJob?.resultJson as { templates?: Record<string, { config?: unknown }> } | null;
    const isResumable = latestJob?.status !== "completed" || !!resultJson?.templates;

    if (latestJob?.type === "initial_generation" && latestJob.status !== "failed" && isResumable) {
      const config = resultJson?.templates
        ? (Object.fromEntries(
            Object.entries(resultJson.templates).map(([templateName, result]) => [templateName, result.config])
          ) as PendingJob["config"])
        : null;
      pendingJob = { id: latestJob.id, config };
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">Theme</h1>

      {!store ? (
        <p className="text-gray-600">
          Connect a Shopify store first —{" "}
          <Link href={`/dashboard/${orgSlug}/stores`} className="font-medium text-black underline">
            go to Stores
          </Link>
          .
        </p>
      ) : (
        <ThemeWorkspace orgSlug={orgSlug} hasTheme={hasTheme} pendingJob={pendingJob} />
      )}
    </div>
  );
}
