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

const fs = require('fs').promises;
const path = require('path');

const LOCAL_THEME_ROOT = path.resolve(
    process.env.LOCAL_THEME_ROOT || path.join(__dirname, '..', '..', '..', 'AI_Schema')
);
const LOCAL_THEME_ID = 'local';

function resolveAssetPath(key) {
    const normalized = key.replace(/\\/g, '/');
    const resolved = path.resolve(LOCAL_THEME_ROOT, normalized);
    if (resolved !== LOCAL_THEME_ROOT && !resolved.startsWith(LOCAL_THEME_ROOT + path.sep)) {
        throw new Error(`Refusing to resolve theme asset key outside LOCAL_THEME_ROOT: "${key}"`);
    }
    return resolved;
}

async function getMainThemeId() {
    return LOCAL_THEME_ID;
}

async function getAsset(shopDomain, accessToken, themeId, key) {
    try {
        const value = await fs.readFile(resolveAssetPath(key), 'utf8');
        return { key, value };
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
}

async function putAsset(shopDomain, accessToken, themeId, key, value) {
    const filePath = resolveAssetPath(key);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, value, 'utf8');
    return { key, value };
}

module.exports = { LOCAL_THEME_ROOT, LOCAL_THEME_ID, getMainThemeId, getAsset, putAsset };
