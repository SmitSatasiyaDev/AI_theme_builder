/**
 * Local-filesystem theme client. Reads and writes the theme's JSON
 * configuration (templates/*.json, config/settings_data.json, etc.)
 * straight off a local Shopify theme checkout on disk (LOCAL_THEME_ROOT),
 * instead of going over the Shopify Admin API.
 *
 * Replaces the original shopify-admin.js REST client: this app's custom-app
 * access token doesn't have merchant-approved read_themes/write_themes, so
 * GET /themes.json 403s ("This action requires merchant approval for
 * read_themes scope"). theme-state.ts/apply.js/worker.ts target the checkout
 * at LOCAL_THEME_ROOT (this repo vendors one at theme_base/theme/) instead of
 * the connected store's live theme. shopDomain/accessToken/themeId are still
 * accepted (and ignored here) so those callers — and the rest of the
 * multi-tenant store flow (auth, products, etc. in lib/shopify/client.ts,
 * which is untouched and still hits the real Admin API) — don't need
 * theme-specific branching.
 *
 * LOCAL_THEME_ROOT is REQUIRED and validated on first use (see
 * getThemeRoot()). It used to fall back to a hardcoded relative path, which
 * failed silently in the worst possible way: a missing/blank value resolved
 * to a directory that didn't exist, every getAsset() swallowed the resulting
 * ENOENT as `null`, and buildThemeState() reported a perfectly healthy theme
 * with zero templates. Validation is deferred to first use rather than
 * module load so that `next build` — which imports route modules without a
 * populated runtime env — doesn't fail on it.
 */

import fs from "fs/promises";
import path from "path";

export const LOCAL_THEME_ID = "local";

const ENV_VAR = "LOCAL_THEME_ROOT";

let cachedRoot: string | null = null;

/**
 * Resolves and validates LOCAL_THEME_ROOT. Throws — loudly, naming the
 * variable — if it is unset, blank, or does not point at a real directory.
 * The successful result is cached; failures are not, so fixing the env and
 * retrying works without a restart in `next dev`.
 */
export async function getThemeRoot(): Promise<string> {
    if (cachedRoot !== null) return cachedRoot;

    const configured = (process.env[ENV_VAR] || "").trim();
    if (!configured) {
        throw new Error(
            `${ENV_VAR} is not set. It must be an absolute path to a Shopify theme ` +
            `checkout (the directory containing templates/, config/, sections/, ...). ` +
            `This repo vendors one at theme_base/theme — set ${ENV_VAR} in .env ` +
            `(not .env.local: scripts/worker.ts reads .env only).`
        );
    }

    const resolved = path.resolve(configured);
    let stats;
    try {
        stats = await fs.stat(resolved);
    } catch {
        throw new Error(
            `${ENV_VAR} points at "${resolved}", which does not exist. ` +
            `It must be an absolute path to a Shopify theme checkout.`
        );
    }
    if (!stats.isDirectory()) {
        throw new Error(`${ENV_VAR} points at "${resolved}", which is not a directory.`);
    }

    cachedRoot = resolved;
    return resolved;
}

/** True when `candidate` (an absolute, resolved path) is `root` itself or lies inside it. */
export function isPathInside(root: string, candidate: string): boolean {
    return candidate === root || candidate.startsWith(root + path.sep);
}

async function resolveAssetPath(key: string): Promise<string> {
    const root = await getThemeRoot();
    const normalized = key.replace(/\\/g, "/");
    const resolved = path.resolve(root, normalized);
    if (!isPathInside(root, resolved)) {
        throw new Error(`Refusing to resolve theme asset key outside ${ENV_VAR}: "${key}"`);
    }
    return resolved;
}

export async function getMainThemeId(): Promise<string> {
    return LOCAL_THEME_ID;
}

export async function getAsset(
    shopDomain: string,
    accessToken: string,
    themeId: string,
    key: string
): Promise<{ key: string; value: string } | null> {
    const filePath = await resolveAssetPath(key);
    try {
        const value = await fs.readFile(filePath, "utf8");
        return { key, value };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
}

export async function putAsset(
    shopDomain: string,
    accessToken: string,
    themeId: string,
    key: string,
    value: string
): Promise<{ key: string; value: string }> {
    const filePath = await resolveAssetPath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, value, "utf8");
    return { key, value };
}
