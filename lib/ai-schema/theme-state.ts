/**
 * Rewritten port of the original ai-schema/theme-state.js for the
 * multi-tenant SaaS. The pure classification/validation/selection logic
 * below (classifyTemplate, summarizeClassification, validateThemeState,
 * serializeThemeState, selectGenerationContext) is copied verbatim from the
 * original — see f:\theme-builder\AI_Schema\ai-schema\theme-state.js.
 *
 * LIVE STATE CONTRACT (2026-08-26): the real theme files on disk
 * (LOCAL_THEME_ROOT, via local-theme-fs.js) are the ONLY source of truth for
 * "what does the theme currently look like." buildThemeState() is how every
 * caller that needs the CURRENT live theme gets it — always a fresh read,
 * never a cache — because a database snapshot and the real files can drift
 * (a generation/edit writes the files but the DB row goes stale, or vice
 * versa), and the edit pipeline silently trusting a stale snapshot is
 * exactly what caused templates/product.json to lose 14 of its 15 blocks on
 * 2026-08-26 (an edit resolved against a snapshot the AI schema catalog
 * cache — not the just-generated real file — remembered as still empty).
 * saveThemeState()/loadThemeState()/saveThemeStateForStore()/
 * loadThemeStateForStore() below still exist and the `theme_states` table
 * still exists, but nothing in the live edit/generate/apply pipeline calls
 * them anymore — see each function's own doc comment. They're kept only as
 * building blocks for a possible future rollback/history feature; do not
 * reach for them to "get the current theme" — call buildThemeState().
 *
 * What changed and why:
 *   - buildThemeState() reads the theme's current JSON config via
 *     lib/ai-schema/local-theme-fs.js, which reads LOCAL_THEME_ROOT
 *     (f:\theme-builder\AI_Schema\ by default) on disk instead of either a
 *     live Shopify Admin API theme or the original's local git checkout.
 *     This fetches a fixed, deliberately narrow set of asset keys
 *     (TRACKED_TEMPLATE_KEYS) rather than walking the whole templates/
 *     directory like the original — every template the app's editor/preview
 *     can target (currently "index" and "product") must be listed here.
 *     A template missing from this list is invisible to the edit pipeline:
 *     runTargetedEdit() can't resolve an edit against its real sections, so
 *     it falls through to proposing a brand-new section against a template
 *     ThemeState treats as empty — and apply.js writes that fabricated
 *     empty-minus-one-section state straight over the real file, discarding
 *     everything the merchant already had. (This happened for real on
 *     2026-08-26: an edit targeting "product" — untracked at the time —
 *     wiped templates/product.json down to a single bare `main-product`
 *     section. See apply.js's own overwrite guard for the second half of
 *     the fix.) Extend this list the moment the editor/preview gains
 *     another template tab.
 *   - saveThemeState()/loadThemeState() persist to the `theme_states`
 *     Postgres table (keyed by storeId + themeId) instead of a local JSON
 *     file under ai-schema/output/theme-state/ — the original's `themeId`
 *     alone isn't tenant-scoped (it defaulted to the literal string
 *     "default" everywhere), which would collide across stores.
 *   - DEFAULT_THEME_ROOT/DEFAULT_THEME_ID are dropped from this module —
 *     local-theme-fs.js owns LOCAL_THEME_ROOT and its own fixed themeId
 *     ("local") now that generation/apply target a local theme checkout
 *     again instead of a live Shopify theme.
 */

import { sql, and, eq } from "drizzle-orm";
import * as instrumentation from "./instrumentation";
import { loadSchemas } from "./ai-client";
import { getAsset } from "./local-theme-fs";
import { db } from "@/db";
import { errorMessage } from "@/lib/errors";
import { themeStates } from "@/db/schema/generation";
import type {
    GenerationContext,
    GenerationConfig,
    SchemaCatalog,
    ThemeState,
    TemplateClassification,
    ThemeStateValidation
} from "./types";

export const THEME_STATE_SCHEMA_VERSION = 1;

// Kept only so conversational-edit.js's unmodified
// `const { ..., themeId = DEFAULT_THEME_ID } = options` destructure has
// something defined to fall back to — every caller in this codebase always
// passes a real composeThemeStateId()-derived themeId explicitly, so this
// default is never actually relied on in practice.
export const DEFAULT_THEME_ID = "default";

export const TRACKED_TEMPLATE_KEYS = [
    { name: "index", sourceFile: "templates/index.json" },
    { name: "product", sourceFile: "templates/product.json" },
    { name: "header-group", sourceFile: "sections/header-group.json" },
    { name: "footer-group", sourceFile: "sections/footer-group.json" }
];
const SETTINGS_SOURCE_FILE = "config/settings_data.json";

// --- Pure logic, copied verbatim from the original theme-state.js --------

export function classifyTemplate(raw: GenerationConfig | null | undefined, knownSectionTypes: Set<string>, knownBlockTypes: Set<string>): TemplateClassification {
    const sections: TemplateClassification["sections"] = {};
    if (raw && raw.sections && typeof raw.sections === "object") {
        for (const [sectionId, section] of Object.entries(raw.sections)) {
            const blocks: TemplateClassification["sections"][string]["blocks"] = {};
            if (section && section.blocks && typeof section.blocks === "object") {
                for (const [blockId, block] of Object.entries(section.blocks)) {
                    blocks[blockId] = {
                        type: block && block.type,
                        knownToAI: !!(block && knownBlockTypes.has(block.type))
                    };
                }
            }
            sections[sectionId] = {
                type: section && section.type,
                knownToAI: !!(section && knownSectionTypes.has(section.type)),
                blockCount: Object.keys(blocks).length,
                blocks
            };
        }
    }
    return { sections };
}

function summarizeClassification(classification: TemplateClassification) {
    let sectionCount = 0, blockCount = 0, unknownSectionCount = 0, unknownBlockCount = 0;
    for (const section of Object.values(classification.sections)) {
        sectionCount++;
        if (!section.knownToAI) unknownSectionCount++;
        for (const block of Object.values(section.blocks)) {
            blockCount++;
            if (!block.knownToAI) unknownBlockCount++;
        }
    }
    return { sectionCount, blockCount, unknownSectionCount, unknownBlockCount };
}

export function validateThemeState(themeState: ThemeState): ThemeStateValidation {
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const entry of themeState.meta.unparseableTemplates) {
        errors.push(`Template "${entry.name}" (${entry.sourceFile}): not valid JSON — ${entry.error}`);
    }
    if (themeState.meta.globalSettingsError) {
        errors.push(`config/settings_data.json is not valid JSON — ${themeState.meta.globalSettingsError}`);
    }

    for (const [name, template] of Object.entries(themeState.templates)) {
        const raw = template.raw;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            errors.push(`Template "${name}": root is not a JSON object`);
            continue;
        }
        if (!raw.sections || typeof raw.sections !== "object") {
            errors.push(`Template "${name}": missing "sections" object`);
            continue;
        }
        if (!Array.isArray(raw.order)) {
            errors.push(`Template "${name}": missing "order" array`);
            continue;
        }

        for (const sectionId of raw.order) {
            if (!Object.prototype.hasOwnProperty.call(raw.sections, sectionId)) {
                errors.push(`Template "${name}": order references unknown section "${sectionId}"`);
            }
        }
        for (const sectionId of Object.keys(raw.sections)) {
            if (!raw.order.includes(sectionId)) {
                warnings.push(`Template "${name}": section "${sectionId}" is not referenced in "order"`);
            }
        }

        for (const [sectionId, section] of Object.entries(raw.sections)) {
            if (!section || typeof section !== "object") {
                errors.push(`Template "${name}", section "${sectionId}": section is not an object`);
                continue;
            }
            if (!section.type) {
                errors.push(`Template "${name}", section "${sectionId}": missing "type"`);
            }
            if (section.blocks && typeof section.blocks === "object") {
                const blockIds = Object.keys(section.blocks);
                if (blockIds.length > 0) {
                    if (!Array.isArray(section.block_order)) {
                        warnings.push(`Template "${name}", section "${sectionId}": has blocks but no "block_order" array`);
                    } else {
                        for (const blockId of section.block_order) {
                            if (!Object.prototype.hasOwnProperty.call(section.blocks, blockId)) {
                                errors.push(`Template "${name}", section "${sectionId}": block_order references unknown block "${blockId}"`);
                            }
                        }
                        for (const blockId of blockIds) {
                            if (!section.block_order.includes(blockId)) {
                                warnings.push(`Template "${name}", section "${sectionId}": block "${blockId}" not listed in block_order`);
                            }
                        }
                    }
                }
            }
        }
    }

    return { valid: errors.length === 0, errors, warnings };
}

export function serializeThemeState(themeState: ThemeState): { templates: Record<string, GenerationConfig>; globalSettings: unknown } {
    const templates: Record<string, GenerationConfig> = {};
    for (const [name, template] of Object.entries(themeState.templates)) {
        templates[name] = template.raw;
    }
    return {
        templates,
        globalSettings: themeState.globalSettings ? themeState.globalSettings.raw : null
    };
}

export function selectGenerationContext(themeState: ThemeState, templateName: string): GenerationContext {
    const template = themeState.templates[templateName] || null;
    const existingSections = template
        ? Object.entries(template.classification.sections).map(([id, section]) => ({
            id,
            type: section.type,
            knownToAI: section.knownToAI,
            blockCount: section.blockCount
        }))
        : [];
    const globalSettingsCurrent = (themeState.globalSettings && themeState.globalSettings.raw && themeState.globalSettings.raw.current)
        ? themeState.globalSettings.raw.current
        : {};

    return {
        templateName,
        templateExists: !!template,
        existingSectionOrder: template ? template.raw.order : [],
        existingSections,
        globalSettingsCurrent
    };
}

// --- Rewritten: Shopify Admin API read + Postgres persistence ------------

export interface BuildThemeStateOptions {
    shopDomain: string;
    accessToken: string;
    themeId: string;
    schemas?: SchemaCatalog | null;
    context?: { requestId?: string };
}

/**
 * options (all required except schemas/context):
 *   - shopDomain, accessToken, themeId: identify which live Shopify theme
 *     to read.
 *   - schemas: pre-loaded { sectionSchemas, blockSchemas } to classify
 *     against; defaults to the full AI schema catalog.
 */
export async function buildThemeState(options: BuildThemeStateOptions): Promise<ThemeState> {
    const { shopDomain, accessToken, themeId, schemas = null, context = {} } = options;
    if (!shopDomain || !accessToken || !themeId) {
        throw new Error("buildThemeState() requires { shopDomain, accessToken, themeId }");
    }

    const requestId = context.requestId || instrumentation.nextRequestId("themestate");
    const startTime = Date.now();

    const resolvedSchemas = schemas || await loadSchemas();
    const knownSectionTypes = new Set(resolvedSchemas.sectionSchemas.map(s => s.id));
    const knownBlockTypes = new Set(resolvedSchemas.blockSchemas.map(b => b.id));

    const templates: ThemeState["templates"] = {};
    const unparseableTemplates: ThemeState["meta"]["unparseableTemplates"] = [];

    for (const { name, sourceFile } of TRACKED_TEMPLATE_KEYS) {
        const asset = await getAsset(shopDomain, accessToken, themeId, sourceFile);
        if (!asset) continue; // not present on this theme — same as ENOENT in the original

        let parsed: GenerationConfig;
        try {
            parsed = JSON.parse(asset.value);
        } catch (error) {
            unparseableTemplates.push({ name, sourceFile, error: errorMessage(error) });
            continue;
        }
        templates[name] = {
            sourceFile,
            raw: parsed,
            classification: classifyTemplate(parsed, knownSectionTypes, knownBlockTypes)
        };
    }

    const settingsAsset = await getAsset(shopDomain, accessToken, themeId, SETTINGS_SOURCE_FILE);
    let globalSettings: ThemeState["globalSettings"] = null;
    let globalSettingsError: string | null = null;
    if (settingsAsset) {
        try {
            globalSettings = { sourceFile: SETTINGS_SOURCE_FILE, raw: JSON.parse(settingsAsset.value) };
        } catch (error) {
            globalSettingsError = errorMessage(error);
        }
    }

    let sectionCount = 0, blockCount = 0, unknownSectionCount = 0, unknownBlockCount = 0;
    for (const template of Object.values(templates)) {
        const summary = summarizeClassification(template.classification);
        sectionCount += summary.sectionCount;
        blockCount += summary.blockCount;
        unknownSectionCount += summary.unknownSectionCount;
        unknownBlockCount += summary.unknownBlockCount;
    }

    const now = new Date().toISOString();
    const themeState: ThemeState = {
        themeId,
        schemaVersion: THEME_STATE_SCHEMA_VERSION,
        createdAt: now,
        updatedAt: now,
        templates,
        globalSettings,
        meta: {
            templateCount: Object.keys(templates).length,
            sectionCount,
            blockCount,
            unknownSectionCount,
            unknownBlockCount,
            unparseableTemplates,
            globalSettingsError
        }
    };

    themeState.validation = validateThemeState(themeState);

    const stateChars = JSON.stringify(themeState).length;
    instrumentation.logThemeState({
        requestId,
        themeId,
        templateCount: themeState.meta.templateCount,
        sectionCount,
        blockCount,
        unknownSectionCount,
        unknownBlockCount,
        unparseableTemplateCount: unparseableTemplates.length,
        stateChars,
        buildDurationMs: Date.now() - startTime,
        valid: themeState.validation.valid,
        errorCount: themeState.validation.errors.length,
        warningCount: themeState.validation.warnings.length
    });

    return themeState;
}

/**
 * Not part of the live pipeline (see this file's header) — no current
 * caller writes here. Kept as a building block for a possible future
 * rollback/history feature; never treat a row written here as "the current
 * theme" without also re-verifying it against a fresh buildThemeState().
 */
export async function saveThemeStateForStore(storeId: string, themeId: string, themeState: ThemeState): Promise<void> {
    if (!storeId || !themeId) throw new Error("saveThemeStateForStore() requires storeId and themeId");
    await db.insert(themeStates)
        .values({ storeId, themeId, snapshotJson: themeState, version: 1 })
        .onConflictDoUpdate({
            target: [themeStates.storeId, themeStates.themeId],
            set: {
                snapshotJson: themeState,
                updatedAt: new Date(),
                version: sql`${themeStates.version} + 1`
            }
        });
}

/**
 * Not part of the live pipeline (see this file's header) — no current
 * caller reads here for "the current theme." A row here can be arbitrarily
 * stale relative to the real files on disk; callers that need the current
 * live theme must call buildThemeState() instead.
 */
export async function loadThemeStateForStore(storeId: string, themeId: string): Promise<ThemeState | null> {
    if (!storeId || !themeId) throw new Error("loadThemeStateForStore() requires storeId and themeId");
    const [row] = await db
        .select()
        .from(themeStates)
        .where(and(eq(themeStates.storeId, storeId), eq(themeStates.themeId, themeId)))
        .limit(1);
    return row ? (row.snapshotJson as ThemeState) : null;
}

// --- Single-argument compatibility layer for edit-pipeline.js/conversational-edit.js ---
//
// Those two files are ported verbatim (Phase 4) and call
// `saveThemeState(themeState)` / `loadThemeState(themeId)` — the ORIGINAL
// CLI's one-argument signature, with `themeId` used as an opaque session
// storage key (never read back to make a Shopify API call — every real
// Admin API call takes shopDomain/accessToken/themeId as explicit options
// instead, see buildThemeState/apply.js). Composing storeId into that
// opaque string, rather than changing the ported files' call sites, is what
// lets them stay byte-for-byte unmodified while storage is still
// tenant-scoped. Callers that build a ThemeState directly (worker.ts) use
// saveThemeStateForStore/loadThemeStateForStore above instead, which are
// explicit and don't need this encoding.
const THEME_STATE_ID_SEPARATOR = "::";

export function composeThemeStateId(storeId: string, themeId: string): string {
    if (!storeId || !themeId) throw new Error("composeThemeStateId() requires storeId and themeId");
    return `${storeId}${THEME_STATE_ID_SEPARATOR}${themeId}`;
}

export function parseThemeStateId(compositeId: string | null | undefined): { storeId: string; themeId: string } {
    const parts = (compositeId || "").split(THEME_STATE_ID_SEPARATOR);
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
        throw new Error(`Invalid composite theme state id: "${compositeId}" (expected "storeId${THEME_STATE_ID_SEPARATOR}themeId")`);
    }
    return { storeId: parts[0], themeId: parts[1] };
}

/**
 * Currently unused by the live pipeline (2026-08-26) — conversational-edit.js
 * used to call this after every turn to cache the mutated ThemeState so a
 * later turn/apply could reuse it; that's exactly the stale-cache mechanism
 * this file's header describes removing. Left defined, not deleted, as a
 * ready-made primitive if a future rollback/history feature wants it.
 */
export async function saveThemeState(themeState: ThemeState): Promise<void> {
    const { storeId, themeId } = parseThemeStateId(themeState.themeId);
    await saveThemeStateForStore(storeId, themeId, themeState);
}

/** Currently unused by the live pipeline — see saveThemeState()'s note above. */
export async function loadThemeState(compositeThemeId: string): Promise<ThemeState | null> {
    const { storeId, themeId } = parseThemeStateId(compositeThemeId);
    return loadThemeStateForStore(storeId, themeId);
}
