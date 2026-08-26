# Project Overview — ai-schema-saas

Reference doc for this codebase's architecture and AI theme-generation pipeline, so future work doesn't require re-exploring the whole project from scratch. Last verified: 2026-08-19 (against commit `50b9da5`). If the code has moved on significantly since, treat this as a starting map, not ground truth — re-check the cited files before relying on specifics.

## What this project is

A **Next.js 16 (canary) multi-tenant SaaS** that generates and edits Shopify theme *configuration* using AI. It is **not** a Shopify Theme App Extension and **not** a tool that writes raw Liquid — it's a layer that AI-configures sections/blocks of one pre-vendored base theme (Dawn-style).

This app (`f:\theme-builder\ai-schema-saas`) is a Postgres/multi-tenant port of a more mature standalone CLI project at `f:\theme-builder\AI_Schema` (referenced throughout code comments as "Phase 1–9" source of truth). When investigating unfamiliar behavior, that sibling project may hold the original design intent.

## Tech stack

- **Framework**: Next.js 16 canary — check `node_modules/next/dist/docs/` before assuming standard Next.js APIs (per `AGENTS.md`)
- **DB/ORM**: Postgres + Drizzle ORM (`db/schema/*.ts`)
- **Auth**: NextAuth v5 beta
- **Job queue**: `pg-boss` (durable Postgres-backed queue), worker at `scripts/worker.ts`
- **Styling**: Tailwind 4
- **AI calls**: raw `fetch()` against **OpenRouter** (`lib/ai-schema/ai-client.ts:259`) — no Vercel AI SDK, no official Anthropic/OpenAI SDK. Default model `moonshotai/kimi-k2.5` (`OPENROUTER_MODEL`, `ai-client.ts:28`), `temperature: 0.8`, `response_format: json_object`.

## High-level flow

1. User signs in, connects a Shopify store via OAuth (`app/api/shopify/install`, `app/api/shopify/callback`).
2. **Initial generation** is a chat: each turn hits `app/api/generate/chat/route.ts`, which extracts `Brief` fields from the message (`lib/ai-schema/brief-intake.ts`) and either asks one follow-up question or, once enough is known, enqueues a generation job. **Targeted edits** are a separate chat (`app/api/edit`).
3. A `pg-boss` job (`scripts/worker.ts`) runs the staged AI pipeline in `lib/ai-schema/`, reading the accreted `Brief` from `generationJobs.inputPrompt`.
4. Pipeline produces a validated **theme state** (JSON section/block config) and merges it into the existing theme structure.
5. Result is "applied" — see **gap #1** below for what this actually does today.

## The generation pipeline (`lib/ai-schema/`)

The core design decision: **the AI never writes Liquid.** It only selects and configures sections/blocks that already exist in the vendored base theme, constrained by hand-authored schema files describing each section/block's real settings (`lib/ai-schema/schema-data/{sections,blocks}/*.json`, 85 files: settings, `allowed_blocks`, `max_blocks`, `allowed_on`). This sidesteps invalid-Liquid, hallucinated-tag, and truncation failure modes common to "AI writes a whole theme" tools.

That base theme is vendored in-repo at `theme_base/theme/` (gitignored, ~31 MB, copied from the sibling `AI_Schema` project — see README "Setup"). `LOCAL_THEME_ROOT` points at it, and `pnpm theme:dev --store <shop>` serves it via the Shopify CLI so generated output can be previewed as a real storefront.

Steps, for **initial generation**:

1. **Retrieval** (`lib/ai-schema/retrieval.ts`) — deterministic, no LLM. Filters candidate sections/blocks by `allowed_on` + keyword rules (`schema-data/retrieval-rules.json`). Falls back to the full catalog on low confidence (`retrieval.ts:207-262`). Forced-exclusive templates (e.g. `product` → `main-product` only) short-circuit to one section (`FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE`, `retrieval.ts:70`).
2. **Stage 1 — Planning** (`generation.ts:107-283`, `runPlanningStage`) — one AI call chooses section/block *types and order* only, no content. Validated structurally + against retrieved candidates (`validateGenerationPlan`); one bounded repair retry; throws (aborts) if repair also fails (`generation.ts:277`).
3. **Stage 2 — Configuration** (`generation.ts:289-472`, `runConfigurationStage`) — second AI call fills settings/content for exactly the approved plan. Validated three ways: `validateOutput()` (structural/type/`max_blocks`/`block_order`/image-hallucination, `ai-client.ts:341-533`), `matchesPlan()` (rejects drift from Stage 1, `generation.ts:367-396`), `validateCandidate()` (`validation.ts:396-409`: `allowed_on` checks, per-setting type/enum/range checks, product/collection hallucination guard). One bounded repair retry, then throws.
4. **Merge** (`lib/ai-schema/merge.ts`) — pure, deterministic reconciliation against existing `ThemeState`. Targeted splice-by-type for forced-exclusive templates; full-structure replacement for `index` (requires `acknowledgeUnknownSectionReplacement: true` — see gap #5).
5. **Apply** (`lib/ai-schema/apply.js` + `local-theme-fs.ts`) — verify-before-write, backs up, writes, verifies, best-effort rollback on partial failure (`apply.js:106-151`).

For **targeted edits** (`edit-pipeline.ts`, `operations.ts`, `conversational-edit.ts`): closed operation vocabulary (`update_section`, `add_block`, etc.), deterministic keyword-based target resolution with an AI fallback that's still re-validated deterministically, ambiguity → clarification questions (never guesses), atomic multi-op execution with all-or-nothing rollback (`operations.ts:589-621`).

## Data model (Postgres via Drizzle, `db/schema/`)

- `organization` / `organization_member` — multi-tenant orgs + roles
- `shopify_store` — one store per org; `accessTokenEncrypted` (AES-256-GCM, `lib/crypto.ts`); `activeThemeId`
- `generation_job` — job queue table (`type`: initial_generation/targeted_edit/apply; `status`: queued/running/completed/failed; `resultJson` jsonb)
- `theme_state` — full JSON config snapshot per `(storeId, themeId)`, monotonic `version` via `onConflictDoUpdate` (`theme-state.ts:315-327`) — **overwrite-in-place, no history table**
- `conversation_session` — one row per multi-turn edit session (`turnsJson` jsonb)
- `brief` — "WebsiteBrief" (business type, audience, tone, etc.) per session
- `usage_counter` — per-org, per-period generation counts (billing/quota scaffolding)

There's no conventional `themes`/`generations` join table — a "theme" is really "the live Shopify theme's JSON state as last observed," and a "generation" is a job row plus the `theme_state` row it produced.

## Known gaps / risks (as of 2026-08-19)

Priority order, most important first:

1. **Theme is never actually deployed to the live Shopify store.** `local-theme-fs.ts` `getAsset`/`putAsset` **ignore** the `shopDomain`/`accessToken`/`themeId` args they receive and instead read/write a local filesystem checkout at `LOCAL_THEME_ROOT` (`local-theme-fs.ts:88-115`). This is a deliberate stopgap — a custom app's access token can't get merchant approval for `read_themes`/`write_themes`. Practical effect: the full OAuth/store-connection flow works but has **zero live effect on any merchant's store**; every tenant's "apply" writes to the same single local checkout. Fixing it means becoming a public app/Theme App Extension to get scopes approved, or another architecture for controlling an installed theme.

   **This is deliberately deferred to last** (owner's call, 2026-08-19): it's a Shopify-approval problem, not a code problem, and the generation quality work does not depend on it. Preview generated output locally with `pnpm theme:dev` instead. Do not treat this as a blocker on other work.
2. **No product/collection catalog wired into generation.** `knownMerchantData` defaults to `{}` everywhere (`validation.ts:298-311`); the hallucination guard strips out *every* product/collection reference, even valid ones. `getProductsForOrg()` (`lib/shopify/client.ts:77`) exists and is used elsewhere but never feeds generation.
3. **`acknowledgeUnknownSectionReplacement: true` is hardcoded** in both callers (`worker.ts:110`, `generate-cli.ts:235`), defeating the safeguard meant to stop silently discarding a merchant's unrecognized existing sections.
4. **Zero automated tests** anywhere in the repo, despite `validation.ts`/`merge.ts`/`operations.ts`/`generation.ts` being pure, deterministic, high-value-to-test logic that is the system's entire safety backbone.
5. **No real rollback/history** — `theme_state.version` is a counter, not a queryable history; `apply.js`'s rollback only covers the immediately preceding value during a partial-failure recovery, not user-facing "undo."
6. **`console.log`-only instrumentation** (`instrumentation.ts`) — no APM/metrics backend.
7. **Color palette AI call is unvalidated.** `generateAIColorPalette()` (`ai-client.ts:598-720`) only checks that two keys exist, no hex-format validation — the one LLM output path without schema validation.
8. **Single fixed base theme.** All generation is scoped to one vendored `LOCAL_THEME_ROOT` theme — "AI theme generation" here means AI-driven *configuration* of one theme (via section choice + color), not bespoke per-merchant themes.

## Assessment (for context on prior discussion)

The generation/validation/edit architecture in `lib/ai-schema/` is sound and more disciplined than typical "AI generates a whole site" tools — schema-constrained JSON output instead of raw Liquid, plan→configure staging, bounded repair loops, deterministic validation, non-destructive merge. The one structural gap is at the boundary between this pipeline and the actual product: it produces a fully validated theme state and then writes it to a local folder instead of the merchant's store (gap #1) — deferred by design.

Current focus is **generation quality and functionality**, not UI polish and not deployment: making the AI gather better input (done — conversational intake), feed it real merchant data (gap #2), and give the deterministic safety logic test coverage (gap #4).
