# Theme Generation Pipeline — Speed Optimization

Companion to [`THEME_GENERATION_PIPELINE.md`](./THEME_GENERATION_PIPELINE.md) (the pipeline's
overall shape). This document covers a targeted optimization pass on `runStagedGeneration()`
and its worker — same 2-stage architecture, same validation/merge guarantees, faster where it
mattered.

## 1. What was slow

Traced `scripts/worker.ts` → `runStagedGeneration()` → planning → configuration → validation →
merge before changing anything:

| Area | Finding |
| --- | --- |
| Index/product parallelism | **Already parallel.** `worker.ts` already ran both templates' full plan→config pipelines concurrently via one `Promise.all`, and `mergeThemeState()` calls were already correctly sequential (pure/synchronous, each composes onto the previous result). No fix needed here. |
| Stage 2 scoping | **Already scoped.** `buildConfigurationSystemPrompt()` already filtered schemas down to only the section/block types the approved plan actually used. No fix needed here. |
| Stage 1 candidate set | **Not scoped.** `runPlanningStage()` received the *entire template-eligible list* from `getTemplateEligibleSchemas()` (21 of 27 sections for `index`) — deliberately, per the original file-header comment, to avoid keyword-narrowing hurting generalization. The existing `retrieveRelevantSchemas()` keyword-matching machinery existed in the codebase but was never wired into the staged pipeline. |
| Model tier | **Both stages used the same primary model.** `OPENROUTER_FAST_MODEL` was already used for `brief-intake.ts`'s per-turn extraction, but Stage 1 planning (structure-only, no content) called `makeAIRequest()` without a `model` override — always the slow/primary model, identical to Stage 2. |
| Repair retries | **AI-only.** Any validation failure (missing `block_order`, a stringified boolean, an un-wrapped richtext value, a hallucinated image/product reference, an extra unschema'd setting key) went straight to a second full AI call — even though these are all mechanically fixable. |
| Repeated schema loads | **Not an issue.** `worker.ts` already calls `loadSchemas()` once per job and reuses it for `buildThemeState()` and both `runStagedGeneration()` calls. |
| Instrumentation | Rich per-call/per-stage logging already existed (`AI_CALL`, `RETRIEVAL`, `CANDIDATE_VALIDATION`, `MERGE`, `PIPELINE`), but nothing rolled it up into one "where did this job's time/calls/tokens go" view. |

So two of the six stated optimization principles (parallelism, scoped configuration) were
**already implemented**; the real gaps were Stage 1's candidate set, Stage 1's model tier, and
paying for an AI round-trip on mechanically-fixable errors.

## 2. What was changed

**`lib/ai-schema/retrieval.ts`** — added `narrowEligibleSchemasForPlanning()`. Reuses the
existing `matchRules()` keyword→category/tag matching (same mechanism `retrieveRelevantSchemas()`
uses) on top of the already-safe template-eligible envelope. Every fallback path (forced-exclusive
template, already-small eligible set, zero keyword confidence, narrowed count below the
per-template floor) returns the **full eligible set unchanged** — narrowing can only shrink what
Stage 1 sees, never expand it beyond what was already safe. Logs `PLANNING_NARROWED` /
`PLANNING_NARROW_SKIPPED` / `PLANNING_NARROW_BELOW_FLOOR` via the existing `RETRIEVAL` log line.

**`lib/ai-schema/generation.ts`**:
- `runStagedGeneration()` now calls `getTemplateEligibleSchemas()` (unchanged, still the hard
  safety envelope) then `narrowEligibleSchemasForPlanning()` on top of it, and passes the
  *narrowed* set to `runPlanningStage()` while Stage 2 continues to scope from the full eligible
  envelope (unaffected, since the plan can only ever reference types Stage 1 was shown).
- `runPlanningStage()`'s two `makeAIRequest()` calls (initial + repair) now pass
  `model: OPENROUTER_FAST_MODEL`.
- `runPlanningStage()` / `runConfigurationStage()` now track and return per-stage
  `durationMs`/`promptChars`/`outputChars`/`aiCallCount` (previously only known indirectly via
  scattered log lines).
- `StagedGenerationResult` gained `timings`, `retryCount`, `deterministicFixCount`, `promptChars`,
  `outputChars`, `estimatedPromptTokens`, `estimatedOutputTokens` — all additive, no existing
  field changed shape (`generate-cli.ts`'s existing consumers are unaffected).

**`lib/ai-schema/validation.ts`** — added `applyDeterministicRepairs(rawOutput, schemas)`. Runs
on Stage 2's raw AI response *before* `validateOutput()`/`matchesPlan()`/`validateCandidate()`,
fixing only settings-level/`block_order` issues (never a section/block's `type` or the plan's
structure, so it can never violate `matchesPlan()`):
- missing `block_order` → generated from the block keys present; a `block_order` that's
  drifted from the actual blocks → repaired to match
- a checkbox setting sent as the string `"true"`/`"false"` → coerced to boolean
- a number/range setting sent as a numeric string → coerced to a number, then clamped to the
  schema's `min`/`max`
- a `richtext`/`inline_richtext`/`html` value with no HTML tags → wrapped in `<p>...</p>`
- a hallucinated `image`/`image_picker` value → cleared to `""` (mirrors the existing
  `validateOutput()` guard's own rule)
- a hallucinated `product_picker`/`collection` reference → cleared to `""` (mirrors
  `validateDataReferences()`'s existing safe-default posture — no product/collection catalog
  integration exists yet, so any non-empty value is unverifiable)
- a setting key the schema doesn't define at all → dropped (mirrors what `validateSettings()`
  would reject it for anyway)

If a fix resolves everything, validation passes on the **first** attempt and the existing AI
repair call is never spent. If deterministic repair can't fully fix it (or the response isn't
parseable JSON), the existing bounded AI-repair retry runs exactly as before — fail-closed
behavior is unchanged; this is a pure fast path in front of it, not a replacement.

**`lib/ai-schema/instrumentation.ts`** — added `logGenerationSummary()`, one `GENERATION_SUMMARY`
log line per job covering retrieval/planning/configuration/validation/merge timings, AI call
count, retry count, deterministic-fix count, and prompt/output token estimates.

**`scripts/worker.ts`** — times the two `mergeThemeState()` calls and the post-generation
`validateCandidate()` sanity pass, aggregates both templates' new stats, calls
`logGenerationSummary()`, and stores the full timing/count breakdown in `resultJson` alongside
the existing fields (all additive).

Nothing else changed: the Shopify apply flow, `edit-pipeline.ts`/conversational editing,
pg-boss, and OpenRouter usage are untouched; no image generation was added.

## 3. How prompt size changed

Measured directly against the real schema catalog (27 sections / 59 blocks, 54,972 chars /
~13.7K tokens if sent whole — the old pre-staging behavior this pipeline already replaced):

| Stage | Before | After |
| --- | --- | --- |
| Stage 1 candidate envelope (`index`) | 21 template-eligible sections, lightweight listing ≈ 7,127 chars | Narrowed to 15–17 sections depending on brief specificity, listing ≈ 5,727–6,126 chars (**14–20% smaller**, 4–6 fewer candidate types the planner has to reason about) |
| Stage 1 candidate envelope (`product`) | 1 section (forced-exclusive) | Unchanged — already minimal, narrowing correctly declines to touch it |
| Stage 2 scoped schemas | Already scoped to the plan's ~10 used types (pre-existing, unaffected) | Unchanged |

The bigger lever than raw chars turned out to be **avoiding a whole second round-trip**: in the
live smoke-test run below, Stage 2's response needed 19 separate fixes (missing `block_order`,
stray settings, etc.) — every one of which would previously have failed `validateOutput()` /
`validateCandidate()` and triggered a full second AI call (same ~14K-char prompt, another full
model round-trip). Deterministic repair absorbed all 19 in <10ms with zero extra AI calls.

## 4. How AI call count changed

Unchanged in the success case (2 calls: 1 planning + 1 configuration) — the task explicitly
called out that call-count reduction wasn't the goal. What changed is the probability of needing
a **3rd or 4th call** (the repair retries): any of the 19 fix categories above no longer
consumes one. In the live test run, `retryCount: 0` with `deterministicFixCount: 19` — under the
old code, several of those 19 issues (the missing `block_order`, the unschema'd setting keys)
would very plausibly have tripped `validateOutput()`/`validateCandidate()` and forced a second
~245s configuration call.

## 5. Which operations now run in parallel

No change here — they already did:
- Index and product's entire plan→config pipelines already ran concurrently
  (`Promise.all` in `worker.ts`), so both templates' planning stages already overlap in
  wall-clock, and both configuration stages already overlap, without a synchronization barrier
  forcing them to lock-step.
- `mergeThemeState()` calls are correctly sequential (each composes onto the previous result;
  see `merge.ts`'s own header comment) — parallelizing them would be incorrect, not faster.

## 6. Expected impact on generation time

Two independent levers, with different payoffs depending on deployment config:

1. **Deterministic repair (always active, no config needed).** Every repair round-trip it
   absorbs saves one full extra Stage-2 AI call — in this environment's measured run, ~245s.
   This is the highest-value, zero-configuration win from this pass.
2. **Fast model for planning (`OPENROUTER_FAST_MODEL`).** This repo's `.env` does not currently
   set `OPENROUTER_FAST_MODEL`, so it falls back to `OPENROUTER_MODEL` (`moonshotai/kimi-k2.5`)
   — meaning the fast-model wiring is live but **has no effect until a genuinely faster model is
   configured for that variable**. Once set (the same pattern `brief-intake.ts` already uses
   successfully for per-turn field extraction), Stage 1's ~150s (measured) should drop
   substantially, since structure selection is a much narrower task than full content
   generation.
3. **Narrower Stage 1 prompt.** A 14–20% smaller candidate listing and 4–6 fewer types to reason
   over. Real, but secondary to (1) and (2) in this environment, where per-call model latency
   (not prompt tokens) dominates.

## 7. Remaining bottlenecks

- **Model latency dominates.** In the live smoke test, one planning call took ~150s and one
  configuration call took ~245s against `moonshotai/kimi-k2.5` — for a 27-section schema
  catalog, that's latency from the model itself, not prompt size. Prompt-size cuts help less
  than they would against a lower-latency model. Setting `OPENROUTER_FAST_MODEL` to an
  actually-fast model is the single highest-leverage remaining lever, and requires an ops
  decision (model choice/cost tradeoff), not a code change.
- **`product` template has no room left to narrow.** It's already forced to exactly one section
  (`main-product`) by `FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE` — its ~245s Stage 2 call is where
  virtually all of its time already goes, and that's inherent to generating 12–18 blocks' worth
  of content, not a retrieval/prompt-size problem.
- **Deterministic repair only covers settings-level issues.** A structural mistake (wrong block
  count vs. the plan, a section type drift) still requires the existing AI repair call — by
  design, since silently "fixing" structure would violate `matchesPlan()`'s whole purpose.

## 8. Files changed

- `lib/ai-schema/retrieval.ts` — added `narrowEligibleSchemasForPlanning()`
- `lib/ai-schema/generation.ts` — wired narrowing + fast model into Stage 1, wired deterministic
  repair into Stage 2, added timing/token/retry tracking throughout
- `lib/ai-schema/validation.ts` — added `applyDeterministicRepairs()`
- `lib/ai-schema/instrumentation.ts` — added `logGenerationSummary()`
- `lib/ai-schema/types.ts` — additive fields on `StagedGenerationResult` (`timings`, `retryCount`,
  `deterministicFixCount`, prompt/output char and token counts)
- `scripts/worker.ts` — times merge + post-validation, aggregates and logs the consolidated
  per-job summary, stores the breakdown in `resultJson`

Untouched (verified by inspection): the Shopify apply flow, `edit-pipeline.ts` /
`conversational-edit.ts`, pg-boss usage, OpenRouter client shape, and all schema-validation
rules (`validateOutput()`, `validateCandidate()`, `matchesPlan()`, `validateGenerationPlan()`
all still run exactly as before — deterministic repair only runs *before* them).

## 9. Tests run and results

- `npx tsc --noEmit` (project-wide, `strict: true`) — clean, no errors.
- `npx eslint` on all six changed files — clean, no warnings/errors.
- Pure-logic check (`getTemplateEligibleSchemas` + `narrowEligibleSchemasForPlanning`, no
  network) against the real schema catalog for both `index` and `product`, with a
  keyword-rich and a keyword-terse brief — confirmed narrowing engages for `index` (17 or 15 of
  21 eligible sections) and correctly declines to touch the already-minimal `product` set.
- **Live end-to-end smoke test** (`runStagedGeneration()` for `index`, real OpenRouter call,
  real schema catalog, a realistic pet-supplements brief):
  - Retrieval narrowed 21 → 17 eligible sections for planning (`PLANNING_NARROWED`).
  - Planning: 1 AI call, no repair needed, valid plan (10 sections incl. forced hero).
  - Configuration: 1 AI call; deterministic repair applied **19 fixes** with **0 additional AI
    calls**; final `validateCandidate()` passed with 0 errors, 0 warnings.
  - `aiCallCount: 2`, `retryCount: 0`, `deterministicFixCount: 19` — matching the design intent
    exactly (repair retry preserved as a fallback, but not needed here because deterministic
    repair absorbed everything).
  - Total pipeline time for this run: ~395s, of which ~150s was Stage 1 and ~245s was Stage 2 —
    both AI-latency-bound, not prompt-size-bound (see §7).
