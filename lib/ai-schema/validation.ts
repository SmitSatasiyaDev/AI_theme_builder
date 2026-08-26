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

import { isEligibleForTemplate } from "./retrieval";
import type { GenerationConfig, KnownMerchantData, SchemaCatalog, SettingSchema, SettingSchemaObject, ThemeState, ValidationIssue, ValidationResult } from "./types";

// ---------------------------------------------------------------------------
// Structured result contract (§22) — stable, small error-code set (§22: "do
// not create hundreds of unnecessary codes"). Every finding carries a code,
// a path (dot/bracket path into the candidate, e.g. `sections.hero-1.settings.title`)
// and a human-readable message (for repair prompts / debugging / future UI).
// ---------------------------------------------------------------------------

export const ERROR_CODES = Object.freeze({
    SECTION_NOT_ALLOWED_ON_TEMPLATE: "SECTION_NOT_ALLOWED_ON_TEMPLATE",
    SETTING_UNKNOWN: "SETTING_UNKNOWN",
    SETTING_INVALID_TYPE: "SETTING_INVALID_TYPE",
    SETTING_INVALID_OPTION: "SETTING_INVALID_OPTION",
    SETTING_OUT_OF_RANGE: "SETTING_OUT_OF_RANGE",
    DATA_REFERENCE_HALLUCINATED: "DATA_REFERENCE_HALLUCINATED"
});

export function makeIssue(code: string, path: string, message: string): ValidationIssue {
    return { code, path, message };
}

function emptyResult(): ValidationResult {
    return { valid: true, errors: [], warnings: [] };
}

function mergeResults(results: ValidationResult[]): ValidationResult {
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

export function validateAllowedOn(config: GenerationConfig, schemas: SchemaCatalog, templateName: string): ValidationResult {
    const sectionById = new Map(schemas.sectionSchemas.map(s => [s.id, s]));
    const errors: ValidationIssue[] = [];

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

export type SettingKind =
    | { kind: "typeName"; typeName: string }
    | { kind: "enum"; options: unknown[] }
    | { kind: "object"; typeName: string | undefined; def: SettingSchemaObject }
    | { kind: "unknown" };

export function getSettingKind(settingSchema: SettingSchema | undefined): SettingKind {
    if (typeof settingSchema === "string") {
        return { kind: "typeName", typeName: settingSchema };
    }
    if (Array.isArray(settingSchema)) {
        return { kind: "enum", options: settingSchema };
    }
    if (settingSchema && typeof settingSchema === "object") {
        return { kind: "object", typeName: settingSchema.type, def: settingSchema };
    }
    return { kind: "unknown" };
}

// image/image_picker hallucination is already fully covered by
// validateOutput() (§6 — do not duplicate). product_picker/collection are
// handled separately by validateDataReferences() below, not here, so a
// single error code isn't overloaded with two different meanings.
const SKIPPED_TYPE_NAMES = new Set(["image", "image_picker", "product_picker", "collection"]);
// Free-form merchant content types — §16: "the goal is schema correctness,
// not content policing." Only a lightweight JS-type check applies (string),
// no pattern/format validation, so ordinary merchant copy is never rejected
// for containing punctuation, HTML, long text, etc.
const FREEFORM_STRING_TYPE_NAMES = new Set(["text", "textarea", "inline_richtext", "richtext", "html", "url", "color", "video"]);

/**
 * Validates ONE setting's value against ONE setting schema definition.
 * Returns an array of issues (usually 0 or 1). `value === undefined` (the AI
 * simply didn't set this key) is always fine — schemas don't declare
 * required settings (confirmed: no schema file uses a "required" flag at
 * the setting-definition level; "required" only ever appears as a setting
 * NAME for form-input blocks, e.g. blocks/textarea.json's own `required`
 * field, which is itself just a boolean-enum setting like any other).
 */
export function validateSettingValue(settingSchema: SettingSchema | undefined, value: unknown, path: string): ValidationIssue[] {
    if (value === undefined) return [];

    const kind = getSettingKind(settingSchema);

    if (kind.kind === "typeName") {
        const { typeName } = kind;
        if (SKIPPED_TYPE_NAMES.has(typeName)) return [];
        if (FREEFORM_STRING_TYPE_NAMES.has(typeName)) {
            if (typeof value !== "string") {
                return [makeIssue(ERROR_CODES.SETTING_INVALID_TYPE, path, `expected a string for "${typeName}" setting, got ${typeof value}`)];
            }
            return [];
        }
        // Unrecognized type-name string (schema authoring drift) — nothing
        // safe to assert; not this validator's job to invent a rule.
        return [];
    }

    if (kind.kind === "enum") {
        const stringOptions = kind.options.map(o => String(o));
        if (!stringOptions.includes(String(value))) {
            return [makeIssue(ERROR_CODES.SETTING_INVALID_OPTION, path, `value ${JSON.stringify(value)} is not one of the allowed options ${JSON.stringify(kind.options)}`)];
        }
        return [];
    }

    if (kind.kind === "object") {
        const { typeName, def } = kind;
        if (typeName === "checkbox") {
            if (typeof value !== "boolean") {
                return [makeIssue(ERROR_CODES.SETTING_INVALID_TYPE, path, `expected a boolean for checkbox setting, got ${typeof value} (${JSON.stringify(value)})`)];
            }
            return [];
        }
        if (typeName === "number" || typeName === "range") {
            if (typeof value !== "number" || Number.isNaN(value)) {
                return [makeIssue(ERROR_CODES.SETTING_INVALID_TYPE, path, `expected a number for "${typeName}" setting, got ${typeof value} (${JSON.stringify(value)})`)];
            }
            if (typeof def.min === "number" && value < def.min) {
                return [makeIssue(ERROR_CODES.SETTING_OUT_OF_RANGE, path, `value ${value} is below the minimum ${def.min}`)];
            }
            if (typeof def.max === "number" && value > def.max) {
                return [makeIssue(ERROR_CODES.SETTING_OUT_OF_RANGE, path, `value ${value} exceeds the maximum ${def.max}`)];
            }
            return [];
        }
        if (typeName === "select") {
            // Documented by SCHEMA_CREATION_GUIDE.md but not exercised by any
            // current real schema (§30/§32 — no schema was invented to test
            // this; see PHASE6_REPORT.md "Known limitations").
            const values = Array.isArray(def.options) ? def.options.map(o => (o && typeof o === "object") ? o.value : o) : [];
            if (values.length > 0 && !values.map(String).includes(String(value))) {
                return [makeIssue(ERROR_CODES.SETTING_INVALID_OPTION, path, `value ${JSON.stringify(value)} is not one of the allowed select options ${JSON.stringify(values)}`)];
            }
            return [];
        }
        if (typeName && SKIPPED_TYPE_NAMES.has(typeName)) return [];
        if (typeName && FREEFORM_STRING_TYPE_NAMES.has(typeName)) {
            if (typeof value !== "string") {
                return [makeIssue(ERROR_CODES.SETTING_INVALID_TYPE, path, `expected a string for "${typeName}" setting, got ${typeof value}`)];
            }
            return [];
        }
        return [];
    }

    return [];
}

interface WalkOwner {
    scope: "section" | "block";
    ownerId: string;
    typeId: string;
}

type WalkVisitor = (key: string, settingSchema: SettingSchema | undefined, value: unknown, path: string, owner: WalkOwner) => void;

/**
 * Walks every section's and every block's settings object in a validated
 * candidate, calling visitor(settingKey, settingSchemaOrUndefined, value,
 * path, {scope: 'section'|'block', ownerId, typeId}) once per key actually
 * PRESENT in the output. Shared by validateSettings() and
 * validateDataReferences() so the walk itself is written once (§5 — layers,
 * not one giant function, but no duplicated iteration either).
 */
export function walkSettings(config: GenerationConfig, schemas: SchemaCatalog, visitor: WalkVisitor): void {
    const sectionById = new Map(schemas.sectionSchemas.map(s => [s.id, s]));
    const blockById = new Map(schemas.blockSchemas.map(b => [b.id, b]));

    for (const [sectionId, section] of Object.entries(config.sections || {})) {
        const sectionSchema = sectionById.get(section.type);
        if (sectionSchema && section.settings && typeof section.settings === "object") {
            for (const [key, value] of Object.entries(section.settings)) {
                const settingSchema = sectionSchema.settings ? sectionSchema.settings[key] : undefined;
                visitor(key, settingSchema, value, `sections.${sectionId}.settings.${key}`, { scope: "section", ownerId: sectionId, typeId: section.type });
            }
        }

        if (section.blocks && typeof section.blocks === "object") {
            for (const [blockId, block] of Object.entries(section.blocks)) {
                const blockSchema = blockById.get(block.type);
                if (blockSchema && block.settings && typeof block.settings === "object") {
                    for (const [key, value] of Object.entries(block.settings)) {
                        const settingSchema = blockSchema.settings ? blockSchema.settings[key] : undefined;
                        visitor(key, settingSchema, value, `sections.${sectionId}.blocks.${blockId}.settings.${key}`, { scope: "block", ownerId: blockId, typeId: block.type });
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
export function validateSettings(config: GenerationConfig, schemas: SchemaCatalog): ValidationResult {
    const errors: ValidationIssue[] = [];
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

const DATA_REFERENCE_TYPE_NAMES = new Set(["product_picker", "collection"]);

function isKnownReference(typeName: string | undefined, value: unknown, knownMerchantData: KnownMerchantData): boolean {
    if (typeName === "product_picker") {
        return Array.isArray(knownMerchantData.products) && knownMerchantData.products.includes(value as string);
    }
    if (typeName === "collection") {
        return Array.isArray(knownMerchantData.collections) && knownMerchantData.collections.includes(value as string);
    }
    return false;
}

export function validateDataReferences(config: GenerationConfig, schemas: SchemaCatalog, context: { knownMerchantData?: KnownMerchantData } = {}): ValidationResult {
    const knownMerchantData = context.knownMerchantData || {};
    const errors: ValidationIssue[] = [];

    walkSettings(config, schemas, (key, settingSchema, value, path) => {
        if (settingSchema === undefined) return; // SETTING_UNKNOWN already covers this via validateSettings()
        const { typeName } = getSettingKind(settingSchema) as { typeName?: string };
        if (!typeName || !DATA_REFERENCE_TYPE_NAMES.has(typeName)) return;
        if (value === "" || value === null || value === undefined) return; // explicitly left blank — safe

        if (typeof value !== "string" || !isKnownReference(typeName, value, knownMerchantData)) {
            errors.push(makeIssue(
                ERROR_CODES.DATA_REFERENCE_HALLUCINATED,
                path,
                `"${key}" (${typeName}) has value ${JSON.stringify(value)}, which is not a known merchant ${typeName === "product_picker" ? "product" : "collection"} handle — leave this field empty rather than inventing one.`
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

export function validateThemeCompatibility(themeState: ThemeState | null | undefined, templateName: string): ValidationResult {
    const warnings: ValidationIssue[] = [];
    if (!themeState) return emptyResult();

    if (!themeState.validation || !themeState.validation.valid) {
        warnings.push(makeIssue(
            "THEME_STATE_STRUCTURAL_ISSUE",
            "themeState",
            `The current ThemeState has ${(themeState.validation && themeState.validation.errors.length) || "unknown"} structural error(s) — see themeState.validation for details. This does not block candidate generation.`
        ));
    }

    const template = themeState.templates && themeState.templates[templateName];
    if (template) {
        const summary = template.classification;
        const unknownSections = Object.values(summary.sections).filter(s => !s.knownToAI).length;
        if (unknownSections > 0) {
            warnings.push(makeIssue(
                "THEME_STATE_UNKNOWN_COMPONENTS",
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

export interface ValidateCandidateContext {
    templateName?: string;
    knownMerchantData?: KnownMerchantData;
    themeState?: ThemeState | null;
}

// ---------------------------------------------------------------------------
// Deterministic repair — applied to a freshly generated candidate BEFORE it
// ever reaches validateOutput()/validateCandidate(), so a class of common,
// mechanically-fixable AI mistakes never has to pay for a second AI repair
// round-trip at all. Every fix here mirrors an existing validator's rule
// exactly (getSettingKind()'s type dispatch, the image/data-reference
// hallucination guards above, the richtext-wrapping "_notes" convention) —
// this file invents no new leniency, it just applies the same rule
// proactively instead of only reactively rejecting.
//
// Deliberately scoped to SETTINGS VALUES and block_order bookkeeping only —
// never touches a section/block's own "type", id, or the plan's structure,
// so a fix here can never change what matchesPlan() checks. Only reached
// after the AI response parses as JSON at all (a malformed-JSON response
// still needs the existing AI repair call — nothing to deterministically
// fix in text that isn't valid JSON yet).
// ---------------------------------------------------------------------------

function coerceRepairValue(kind: SettingKind, value: unknown, path: string, fixes: string[]): { value: unknown; changed: boolean } {
    if (kind.kind === "typeName" || kind.kind === "object") {
        const typeName = kind.typeName;

        if (typeName === "image" || typeName === "image_picker") {
            if (typeof value === "string" && value !== "" && !value.startsWith("shopify://") && !/^https?:\/\//.test(value)) {
                fixes.push(`${path}: cleared hallucinated ${typeName} value ${JSON.stringify(value)}`);
                return { value: "", changed: true };
            }
            return { value, changed: false };
        }

        if (typeName === "product_picker" || typeName === "collection") {
            // No known-merchant-data catalog integration exists yet (see
            // validateDataReferences() above) — any non-empty value is
            // unverifiable today, so blanking it is always the safe default,
            // identical to the image guard's own posture.
            if (typeof value === "string" && value !== "") {
                fixes.push(`${path}: cleared unverified ${typeName} reference ${JSON.stringify(value)}`);
                return { value: "", changed: true };
            }
            return { value, changed: false };
        }

        if (typeName === "richtext" || typeName === "inline_richtext" || typeName === "html") {
            if (typeof value === "string" && value.length > 0 && !/<[a-z][\s\S]*>/i.test(value)) {
                fixes.push(`${path}: wrapped plain text in <p> for "${typeName}" field`);
                return { value: `<p>${value}</p>`, changed: true };
            }
            return { value, changed: false };
        }

        if (typeName === "checkbox") {
            if (typeof value === "string" && (value === "true" || value === "false")) {
                fixes.push(`${path}: coerced string "${value}" to boolean for checkbox`);
                return { value: value === "true", changed: true };
            }
            return { value, changed: false };
        }

        if (typeName === "number" || typeName === "range") {
            let numValue: unknown = value;
            if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) {
                numValue = Number(value);
            }
            if (typeof numValue === "number" && !Number.isNaN(numValue)) {
                const def = kind.kind === "object" ? kind.def : undefined;
                let clamped = numValue;
                if (def && typeof def.min === "number" && clamped < def.min) clamped = def.min;
                if (def && typeof def.max === "number" && clamped > def.max) clamped = def.max;
                if (clamped !== value) {
                    fixes.push(`${path}: coerced/clamped "${typeName}" value ${JSON.stringify(value)} to ${clamped}`);
                    return { value: clamped, changed: true };
                }
            }
            return { value, changed: false };
        }
    }
    return { value, changed: false };
}

function repairSettingsObject(
    settingsObj: Record<string, unknown>,
    schemaSettings: Record<string, SettingSchema> | undefined,
    pathPrefix: string,
    fixes: string[]
): void {
    for (const key of Object.keys(settingsObj)) {
        const settingSchema = schemaSettings ? schemaSettings[key] : undefined;
        const path = `${pathPrefix}.${key}`;

        // A setting the schema doesn't define at all is not safely
        // guessable — dropping it is deterministic and mirrors what
        // validateSettings() would reject it for anyway (SETTING_UNKNOWN),
        // just without spending an AI repair call to remove one stray key.
        if (settingSchema === undefined) {
            delete settingsObj[key];
            fixes.push(`${path}: removed setting not defined by this schema`);
            continue;
        }

        const value = settingsObj[key];
        if (value === undefined || value === null) continue;

        const kind = getSettingKind(settingSchema);
        const { value: repaired, changed } = coerceRepairValue(kind, value, path, fixes);
        if (changed) settingsObj[key] = repaired;
    }
}

/**
 * Applies deterministic, mechanical fixes to a raw (still-string) Stage 2
 * AI response — run BEFORE validateOutput()/matchesPlan()/validateCandidate()
 * so fixable mistakes never trigger a second AI call. Returns the (possibly
 * unchanged) JSON text plus a human-readable list of what was fixed, for
 * instrumentation/logging.
 *
 * Never throws: an unparseable or structurally-unexpected response is
 * returned completely unchanged (`fixes: []`) and falls through to the
 * existing validateOutput()/AI-repair path exactly as it did before this
 * function existed — this is purely an additive fast path, not a
 * replacement for the fail-closed validation pipeline.
 */
export function applyDeterministicRepairs(rawOutput: string, schemas: SchemaCatalog): { output: string; fixes: string[] } {
    let config: GenerationConfig;
    try {
        config = JSON.parse(rawOutput);
    } catch {
        return { output: rawOutput, fixes: [] };
    }
    if (!config || typeof config !== "object" || !config.sections || typeof config.sections !== "object") {
        return { output: rawOutput, fixes: [] };
    }

    const fixes: string[] = [];
    const sectionById = new Map(schemas.sectionSchemas.map(s => [s.id, s]));
    const blockById = new Map(schemas.blockSchemas.map(b => [b.id, b]));

    for (const [sectionId, section] of Object.entries(config.sections)) {
        if (!section || typeof section !== "object") continue;
        const sectionSchema = sectionById.get(section.type);

        if (sectionSchema?.settings && section.settings && typeof section.settings === "object") {
            repairSettingsObject(section.settings, sectionSchema.settings, `sections.${sectionId}.settings`, fixes);
        }

        if (section.blocks && typeof section.blocks === "object") {
            const blockIds = Object.keys(section.blocks);

            if (blockIds.length > 0) {
                if (!Array.isArray(section.block_order)) {
                    section.block_order = blockIds;
                    fixes.push(`sections.${sectionId}: generated missing block_order from block keys`);
                } else {
                    const knownIds = new Set(blockIds);
                    const cleaned = section.block_order.filter((id) => knownIds.has(id));
                    const missing = blockIds.filter(id => !cleaned.includes(id));
                    if (missing.length > 0 || cleaned.length !== section.block_order.length) {
                        section.block_order = [...cleaned, ...missing];
                        fixes.push(`sections.${sectionId}: repaired block_order to match the actual blocks present`);
                    }
                }
            }

            for (const [blockId, block] of Object.entries(section.blocks)) {
                if (!block || typeof block !== "object") continue;
                const blockSchema = blockById.get(block.type);
                if (blockSchema?.settings && block.settings && typeof block.settings === "object") {
                    repairSettingsObject(block.settings, blockSchema.settings, `sections.${sectionId}.blocks.${blockId}.settings`, fixes);
                }
            }
        }
    }

    if (fixes.length === 0) return { output: rawOutput, fixes };
    return { output: JSON.stringify(config), fixes };
}

export function validateCandidate(config: GenerationConfig, schemas: SchemaCatalog, context: ValidateCandidateContext = {}): ValidationResult {
    const { templateName = "index", knownMerchantData = {}, themeState = null } = context;

    const results = [
        validateAllowedOn(config, schemas, templateName),
        validateSettings(config, schemas),
        validateDataReferences(config, schemas, { knownMerchantData })
    ];

    const themeCompat = validateThemeCompatibility(themeState, templateName);
    results.push(themeCompat);

    return mergeResults(results);
}
