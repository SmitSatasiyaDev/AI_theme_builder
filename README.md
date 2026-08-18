# AI Theme Studio

Multi-tenant SaaS that lets merchants connect a Shopify store and generate/edit
their theme with AI. This project reuses the generation/validation/merge logic
from `../AI_Schema/ai-schema` (the original CLI tool) as a library, replacing
its local-filesystem persistence and single-user assumptions with a
database-backed, multi-tenant, Shopify-Admin-API-driven implementation. See
the build plan for the full architecture and phased rollout.

Status:
- **Phase 1** — Next.js scaffold, Auth.js (email/password, optional Google) +
  Drizzle/Postgres, organization creation, `/dashboard/[org]` route guards.
- **Phase 2** — Shopify OAuth connect (`app/api/shopify/install|callback`),
  encrypted access-token storage, an Admin GraphQL client (`lib/shopify/`).
- **Phase 3** — the core AI generation loop: a one-shot "business type +
  description" form generates a homepage via a `pg-boss` background job, then
  an explicit "Apply to store" action pushes it live via the Shopify Admin
  API. See `lib/ai-schema/` below.
- **Phase 4** (this state) — conversational multi-turn editing: a chat-style
  UI (`/dashboard/[org]/edit`) sends free-form change requests ("change the
  hero heading to...") through `conversational-edit.js`/`edit-pipeline.js`
  (ported from the original tool), backed by Postgres-persisted sessions and
  theme state instead of the original's local JSON files. Synchronous, not
  queued — a single turn is 1-3 bounded AI calls, fast enough for a direct
  request/response instead of `pg-boss`.
- **Phase 5+** (not built yet) — billing/usage limits, GDPR/uninstall
  webhooks, audit logging, rate limiting.

## Setup

1. Copy `.env.example` to `.env.local` (or `.env`) and fill in:
   - `DATABASE_URL` — a Postgres connection string.
   - `AUTH_SECRET` — generate with `npx auth secret`.
   - `ENCRYPTION_KEY` — a separate long random secret (used to encrypt stored
     Shopify access tokens at rest; do not reuse `AUTH_SECRET`).
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — optional; email/password
     sign-in works without them.
   - `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` / `SHOPIFY_APP_URL` /
     `SHOPIFY_SCOPES` — from a Dev Dashboard app (non-embedded). `SHOPIFY_APP_URL`
     must be a public HTTPS URL (a tunnel in local dev) — Shopify's OAuth
     redirect won't accept `localhost`.
   - `OPENROUTER_API_KEY` (+ optional `OPENROUTER_BASE_URL`/`OPENROUTER_MODEL`)
     — used by `lib/ai-schema/ai-client.js` for every AI call.

2. Install dependencies and push the schema:

   ```bash
   npm install
   npm run db:push
   ```

3. Run the app **and** the background job worker together:

   ```bash
   npm run dev:all
   ```

   (`npm run dev` alone starts only the Next.js server — theme generation
   silently never completes without the worker also running. `npm run worker`
   runs just the worker on its own.)

## Database

Schema lives in `db/schema/*.ts` (Drizzle ORM, Postgres). Useful scripts:

- `npm run db:push` — push schema changes directly (fastest for local dev).
- `npm run db:generate` — generate a SQL migration file.
- `npm run db:studio` — open Drizzle Studio.

## Structure

- `app/(auth)/` — sign in / sign up.
- `app/dashboard/` — org picker + org-scoped dashboard (`[org]/stores`,
  `[org]/generate`, `[org]/edit`, `[org]/settings`).
- `app/api/shopify/install|callback` — Shopify OAuth (state/HMAC verified).
- `app/api/generate` / `app/api/generate/[jobId]` — kick off a generation job,
  poll its status/result.
- `app/api/theme/apply` — push an approved generation result to the store.
- `app/api/edit` — one conversational-edit turn (synchronous).
- `app/api/edit/apply` — push a session's last proposed edit to the store.
- `lib/auth.ts` — Auth.js config (Credentials + optional Google, Drizzle
  adapter).
- `lib/actions/` — server actions (user registration, organization creation).
- `lib/crypto.ts` — AES-256-GCM helpers for encrypting secrets at rest.
- `lib/shopify/` — Admin GraphQL client used by the Stores page.
- `lib/queue.ts` — pg-boss setup (`getBoss()`, `GENERATE_THEME_QUEUE`).
- `lib/ai-schema/` — the ported AI generation library. Most files
  (`retrieval.js`, `merge.js`, `operations.js`, `validation.js`,
  `capability-index.js`, `generation.js`, `brief-logic.js`, `ai-client.js`,
  `edit-pipeline.js`, `conversational-edit.js`) are a near-verbatim CommonJS
  port of `../AI_Schema/ai-schema/*.js` — see each file's header comment for
  exactly what changed. `theme-state.js`, `apply.js`, and
  `conversation-session.js` are rewritten: they read/write the theme via
  `local-theme-fs.js`, which targets a local theme checkout on disk
  (`LOCAL_THEME_ROOT`, defaulting to `../AI_Schema`) rather than the live
  store's theme over the Shopify Admin API — the custom app's token doesn't
  have merchant-approved `read_themes`/`write_themes` — and persist
  state/sessions to Postgres instead of local JSON files. Since `edit-pipeline.js`/
  `conversational-edit.js` are ported *unmodified*, they still call
  `saveThemeState(themeState)` / `loadThemeState(themeId)` /
  `saveSession(session)` / `loadSession(sessionId)` with the original's
  single-argument signature — tenant scoping is smuggled in by encoding
  `storeId`/`userId` into the `themeId`/`sessionId` strings themselves
  (`composeThemeStateId`/`parseThemeStateId` in `theme-state.js`,
  `composeSessionId`/`parseSessionId` in `conversation-session.js`), rather
  than changing the ported files' call sites. `clarification.js` was ported
  in Phase 3 but is still **not wired up anywhere** — Phase 3's one-shot form
  builds a WebsiteBrief directly instead of using its multi-turn Q&A loop,
  and Phase 4's editing flow doesn't use the brief/clarification system at
  all (`edit-pipeline.js` has its own separate, deterministic
  classification/target-resolution). It's dead code today, kept for a future
  multi-turn *generation* clarification flow that would need the same
  DB-backed session treatment given to `conversation-session.js` here.
- `scripts/worker.ts` — the pg-boss worker process that actually runs
  generation jobs. Uses `require()`, not `import`, throughout — see the
  comment at the top of the file for why (ESM import hoisting silently broke
  env-var loading here once).
- `components/generate-panel.tsx` — the generation UI (Base UI + Tailwind):
  submit a prompt, poll job status, review the plan, apply to the store.
- `components/edit-chat-panel.tsx` — the conversational editing UI: a simple
  chat log, session persisted server-side, an "Apply to store" action when a
  turn produces a proposed change.
- `proxy.ts` — Next.js 16's route-protection convention (formerly
  `middleware.ts`); guards `/dashboard/*`.
