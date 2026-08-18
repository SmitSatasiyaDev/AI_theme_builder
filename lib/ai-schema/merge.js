/**
 * Phase 7 — Merge (pure, non-writing half of merge/apply safety).
 *
 * Reconciles an existing Phase 4 `ThemeState` with a Phase 5/6 validated
 * candidate — deterministically, with no AI call anywhere in this file
 * (§7). `apply.js` is the separate, file-system half (§6 — merge and apply
 * are deliberately two files, not one function, "required for testing and
 * safety").
 *
 * ---------------------------------------------------------------------
 * The candidate contract (§11 — "determine from the actual Phase 5
 * implementation ... do NOT assume"), confirmed by reading generation.js,
 * example-implementation.js and the REAL write path (2-copy-to-theme.js)
 * that already existed before this phase:
 *
 *   - For `FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE` templates (today: only
 *     "product") — Stage 1/2 and the legacy prompt both hard-require
 *     EXACTLY ONE section, of the forced type. The pre-existing
 *     `mergeProductTemplate()` (2-copy-to-theme.js) already treats this as
 *     a TARGETED, PARTIAL update: it splices that one section into the
 *     live template by TYPE match (reusing the existing key, or creating
 *     "main"), leaving every other existing section in that template file
 *     completely untouched. This is the one pre-existing "configure, don't
 *     replace" pattern in the whole codebase (per
 *     AI_THEME_BUILDER_PHASE_PLAN.md) — Phase 7 generalizes it, not
 *     reinvents it. See mergeForcedExclusiveTemplate() below.
 *
 *   - For every other template (today: "index") — both the legacy
 *     `buildSystemPrompt()` ("MUST include EXACTLY 10 sections... FIRST
 *     section MUST ALWAYS be slideshow") and Stage 1's plan (`order`, up to
 *     MAX_PLAN_SECTIONS) generate a COMPLETE desired section list for that
 *     one template, not a diff against what's currently there — confirmed
 *     by PHASE5_REPORT.md's own "No merge with existing content" known
 *     limitation and by 2-copy-to-theme.js's pre-Phase-7 behavior (a full
 *     `copyFile()`, not a merge, for any non-product template). Per §11:
 *     "If the candidate is intentionally a complete ... structure, the
 *     merge MAY replace the relevant ... structure while still preserving
 *     unrelated templates, global settings not targeted, unknown data
 *     outside the target, unrelated files." That is exactly the policy
 *     implemented here: mergeFullStructureTemplate() replaces ONLY the
 *     target template's own `sections`/`order`; every other template,
 *     every untouched global setting, and every other file is left
 *     completely alone by construction (mergeThemeState() only ever
 *     touches ONE template entry of the cloned ThemeState).
 *
 *     Because this intentionally discards whatever was previously in the
 *     target template — including sections unknown to the AI schema
 *     catalog, which Phase 4/6 otherwise always preserve — this specific
 *     replacement requires an explicit, non-default acknowledgement
 *     (`acknowledgeUnknownSectionReplacement: true`) whenever the existing
 *     target template actually contains such sections. Silently discarding
 *     unknown data is exactly what §2/§12 forbid; requiring the caller to
 *     say so explicitly keeps that decision visible instead of implicit.
 * ---------------------------------------------------------------------
 */

const instrumentation = require('./instrumentation');
const { FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE } = require('./retrieval');

const MERGE_ERROR_CODES = Object.freeze({
    // Malformed/insufficient input to even attempt a merge — missing
    // required validation evidence (§8), missing templateName/candidate,
    // or a candidate shape that doesn't match its template's known policy
    // (e.g. more than one section for a forced-exclusive-section template).
    MERGE_INVALID_TARGET: 'MERGE_INVALID_TARGET',
    // candidate.order contains the same section id twice — validateOutput()
    // doesn't check this today (duplicate object keys are impossible, but
    // an `order` ARRAY listing the same id twice is not caught upstream);
    // defense in depth, not a duplicate of an existing check (§19).
    MERGE_DUPLICATE_ID: 'MERGE_DUPLICATE_ID',
    // A forced-exclusive-section template's EXISTING content already has
    // more than one section of the forced type — ambiguous which one the
    // candidate should replace. Fail closed rather than guess (§20).
    MERGE_SECTION_TYPE_CONFLICT: 'MERGE_SECTION_TYPE_CONFLICT',
    // A full-structure replacement would silently discard one or more
    // existing sections unknown to the AI schema catalog, and the caller
    // hasn't explicitly acknowledged that (see file header).
    MERGE_UNSAFE_REPLACEMENT: 'MERGE_UNSAFE_REPLACEMENT'
});

function conflict(code, path, message) {
    return { code, path, message };
}

function cloneJSON(value) {
    return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function emptyTemplateRaw() {
    return { sections: {}, order: [] };
}

// ---------------------------------------------------------------------------
// §10/§16/§17 — per-template merge policies.
// ---------------------------------------------------------------------------

/**
 * Partial/targeted merge for a FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE
 * template (e.g. "product"): splices the candidate's single section into
 * the existing template by TYPE match, preserving every other existing
 * section, every other existing property on the matched section (§13 —
 * spreading the existing section object before overwriting only the
 * fields the candidate actually owns), and the existing order otherwise.
 * Generalizes 2-copy-to-theme.js's mergeProductTemplate() unchanged.
 */
function mergeForcedExclusiveTemplate(existingRaw, candidate, forcedSectionId) {
    const conflicts = [];
    const candidateSectionId = candidate.order[0];
    const candidateSection = candidate.sections[candidateSectionId];

    if (candidate.order.length !== 1 || !candidateSection || candidateSection.type !== forcedSectionId) {
        conflicts.push(conflict(
            MERGE_ERROR_CODES.MERGE_INVALID_TARGET,
            'candidate',
            `Expected exactly one "${forcedSectionId}" section for this template, got order ${JSON.stringify(candidate.order)}`
        ));
        return { conflicts, mergedRaw: null, summary: null };
    }

    const dest = cloneJSON(existingRaw) || emptyTemplateRaw();
    if (!dest.sections || typeof dest.sections !== 'object') dest.sections = {};
    if (!Array.isArray(dest.order)) dest.order = [];

    const matches = Object.entries(dest.sections).filter(([, s]) => s && s.type === forcedSectionId);
    if (matches.length > 1) {
        conflicts.push(conflict(
            MERGE_ERROR_CODES.MERGE_SECTION_TYPE_CONFLICT,
            `sections`,
            `Existing template already has ${matches.length} sections of type "${forcedSectionId}" — ambiguous which one to replace.`
        ));
        return { conflicts, mergedRaw: null, summary: null };
    }

    const existedBefore = matches.length === 1;
    const targetKey = existedBefore ? matches[0][0] : 'main';

    dest.sections[targetKey] = {
        ...(dest.sections[targetKey] || {}),
        type: candidateSection.type,
        // Spread (not replace): a candidate whose schema declares no
        // section-level settings at all (e.g. "footer" — merchant styling
        // is deliberately out of AI scope, see footer.json) must not wipe
        // every existing setting down to {}. Keys the candidate DOES
        // provide (e.g. "product"/main-product's AI-controlled settings)
        // still override, same as before.
        settings: { ...((dest.sections[targetKey] || {}).settings || {}), ...candidateSection.settings },
        blocks: candidateSection.blocks,
        block_order: candidateSection.block_order
    };
    if (!dest.order.includes(targetKey)) {
        dest.order = [targetKey, ...dest.order];
    }

    const summary = {
        addedSections: existedBefore ? [] : [targetKey],
        updatedSections: existedBefore ? [targetKey] : [],
        removedSections: [],
        preservedSectionIds: Object.keys(dest.sections).filter(id => id !== targetKey)
    };

    return { conflicts: [], mergedRaw: dest, summary };
}

/**
 * Full-structure replacement for a non-forced-exclusive template (e.g.
 * "index"): the candidate IS the complete desired `sections`/`order` for
 * this one template (see file header). Every OTHER template in the cloned
 * ThemeState, and every untouched global setting, is never even visited by
 * this function — preservation there is structural (mergeThemeState() only
 * clones+replaces the one targeted template entry), not a rule this
 * function has to enforce itself.
 */
function mergeFullStructureTemplate(existingRaw, candidate, existingClassification, acknowledgeUnknownSectionReplacement) {
    const conflicts = [];

    if (new Set(candidate.order).size !== candidate.order.length) {
        conflicts.push(conflict(MERGE_ERROR_CODES.MERGE_DUPLICATE_ID, 'candidate.order', 'candidate.order contains a duplicate section id.'));
    }

    const existingSections = (existingClassification && existingClassification.sections) || {};
    const unknownExisting = Object.entries(existingSections).filter(([, s]) => !s.knownToAI).map(([id]) => id);
    if (unknownExisting.length > 0 && !acknowledgeUnknownSectionReplacement) {
        conflicts.push(conflict(
            MERGE_ERROR_CODES.MERGE_UNSAFE_REPLACEMENT,
            'template',
            `This template currently has ${unknownExisting.length} section(s) unknown to the AI schema catalog (${unknownExisting.join(', ')}) that a full-structure replacement would discard. Pass acknowledgeUnknownSectionReplacement: true to proceed anyway.`
        ));
    }

    if (conflicts.length > 0) return { conflicts, mergedRaw: null, summary: null };

    const existingSectionIds = new Set(Object.keys((existingRaw && existingRaw.sections) || {}));
    const candidateSectionIds = new Set(candidate.order);

    const summary = {
        addedSections: [...candidateSectionIds].filter(id => !existingSectionIds.has(id)),
        updatedSections: [...candidateSectionIds].filter(id => existingSectionIds.has(id)),
        removedSections: [...existingSectionIds].filter(id => !candidateSectionIds.has(id)),
        preservedSectionIds: []
    };

    const mergedRaw = { sections: cloneJSON(candidate.sections), order: [...candidate.order] };
    return { conflicts: [], mergedRaw, summary };
}

// ---------------------------------------------------------------------------
// §14 — global settings: targeted merge, never a wholesale rebuild. Only
// `current` is ever modified, and only the keys the caller explicitly
// passes; `presets`/`platform_customizations`/any other top-level key are
// spread through untouched. This directly fixes the AUDIT.md-flagged
// data-loss risk (settings_data.json previously rebuilt fresh from
// global.json's 8 tokens every run).
// ---------------------------------------------------------------------------

function mergeGlobalSettingsChanges(existingGlobalSettingsRaw, changes) {
    const base = (existingGlobalSettingsRaw && typeof existingGlobalSettingsRaw === 'object')
        ? cloneJSON(existingGlobalSettingsRaw)
        : { current: {}, presets: {}, platform_customizations: { custom_css: [] } };

    if (!base.current || typeof base.current !== 'object') base.current = {};

    if (!changes || Object.keys(changes).length === 0) {
        return { mergedRaw: base, changedKeys: [] };
    }

    const changedKeys = Object.keys(changes).filter(key => base.current[key] !== changes[key]);
    base.current = { ...base.current, ...changes };
    return { mergedRaw: base, changedKeys };
}

// ---------------------------------------------------------------------------
// Orchestrator — operates on ONE (templateName, candidate) pair per call,
// matching how generation.js/1-generate-theme.js actually produce
// candidates today (one template per pipeline run). Never mutates its
// inputs (tested); never writes anything (apply.js's job).
// ---------------------------------------------------------------------------

/**
 * options:
 *   - templateName: string, REQUIRED.
 *   - candidate: {sections, order}, REQUIRED — already validated (§8: the
 *     caller must have already run validateOutput()+validateCandidate(),
 *     and for staged generation matchesPlan()).
 *   - candidateValidation: the Phase 6 validateCandidate() result for this
 *     exact candidate — REQUIRED evidence; merge fails closed without it
 *     rather than trusting an unvalidated candidate (§8).
 *   - globalSettingsChanges: optional flat {key: value} object to merge
 *     into config/settings_data.json's `current` (§14).
 *   - acknowledgeUnknownSectionReplacement: default false (§ file header).
 */
function mergeThemeState(existingThemeState, options = {}) {
    const {
        templateName,
        candidate,
        candidateValidation,
        globalSettingsChanges = null,
        acknowledgeUnknownSectionReplacement = false,
        requestId = instrumentation.nextRequestId('merge')
    } = options;

    const startTime = Date.now();
    function finish(result) {
        instrumentation.logMerge({
            requestId,
            templateName,
            valid: result.valid,
            conflictCount: result.conflicts.length,
            conflictCodes: [...new Set(result.conflicts.map(c => c.code))],
            addedSectionCount: result.summary ? result.summary.addedSections.length : 0,
            updatedSectionCount: result.summary ? result.summary.updatedSections.length : 0,
            removedSectionCount: result.summary ? result.summary.removedSections.length : 0,
            changedSettingCount: result.summary ? result.summary.changedSettings.length : 0,
            preservedUnknownCount: result.summary ? result.summary.preservedUnknownComponents.length : 0,
            durationMs: Date.now() - startTime
        });
        return result;
    }

    if (!templateName || typeof templateName !== 'string') {
        return finish({ valid: false, conflicts: [conflict(MERGE_ERROR_CODES.MERGE_INVALID_TARGET, 'templateName', 'templateName is required.')], mergedThemeState: null, summary: null });
    }
    if (!candidate || typeof candidate !== 'object' || !candidate.sections || !Array.isArray(candidate.order)) {
        return finish({ valid: false, conflicts: [conflict(MERGE_ERROR_CODES.MERGE_INVALID_TARGET, 'candidate', 'candidate must be a validated {sections, order} object.')], mergedThemeState: null, summary: null });
    }
    if (!candidateValidation || candidateValidation.valid !== true) {
        return finish({
            valid: false,
            conflicts: [conflict(MERGE_ERROR_CODES.MERGE_INVALID_TARGET, 'candidateValidation', 'merge requires evidence that the candidate already passed Phase 6 validateCandidate() — none was provided or it was not valid.')],
            mergedThemeState: null,
            summary: null
        });
    }

    const existingTemplate = existingThemeState.templates && existingThemeState.templates[templateName];
    const existingRaw = existingTemplate ? existingTemplate.raw : emptyTemplateRaw();
    const existingClassification = existingTemplate ? existingTemplate.classification : { sections: {} };

    const forcedSectionId = FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE[templateName];
    const { conflicts, mergedRaw, summary: templateSummary } = forcedSectionId
        ? mergeForcedExclusiveTemplate(existingRaw, candidate, forcedSectionId)
        : mergeFullStructureTemplate(existingRaw, candidate, existingClassification, acknowledgeUnknownSectionReplacement);

    if (conflicts.length > 0) {
        return finish({ valid: false, conflicts, mergedThemeState: null, summary: null });
    }

    const { mergedRaw: mergedGlobalRaw, changedKeys } = mergeGlobalSettingsChanges(
        existingThemeState.globalSettings ? existingThemeState.globalSettings.raw : null,
        globalSettingsChanges
    );

    // Deep-clone the WHOLE existing ThemeState first (§7's "merge does not
    // mutate input"), then replace only the one targeted template entry and
    // globalSettings — every other template/property is untouched by
    // construction, not by a preservation rule this function has to enforce.
    const mergedThemeState = cloneJSON({
        themeId: existingThemeState.themeId,
        sourcePath: existingThemeState.sourcePath,
        schemaVersion: existingThemeState.schemaVersion,
        createdAt: existingThemeState.createdAt,
        templates: existingThemeState.templates || {},
        globalSettings: existingThemeState.globalSettings
    });

    mergedThemeState.templates[templateName] = {
        sourceFile: (existingTemplate && existingTemplate.sourceFile) || `templates/${templateName}.json`,
        raw: mergedRaw
        // classification is intentionally NOT recomputed here — apply.js
        // re-derives ThemeState (and therefore classification) from what
        // was actually written, as part of its post-write verification
        // (§28), so this in-memory object is never trusted as the final
        // word on classification.
    };
    mergedThemeState.globalSettings = mergedGlobalRaw
        ? { sourceFile: (existingThemeState.globalSettings && existingThemeState.globalSettings.sourceFile) || 'config/settings_data.json', raw: mergedGlobalRaw }
        : existingThemeState.globalSettings;
    mergedThemeState.updatedAt = existingThemeState.updatedAt; // stamped by the caller after a real write, not guessed here — this function's own Date.now() usage is instrumentation timing only (finish()), never merge CONTENT

    const preservedUnknownComponents = Object.entries(existingClassification.sections || {})
        .filter(([id, s]) => !s.knownToAI && templateSummary.preservedSectionIds.includes(id))
        .map(([id]) => id);

    const summary = {
        changedFiles: [
            `templates/${templateName}.json`,
            ...(changedKeys.length > 0 ? ['config/settings_data.json'] : [])
        ],
        changedTemplates: [templateName],
        addedSections: templateSummary.addedSections,
        updatedSections: templateSummary.updatedSections,
        removedSections: templateSummary.removedSections,
        changedSettings: changedKeys,
        preservedUnknownComponents
    };

    return finish({ valid: true, conflicts: [], mergedThemeState, summary });
}

/**
 * §23 — dry-run report: runs the exact same pure merge (which never writes
 * anything to begin with) and shapes the result as a report rather than an
 * internal ThemeState object, so a caller can show "what would change"
 * without ever reaching apply.js.
 */
function dryRunMerge(existingThemeState, options = {}) {
    const result = mergeThemeState(existingThemeState, options);
    return {
        wouldApply: result.valid,
        conflicts: result.conflicts,
        summary: result.summary
    };
}

module.exports = {
    MERGE_ERROR_CODES,
    mergeForcedExclusiveTemplate,
    mergeFullStructureTemplate,
    mergeGlobalSettingsChanges,
    mergeThemeState,
    dryRunMerge
};
