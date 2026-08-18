# AI Theme Studio

Multi-tenant SaaS that lets merchants connect a Shopify store and generate/edit
their theme with AI. This project reuses the generation/validation/merge logic
from `../AI_Schema/ai-schema` (the original CLI tool) as a library, replacing
its local-filesystem persistence and single-user assumptions with a
database-backed, multi-tenant, Shopify-Admin-API-driven implementation. See
the build plan for the full architecture and phased rollout.

Phase 1 (this state): Next.js app scaffold, Auth.js (email/password, optional
Google OAuth) + Drizzle/Postgres, organization creation, and a dashboard shell
with `/dashboard/[org]` route guards. Shopify OAuth connect (Phase 2) and the
AI generation pipeline (Phase 3) are stubbed with placeholder pages.

## Setup

1. Copy `.env.example` to `.env.local` and fill in:
   - `DATABASE_URL` — a Postgres connection string.
   - `AUTH_SECRET` — generate with `npx auth secret`.
   - `ENCRYPTION_KEY` — a separate long random secret (used later to encrypt
     stored Shopify access tokens; do not reuse `AUTH_SECRET`).
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — optional; email/password
     sign-in works without them.
   - Shopify/OpenRouter vars are unused until Phases 2–3.

2. Install dependencies and push the schema:

   ```bash
   npm install
   npm run db:push
   ```

3. Run the dev server:

   ```bash
   npm run dev
   ```

## Database

Schema lives in `db/schema/*.ts` (Drizzle ORM, Postgres). Useful scripts:

- `npm run db:push` — push schema changes directly (fastest for local dev).
- `npm run db:generate` — generate a SQL migration file.
- `npm run db:studio` — open Drizzle Studio.

## Structure

- `app/(auth)/` — sign in / sign up.
- `app/dashboard/` — org picker + org-scoped dashboard (`[org]/stores`,
  `[org]/generate`, `[org]/settings`).
- `lib/auth.ts` — Auth.js config (Credentials + optional Google, Drizzle
  adapter).
- `lib/actions/` — server actions (user registration, organization creation).
- `lib/crypto.ts` — AES-256-GCM helpers for encrypting secrets at rest
  (Shopify access tokens, from Phase 2 onward).
- `proxy.ts` — Next.js 16's route-protection convention (formerly
  `middleware.ts`); guards `/dashboard/*`.
