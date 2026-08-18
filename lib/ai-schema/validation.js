/**
 * Phase 6 — Validation Extension.
 *
 * Additive validation layers on top of the Phase 1 `validateOutput()`
 * (`example-implementation.js`), which stays completely untouched — same
 * signature, same behavior, same passing tests (AI_THEME_BUILDER_PHASE6_PLAN.md
 * §6: "do not weaken it"). Everything here assumes its input already passed
 * `validateOutput()` (structural shape, section/block type membership,
 * `allowed_blocks`, `max_blocks`, `block_order`, image-hallucination guard —
 * see PHASE6_REPORT.md "Existing Validation"); it never re-implements those
 * checks (§5 — "reuse existing validation wherever possible, do not
 * duplicate rules that already exist").
 *
 * Pipeline shape (§5):
 *
 *   Configuration Generation
 *        │
 *        ▼
 *   validateOutput()            <- Phase 1, unchanged, structural baseline
 *        │ (only reached if valid)
 *        ▼
 *   validateCandidate()         <- Phase 6, THIS FILE: allowed_on-vs-template,
 *        │                         deep setting validation, product/collection
 *        │                         hallucination guard
 *        ▼
 *   Final Candidate
 *
 * Every validator here is pure, deterministic application logic — no AI call
 * decides whether a section/setting/reference is valid (§27). AI is only
 * ever used afterward, by a caller, for bounded repair once these
 * deterministic checks report a structured error.
 */

const { isEligibleForTemplate } = require('./retrieval');

// ---------------------------------------------------------------------------
// Structured result contract (§22) — stable, small error-code set (§22: "do
// not create hundreds of unnecessary codes"). Every finding carries a code,
// a path (dot/bracket path into the candidate, e.g. `sections.hero-1.settings.title`)
// and a human-readable message (for repair prompts / debugging / future UI).
// ---------------------------------------------------------------------------

const ERROR_CODES = Object.freeze({
    SECTION_NOT_ALLOWED_ON_TEMPLATE: 'SECTION_NOT_ALLOWED_ON_TEMPLATE',
    SETTING_UNKNOWN: 'SETTING_UNKNOWN',
    SETTING_INVALID_TYPE: 'SETTING_INVALID_TYPE',
    SETTING_INVALID_OPTION: 'SETTING_INVALID_OPTION',
    SETTING_OUT_OF_RANGE: 'SETTING_OUT_OF_RANGE',
    DATA_REFERENCE_HALLUCINATED: 'DATA_REFERENCE_HALLUCINATED'
});

function makeIssue(code, path, message) {
    return { code, path, message };
}

function emptyResult() {
    return { valid: true, errors: [], warnings: [] };
}

function mergeResults(results) {
    const errors = results.flatMap(r => r.errors);
    const warnings = results.flatMap(r => r.warnings);
    return { valid: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// §7/§8 — allowed_on vs. target template.
//
// Reuses retrieval.js's isEligibleForTemplate() so "missing/empty allowed_on
// == unrestricted, everywhere" is one single definition, not reinterpreted
// here (retrieval.js's own comment: "none of the current 16 are actually
// missing it, so treat as eligible everywhere rather than silently excluding
// a mis-authored schema"). This is the FIRST place allowed_on is enforced
// against actual generated OUTPUT (retrieval.js only ever used it to narrow
// candidates BEFORE generation; nothing previously checked the final
// candidate itself — see PHASE6_REPORT.md for the concrete gap this closes:
// a FULL_FALLBACK retrieval pool is unfiltered by allowed_on).
// ---------------------------------------------------------------------------

function validateAllowedOn(config, schemas, templateName) {
    const sectionById = new Map(schemas.sectionSchemas.map(s => [s.id, s]));
    const errors = [];

    for (const [sectionId, section] of Object.entries(config.sections || {})) {
        const sectionSchema = sectionById.get(section.type);
        // A section type unknown to `schemas` is validateOutput()'s job to
        // reject (already ran, already passed) — nothing to check here.
        if (!sectionSchema) continue;

        if (!isEligibleForTemplate(sectionSchema, templateName)) {
            errors.push(makeIssue(
                ERROR_CODES.SECTION_NOT_ALLOWED_ON_TEMPLATE,
                `sections.${sectionId}`,
                `Section "${sectionId}" (type "${section.type}") declares allowed_on ${JSON.stringify(sectionSchema.allowed_on)}, which does not include the target template "${templateName}".`
            ));
        }
    }

    return { valid: errors.length === 0, errors, warnings: [] };
}

// ---------------------------------------------------------------------------
// §12 — Settings validation. The schema convention (SCHEMA_CREATION_GUIDE.md
// "Settings Types", confirmed against all 69 real schema files) has exactly
// three setting-definition shapes:
//
//   1. string   — a type name ("text", "richtext", "color", "image_picker",
//                 "product_picker", "collection", ...). No further metadata.
//   2. array    — an enum of literal allowed option values (e.g.
//                 ["true","false"], ["left","center","right"]).
//   3. object   — { type: "number"|"range"|"checkbox"|"text"|"richtext"|
//                 "select", min?, max?, options?, default?, ... }.
//
// getSettingKind() normalizes all three into one shape validateSettingValue()
// can dispatch on without re-deriving this three-way distinction elsewhere.
// ---------------------------------------------------------------------------

function getSettingKind(settingSchema) {
    if (typeof settingSchema === 'string') {
        return { kind: 'typeName', typeName: settingSchema };
    }
    if (Array.isArray(settingSchema)) {
        return { kind: 'enum', options: settingSchema };
    }
    if (settingSchema && typeof settingSchema === 'object') {
        return { kind: 'object', typeName: settingSchema.type, def: settingSchema };
    }
    return { kind: 'unknown' };
}

// image/image_picker hallucination is already fully covered by
// validateOutput() (§6 — do not duplicate). product_picker/collection are
// handled separately by validateDataReferences() below, not here, so a
// single error code isn't overloaded with two different meanings.
const SKIPPED_TYPE_NAMES = new Set(['image', 'image_picker', 'product_picker', 'collection']);
// Free-form merchant content types — §16: "the goal is schema correctness,
// not content policing." Only a lightweight JS-type check applies (string),
// no pattern/format validation, so ordinary merchant copy is never rejected
// for containing punctuation, HTML, long text, etc.
const FREEFORM_STRING_TYPE_NAMES = new Set(['text', 'textarea', 'inline_richtext', 'richtext', 'html', 'url', 'color', 'video']);

/**
 * Validates ONE setting's value against ONE setting schema definition.
 * Returns an array of issues (usually 0 or 1). `value === undefined` (the AI
 * simply didn't set this key) is always fine — schemas don't declare
 * required settings (confirmed: no schema file uses a "required" flag at
 * the setting-definition level; "required" only ever appears as a setting
 * NAME for form-input blocks, e.g. blocks/textarea.json's own `required`
 * field, which is itself just a boolean-enum setting like any other).
 */
function validateSettingValue(settingSchema, value, path) {
    if (value === undefined) return [];

    const { kind, typeName, options, def } = getSettingKind(settingSchema);

    if (kind === 'typeName') {
        if (SKIPPED_TYPE_NAMES.has(typeName)) return [];
        if (FREEFORM_STRING_TYPE_NAMES.has(typeName)) {
            if (typeof value !== 'string') {
                return [makeIssue(ERROR_CODES.SETTING_INVALID_TYPE, path, `expected a string for "${typeName}" setting, got ${typeof value}`)];
            }
            return [];
        }
        // Unrecognized type-name string (schema authoring drift) — nothing
        // safe to assert; not this validator's job to invent a rule.
        return [];
    }

    if (kind === 'enum') {
        const stringOptions = options.map(o => String(o));
        if (!stringOptions.includes(String(value))) {
            return [makeIssue(ERROR_CODES.SETTING_INVALID_OPTION, path, `value ${JSON.stringify(value)} is not one of the allowed options ${JSON.stringify(options)}`)];
        }
        return [];
    }

    if (kind === 'object') {
        if (typeName === 'checkbox') {
            if (typeof value !== 'boolean') {
                return [makeIssue(ERROR_CODES.SETTING_INVALID_TYPE, path, `expected a boolean for checkbox setting, got ${typeof value} (${JSON.stringify(value)})`)];
            }
            return [];
        }
        if (typeName === 'number' || typeName === 'range') {
            if (typeof value !== 'number' || Number.isNaN(value)) {
                return [makeIssue(ERROR_CODES.SETTING_INVALID_TYPE, path, `expected a number for "${typeName}" setting, got ${typeof value} (${JSON.stringify(value)})`)];
            }
            if (typeof def.min === 'number' && value < def.min) {
                return [makeIssue(ERROR_CODES.SETTING_OUT_OF_RANGE, path, `value ${value} is below the minimum ${def.min}`)];
            }
            if (typeof def.max === 'number' && value > def.max) {
                return [makeIssue(ERROR_CODES.SETTING_OUT_OF_RANGE, path, `value ${value} exceeds the maximum ${def.max}`)];
            }
            return [];
        }
        if (typeName === 'select') {
            // Documented by SCHEMA_CREATION_GUIDE.md but not exercised by any
            // current real schema (§30/§32 — no schema was invented to test
            // this; see PHASE6_REPORT.md "Known limitations").
            const values = Array.isArray(def.options) ? def.options.map(o => (o && typeof o === 'object') ? o.value : o) : [];
            if (values.length > 0 && !values.map(String).includes(String(value))) {
                return [makeIssue(ERROR_CODES.SETTING_INVALID_OPTION, path, `value ${JSON.stringify(value)} is not one of the allowed select options ${JSON.stringify(values)}`)];
            }
            return [];
        }
        if (SKIPPED_TYPE_NAMES.has(typeName)) return [];
        if (FREEFORM_STRING_TYPE_NAMES.has(typeName)) {
            if (typeof value !== 'string') {
                return [makeIssue(ERROR_CODES.SETTING_INVALID_TYPE, path, `expected a string for "${typeName}" setting, got ${typeof value}`)];
            }
            return [];
        }
        return [];
    }

    return [];
}

/**
 * Walks every section's and every block's settings object in a validated
 * candidate, calling visitor(settingKey, settingSchemaOrUndefined, value,
 * path, {scope: 'section'|'block', ownerId, typeId}) once per key actually
 * PRESENT in the output. Shared by validateSettings() and
 * validateDataReferences() so the walk itself is written once (§5 — layers,
 * not one giant function, but no duplicated iteration either).
 */
function walkSettings(config, schemas, visitor) {
    const sectionById = new Map(schemas.sectionSchemas.map(s => [s.id, s]));
    const blockById = new Map(schemas.blockSchemas.map(b => [b.id, b]));

    for (const [sectionId, section] of Object.entries(config.sections || {})) {
        const sectionSchema = sectionById.get(section.type);
        if (sectionSchema && section.settings && typeof section.settings === 'object') {
            for (const [key, value] of Object.entries(section.settings)) {
                const settingSchema = sectionSchema.settings ? sectionSchema.settings[key] : undefined;
                visitor(key, settingSchema, value, `sections.${sectionId}.settings.${key}`, { scope: 'section', ownerId: sectionId, typeId: section.type });
            }
        }

        if (section.blocks && typeof section.blocks === 'object') {
            for (const [blockId, block] of Object.entries(section.blocks)) {
                const blockSchema = blockById.get(block.type);
                if (blockSchema && block.settings && typeof block.settings === 'object') {
                    for (const [key, value] of Object.entries(block.settings)) {
                        const settingSchema = blockSchema.settings ? blockSchema.settings[key] : undefined;
                        visitor(key, settingSchema, value, `sections.${sectionId}.blocks.${blockId}.settings.${key}`, { scope: 'block', ownerId: blockId, typeId: block.type });
                    }
                }
            }
        }
    }
}

/**
 * §12/§13 — deep setting validation: type/enum/range/checkbox correctness
 * for settings the schema DOES define, and outright rejection of settings
 * the AI emitted that the schema doesn't define at all ("AI-generated
 * setting → not supported by schema → reject", §13). This only ever
 * inspects a freshly generated CANDIDATE's settings, never the live theme's
 * `config/settings_data.json` — so "existing unknown theme setting
 * preserved" (§13, §29) is automatically true: this validator has no code
 * path that reads or mutates that file at all (see theme-state.js, whose
 * `raw` passthrough already preserves it untouched — PHASE4_REPORT.md).
 */
function validateSettings(config, schemas) {
    const errors = [];
    walkSettings(config, schemas, (key, settingSchema, value, path, owner) => {
        if (settingSchema === undefined) {
            errors.push(makeIssue(
                ERROR_CODES.SETTING_UNKNOWN,
                path,
                `"${key}" is not a setting defined by ${owner.scope} type "${owner.typeId}" — AI-generated settings must use only keys the schema declares.`
            ));
            return;
        }
        errors.push(...validateSettingValue(settingSchema, value, path));
    });
    return { valid: errors.length === 0, errors, warnings: [] };
}

// ---------------------------------------------------------------------------
// §14 — Product/collection data reference hallucination guard. Mirrors the
// existing image/image_picker guard in validateOutput() exactly (empty
// string is always safe; a real, KNOWN handle is safe; anything else is
// rejected as invented merchant data) — see AUDIT.md's documented
// `"product": "signature-vegan-chicken"` artifact, the concrete evidence
// this closes. There is no product/collection catalog integration in this
// repository yet (that's Phase 13 in AI_THEME_BUILDER_PHASE_PLAN.md); until
// one exists, `knownMerchantData` defaults to empty, so ANY non-empty
// product_picker/collection value is rejected — the same safe-by-default
// posture the image guard already established, not a new invention (§14:
// "if merchant data is unavailable ... otherwise reject the hallucinated
// reference").
// ---------------------------------------------------------------------------

const DATA_REFERENCE_TYPE_NAMES = new Set(['product_picker', 'collection']);

function isKnownReference(typeName, value, knownMerchantData) {
    if (typeName === 'product_picker') {
        return Array.isArray(knownMerchantData.products) && knownMerchantData.products.includes(value);
    }
    if (typeName === 'collection') {
        return Array.isArray(knownMerchantData.collections) && knownMerchantData.collections.includes(value);
    }
    return false;
}

function validateDataReferences(config, schemas, context = {}) {
    const knownMerchantData = context.knownMerchantData || {};
    const errors = [];

    walkSettings(config, schemas, (key, settingSchema, value, path) => {
        if (settingSchema === undefined) return; // SETTING_UNKNOWN already covers this via validateSettings()
        const { typeName } = getSettingKind(settingSchema);
        if (!DATA_REFERENCE_TYPE_NAMES.has(typeName)) return;
        if (value === '' || value === null || value === undefined) return; // explicitly left blank — safe

        if (typeof value !== 'string' || !isKnownReference(typeName, value, knownMerchantData)) {
            errors.push(makeIssue(
                ERROR_CODES.DATA_REFERENCE_HALLUCINATED,
                path,
                `"${key}" (${typeName}) has value ${JSON.stringify(value)}, which is not a known merchant ${typeName === 'product_picker' ? 'product' : 'collection'} handle — leave this field empty rather than inventing one.`
            ));
        }
    });

    return { valid: errors.length === 0, errors, warnings: [] };
}

// ---------------------------------------------------------------------------
// §20/§21 — ThemeState compatibility boundary. Deliberately NOT a merge or
// an "unrelated content must be byte-identical" rule (§21 explicitly warns
// against that for initial generation, which may legitimately
// replace/reorder the homepage per the Phase 5 generation contract). This
// only checks that the ThemeState the candidate is being validated against
// is itself structurally sound, and surfaces informational context — never
// blocks a candidate on its own.
// ---------------------------------------------------------------------------

function validateThemeCompatibility(themeState, templateName) {
    const warnings = [];
    if (!themeState) return emptyResult();

    if (!themeState.validation || !themeState.validation.valid) {
        warnings.push(makeIssue(
            'THEME_STATE_STRUCTURAL_ISSUE',
            'themeState',
            `The current ThemeState has ${(themeState.validation && themeState.validation.errors.length) || 'unknown'} structural error(s) — see themeState.validation for details. This does not block candidate generation.`
        ));
    }

    const template = themeState.templates && themeState.templates[templateName];
    if (template) {
        const summary = template.classification;
        const unknownSections = Object.values(summary.sections).filter(s => !s.knownToAI).length;
        if (unknownSections > 0) {
            warnings.push(makeIssue(
                'THEME_STATE_UNKNOWN_COMPONENTS',
                `themeState.templates.${templateName}`,
                `${unknownSections} section(s) currently on "${templateName}" are not recognized by the AI schema catalog — they are preserved as-is (never AI-editable) and are informational context only.`
            ));
        }
    }

    return { valid: true, errors: [], warnings };
}

// ---------------------------------------------------------------------------
// Orchestrator — assumes `config` already passed validateOutput() (§5's
// pipeline diagram: Output Validation happens BEFORE this layer runs).
// ---------------------------------------------------------------------------

function validateCandidate(config, schemas, context = {}) {
    const { templateName = 'index', knownMerchantData = {}, themeState = null } = context;

    const results = [
        validateAllowedOn(config, schemas, templateName),
        validateSettings(config, schemas),
        validateDataReferences(config, schemas, { knownMerchantData })
    ];

    const themeCompat = validateThemeCompatibility(themeState, templateName);
    results.push(themeCompat);

    return mergeResults(results);
}

module.exports = {
    ERROR_CODES,
    makeIssue,
    validateAllowedOn,
    getSettingKind,
    validateSettingValue,
    walkSettings,
    validateSettings,
    validateDataReferences,
    validateThemeCompatibility,
    validateCandidate
};
