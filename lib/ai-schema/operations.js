/**
 * Phase 8 — Structured Theme Operations.
 *
 * The deterministic core of targeted editing: a closed operation
 * vocabulary, deterministic target resolution against `ThemeState`
 * (Phase 4), deterministic validation (reusing Phase 6's per-setting/
 * data-reference checks, never duplicating them), a pure in-memory
 * executor, and an atomic multi-operation runner. No AI call anywhere in
 * this file (§13/§19 — "not call AI"); the ONE place an AI call happens at
 * all in Phase 8 is `edit-pipeline.js`'s bounded operation-PROPOSAL step —
 * this file only ever validates/executes an already-produced operation
 * object, exactly the same "AI proposes, application decides and mutates"
 * split Phase 5 established for GenerationPlan (§24).
 *
 * ---------------------------------------------------------------------
 * §4 — the gap this closes, confirmed by inspection before writing
 * anything: NOTHING in the repository before Phase 8 can target an
 * existing section/block for a scoped change. `clarification.js`/`brief.js`
 * only understand INITIAL generation requirements (WebsiteBrief fields —
 * business type, audience, tone, ...), never "which existing section".
 * `generation.js` only ever produces a brand-new candidate structure for a
 * whole template. The only non-destructive splice anywhere is
 * `mergeProductTemplate()`/`merge.js`'s forced-exclusive-section policy,
 * and that's driven by a hardcoded template rule, not a user's specific
 * request. "Change the hero heading" today has no path except regenerating
 * (and, without Phase 7, overwriting) the whole homepage. This file is that
 * missing path.
 * ---------------------------------------------------------------------
 */

const instrumentation = require('./instrumentation');
const { buildCapabilityIndex } = require('./capability-index');
const { isEligibleForTemplate } = require('./retrieval');
const { validateSettingValue, getSettingKind } = require('./validation');
const { validateThemeState } = require('./theme-state');
const { mergeGlobalSettingsChanges } = require('./merge');

// ---------------------------------------------------------------------------
// §6/§31 — the smallest useful operation set the actual ThemeState/schema
// architecture can support safely and deterministically. Every one of
// these maps directly onto a real, already-existing JSON shape
// (`{type, settings, blocks, block_order}` for sections/blocks, `{current}`
// for global settings) — nothing here invents a new theme concept.
// ---------------------------------------------------------------------------

const OPERATION_TYPES = Object.freeze([
    'update_section',
    'update_block',
    'add_section',
    'remove_section',
    'add_block',
    'remove_block',
    'update_global_settings'
]);

// §22 — small, stable, meaningful conflict/error code set.
const OPERATION_ERROR_CODES = Object.freeze({
    OPERATION_INVALID: 'OPERATION_INVALID',
    OPERATION_TARGET_NOT_FOUND: 'OPERATION_TARGET_NOT_FOUND',
    OPERATION_TARGET_AMBIGUOUS: 'OPERATION_TARGET_AMBIGUOUS',
    OPERATION_SECTION_NOT_ALLOWED: 'OPERATION_SECTION_NOT_ALLOWED',
    OPERATION_BLOCK_NOT_ALLOWED: 'OPERATION_BLOCK_NOT_ALLOWED',
    OPERATION_MAX_BLOCKS_EXCEEDED: 'OPERATION_MAX_BLOCKS_EXCEEDED',
    OPERATION_SETTING_INVALID: 'OPERATION_SETTING_INVALID',
    OPERATION_DATA_REFERENCE_INVALID: 'OPERATION_DATA_REFERENCE_INVALID',
    OPERATION_CONFLICT: 'OPERATION_CONFLICT',
    OPERATION_ORDER_INVALID: 'OPERATION_ORDER_INVALID'
});

function issue(code, path, message) {
    return { code, path, message };
}

function cloneJSON(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

// §7 — deterministic, not random: stable for one execution, human-readable
// for logs/repair prompts. Two operations with the exact same shape in the
// same batch legitimately collide (that's a real duplicate, not a bug to
// paper over with randomness).
function generateOperationId(operation) {
    const t = operation && operation.target ? operation.target : {};
    return [operation && operation.operation, t.templateName, t.sectionId, t.blockId]
        .filter(Boolean)
        .join(':');
}

// ---------------------------------------------------------------------------
// §8/§9/§23 — Target resolution. Exact id match always wins outright. When
// no exact id matches, a bounded, deterministic keyword-overlap match runs
// against each candidate's id + schema type/label/category/tags (via
// capability-index.js, reused unmodified). Ties at the top score are
// reported as OPERATION_TARGET_AMBIGUOUS with every tied candidate listed —
// never silently resolved by arbitrary ranking (§23, the "critical safety
// rule").
// ---------------------------------------------------------------------------

function tokenize(text) {
    return (text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// Generic filler/structural words that carry no target-identifying signal
// on their own but can still coincidentally equal a real candidate token
// (e.g. "section" is itself a token inside the section TYPE id
// "section-divider") — left unfiltered, a vague request like "change one
// section" would token-match that unrelated type and silently RESOLVE
// instead of correctly finding nothing to match on. Only applied to the
// QUERY side of scoring; candidate id/type/label/tag tokens are left
// untouched so an explicit, specific mention (e.g. "the divider") still
// matches normally.
const RESOLUTION_STOP_WORDS = new Set([
    'i', 'want', 'to', 'the', 'a', 'an', 'of', 'on', 'for', 'my', 'this', 'that', 'it',
    'please', 'would', 'like', 'me', 'can', 'you',
    'change', 'update', 'edit', 'modify', 'set', 'remove', 'delete', 'add', 'move', 'replace',
    'one', 'some', 'section', 'block'
]);

function queryTokenize(text) {
    return tokenize(text).filter(token => !RESOLUTION_STOP_WORDS.has(token));
}

function candidateTokens(id, typeEntry) {
    const parts = [id, typeEntry ? typeEntry.id : '', typeEntry ? typeEntry.label : '', typeEntry ? typeEntry.category : '', ...(typeEntry && typeEntry.tags ? typeEntry.tags : [])];
    return new Set(tokenize(parts.join(' ')));
}

function scoreOverlap(queryTokens, candidateTokenSet) {
    let score = 0;
    for (const token of queryTokens) {
        if (candidateTokenSet.has(token)) score++;
    }
    return score;
}

/**
 * Resolves a section target within one template. `query` is either an EXACT
 * existing section id (fast path, always deterministic and unambiguous) or
 * natural-language text to keyword-match against every existing section's
 * id/type/label/category/tags.
 *
 * Returns one of:
 *   { status: 'RESOLVED', sectionId, section }
 *   { status: 'NOT_FOUND' }
 *   { status: 'AMBIGUOUS', candidates: [{sectionId, type, score}, ...] }
 */
function resolveSectionTarget(themeState, templateName, query, schemas) {
    const template = themeState.templates && themeState.templates[templateName];
    if (!template) return { status: 'NOT_FOUND' };

    if (query && template.raw.sections.hasOwnProperty(query)) {
        return { status: 'RESOLVED', sectionId: query, section: template.raw.sections[query] };
    }

    const index = buildCapabilityIndex(schemas);
    const sectionTypeById = new Map(index.sections.map(s => [s.id, s]));
    const queryTokens = queryTokenize(query);
    if (queryTokens.length === 0) return { status: 'NOT_FOUND' };

    const scored = Object.entries(template.raw.sections).map(([sectionId, section]) => {
        const typeEntry = sectionTypeById.get(section.type);
        const score = scoreOverlap(queryTokens, candidateTokens(sectionId, typeEntry));
        return { sectionId, type: section.type, score };
    }).filter(c => c.score > 0);

    if (scored.length === 0) return { status: 'NOT_FOUND' };

    const topScore = Math.max(...scored.map(c => c.score));
    const top = scored.filter(c => c.score === topScore);
    if (top.length > 1) return { status: 'AMBIGUOUS', candidates: top };
    return { status: 'RESOLVED', sectionId: top[0].sectionId, section: template.raw.sections[top[0].sectionId] };
}

/**
 * Same idea, scoped to blocks WITHIN one already-resolved section.
 */
function resolveBlockTarget(section, query, schemas) {
    const blocks = (section && section.blocks) || {};
    if (query && blocks.hasOwnProperty(query)) {
        return { status: 'RESOLVED', blockId: query, block: blocks[query] };
    }

    const index = buildCapabilityIndex(schemas);
    const blockTypeById = new Map(index.blocks.map(b => [b.id, b]));
    const queryTokens = queryTokenize(query);
    if (queryTokens.length === 0) return { status: 'NOT_FOUND' };

    const scored = Object.entries(blocks).map(([blockId, block]) => {
        const typeEntry = blockTypeById.get(block.type);
        const score = scoreOverlap(queryTokens, candidateTokens(blockId, typeEntry));
        return { blockId, type: block.type, score };
    }).filter(c => c.score > 0);

    if (scored.length === 0) return { status: 'NOT_FOUND' };

    const topScore = Math.max(...scored.map(c => c.score));
    const top = scored.filter(c => c.score === topScore);
    if (top.length > 1) return { status: 'AMBIGUOUS', candidates: top };
    return { status: 'RESOLVED', blockId: top[0].blockId, block: blocks[top[0].blockId] };
}

// ---------------------------------------------------------------------------
// §13/§14/§15/§34 — deterministic validation. Reuses Phase 6's
// validateSettingValue()/getSettingKind() for per-setting correctness and
// the exact same product_picker/collection hallucination posture
// (validation.js's DATA_REFERENCE_TYPE_NAMES concept, reimplemented as the
// one-line check below since validation.js doesn't export that set
// directly — see validation.js for the canonical rule this mirrors) rather
// than re-deriving setting-shape logic from scratch.
// ---------------------------------------------------------------------------

function validateChangedSettings(settingsSchemaMap, changes, pathPrefix, knownMerchantData) {
    const errors = [];
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || Object.keys(changes).length === 0) {
        return [issue(OPERATION_ERROR_CODES.OPERATION_INVALID, pathPrefix, 'changes.settings must be a non-empty object — an operation must change at least one setting.')];
    }
    for (const [key, value] of Object.entries(changes)) {
        const settingSchema = settingsSchemaMap ? settingsSchemaMap[key] : undefined;
        if (settingSchema === undefined) {
            errors.push(issue(OPERATION_ERROR_CODES.OPERATION_SETTING_INVALID, `${pathPrefix}.${key}`, `"${key}" is not a setting defined by this section/block's schema.`));
            continue;
        }
        const { typeName } = getSettingKind(settingSchema);
        if ((typeName === 'product_picker' || typeName === 'collection') && value !== '' && value !== null) {
            const known = typeName === 'product_picker' ? (knownMerchantData.products || []) : (knownMerchantData.collections || []);
            if (!known.includes(value)) {
                errors.push(issue(OPERATION_ERROR_CODES.OPERATION_DATA_REFERENCE_INVALID, `${pathPrefix}.${key}`, `"${key}" (${typeName}) value ${JSON.stringify(value)} is not a known merchant reference — leave blank rather than inventing one.`));
                continue;
            }
        }
        for (const problem of validateSettingValue(settingSchema, value, `${pathPrefix}.${key}`)) {
            errors.push(issue(OPERATION_ERROR_CODES.OPERATION_SETTING_INVALID, problem.path, problem.message));
        }
    }
    return errors;
}

function allowedBlocksList(sectionSchema) {
    if (!sectionSchema || !sectionSchema.allowed_blocks) return [];
    return Array.isArray(sectionSchema.allowed_blocks) ? sectionSchema.allowed_blocks : Object.keys(sectionSchema.allowed_blocks);
}

/**
 * options: { themeState, schemas, knownMerchantData = {} }
 * Returns { valid, errors } — never mutates anything, never touches AI.
 */
function validateOperation(operation, options = {}) {
    const { themeState, schemas, knownMerchantData = {} } = options;
    const errors = [];

    if (!operation || typeof operation !== 'object') {
        return { valid: false, errors: [issue(OPERATION_ERROR_CODES.OPERATION_INVALID, 'operation', 'operation must be an object.')] };
    }
    if (!OPERATION_TYPES.includes(operation.operation)) {
        return { valid: false, errors: [issue(OPERATION_ERROR_CODES.OPERATION_INVALID, 'operation.operation', `"${operation.operation}" is not a supported operation type. Supported: ${OPERATION_TYPES.join(', ')}`)] };
    }
    const target = operation.target || {};
    const changes = operation.changes || {};
    const op = operation.operation;

    if (op !== 'update_global_settings' && !target.templateName) {
        return { valid: false, errors: [issue(OPERATION_ERROR_CODES.OPERATION_INVALID, 'operation.target.templateName', 'target.templateName is required.')] };
    }

    const sectionById = new Map(schemas.sectionSchemas.map(s => [s.id, s]));
    const blockById = new Map(schemas.blockSchemas.map(b => [b.id, b]));
    const template = target.templateName ? (themeState.templates && themeState.templates[target.templateName]) : null;
    const existingSections = template ? template.raw.sections : {};

    if (op === 'update_section' || op === 'remove_section') {
        if (!target.sectionId || !existingSections.hasOwnProperty(target.sectionId)) {
            errors.push(issue(OPERATION_ERROR_CODES.OPERATION_TARGET_NOT_FOUND, 'operation.target.sectionId', `Section "${target.sectionId}" does not exist in template "${target.templateName}".`));
            return { valid: false, errors };
        }
        if (op === 'update_section') {
            const sectionSchema = sectionById.get(existingSections[target.sectionId].type);
            errors.push(...validateChangedSettings(sectionSchema ? sectionSchema.settings : {}, changes.settings, 'operation.changes.settings', knownMerchantData));
        }
        return { valid: errors.length === 0, errors };
    }

    if (op === 'add_section') {
        if (!changes.type || !sectionById.has(changes.type)) {
            errors.push(issue(OPERATION_ERROR_CODES.OPERATION_SECTION_NOT_ALLOWED, 'operation.changes.type', `"${changes.type}" is not a section type that exists in the schema catalog.`));
            return { valid: false, errors };
        }
        const sectionSchema = sectionById.get(changes.type);
        if (!isEligibleForTemplate(sectionSchema, target.templateName)) {
            errors.push(issue(OPERATION_ERROR_CODES.OPERATION_SECTION_NOT_ALLOWED, 'operation.target.templateName', `Section type "${changes.type}" declares allowed_on ${JSON.stringify(sectionSchema.allowed_on)}, which does not include "${target.templateName}".`));
        }
        if (changes.settings) {
            errors.push(...validateChangedSettings(sectionSchema.settings, changes.settings, 'operation.changes.settings', knownMerchantData));
        }
        return { valid: errors.length === 0, errors };
    }

    if (op === 'update_global_settings') {
        const globalSettingsSchema = schemas.globalSchema ? schemas.globalSchema.settings : {};
        errors.push(...validateChangedSettings(globalSettingsSchema, changes.settings, 'operation.changes.settings', knownMerchantData));
        return { valid: errors.length === 0, errors };
    }

    // Block-level operations all require an existing parent section.
    if (!target.sectionId || !existingSections.hasOwnProperty(target.sectionId)) {
        errors.push(issue(OPERATION_ERROR_CODES.OPERATION_TARGET_NOT_FOUND, 'operation.target.sectionId', `Section "${target.sectionId}" does not exist in template "${target.templateName}".`));
        return { valid: false, errors };
    }
    const parentSection = existingSections[target.sectionId];
    const parentSectionSchema = sectionById.get(parentSection.type);
    const existingBlocks = parentSection.blocks || {};

    if (op === 'update_block' || op === 'remove_block') {
        if (!target.blockId || !existingBlocks.hasOwnProperty(target.blockId)) {
            errors.push(issue(OPERATION_ERROR_CODES.OPERATION_TARGET_NOT_FOUND, 'operation.target.blockId', `Block "${target.blockId}" does not exist in section "${target.sectionId}".`));
            return { valid: false, errors };
        }
        if (op === 'update_block') {
            const blockSchema = blockById.get(existingBlocks[target.blockId].type);
            errors.push(...validateChangedSettings(blockSchema ? blockSchema.settings : {}, changes.settings, 'operation.changes.settings', knownMerchantData));
        }
        return { valid: errors.length === 0, errors };
    }

    if (op === 'add_block') {
        if (!changes.type || !blockById.has(changes.type)) {
            errors.push(issue(OPERATION_ERROR_CODES.OPERATION_BLOCK_NOT_ALLOWED, 'operation.changes.type', `"${changes.type}" is not a block type that exists in the schema catalog.`));
            return { valid: false, errors };
        }
        const allowed = allowedBlocksList(parentSectionSchema);
        if (allowed.length > 0 && !allowed.includes(changes.type)) {
            errors.push(issue(OPERATION_ERROR_CODES.OPERATION_BLOCK_NOT_ALLOWED, 'operation.changes.type', `Block type "${changes.type}" is not allowed inside a "${parentSection.type}" section.`));
        }
        if (parentSectionSchema && typeof parentSectionSchema.max_blocks === 'number' && Object.keys(existingBlocks).length + 1 > parentSectionSchema.max_blocks) {
            errors.push(issue(OPERATION_ERROR_CODES.OPERATION_MAX_BLOCKS_EXCEEDED, 'operation.target.sectionId', `Section "${target.sectionId}" already has ${Object.keys(existingBlocks).length} block(s); adding one more would exceed max_blocks (${parentSectionSchema.max_blocks}).`));
        }
        if (changes.settings) {
            const blockSchema = blockById.get(changes.type);
            errors.push(...validateChangedSettings(blockSchema.settings, changes.settings, 'operation.changes.settings', knownMerchantData));
        }
        return { valid: errors.length === 0, errors };
    }

    // Unreachable given the OPERATION_TYPES membership check above.
    return { valid: false, errors: [issue(OPERATION_ERROR_CODES.OPERATION_INVALID, 'operation.operation', `Unhandled operation type "${op}".`)] };
}

// ---------------------------------------------------------------------------
// §18/§19 — pure in-memory execution. Every branch spreads the existing
// object first, so unknown properties on that exact section/block survive
// (same discipline merge.js's forced-exclusive splice already established
// in Phase 7) — only the fields the operation actually owns are replaced.
// ---------------------------------------------------------------------------

function nextAutoId(existingIds, typePrefix) {
    const pattern = new RegExp(`^${typePrefix}-(\\d+)$`);
    let max = 0;
    for (const id of existingIds) {
        const m = pattern.exec(id);
        if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    return `${typePrefix}-${max + 1}`;
}

function insertAt(array, id, position) {
    return position === 'start' ? [id, ...array] : [...array, id];
}

/**
 * Applies exactly ONE already-validated operation to a ThemeState, purely
 * in memory. Assumes validateOperation() already passed (§8 — "operation
 * validation is deterministic", called once by the caller, not re-run
 * silently here to avoid two sources of truth on what's "invalid").
 *
 * Returns { themeState: newThemeState, changeSummary }.
 */
function executeOperation(themeState, operation) {
    const newThemeState = cloneJSON({
        themeId: themeState.themeId,
        sourcePath: themeState.sourcePath,
        schemaVersion: themeState.schemaVersion,
        createdAt: themeState.createdAt,
        templates: themeState.templates || {},
        globalSettings: themeState.globalSettings,
        // Passed through unchanged: operations never introduce a new
        // unparseable-template/settings-file error (they never touch file
        // parsing), so the original meta.unparseableTemplates/
        // globalSettingsError — the only fields validateThemeState() reads
        // — remain accurate. Section/block COUNTS in meta go stale after an
        // operation; nothing here relies on them being live.
        meta: themeState.meta || { unparseableTemplates: [], globalSettingsError: null }
    });

    const target = operation.target || {};
    const changes = operation.changes || {};
    const op = operation.operation;
    const operationId = generateOperationId(operation);
    let changed = [];

    if (op === 'update_global_settings') {
        const { mergedRaw, changedKeys } = mergeGlobalSettingsChanges(
            newThemeState.globalSettings ? newThemeState.globalSettings.raw : null,
            changes.settings
        );
        newThemeState.globalSettings = { sourceFile: (themeState.globalSettings && themeState.globalSettings.sourceFile) || 'config/settings_data.json', raw: mergedRaw };
        changed = changedKeys.map(k => `globalSettings.current.${k}`);
        return { themeState: newThemeState, changeSummary: { operationId, operation: op, target: 'globalSettings', changed, preserved: true } };
    }

    const templateName = target.templateName;
    const existingTemplate = newThemeState.templates[templateName];
    const templateRaw = existingTemplate ? existingTemplate.raw : { sections: {}, order: [] };
    const sourceFile = (existingTemplate && existingTemplate.sourceFile) || `templates/${templateName}.json`;

    if (op === 'add_section') {
        const sectionId = nextAutoId(Object.keys(templateRaw.sections), changes.type);
        templateRaw.sections[sectionId] = { type: changes.type, settings: changes.settings || {}, blocks: {}, block_order: [] };
        templateRaw.order = insertAt(templateRaw.order, sectionId, changes.position);
        changed = [`sections.${sectionId}`];
        newThemeState.templates[templateName] = { sourceFile, raw: templateRaw };
        return { themeState: newThemeState, changeSummary: { operationId, operation: op, target: `${templateName}.${sectionId}`, changed, preserved: true } };
    }

    if (op === 'remove_section') {
        delete templateRaw.sections[target.sectionId];
        templateRaw.order = templateRaw.order.filter(id => id !== target.sectionId);
        changed = [`sections.${target.sectionId}`];
        newThemeState.templates[templateName] = { sourceFile, raw: templateRaw };
        return { themeState: newThemeState, changeSummary: { operationId, operation: op, target: `${templateName}.${target.sectionId}`, changed, preserved: true } };
    }

    if (op === 'update_section') {
        const existing = templateRaw.sections[target.sectionId];
        templateRaw.sections[target.sectionId] = { ...existing, settings: { ...(existing.settings || {}), ...changes.settings } };
        changed = Object.keys(changes.settings).map(k => `settings.${k}`);
        newThemeState.templates[templateName] = { sourceFile, raw: templateRaw };
        return { themeState: newThemeState, changeSummary: { operationId, operation: op, target: `${templateName}.${target.sectionId}`, changed, preserved: true } };
    }

    // Block-level operations
    const section = templateRaw.sections[target.sectionId];
    const blocks = { ...(section.blocks || {}) };
    let blockOrder = [...(section.block_order || [])];

    if (op === 'add_block') {
        const blockId = nextAutoId(Object.keys(blocks), changes.type);
        blocks[blockId] = { type: changes.type, settings: changes.settings || {} };
        blockOrder = insertAt(blockOrder, blockId, changes.position);
        templateRaw.sections[target.sectionId] = { ...section, blocks, block_order: blockOrder };
        changed = [`blocks.${blockId}`];
        newThemeState.templates[templateName] = { sourceFile, raw: templateRaw };
        return { themeState: newThemeState, changeSummary: { operationId, operation: op, target: `${templateName}.${target.sectionId}.${blockId}`, changed, preserved: true } };
    }

    if (op === 'remove_block') {
        delete blocks[target.blockId];
        blockOrder = blockOrder.filter(id => id !== target.blockId);
        templateRaw.sections[target.sectionId] = { ...section, blocks, block_order: blockOrder };
        changed = [`blocks.${target.blockId}`];
        newThemeState.templates[templateName] = { sourceFile, raw: templateRaw };
        return { themeState: newThemeState, changeSummary: { operationId, operation: op, target: `${templateName}.${target.sectionId}.${target.blockId}`, changed, preserved: true } };
    }

    if (op === 'update_block') {
        const existingBlock = blocks[target.blockId];
        blocks[target.blockId] = { ...existingBlock, settings: { ...(existingBlock.settings || {}), ...changes.settings } };
        templateRaw.sections[target.sectionId] = { ...section, blocks, block_order: blockOrder };
        changed = Object.keys(changes.settings).map(k => `settings.${k}`);
        newThemeState.templates[templateName] = { sourceFile, raw: templateRaw };
        return { themeState: newThemeState, changeSummary: { operationId, operation: op, target: `${templateName}.${target.sectionId}.${target.blockId}`, changed, preserved: true } };
    }

    throw new Error(`executeOperation(): unhandled operation type "${op}" — validateOperation() should have rejected this before reaching execution.`);
}

/**
 * Applies exactly ONE operation end to end: validate -> execute -> validate
 * the resulting ThemeState (§25). Never mutates the input ThemeState.
 */
function applyOperationToThemeState(themeState, operation, options = {}) {
    const startTime = Date.now();
    const requestId = options.requestId || instrumentation.nextRequestId('operation');
    // Always validate against THIS call's `themeState` argument, never a
    // possibly-stale `options.themeState` — critical inside
    // applyOperationsToThemeState()'s sequential loop below, where each
    // step's `themeState` is the evolving clone from the PREVIOUS step, not
    // the original state the caller's `options` object was first built with.
    const validation = validateOperation(operation, { ...options, themeState });

    if (!validation.valid) {
        instrumentation.logOperation({ requestId, operationId: generateOperationId(operation), operation: operation && operation.operation, valid: false, errorCount: validation.errors.length, durationMs: Date.now() - startTime });
        return { valid: false, errors: validation.errors, themeState: null, changeSummary: null };
    }

    const { themeState: newThemeState, changeSummary } = executeOperation(themeState, operation);
    const structuralCheck = validateThemeState(newThemeState);
    if (!structuralCheck.valid) {
        instrumentation.logOperation({ requestId, operationId: changeSummary.operationId, operation: operation.operation, valid: false, errorCount: structuralCheck.errors.length, durationMs: Date.now() - startTime });
        return { valid: false, errors: structuralCheck.errors.map(m => issue(OPERATION_ERROR_CODES.OPERATION_CONFLICT, 'themeState', m)), themeState: null, changeSummary: null };
    }

    instrumentation.logOperation({ requestId, operationId: changeSummary.operationId, operation: operation.operation, valid: true, errorCount: 0, changedCount: changeSummary.changed.length, durationMs: Date.now() - startTime });
    return { valid: true, errors: [], themeState: newThemeState, changeSummary };
}

// ---------------------------------------------------------------------------
// §20/§21 — atomic multi-operation execution. Every operation is validated
// against the ORIGINAL state first (so ordering problems like
// remove-then-update-the-same-target are caught deterministically before
// any mutation happens), then re-applied sequentially against one evolving
// clone. Any failure at any stage discards the whole in-progress clone and
// returns the ORIGINAL, untouched ThemeState — never a partial result.
// ---------------------------------------------------------------------------

function targetKey(operation) {
    const t = operation.target || {};
    return [t.templateName, t.sectionId, t.blockId].filter(Boolean).join('.');
}

/**
 * Deterministic ordering rule (§21): once an operation REMOVES a section or
 * block, no LATER operation in the same batch may target that exact
 * section/block again (update, remove-again, or add a block inside a
 * removed section) — this is the one ordering conflict the spec calls out
 * by name ("remove_section -> update_section on removed section must
 * fail"), and it generalizes cleanly to blocks. Anything else (e.g.
 * add_section -> update_section on the newly added one) is left to the
 * sequential re-validation below, which already catches "target doesn't
 * exist yet" naturally.
 */
function validateOperationOrder(operations) {
    const errors = [];
    const removedTargets = new Set();
    for (const operation of operations) {
        const key = targetKey(operation);
        if (removedTargets.has(key)) {
            errors.push(issue(OPERATION_ERROR_CODES.OPERATION_ORDER_INVALID, 'operations', `Operation "${operation.operation}" targets "${key}", which an earlier operation in this batch already removed.`));
        }
        if (operation.operation === 'remove_section' || operation.operation === 'remove_block') {
            removedTargets.add(key);
        }
    }
    return errors;
}

/**
 * options: { themeState, schemas, knownMerchantData, requestId }
 * Returns { valid, errors, themeState, changeSummaries }. On any failure,
 * `themeState` is null and the CALLER's original object is guaranteed
 * untouched (nothing here ever mutates it).
 */
function applyOperationsToThemeState(themeState, operations, options = {}) {
    const startTime = Date.now();
    const requestId = options.requestId || instrumentation.nextRequestId('operations');

    if (!Array.isArray(operations) || operations.length === 0) {
        return { valid: false, errors: [issue(OPERATION_ERROR_CODES.OPERATION_INVALID, 'operations', 'operations must be a non-empty array.')], themeState: null, changeSummaries: [] };
    }

    const orderErrors = validateOperationOrder(operations);
    if (orderErrors.length > 0) {
        instrumentation.logOperationBatch({ requestId, operationCount: operations.length, valid: false, errorCount: orderErrors.length, durationMs: Date.now() - startTime });
        return { valid: false, errors: orderErrors, themeState: null, changeSummaries: [] };
    }

    let working = themeState;
    const changeSummaries = [];
    for (const operation of operations) {
        const result = applyOperationToThemeState(working, operation, options);
        if (!result.valid) {
            // Fail closed: discard the whole in-progress clone chain.
            // `themeState` (the caller's original) was never touched by any
            // step, including this failing one (applyOperationToThemeState
            // never mutates its input).
            instrumentation.logOperationBatch({ requestId, operationCount: operations.length, valid: false, errorCount: result.errors.length, durationMs: Date.now() - startTime });
            return { valid: false, errors: result.errors, themeState: null, changeSummaries: [] };
        }
        working = result.themeState;
        changeSummaries.push(result.changeSummary);
    }

    instrumentation.logOperationBatch({ requestId, operationCount: operations.length, valid: true, errorCount: 0, durationMs: Date.now() - startTime });
    return { valid: true, errors: [], themeState: working, changeSummaries };
}

/**
 * §36 — dry run: identical validate+execute path, explicitly documented as
 * performing no I/O (this whole file never does I/O to begin with — the
 * distinction that matters is at the edit-pipeline.js/apply.js boundary,
 * not here).
 */
function dryRunOperations(themeState, operations, options = {}) {
    const result = applyOperationsToThemeState(themeState, operations, options);
    return {
        wouldApply: result.valid,
        errors: result.errors,
        changeSummaries: result.changeSummaries
    };
}

module.exports = {
    OPERATION_TYPES,
    OPERATION_ERROR_CODES,
    generateOperationId,
    resolveSectionTarget,
    resolveBlockTarget,
    validateOperation,
    executeOperation,
    applyOperationToThemeState,
    validateOperationOrder,
    applyOperationsToThemeState,
    dryRunOperations
};
