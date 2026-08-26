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
import type { Brief } from "../lib/ai-schema/types";

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

    // Written by app/api/generate/chat/route.ts as JSON.stringify(brief)
    // once the intake conversation has gathered enough to generate.
    const brief = JSON.parse(job.inputPrompt || "{}") as Brief;
    const templateNames = ["index", "product"];

    // Both templates are independent generations against the same brief (the brief already
    // carries a "products" field the product template's Stage 2 can use) — running them
    // concurrently rather than sequentially halves the wall-clock cost of the two AI-call
    // pairs, the same way Shopforge parallelizes its own index+product generation.
    const wallClockStart = Date.now();
    const [generatedIndex, generatedProduct] = await Promise.all(
      templateNames.map(templateName =>
        runStagedGeneration({
          brief,
          schemas: fullSchemas,
          themeState,
          templateName,
          requestId: `${jobId}:${templateName}`
        })
      )
    );

    const indexValidation = validateCandidate(generatedIndex.config, fullSchemas, {
      templateName: "index",
      themeState
    });
    const productValidation = validateCandidate(generatedProduct.config, fullSchemas, {
      templateName: "product",
      themeState
    });

    // Sequential, not parallel: mergeThemeState() is pure/synchronous and each call only
    // touches its own template entry (see merge.ts's file header) — feeding the first result's
    // mergedThemeState as the second call's base composes both into one final state without
    // either merge needing to know about the other.
    //
    // Phase 3 targets a fresh homepage generation, which intentionally replaces the template's
    // own section structure — see merge.js's header comment on mergeFullStructureTemplate(). A
    // generic Shopify theme's default index.json will usually contain sections our AI schema
    // catalog doesn't recognize, so this is acknowledged by design here rather than failing
    // closed on every first run. The product template goes through mergeForcedExclusiveTemplate
    // instead (splices main-product in by type match, see merge.ts) — the flag is a no-op there.
    const mergedIndex = mergeThemeState(themeState, {
      templateName: "index",
      candidate: generatedIndex.config,
      candidateValidation: indexValidation,
      acknowledgeUnknownSectionReplacement: true,
      requestId: `${jobId}:index`
    });
    if (!mergedIndex.valid) {
      throw new Error(
        `Merge failed for index: ${mergedIndex.conflicts.map((c: { code: string; message: string }) => `[${c.code}] ${c.message}`).join("; ")}`
      );
    }

    const mergedProduct = mergeThemeState(mergedIndex.mergedThemeState, {
      templateName: "product",
      candidate: generatedProduct.config,
      candidateValidation: productValidation,
      acknowledgeUnknownSectionReplacement: true,
      requestId: `${jobId}:product`
    });
    if (!mergedProduct.valid) {
      throw new Error(
        `Merge failed for product: ${mergedProduct.conflicts.map((c: { code: string; message: string }) => `[${c.code}] ${c.message}`).join("; ")}`
      );
    }

    const combinedSummary = {
      changedFiles: [...mergedIndex.summary!.changedFiles, ...mergedProduct.summary!.changedFiles],
      changedTemplates: [...mergedIndex.summary!.changedTemplates, ...mergedProduct.summary!.changedTemplates],
      addedSections: [...mergedIndex.summary!.addedSections, ...mergedProduct.summary!.addedSections],
      updatedSections: [...mergedIndex.summary!.updatedSections, ...mergedProduct.summary!.updatedSections],
      removedSections: [...mergedIndex.summary!.removedSections, ...mergedProduct.summary!.removedSections],
      changedSettings: [...mergedIndex.summary!.changedSettings, ...mergedProduct.summary!.changedSettings],
      preservedUnknownComponents: [
        ...mergedIndex.summary!.preservedUnknownComponents,
        ...mergedProduct.summary!.preservedUnknownComponents
      ]
    };

    await db.update(generationJobs).set({
      status: "completed",
      resultJson: {
        templates: {
          index: {
            plan: generatedIndex.plan,
            config: generatedIndex.config,
            warnings: generatedIndex.warnings,
            candidateValidation: indexValidation,
            planRepaired: generatedIndex.planRepaired,
            configRepaired: generatedIndex.configRepaired,
            aiCallCount: generatedIndex.aiCallCount,
            durationMs: generatedIndex.durationMs
          },
          product: {
            plan: generatedProduct.plan,
            config: generatedProduct.config,
            warnings: generatedProduct.warnings,
            candidateValidation: productValidation,
            planRepaired: generatedProduct.planRepaired,
            configRepaired: generatedProduct.configRepaired,
            aiCallCount: generatedProduct.aiCallCount,
            durationMs: generatedProduct.durationMs
          }
        },
        mergeSummary: combinedSummary,
        mergedThemeState: mergedProduct.mergedThemeState,
        aiCallCount: generatedIndex.aiCallCount + generatedProduct.aiCallCount,
        durationMs: Date.now() - wallClockStart
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
