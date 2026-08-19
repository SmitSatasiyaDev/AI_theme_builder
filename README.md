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

1. Copy `.env.example` to **`.env`** and fill it in.

   Use `.env`, **not** `.env.local`. Next.js reads both, but the background
   worker (`scripts/worker.ts`) loads its environment with
   `process.loadEnvFile()`, which reads `.env` only — putting values in
   `.env.local` silently gives the web app and the worker two different
   configurations (most visibly, two different `LOCAL_THEME_ROOT`s).

   - `DATABASE_URL` — a Postgres connection string.
   - `AUTH_SECRET` — generate with `pnpm dlx auth secret`.
   - `ENCRYPTION_KEY` — a separate long random secret (used to encrypt stored
     Shopify access tokens at rest; do not reuse `AUTH_SECRET`). Anything that
     touches a stored Shopify token throws `ENCRYPTION_KEY is not set` without
     it — see `lib/crypto.ts`.
   - `LOCAL_THEME_ROOT` — **required**, absolute path to a Shopify theme
     checkout (the directory containing `templates/`, `config/`, `sections/`,
     …). This repo vendors one at `theme_base/theme`, so the usual value is
     `<repo>/theme_base/theme`. There is no fallback: generation and "apply"
     read and write this directory instead of the connected store's live theme
     (see `lib/ai-schema/local-theme-fs.ts` for why). If it is unset or points
     somewhere that doesn't exist, the first theme read throws and names the
     variable.
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — optional; email/password
     sign-in works without them.
   - `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET` / `SHOPIFY_APP_URL` /
     `SHOPIFY_SCOPES` — from a Dev Dashboard app (non-embedded). `SHOPIFY_APP_URL`
     must be a public HTTPS URL (a tunnel in local dev) — Shopify's OAuth
     redirect won't accept `localhost`. Keep `SHOPIFY_SCOPES=read_products`:
     `read_themes`/`write_themes` are deliberately not requested, since the
     custom app can't get merchant approval for them — that is precisely why
     theme I/O goes to `LOCAL_THEME_ROOT` on disk.
   - `OPENROUTER_API_KEY` (+ optional `OPENROUTER_BASE_URL`/`OPENROUTER_MODEL`)
     — used by `lib/ai-schema/ai-client.ts` for every AI call.

   Note that `theme_base/` is listed in `.gitignore`, so a fresh clone has no
   theme checkout and must obtain one before `LOCAL_THEME_ROOT` can point at
   anything.

2. Install dependencies and push the schema:

   ```bash
   pnpm install
   pnpm db:push
   ```

   This project is on **pnpm** (see `packageManager` in `package.json`); there
   is no `package-lock.json`. `pnpm-workspace.yaml` pre-approves the two
   dependency build scripts that matter (`esbuild`, which supplies the binary
   `tsx` runs the worker and `db:local` with, and `unrs-resolver`), so the
   install needs no `pnpm approve-builds` prompt.

3. Run the app **and** the background job worker together:

   ```bash
   pnpm dev:all
   ```

   (`pnpm dev` alone starts only the Next.js server — theme generation
   silently never completes without the worker also running. `pnpm worker`
   runs just the worker on its own.)

## Database

Schema lives in `db/schema/*.ts` (Drizzle ORM, Postgres). Useful scripts:

- `pnpm db:push` — push schema changes directly (fastest for local dev).
- `pnpm db:generate` — generate a SQL migration file.
- `pnpm db:studio` — open Drizzle Studio.
- `pnpm db:local` — talk to `DATABASE_URL` straight from the terminal, no GUI:

  ```bash
  pnpm db:local                                # interactive shell
  pnpm db:local "select id, email from users"  # run one query and exit
  pnpm db:local -f some/migration.sql          # run a .sql file
  echo "select count(*) from generation_jobs" | pnpm db:local
  ```

  With `psql` installed the interactive form hands over to it (history, tab
  completion, pager); otherwise it falls back to a built-in shell that
  understands `\dt`, `\d <table>` and `\q`. Statements are read until a `;`,
  so multi-line SQL can be pasted in. `-h` prints the full usage.

  Several `;`-separated statements run as one batch — all of them execute, but
  Postgres reports back per row-returning statement, so DDL/DML lines in a
  batch may not print a result tag of their own.

## Generating from the terminal

`pnpm generate "<prompt>"` runs the exact pipeline `scripts/worker.ts` runs, but
without the browser, sign-up, Shopify OAuth, queue or database — handy for
exercising the AI side on its own:

```bash
pnpm generate "modern coffee shop, warm tones, big hero"
pnpm generate --type restaurant --template index "brunch spot, menu + gallery"
pnpm generate --out-dir theme_out "..."   # write into a copy of the theme
pnpm generate --apply "..."               # write into LOCAL_THEME_ROOT itself
pnpm generate --out result.json "..."     # dump the full result JSON
```

It reports each stage — theme read, AI generation, validation, merge — and by
default does a *dry-run* apply that names the files it would write without
touching them. It needs `OPENROUTER_API_KEY` and `LOCAL_THEME_ROOT` and nothing
else; there is no connected store because theme I/O goes to the local checkout
either way. Every run makes real, paid OpenRouter calls.

Two ways to actually write the result:

- `--out-dir <dir>` copies the whole theme there (~30 MB, well under a second)
  and writes the generated template into **that copy**, so the vendored theme
  is never modified. Preview it with `shopify theme dev --path <dir>`. An
  existing directory is reused so successive runs stack up; `--fresh` re-copies
  from the vendored theme first. `theme_out*` is gitignored.
- `--apply` overwrites `LOCAL_THEME_ROOT` in place — the same thing the worker
  and the app's "Apply to store" button do. Since `theme_base/` is gitignored,
  there is no way to recover the previous `templates/index.json` afterwards, so
  prefer `--out-dir` while experimenting.

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
