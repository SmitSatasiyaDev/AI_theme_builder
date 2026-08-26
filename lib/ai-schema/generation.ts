/**
 * Phase 5 — Staged Initial-Generation Pipeline.
 *
 * Replaces the single mega-prompt ("send everything, get a whole homepage
 * back in one shot") with two bounded, purpose-built AI calls that share
 * one approved structure:
 *
 *   WebsiteBrief (Phase 3) + ThemeState context (Phase 4, bounded)
 *        │
 *        ▼
 *   Template-eligibility filter (retrieval.js's getTemplateEligibleSchemas —
 *   hard constraints only: allowed_on + forced-exclusive-section rules, no
 *   keyword-based relevance guessing, no LLM call). Falls back to the full
 *   catalog only when zero sections declare the template eligible at all.
 *   This is the outer safety envelope every later step stays inside of.
 *        │
 *        ▼
 *   Planning-candidate narrowing (retrieval.js's
 *   narrowEligibleSchemasForPlanning — the SAME deterministic
 *   retrieval-rules.json keyword matching retrieveRelevantSchemas() uses
 *   elsewhere, applied on top of the eligible envelope above). On a
 *   confident keyword match it hands Stage 1 a small, relevant candidate
 *   list instead of every eligible section; on low/no confidence it falls
 *   back to the full eligible envelope unchanged — never anything broader,
 *   never anything the template-eligibility filter didn't already allow.
 *        │
 *        ▼
 *   Stage 1 — PLANNING: the AI itself decides which existing section/block
 *   types to use, in what order and composition, from the narrowed
 *   candidate list above (or the full eligible list, when narrowing
 *   declined to shrink it) — this is what lets it generalize to
 *   niches/requests retrieval-rules.json never anticipated, while still
 *   keeping the common case's prompt small. No settings, no content yet.
 *   Validated against the exact candidate set it was shown (never an
 *   arbitrary invented type) before Stage 2 is allowed to run at all.
 *        │
 *        ▼
 *   Stage 2 — CONFIGURATION: fill in settings/content for EXACTLY the
 *   approved structure, scoped to only the section/block schemas the
 *   approved plan actually uses (buildConfigurationSystemPrompt). Validated
 *   with the existing, unmodified validateOutput() (Phase 1) plus a
 *   plan-conformance check — with a deterministic repair pass
 *   (validation.js's applyDeterministicRepairs) attempted first, so a
 *   mechanically-fixable mistake never has to cost a second AI call.
 *
 * Both stages reuse makeAIRequest() and, for Stage 2, validateOutput() —
 * this file adds no new AI-call plumbing or Shopify-JSON validation rules
 * of its own; it only adds the plan layer and the prompts/validation that
 * are genuinely new to staging.
 *
 * This module never applies anything to the live theme and never persists
 * automatically — its output is a candidate for a later merge/apply phase
 * (see AI_THEME_BUILDER_PHASE5_PLAN.md §33/§40).
 */

import * as instrumentation from "./instrumentation";
import { buildCapabilityIndex } from "./capability-index";
import {
    getTemplateEligibleSchemas,
    narrowEligibleSchemasForPlanning,
    FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE,
    isEligibleForTemplate
} from "./retrieval";
import { makeAIRequest, validateOutput, OPENROUTER_FAST_MODEL } from "./ai-client";
import { briefToSummaryText } from "./brief-logic";
import { selectGenerationContext } from "./theme-state";
import { validateCandidate, applyDeterministicRepairs } from "./validation";
import type {
    Brief,
    CapabilityListing,
    GenerationConfig,
    GenerationContext,
    GenerationPlan,
    PlainValidationResult,
    RetrievedSchemaCatalog,
    SchemaCatalog,
    SectionSchema,
    StagedGenerationResult,
    StagedGenerationTimings,
    ThemeState
} from "./types";

export const MAX_PLAN_SECTIONS = 10; // same homepage ceiling validateOutput() already enforces for the legacy path

// A hero section, when one exists, is placed first deterministically instead of left to the
// planner's judgment. Only one hero-category section exists in the catalog today
// ("slideshow"), so there is no variety being traded away — this purely removes a class of
// repair-loop triggers (a plan that omits the hero or buries it isn't structurally invalid
// today, just off-spec) and shrinks what the AI has to decide. 3 slides is comfortably above
// slideshow's own schema "_notes" minimum of 2; only the slide *count* is fixed here — slide
// *content* is still fully AI-written in Stage 2, same as every other section.
const FORCED_HERO_BLOCK_COUNT = 3;
const FORCED_HERO_SLOT_ID = "hero-forced";

export interface ForcedHeroSection {
    id: string;
    type: string;
    blockTypes: string[];
}

/**
 * Picks the section that should always occupy position 0, if any. Only applies to the general
 * (non-forced-exclusive) planning path — product/footer-group already fully bypass section
 * choice via FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE, so forcing a hero there would be redundant.
 * Returns null when no hero-category section is eligible for this template, so the planner
 * falls back to deciding freely (e.g. a future template with no hero option at all).
 */
export function determineForcedHeroSection(retrievedSchemas: SchemaCatalog, templateName: string): ForcedHeroSection | null {
    if (FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE[templateName]) return null;

    const heroCandidates = retrievedSchemas.sectionSchemas
        .filter(s => s.category === "hero")
        .sort((a, b) => a.id.localeCompare(b.id));
    const hero = heroCandidates[0];
    if (!hero) return null;

    const allowedBlockIds = getAllowedBlockIds(hero);
    const blockCount = hero.max_blocks ? Math.min(FORCED_HERO_BLOCK_COUNT, hero.max_blocks) : FORCED_HERO_BLOCK_COUNT;
    // Only auto-fills the block list when the section accepts exactly one block type (true of
    // "slideshow" today, whose only allowed block is "slide") — with more than one type,
    // picking a mix would itself be a content decision, so it's left to Stage 1 by not forcing
    // blockTypes at all (an empty array here just means Stage 2 configures zero blocks for it).
    const blockTypes = allowedBlockIds.length === 1 ? Array(blockCount).fill(allowedBlockIds[0]) : [];

    return { id: FORCED_HERO_SLOT_ID, type: hero.id, blockTypes };
}

// ---------------------------------------------------------------------------
// Lightweight capability listing for the planning prompt (no full settings
// definitions — those only enter Stage 2's prompt, and even there only for
// the specific types the plan actually uses).
// ---------------------------------------------------------------------------

// Shared by lightweightCapabilityListing() (tells the planner which block
// ids a section accepts) and validateGenerationPlan() (checks a proposed
// block id against that same list) — a single source of truth so the
// planning prompt's constraint can never drift from what's actually
// enforced. allowed_blocks is schema data, either an array of ids or an
// object keyed by id (both forms occur in the schema catalog).
function getAllowedBlockIds(sectionSchema: Partial<SectionSchema>): string[] {
    return Array.isArray(sectionSchema.allowed_blocks)
        ? sectionSchema.allowed_blocks
        : (sectionSchema.allowed_blocks && typeof sectionSchema.allowed_blocks === "object"
            ? Object.keys(sectionSchema.allowed_blocks)
            : []);
}

export function lightweightCapabilityListing(retrievedSchemas: SchemaCatalog): CapabilityListing {
    const index = buildCapabilityIndex(retrievedSchemas);
    const sectionSchemaById = new Map(retrievedSchemas.sectionSchemas.map(s => [s.id, s]));
    return {
        sections: index.sections.map(s => ({
            id: s.id, label: s.label, summary: s.summary,
            hasBlocks: s.hasBlocks, maxBlocks: s.maxBlocks,
            // The exact block ids THIS section accepts — not just a count.
            // Without this, the planner previously had no way to actually
            // know which blocks fit which section (only a global block
            // list + a per-section count) and had to guess from labels
            // alone, which is what produced schema-invalid plans that
            // survived even a repair attempt (e.g. proposing "text-with-icon"
            // inside "email-signup-banner").
            allowedBlockTypes: getAllowedBlockIds(sectionSchemaById.get(s.id) || {})
        })),
        blocks: index.blocks.map(b => ({ id: b.id, label: b.label, summary: b.summary }))
    };
}

// ---------------------------------------------------------------------------
// Stage 1 — Planning
// ---------------------------------------------------------------------------

export function buildPlanningSystemPrompt(
    templateName: string,
    capabilityListing: CapabilityListing,
    themeContext: GenerationContext,
    forcedHero: ForcedHeroSection | null = null,
    maxSections: number = MAX_PLAN_SECTIONS
): string {
    const forcedSectionId = FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE[templateName];

    let rules = `You are a Shopify theme STRUCTURE planner. Your only job is to decide WHICH existing sections and blocks to use and in what order — you do NOT write any settings, text, or content yet (that happens in a later step).

CRITICAL RULES:
1. You may ONLY use section types listed in AVAILABLE SECTIONS below, and block types listed in AVAILABLE BLOCKS below — copy each "id" value VERBATIM (exact spelling, exact hyphens/underscores).
2. Do NOT invent a section or block type that isn't listed. If nothing listed fits a need, omit it — do not approximate with a made-up type.
3. Each entry in AVAILABLE SECTIONS has its own "allowedBlockTypes" array — this is the COMPLETE and ONLY set of block ids that section accepts. A block type that "sounds like" it would fit (e.g. a generic "buttons"/"text-with-icon" block) is INVALID unless it literally appears in that specific section's "allowedBlockTypes". Never reuse a block id from one section's list inside a different section unless that section's own "allowedBlockTypes" also contains it.
`;

    if (forcedSectionId) {
        rules += `4. This is the "${templateName}" template: your plan MUST contain EXACTLY ONE section, of type "${forcedSectionId}", and nothing else.\n`;
    } else if (forcedHero) {
        rules += `4. The FIRST section of this page is already fixed to a "${forcedHero.type}" section, placed automatically before you plan anything. It is NOT listed in AVAILABLE SECTIONS below — do not include it, reference it, or plan a substitute hero/banner section; do not use the id "${forcedHero.id}" for any section of your own. Your plan covers ONLY the sections that come AFTER it: choose a coherent, non-repetitive set of at most ${maxSections} of them for the "${templateName}" template.\n`;
    } else {
        rules += `4. Choose a coherent, non-repetitive set of at most ${maxSections} sections for the "${templateName}" template. If a hero-like section is available in AVAILABLE SECTIONS, it typically works well first, but use your judgment.\n`;
    }

    rules += `5. Respond ONLY with valid JSON (no markdown, no explanation) in this exact shape:
{
  "templateName": "${templateName}",
  "order": ["<section-id-1>", "<section-id-2>", ...],
  "sections": {
    "<section-id-1>": { "type": "<one of AVAILABLE SECTIONS ids>", "blockTypes": ["<block id>", "<block id>", ...] }
  }
}
"blockTypes" lists one entry per block you intend to include (omit or use an empty array if the section has no blocks). Section ids (the keys under "sections") are your own short slugs, e.g. "hero-1", "trust-1" — NOT the type. Every id in "sections" must appear exactly once in "order", and vice versa.`;

    if (themeContext.templateExists && themeContext.existingSections.length > 0) {
        rules += `\n\nCURRENT THEME AWARENESS: the "${templateName}" template currently already contains these section types (context only — prefer a similar composition over an arbitrary one when it genuinely fits the request, but you are planning fresh for this request): ${JSON.stringify(themeContext.existingSections.map(s => s.type))}.`;
    }

    // Compact (not pretty-printed) — this listing is sent on every single
    // generation regardless of how many of the ~27 sections/59 blocks are
    // actually relevant (see file header: Stage 1 deliberately sees the
    // full template-eligible set, not a keyword-narrowed one, so it can
    // generalize beyond retrieval-rules.json). Dropping the 2-space
    // indentation cuts ~25-30% of prompt chars for zero information loss.
    rules += `\n\nAVAILABLE SECTIONS:\n${JSON.stringify(capabilityListing.sections)}\n\nAVAILABLE BLOCKS:\n${JSON.stringify(capabilityListing.blocks)}`;

    return rules;
}

export function buildPlanningUserPrompt(brief: Brief, templateName: string, repairErrors: string[] | null): string {
    let prompt = `Merchant requirements:\n${briefToSummaryText(brief)}\n\nTarget template: ${templateName}\n\nProduce the GenerationPlan JSON now.`;
    if (repairErrors && repairErrors.length > 0) {
        prompt += `\n\nYour previous plan was invalid for these reasons: ${repairErrors.join("; ")}. Fix these issues and respond again with ONLY the corrected JSON object.`;
    }
    return prompt;
}

/**
 * Validates a GenerationPlan structurally AND against the retrieved
 * candidate set (never the full catalog — §12: "constrained to
 * capabilities that actually exist in the SELECTED schema set").
 */
export function validateGenerationPlan(plan: unknown, retrievedSchemas: SchemaCatalog, templateName: string, maxSections: number = MAX_PLAN_SECTIONS): PlainValidationResult {
    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
        return { valid: false, errors: ["plan is not a JSON object"] };
    }

    const p = plan as Partial<GenerationPlan>;
    const errors: string[] = [];
    if (p.templateName !== templateName) {
        errors.push(`plan.templateName "${p.templateName}" does not match the requested template "${templateName}"`);
    }
    if (!p.sections || typeof p.sections !== "object" || Array.isArray(p.sections)) {
        errors.push("plan.sections must be an object");
    }
    if (!Array.isArray(p.order)) {
        errors.push("plan.order must be an array");
    }
    if (errors.length > 0) return { valid: false, errors };

    const sections = p.sections!;
    const order = p.order!;
    const sectionIds = Object.keys(sections);
    if (sectionIds.length === 0) {
        errors.push("plan.sections must not be empty");
    }
    if (order.length > maxSections) {
        errors.push(`plan.order has ${order.length} sections, maximum ${maxSections} allowed`);
    }
    if (new Set(order).size !== order.length) {
        errors.push("plan.order contains duplicate section ids");
    }
    for (const id of order) {
        if (!Object.prototype.hasOwnProperty.call(sections, id)) errors.push(`plan.order references unknown section id "${id}"`);
    }
    for (const id of sectionIds) {
        if (!order.includes(id)) errors.push(`plan.sections["${id}"] is not listed in plan.order`);
    }

    const sectionById = new Map(retrievedSchemas.sectionSchemas.map(s => [s.id, s]));
    const blockById = new Map(retrievedSchemas.blockSchemas.map(b => [b.id, b]));

    const forcedSectionId = FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE[templateName];
    if (forcedSectionId && (sectionIds.length !== 1 || sections[sectionIds[0]].type !== forcedSectionId)) {
        errors.push(`template "${templateName}" must use exactly one section of type "${forcedSectionId}"`);
    }

    for (const [id, section] of Object.entries(sections)) {
        if (!section || typeof section !== "object") {
            errors.push(`plan.sections["${id}"] must be an object`);
            continue;
        }
        if (!section.type || !sectionById.has(section.type)) {
            errors.push(`plan.sections["${id}"].type "${section.type}" is not part of the retrieved/relevant capabilities for this request`);
            continue;
        }
        const sectionSchema = sectionById.get(section.type)!;

        // Phase 6 (§7/§18): closes a real gap — a FULL_FALLBACK retrieval
        // pool (retrieval.js) is the FULL unfiltered schema catalog, not
        // narrowed by allowed_on, so a section type could be "part of the
        // retrieved capabilities" while still being invalid for this
        // template. Reuses retrieval.js's own eligibility rule rather than
        // reinterpreting allowed_on semantics here.
        if (!isEligibleForTemplate(sectionSchema, templateName)) {
            errors.push(`plan.sections["${id}"].type "${section.type}" declares allowed_on ${JSON.stringify(sectionSchema.allowed_on)}, which does not include template "${templateName}"`);
        }

        const blockTypes = Array.isArray(section.blockTypes) ? section.blockTypes : [];
        if (blockTypes.length === 0) continue;

        const allowedBlocksList = getAllowedBlockIds(sectionSchema);

        if (sectionSchema.max_blocks && blockTypes.length > sectionSchema.max_blocks) {
            errors.push(`plan.sections["${id}"] has ${blockTypes.length} blocks but "${section.type}" allows at most ${sectionSchema.max_blocks}`);
        }
        for (const blockType of blockTypes) {
            if (!blockById.has(blockType)) {
                errors.push(`plan.sections["${id}"].blockTypes references "${blockType}", which is not part of the retrieved/relevant capabilities`);
            } else if (allowedBlocksList.length > 0 && !allowedBlocksList.includes(blockType)) {
                errors.push(`plan.sections["${id}"].blockTypes references "${blockType}", which is not allowed inside a "${section.type}" section`);
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

interface RunPlanningStageOptions {
    brief: Brief;
    templateName: string;
    retrievedSchemas: RetrievedSchemaCatalog;
    themeContext: GenerationContext;
    requestId: string;
}

interface RunPlanningStageResult {
    plan: GenerationPlan;
    repaired: boolean;
    capabilityListing: CapabilityListing;
    aiCallCount: number;
    promptChars: number;
    outputChars: number;
    durationMs: number;
}

/**
 * Runs Stage 1 to completion: one AI call, validated; a single bounded
 * repair retry if invalid; throws (does not continue to Stage 2) if the
 * repair attempt is also invalid — §21.
 *
 * `retrievedSchemas` is expected to already be the small planning candidate
 * set (see runStagedGeneration()'s narrowEligibleSchemasForPlanning() call)
 * — this function does no further narrowing of its own, it just plans
 * against whatever candidate pool it's handed.
 *
 * Uses OPENROUTER_FAST_MODEL: structure selection (which existing
 * section/block ids, in what order) is a much narrower reasoning task than
 * Stage 2's content generation, and — like brief-intake.ts's per-turn field
 * extraction — is well within a fast model's reach. validateGenerationPlan()
 * plus the one bounded repair attempt below are what keep this safe: an
 * invalid plan from the fast model still fails closed exactly like an
 * invalid plan from the primary model would.
 */
export async function runPlanningStage({ brief, templateName, retrievedSchemas, themeContext, requestId }: RunPlanningStageOptions): Promise<RunPlanningStageResult> {
    const startTime = Date.now();
    const forcedHero = determineForcedHeroSection(retrievedSchemas, templateName);
    const maxSections = forcedHero ? MAX_PLAN_SECTIONS - 1 : MAX_PLAN_SECTIONS;

    // When a hero is forced, the AI never sees or plans it — excluded from what it's shown so
    // it can't accidentally reintroduce it as a "regular" section, and the capability listing
    // shrinks by exactly the one entry it no longer needs to consider.
    const planningSchemas = forcedHero
        ? { ...retrievedSchemas, sectionSchemas: retrievedSchemas.sectionSchemas.filter(s => s.id !== forcedHero.type) }
        : retrievedSchemas;

    const capabilityListing = lightweightCapabilityListing(planningSchemas);
    const systemPrompt = buildPlanningSystemPrompt(templateName, capabilityListing, themeContext, forcedHero, maxSections);

    function parseAndValidate(content: string | undefined): { plan: GenerationPlan | null; validation: PlainValidationResult } {
        let plan: GenerationPlan;
        try {
            plan = JSON.parse(content!);
        } catch (error) {
            return { plan: null, validation: { valid: false, errors: [`plan was not valid JSON: ${(error as Error).message}`] } };
        }
        return { plan, validation: validateGenerationPlan(plan, planningSchemas, templateName, maxSections) };
    }

    let promptChars = 0;
    let outputChars = 0;
    let aiCallCount = 0;

    const firstUserPrompt = buildPlanningUserPrompt(brief, templateName, null);
    const firstContent = await makeAIRequest(firstUserPrompt, systemPrompt, 2, { requestId, callType: "generation_plan", model: OPENROUTER_FAST_MODEL });
    aiCallCount++;
    promptChars += systemPrompt.length + firstUserPrompt.length;
    outputChars += firstContent?.length ?? 0;

    let { plan, validation } = parseAndValidate(firstContent);
    let repaired = false;

    if (!validation.valid) {
        repaired = true;
        const repairUserPrompt = buildPlanningUserPrompt(brief, templateName, validation.errors);
        const repairContent = await makeAIRequest(repairUserPrompt, systemPrompt, 2, { requestId, callType: "generation_plan_repair", model: OPENROUTER_FAST_MODEL });
        aiCallCount++;
        promptChars += systemPrompt.length + repairUserPrompt.length;
        outputChars += repairContent?.length ?? 0;

        ({ plan, validation } = parseAndValidate(repairContent));
        if (!validation.valid) {
            throw new Error(`Stage 1 (planning) produced an invalid GenerationPlan even after a repair attempt: ${validation.errors.join("; ")}`);
        }
    }

    // Prepend the deterministic hero slot — invisible to everything downstream (Stage 2,
    // matchesPlan, mergeThemeState) since the merged plan is structurally identical to one the
    // AI produced in full.
    const finalPlan: GenerationPlan = forcedHero
        ? {
            templateName,
            order: [forcedHero.id, ...plan!.order],
            sections: { [forcedHero.id]: { type: forcedHero.type, blockTypes: forcedHero.blockTypes }, ...plan!.sections }
        }
        : plan!;

    return { plan: finalPlan, repaired, capabilityListing, aiCallCount, promptChars, outputChars, durationMs: Date.now() - startTime };
}

// ---------------------------------------------------------------------------
// Stage 2 — Configuration
// ---------------------------------------------------------------------------

export function buildConfigurationSystemPrompt(plan: GenerationPlan, retrievedSchemas: SchemaCatalog): string {
    const usedSectionTypes = new Set(Object.values(plan.sections).map(s => s.type));
    const usedBlockTypes = new Set(Object.values(plan.sections).flatMap(s => Array.isArray(s.blockTypes) ? s.blockTypes : []));
    const scopedSectionSchemas = retrievedSchemas.sectionSchemas.filter(s => usedSectionTypes.has(s.id));
    const scopedBlockSchemas = retrievedSchemas.blockSchemas.filter(b => usedBlockTypes.has(b.id));

    const structureList = plan.order.map(id => {
        const s = plan.sections[id];
        const blocksNote = (s.blockTypes && s.blockTypes.length) ? `, blocks: [${s.blockTypes.join(", ")}]` : "";
        return `  - "${id}": type "${s.type}"${blocksNote}`;
    }).join("\n");

    return `You are an AI Shopify theme configurator. A structure plan has ALREADY been approved — your only job now is to fill in settings and content for EXACTLY that structure. Do not add, remove, reorder, or retype any section or block.

APPROVED STRUCTURE (must match exactly):
Template: ${plan.templateName}
Order: ${JSON.stringify(plan.order)}
Sections:
${structureList}

CRITICAL RULES:
1. Use EXACTLY the section ids, types, order, and block composition listed above — do not deviate from the approved structure.
2. Every section/block "type" you output MUST be copied VERBATIM from the approved structure above.
3. Return ONLY valid JSON — no explanations, no markdown.
4. All setting values must match the allowed options in the schemas below.
5. READ AND FOLLOW "_notes" fields in the schemas below — they contain constraints you must obey (e.g. richtext wrapping).
6. RICHTEXT FIELDS: any setting of type "richtext" MUST be wrapped in HTML tags (<p>, <ul>, <ol>, <h1>-<h6>) — never plain text.
7. IMAGE FIELDS: any setting of type "image" or "image_picker" MUST be left as an empty string "" — never invent a filename or URL.
8. Assign your own block ids (e.g. "slide-1", "slide-2") and include a "block_order" array listing them whenever a section has blocks.
9. Do not invent product handles, collection handles, or other store data that isn't already known to you — leave such a field empty/omitted rather than guessing.

SCOPED SECTION SCHEMAS (only the types used in the approved structure):
${JSON.stringify(scopedSectionSchemas)}

SCOPED BLOCK SCHEMAS (only the types used in the approved structure):
${JSON.stringify(scopedBlockSchemas)}

OUTPUT FORMAT:
{
  "sections": {
    "<section-id>": {
      "type": "<type>",
      "settings": { ... },
      "blocks": { "<block-id>": { "type": "<type>", "settings": { ... } } },
      "block_order": ["<block-id>", ...]
    }
  },
  "order": ${JSON.stringify(plan.order)}
}`;
}

export function buildConfigurationUserPrompt(brief: Brief, plan: GenerationPlan, themeContext: GenerationContext, repairErrors: string[] | null): string {
    let prompt = `Merchant requirements:\n${briefToSummaryText(brief)}\n\nGenerate the settings/content for the approved structure now.`;

    const colorKeys = Object.entries(themeContext.globalSettingsCurrent || {})
        .filter(([key]) => key.startsWith("colors_") || key.startsWith("gradient_"));
    if (colorKeys.length > 0) {
        prompt += `\n\nThe theme's current global colors (context only — do not output global settings yourself, only section/block content): ${JSON.stringify(Object.fromEntries(colorKeys))}.`;
    }

    if (repairErrors && repairErrors.length > 0) {
        prompt += `\n\nYour previous response was invalid for these reasons: ${repairErrors.join("; ")}. Fix these issues and respond again with ONLY the corrected JSON object.`;
    }
    return prompt;
}

function countBy(arr: string[]): Map<string, number> {
    const map = new Map<string, number>();
    for (const x of arr) map.set(x, (map.get(x) || 0) + 1);
    return map;
}

/**
 * Confirms Stage 2's output didn't silently drift from the approved plan
 * (structure/types/block composition) — validateOutput() alone wouldn't
 * catch this, since a *different but still valid* structure would still
 * pass generic schema validation.
 */
export function matchesPlan(config: GenerationConfig, plan: GenerationPlan): PlainValidationResult {
    const errors: string[] = [];
    if (JSON.stringify(config.order) !== JSON.stringify(plan.order)) {
        errors.push(`configuration order ${JSON.stringify(config.order)} does not match the approved plan order ${JSON.stringify(plan.order)}`);
    }
    for (const id of plan.order) {
        const planned = plan.sections[id];
        const actual = config.sections[id];
        if (!actual) {
            errors.push(`configuration is missing planned section "${id}"`);
            continue;
        }
        if (actual.type !== planned.type) {
            errors.push(`configuration section "${id}" has type "${actual.type}", plan required "${planned.type}"`);
        }
        const plannedCounts = countBy(planned.blockTypes || []);
        const actualCounts = countBy(Object.values(actual.blocks || {}).map(b => b.type));
        for (const [type, count] of plannedCounts) {
            if ((actualCounts.get(type) || 0) !== count) {
                errors.push(`configuration section "${id}" has ${actualCounts.get(type) || 0} "${type}" block(s), plan required ${count}`);
            }
        }
        for (const [type] of actualCounts) {
            if (!plannedCounts.has(type)) {
                errors.push(`configuration section "${id}" has an unplanned block type "${type}"`);
            }
        }
    }
    return { valid: errors.length === 0, errors };
}

interface RunConfigurationStageOptions {
    brief: Brief;
    plan: GenerationPlan;
    retrievedSchemas: RetrievedSchemaCatalog;
    themeContext: GenerationContext;
    requestId: string;
}

interface RunConfigurationStageResult {
    config: GenerationConfig | null;
    warnings: string[];
    repaired: boolean;
    aiCallCount: number;
    promptChars: number;
    outputChars: number;
    deterministicFixCount: number;
    durationMs: number;
    validationMs: number;
}

/**
 * Runs Stage 2 to completion against an ALREADY-VALID plan: one AI call,
 * validated via the existing (unmodified) validateOutput() plus
 * matchesPlan(); a single bounded repair retry if invalid; throws if the
 * repair attempt is also invalid — §21.
 *
 * Before each validation pass, applyDeterministicRepairs() (validation.ts)
 * mechanically fixes the class of mistakes that don't need another AI call
 * to resolve (a missing block_order, a stringified boolean/number, an
 * un-wrapped richtext value, a hallucinated image/product reference, an
 * undeclared setting key) — so the AI repair call below is only ever spent
 * on mistakes that genuinely need the model's judgment (wrong structure,
 * wrong type, a setting value that's simply wrong rather than
 * wrong-shaped).
 */
export async function runConfigurationStage({ brief, plan, retrievedSchemas, themeContext, requestId }: RunConfigurationStageOptions): Promise<RunConfigurationStageResult> {
    const systemPrompt = buildConfigurationSystemPrompt(plan, retrievedSchemas);
    let validationMs = 0;

    function validate(aiOutput: string, repairAttempt: number): { config: GenerationConfig | null; warnings: string[]; valid: boolean; errors: string[] } {
        const startTime = Date.now();
        const outputValidation = validateOutput(aiOutput, retrievedSchemas, { requestId });
        if (!outputValidation.valid) {
            const durationMs = Date.now() - startTime;
            validationMs += durationMs;
            instrumentation.logCandidateValidation({
                requestId, stage: "staged_configuration", templateName: plan.templateName,
                valid: false, errorCount: 1, candidateChars: aiOutput.length, repairAttempt,
                durationMs
            });
            return { config: null, warnings: [], valid: false, errors: [outputValidation.error!] };
        }
        const planValidation = matchesPlan(outputValidation.config!, plan);
        if (!planValidation.valid) {
            const durationMs = Date.now() - startTime;
            validationMs += durationMs;
            instrumentation.logCandidateValidation({
                requestId, stage: "staged_configuration", templateName: plan.templateName,
                valid: false, errorCount: planValidation.errors.length, candidateChars: aiOutput.length, repairAttempt,
                durationMs
            });
            return { config: null, warnings: outputValidation.warnings || [], valid: false, errors: planValidation.errors };
        }

        // Phase 6 — deep candidate validation (allowed_on, setting
        // type/enum/range, product/collection hallucination guard) layered
        // on top of the already-passed Phase 1/5 checks (§5's pipeline).
        const candidateValidation = validateCandidate(outputValidation.config!, retrievedSchemas, { templateName: plan.templateName });
        const durationMs = Date.now() - startTime;
        validationMs += durationMs;
        instrumentation.logCandidateValidation({
            requestId, stage: "staged_configuration", templateName: plan.templateName,
            valid: candidateValidation.valid,
            errorCount: candidateValidation.errors.length,
            warningCount: candidateValidation.warnings.length,
            errorCodes: [...new Set(candidateValidation.errors.map(e => e.code))],
            candidateChars: aiOutput.length,
            repairAttempt,
            durationMs
        });
        return {
            config: candidateValidation.valid ? outputValidation.config! : null,
            warnings: outputValidation.warnings || [],
            valid: candidateValidation.valid,
            errors: candidateValidation.errors.map(e => `[${e.code}] ${e.path}: ${e.message}`)
        };
    }

    const startTime = Date.now();
    let promptChars = 0;
    let outputChars = 0;
    let aiCallCount = 0;
    let deterministicFixCount = 0;

    const firstUserPrompt = buildConfigurationUserPrompt(brief, plan, themeContext, null);
    const firstOutput = await makeAIRequest(firstUserPrompt, systemPrompt, 3, { requestId, callType: "staged_configuration" });
    aiCallCount++;
    promptChars += systemPrompt.length + firstUserPrompt.length;
    outputChars += firstOutput?.length ?? 0;

    const firstRepair = applyDeterministicRepairs(firstOutput!, retrievedSchemas);
    deterministicFixCount += firstRepair.fixes.length;
    if (firstRepair.fixes.length > 0) {
        instrumentation.logCandidateValidation({
            requestId, stage: "staged_configuration_deterministic_repair", templateName: plan.templateName,
            valid: true, errorCount: 0, warningCount: firstRepair.fixes.length, candidateChars: firstRepair.output.length, repairAttempt: 0, durationMs: 0
        });
    }
    let result = validate(firstRepair.output, 0);
    let repaired = false;

    if (!result.valid) {
        repaired = true;
        const repairUserPrompt = buildConfigurationUserPrompt(brief, plan, themeContext, result.errors);
        const repairOutput = await makeAIRequest(repairUserPrompt, systemPrompt, 3, { requestId, callType: "staged_configuration_repair" });
        aiCallCount++;
        promptChars += systemPrompt.length + repairUserPrompt.length;
        outputChars += repairOutput?.length ?? 0;

        const secondRepair = applyDeterministicRepairs(repairOutput!, retrievedSchemas);
        deterministicFixCount += secondRepair.fixes.length;
        if (secondRepair.fixes.length > 0) {
            instrumentation.logCandidateValidation({
                requestId, stage: "staged_configuration_deterministic_repair", templateName: plan.templateName,
                valid: true, errorCount: 0, warningCount: secondRepair.fixes.length, candidateChars: secondRepair.output.length, repairAttempt: 1, durationMs: 0
            });
        }
        result = validate(secondRepair.output, 1);
        if (!result.valid) {
            throw new Error(`Stage 2 (configuration) produced invalid output even after a repair attempt: ${result.errors.join("; ")}`);
        }
    }

    return {
        config: result.config,
        warnings: result.warnings,
        repaired,
        aiCallCount,
        promptChars,
        outputChars,
        deterministicFixCount,
        durationMs: Date.now() - startTime,
        validationMs
    };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface RunStagedGenerationOptions {
    brief: Brief;
    schemas: SchemaCatalog;
    themeState?: ThemeState | null;
    templateName?: string;
    requestId?: string;
}

/**
 * options:
 *   - brief: a READY WebsiteBrief (Phase 3) — REQUIRED, the authoritative
 *     requirements input (§6).
 *   - schemas: the full AI schema catalog ({sectionSchemas, blockSchemas,
 *     globalSchema}) — REQUIRED. Retrieval narrows this internally; the
 *     caller doesn't need to pre-filter it.
 *   - themeState: an optional Phase 4 ThemeState — if provided, its
 *     relevant slice is selected via selectGenerationContext() (§7/§25);
 *     if omitted, generation proceeds with no current-theme awareness
 *     (structurally valid, just less informed).
 *   - templateName: default 'index'.
 *   - requestId: plumbed into instrumentation, matching existing convention.
 */
export async function runStagedGeneration(options: RunStagedGenerationOptions): Promise<StagedGenerationResult> {
    const {
        brief,
        schemas,
        themeState = null,
        templateName = "index",
        requestId = instrumentation.nextRequestId("staged")
    } = options;

    if (!brief) throw new Error("runStagedGeneration() requires a resolved WebsiteBrief");
    if (!schemas || !Array.isArray(schemas.sectionSchemas) || !Array.isArray(schemas.blockSchemas)) {
        throw new Error("runStagedGeneration() requires the full AI schema catalog ({sectionSchemas, blockSchemas})");
    }

    const startTime = Date.now();

    // Hard-constraint-only eligibility filter — allowed_on + forced-exclusive-section
    // rules, no keyword guessing. This remains the outer safety envelope Stage 2's
    // scoped schemas and validateGenerationPlan()/isEligibleForTemplate() are checked
    // against (see file header).
    const eligibleStart = Date.now();
    const eligible = getTemplateEligibleSchemas(schemas, templateName, requestId);

    // Narrows THAT envelope further, down to a small keyword-relevant candidate set,
    // for Stage 1's prompt specifically — reusing the same deterministic
    // retrieval-rules.json matching retrieveRelevantSchemas() uses elsewhere. Every
    // fallback branch inside narrowEligibleSchemasForPlanning() returns the full
    // `eligible` set unchanged, so this can only ever shrink what Stage 1 sees, never
    // expand it beyond the already-safe template-eligible envelope — Stage 2 continues
    // to scope itself from the plan's approved types regardless (buildConfigurationSystemPrompt).
    const planningCandidates = narrowEligibleSchemasForPlanning(eligible, templateName, briefToSummaryText(brief), requestId);
    const retrievalMs = Date.now() - eligibleStart;

    // §7/§25 — bounded, deterministic ThemeState slice; never the whole state.
    const themeContext: GenerationContext = themeState
        ? selectGenerationContext(themeState, templateName)
        : { templateName, templateExists: false, existingSectionOrder: [], existingSections: [], globalSettingsCurrent: {} };

    const planningResult = await runPlanningStage({ brief, templateName, retrievedSchemas: planningCandidates, themeContext, requestId });
    const { plan, repaired: planRepaired } = planningResult;
    const configResult = await runConfigurationStage({ brief, plan, retrievedSchemas: eligible, themeContext, requestId });
    const { config, warnings, repaired: configRepaired } = configResult;

    const durationMs = Date.now() - startTime;
    const aiCallCount = planningResult.aiCallCount + configResult.aiCallCount;
    const retryCount = (planRepaired ? 1 : 0) + (configRepaired ? 1 : 0);
    const promptChars = planningResult.promptChars + configResult.promptChars;
    const outputChars = planningResult.outputChars + configResult.outputChars;
    const timings: StagedGenerationTimings = {
        retrievalMs,
        planningMs: planningResult.durationMs,
        configurationMs: configResult.durationMs,
        validationMs: configResult.validationMs,
        totalMs: durationMs
    };

    instrumentation.logPipeline({
        requestId,
        success: true,
        stage: "staged_generation",
        templateName,
        retrievalMode: planningCandidates.retrievalMeta.mode,
        selectedSectionCount: planningCandidates.retrievalMeta.selectedSectionCount,
        selectedBlockCount: planningCandidates.retrievalMeta.selectedBlockCount,
        eligibleSectionCount: eligible.sectionSchemas.length,
        eligibleBlockCount: eligible.blockSchemas.length,
        planRepaired,
        configRepaired,
        aiCallCount,
        retryCount,
        deterministicFixCount: configResult.deterministicFixCount,
        promptChars,
        outputChars,
        estimatedPromptTokens: instrumentation.estimateTokensFromChars(promptChars),
        estimatedOutputTokens: instrumentation.estimateTokensFromChars(outputChars),
        timings,
        durationMs
    });

    return {
        templateName,
        plan,
        config,
        warnings,
        retrievalMeta: planningCandidates.retrievalMeta,
        themeContext,
        planRepaired,
        configRepaired,
        aiCallCount,
        durationMs,
        timings,
        retryCount,
        deterministicFixCount: configResult.deterministicFixCount,
        promptChars,
        outputChars,
        estimatedPromptTokens: instrumentation.estimateTokensFromChars(promptChars),
        estimatedOutputTokens: instrumentation.estimateTokensFromChars(outputChars)
    };
}
