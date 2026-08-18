/**
 * Local-filesystem theme client. Reads and writes the theme's JSON
 * configuration (templates/*.json, config/settings_data.json, etc.)
 * straight off a local Shopify theme checkout on disk (LOCAL_THEME_ROOT),
 * instead of going over the Shopify Admin API.
 *
 * Replaces the original shopify-admin.js REST client: this app's custom-app
 * access token doesn't have merchant-approved read_themes/write_themes, so
 * GET /themes.json 403s ("This action requires merchant approval for
 * read_themes scope"). theme-state.js/apply.js/worker.ts target
 * f:\theme-builder\AI_Schema\ (a full theme checkout) instead of the
 * connected store's live theme. shopDomain/accessToken/themeId are still
 * accepted (and ignored here) so those callers — and the rest of the
 * multi-tenant store flow (auth, products, etc. in lib/shopify/client.ts,
 * which is untouched and still hits the real Admin API) — don't need
 * theme-specific branching.
 */

import fs from "fs/promises";
import path from "path";

export const LOCAL_THEME_ROOT = path.resolve(
    process.env.LOCAL_THEME_ROOT || path.join(__dirname, "..", "..", "..", "AI_Schema")
);
export const LOCAL_THEME_ID = "local";

function resolveAssetPath(key: string): string {
    const normalized = key.replace(/\\/g, "/");
    const resolved = path.resolve(LOCAL_THEME_ROOT, normalized);
    if (resolved !== LOCAL_THEME_ROOT && !resolved.startsWith(LOCAL_THEME_ROOT + path.sep)) {
        throw new Error(`Refusing to resolve theme asset key outside LOCAL_THEME_ROOT: "${key}"`);
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
    try {
        const value = await fs.readFile(resolveAssetPath(key), "utf8");
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
    const filePath = resolveAssetPath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, value, "utf8");
    return { key, value };
}
