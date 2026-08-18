/**
 * Rewritten port of the original ai-schema/apply.js for the multi-tenant
 * SaaS. computeTargetFiles() and verifyStructuralShape() are copied
 * verbatim (pure, no I/O) from f:\theme-builder\AI_Schema\ai-schema\apply.js.
 *
 * What changed and why: the original staged writes into a temp directory,
 * backed up the real files it was about to overwrite, committed via atomic
 * fs.rename, and rolled back from the backup on partial failure — all
 * local-filesystem mechanics that don't apply once the "live theme" is a
 * remote Shopify store reached over the Admin API. This keeps the same
 * safety envelope (verify-before-write, back up what's about to change,
 * best-effort restore on partial failure, verify-after-write) but
 * implements it against lib/ai-schema/local-theme-fs.js's getAsset/putAsset,
 * which itself now reads/writes LOCAL_THEME_ROOT on disk instead of a live
 * Shopify Admin API theme (see local-theme-fs.js's header comment) — so
 * this module's own path-traversal guard was dropped in favor of the one
 * local-theme-fs.js's resolveAssetPath() applies against LOCAL_THEME_ROOT.
 */

const instrumentation = require('./instrumentation');
const { getAsset, putAsset } = require('./local-theme-fs');

function computeTargetFiles(mergedThemeState, options = {}) {
    const { changedTemplates = [], writeGlobalSettings = false } = options;
    const targets = [];

    for (const templateName of changedTemplates) {
        const template = mergedThemeState.templates && mergedThemeState.templates[templateName];
        if (!template) continue;
        targets.push({
            relativePath: template.sourceFile || `templates/${templateName}.json`,
            content: template.raw
        });
    }

    if (writeGlobalSettings && mergedThemeState.globalSettings) {
        targets.push({
            relativePath: mergedThemeState.globalSettings.sourceFile || 'config/settings_data.json',
            content: mergedThemeState.globalSettings.raw
        });
    }

    return targets;
}

function verifyStructuralShape(relativePath, parsed) {
    if (relativePath.startsWith('templates/')) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.sections || typeof parsed.sections !== 'object' || !Array.isArray(parsed.order)) {
            throw new Error(`Apply verification failed for "${relativePath}": missing/invalid "sections" or "order"`);
        }
        for (const id of parsed.order) {
            if (!parsed.sections.hasOwnProperty(id)) {
                throw new Error(`Apply verification failed for "${relativePath}": order references unknown section "${id}"`);
            }
        }
    } else if (relativePath.endsWith('settings_data.json')) {
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.current || typeof parsed.current !== 'object') {
            throw new Error(`Apply verification failed for "${relativePath}": missing/invalid "current" object`);
        }
    }
}

/**
 * options:
 *   - shopDomain, accessToken, themeId: identify which live Shopify theme
 *     to write to (required unless dryRun).
 *   - changedTemplates: array of template names to write, normally taken
 *     directly from merge.js's `summary.changedTemplates`.
 *   - writeGlobalSettings: whether to also write config/settings_data.json.
 *   - dryRun: report targets without writing anything.
 */
async function applyThemeState(mergedThemeState, options = {}) {
    const {
        shopDomain,
        accessToken,
        themeId,
        changedTemplates = [],
        writeGlobalSettings = false,
        dryRun = false,
        requestId = instrumentation.nextRequestId('apply')
    } = options;

    if (!dryRun && (!shopDomain || !accessToken || !themeId)) {
        throw new Error('applyThemeState() requires { shopDomain, accessToken, themeId } unless dryRun is true');
    }

    const startTime = Date.now();
    const targets = computeTargetFiles(mergedThemeState, { changedTemplates, writeGlobalSettings });

    if (targets.length === 0) {
        return { applied: false, dryRun, filesWritten: [], targets: [], durationMs: Date.now() - startTime };
    }

    // Verify shape BEFORE any write — a bad target aborts the whole apply.
    for (const t of targets) {
        verifyStructuralShape(t.relativePath, t.content);
    }

    if (dryRun) {
        const durationMs = Date.now() - startTime;
        instrumentation.logApply({ requestId, dryRun: true, success: true, filesWritten: 0, targets: targets.map(t => t.relativePath), durationMs });
        return { applied: false, dryRun: true, filesWritten: [], targets: targets.map(t => t.relativePath), durationMs };
    }

    // Back up whatever's currently live for each target, so a partial
    // failure below can attempt to restore it.
    const backups = [];
    for (const t of targets) {
        const existing = await getAsset(shopDomain, accessToken, themeId, t.relativePath);
        backups.push({ relativePath: t.relativePath, previousValue: existing ? existing.value : null });
    }

    const committed = [];
    try {
        for (const t of targets) {
            await putAsset(shopDomain, accessToken, themeId, t.relativePath, JSON.stringify(t.content, null, 2));
            committed.push(t);
        }
    } catch (commitError) {
        for (const t of committed) {
            const backup = backups.find(b => b.relativePath === t.relativePath);
            if (backup && backup.previousValue !== null) {
                await putAsset(shopDomain, accessToken, themeId, t.relativePath, backup.previousValue).catch(() => {});
            }
            // No target here was absent before this apply in practice (every
            // Shopify theme ships templates/index.json + settings_data.json),
            // so there's no "delete the asset we just created" case to
            // handle, unlike the original's local-file equivalent.
        }
        instrumentation.logApply({
            requestId, dryRun: false, success: false, filesWritten: 0,
            targets: targets.map(t => t.relativePath), durationMs: Date.now() - startTime,
            error: commitError.message
        });
        throw commitError;
    }

    // Post-write verification against the real, just-written assets.
    for (const t of targets) {
        const written = await getAsset(shopDomain, accessToken, themeId, t.relativePath);
        const parsed = JSON.parse(written.value);
        verifyStructuralShape(t.relativePath, parsed);
    }

    const durationMs = Date.now() - startTime;
    instrumentation.logApply({
        requestId, dryRun: false, success: true,
        filesWritten: targets.length, targets: targets.map(t => t.relativePath), durationMs
    });

    return { applied: true, dryRun: false, filesWritten: targets.map(t => t.relativePath), durationMs };
}

module.exports = { computeTargetFiles, verifyStructuralShape, applyThemeState };
