// Standalone pg-boss worker process — run alongside `next dev`/`next start`
// (see package.json's "dev"/"worker" scripts), not bundled into the Next.js
// server.
//
// This whole file deliberately uses require(), not `import`, for every
// value it needs (Node's built-in env loader below included) — with ESM
// `import` syntax anywhere in the file, those imports get HOISTED and
// evaluated before any other top-level statement runs, regardless of
// source order. That silently ran `import { db } from "../db"` (which
// opens a Postgres connection using DATABASE_URL at module-eval time)
// before this file's own env-loading line, even though that line was
// written first. require() calls execute strictly top-to-bottom, which is
// what makes the ordering below actually reliable. `import type` is fine
// to keep — it's erased at compile time and never affects load order.

try {
  process.loadEnvFile();
} catch {
  // no .env file present in cwd — assume the environment is already set
}

import type { Job } from "pg-boss";

const { eq } = require("drizzle-orm");
const { db } = require("../db");
const { generationJobs, shopifyStores } = require("../db/schema");
const { decryptSecret } = require("../lib/crypto");
const { getBoss, GENERATE_THEME_QUEUE } = require("../lib/queue");
type GenerateThemeJobData = { jobId: string };

const { getMainThemeId } = require("../lib/ai-schema/local-theme-fs");
const { loadSchemas } = require("../lib/ai-schema/ai-client");
const { buildThemeState, saveThemeStateForStore } = require("../lib/ai-schema/theme-state");
const { runStagedGeneration } = require("../lib/ai-schema/generation");
const { validateCandidate } = require("../lib/ai-schema/validation");
const { mergeThemeState } = require("../lib/ai-schema/merge");
const { createEmptyBrief } = require("../lib/ai-schema/brief-logic");

// Phase 3 scope: a one-shot form (business type + free-form description),
// not the original CLI's multi-turn clarification.js flow — that needs
// DB-backed session persistence and belongs with Phase 4's conversational
// editing work. This builds a WebsiteBrief directly instead.
function buildOneShotBrief(businessType: string, prompt: string) {
  const brief = createEmptyBrief();
  brief.businessType = { value: businessType, status: "confirmed", source: "user" };
  if (prompt) {
    brief.additionalRequirements = { value: prompt, status: "confirmed", source: "user" };
  }
  return brief;
}

async function processGenerateTheme(jobId: string) {
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, jobId)).limit(1);
  if (!job) {
    console.error(`[worker] job ${jobId} not found`);
    return;
  }

  await db.update(generationJobs).set({ status: "running" }).where(eq(generationJobs.id, jobId));

  try {
    const [store] = await db.select().from(shopifyStores).where(eq(shopifyStores.id, job.storeId)).limit(1);
    if (!store) throw new Error("Connected store not found");

    const accessToken = decryptSecret(store.accessTokenEncrypted);
    let themeId = store.activeThemeId;
    if (!themeId) {
      themeId = await getMainThemeId(store.shopDomain, accessToken);
      await db.update(shopifyStores).set({ activeThemeId: themeId }).where(eq(shopifyStores.id, store.id));
    }

    const fullSchemas = await loadSchemas();

    const themeState = await buildThemeState({
      shopDomain: store.shopDomain,
      accessToken,
      themeId,
      schemas: fullSchemas,
      context: { requestId: jobId }
    });
    await saveThemeStateForStore(store.id, themeId, themeState);

    const inputPayload = JSON.parse(job.inputPrompt || "{}") as { businessType?: string; prompt?: string };
    const brief = buildOneShotBrief(inputPayload.businessType || "", inputPayload.prompt || "");
    const templateName = "index";

    const generated = await runStagedGeneration({
      brief,
      schemas: fullSchemas,
      themeState,
      templateName,
      requestId: jobId
    });

    const candidateValidation = validateCandidate(generated.config, fullSchemas, {
      templateName,
      themeState
    });

    // Phase 3 targets a fresh homepage generation, which intentionally
    // replaces the template's own section structure — see merge.js's
    // header comment on mergeFullStructureTemplate(). A generic Shopify
    // theme's default index.json will usually contain sections our AI
    // schema catalog doesn't recognize, so this is acknowledged by design
    // here rather than failing closed on every first run.
    const merged = mergeThemeState(themeState, {
      templateName,
      candidate: generated.config,
      candidateValidation,
      acknowledgeUnknownSectionReplacement: true,
      requestId: jobId
    });

    if (!merged.valid) {
      throw new Error(
        `Merge failed: ${merged.conflicts.map((c: { code: string; message: string }) => `[${c.code}] ${c.message}`).join("; ")}`
      );
    }

    await db.update(generationJobs).set({
      status: "completed",
      resultJson: {
        templateName,
        plan: generated.plan,
        config: generated.config,
        warnings: generated.warnings,
        candidateValidation,
        mergeSummary: merged.summary,
        mergedThemeState: merged.mergedThemeState,
        planRepaired: generated.planRepaired,
        configRepaired: generated.configRepaired,
        aiCallCount: generated.aiCallCount,
        durationMs: generated.durationMs
      },
      completedAt: new Date()
    }).where(eq(generationJobs.id, jobId));
  } catch (error) {
    console.error(`[worker] job ${jobId} failed`, error);
    await db.update(generationJobs).set({
      status: "failed",
      errorMessage: error instanceof Error ? error.message : String(error),
      completedAt: new Date()
    }).where(eq(generationJobs.id, jobId));
  }
}

async function main() {
  const boss = await getBoss();
  await boss.work(GENERATE_THEME_QUEUE, async ([job]: Job<GenerateThemeJobData>[]) => {
    await processGenerateTheme(job.data.jobId);
  });
  console.log(`[worker] listening on "${GENERATE_THEME_QUEUE}"`);
}

main().catch((error) => {
  console.error("[worker] fatal error", error);
  process.exit(1);
});
