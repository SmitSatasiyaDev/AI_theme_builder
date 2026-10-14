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
import type { Brief, MergeConflict, MergeSummary, StagedGenerationResult, ValidationResult } from "../lib/ai-schema/types";
import type { GenerateThemeJobData } from "../lib/queue";

const { eq } = require("drizzle-orm");
const { db } = require("../db");
const { generationJobs, shopifyStores } = require("../db/schema");
const { decryptSecret } = require("../lib/crypto");
const { errorMessage } = require("../lib/errors");
const { completeJob, failJob } = require("../lib/jobs");
const { getBoss, GENERATE_THEME_QUEUE } = require("../lib/queue");

const { getMainThemeId } = require("../lib/ai-schema/local-theme-fs");
const { loadSchemas } = require("../lib/ai-schema/ai-client");
const { buildThemeState } = require("../lib/ai-schema/theme-state");
const { runStagedGeneration } = require("../lib/ai-schema/generation");
const { validateCandidate } = require("../lib/ai-schema/validation");
const { mergeThemeState } = require("../lib/ai-schema/merge");
const instrumentation = require("../lib/ai-schema/instrumentation");

/** Concatenates every list in two per-template merge summaries into one job-level summary. */
function combineMergeSummaries(a: MergeSummary, b: MergeSummary): MergeSummary {
  const combined = {} as MergeSummary;
  for (const key of Object.keys(a) as (keyof MergeSummary)[]) {
    combined[key] = [...a[key], ...b[key]];
  }
  return combined;
}

function formatConflicts(conflicts: MergeConflict[]): string {
  return conflicts.map((c) => `[${c.code}] ${c.message}`).join("; ");
}

/** The per-template slice of a job's stored resultJson (read back by the generate page/chat). */
function templateResultSummary(generated: StagedGenerationResult, candidateValidation: ValidationResult) {
  return {
    plan: generated.plan,
    config: generated.config,
    warnings: generated.warnings,
    candidateValidation,
    planRepaired: generated.planRepaired,
    configRepaired: generated.configRepaired,
    aiCallCount: generated.aiCallCount,
    retryCount: generated.retryCount,
    deterministicFixCount: generated.deterministicFixCount,
    durationMs: generated.durationMs,
    timings: generated.timings
  };
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

    // Freshly rebuilt from the real theme files on disk — the only live
    // ThemeState source now (see theme-state.ts's buildThemeState); this is
    // not cached anywhere, so every generation reads current reality.
    const themeState = await buildThemeState({
      shopDomain: store.shopDomain,
      accessToken,
      themeId,
      schemas: fullSchemas,
      context: { requestId: jobId }
    });

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

    // Final sanity-check pass against the FULL (untrimmed) catalog + live themeState —
    // deliberately a second, separate validateCandidate() call from the one already run
    // inside runConfigurationStage() (which validates against the trimmed candidate set
    // and without themeState context) — both are pure/local/synchronous, no DB or
    // network I/O, so timing them costs only what the validation logic itself costs.
    const postValidationStart = Date.now();
    const indexValidation = validateCandidate(generatedIndex.config, fullSchemas, {
      templateName: "index",
      themeState
    });
    const productValidation = validateCandidate(generatedProduct.config, fullSchemas, {
      templateName: "product",
      themeState
    });
    const postValidationMs = Date.now() - postValidationStart;

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
    const mergeStart = Date.now();
    const mergedIndex = mergeThemeState(themeState, {
      templateName: "index",
      candidate: generatedIndex.config,
      candidateValidation: indexValidation,
      acknowledgeUnknownSectionReplacement: true,
      requestId: `${jobId}:index`
    });
    if (!mergedIndex.valid) {
      throw new Error(`Merge failed for index: ${formatConflicts(mergedIndex.conflicts)}`);
    }

    const mergedProduct = mergeThemeState(mergedIndex.mergedThemeState, {
      templateName: "product",
      candidate: generatedProduct.config,
      candidateValidation: productValidation,
      acknowledgeUnknownSectionReplacement: true,
      requestId: `${jobId}:product`
    });
    if (!mergedProduct.valid) {
      throw new Error(`Merge failed for product: ${formatConflicts(mergedProduct.conflicts)}`);
    }
    const mergeMs = Date.now() - mergeStart;

    const combinedSummary = combineMergeSummaries(mergedIndex.summary!, mergedProduct.summary!);

    const totalMs = Date.now() - wallClockStart;
    const aiCallCount = generatedIndex.aiCallCount + generatedProduct.aiCallCount;
    const retryCount = generatedIndex.retryCount + generatedProduct.retryCount;
    const deterministicFixCount = generatedIndex.deterministicFixCount + generatedProduct.deterministicFixCount;
    const promptChars = generatedIndex.promptChars + generatedProduct.promptChars;
    const outputChars = generatedIndex.outputChars + generatedProduct.outputChars;
    const validationMs = generatedIndex.timings.validationMs + generatedProduct.timings.validationMs + postValidationMs;

    // §8 — one consolidated, easy-to-grep line covering the whole job: every number
    // here is also already logged piecemeal by generation.ts/merge.ts/instrumentation.ts
    // as the job ran, this is just the single before/after summary view.
    const timings = {
      retrievalMs: generatedIndex.timings.retrievalMs + generatedProduct.timings.retrievalMs,
      indexPlanningMs: generatedIndex.timings.planningMs,
      productPlanningMs: generatedProduct.timings.planningMs,
      indexConfigurationMs: generatedIndex.timings.configurationMs,
      productConfigurationMs: generatedProduct.timings.configurationMs,
      validationMs,
      mergeMs,
      totalMs
    };

    instrumentation.logGenerationSummary({
      requestId: jobId,
      jobId,
      ...timings,
      aiCallCount,
      retryCount,
      deterministicFixCount,
      promptChars,
      outputChars
    });

    await completeJob(jobId, {
      templates: {
        index: templateResultSummary(generatedIndex, indexValidation),
        product: templateResultSummary(generatedProduct, productValidation)
      },
      mergeSummary: combinedSummary,
      mergedThemeState: mergedProduct.mergedThemeState,
      aiCallCount,
      retryCount,
      deterministicFixCount,
      promptChars,
      outputChars,
      timings,
      durationMs: totalMs
    });
  } catch (error) {
    console.error(`[worker] job ${jobId} failed`, error);
    await failJob(jobId, errorMessage(error));
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
