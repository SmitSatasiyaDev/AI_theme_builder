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
 *        │
 *        ▼
 *   Stage 1 — PLANNING: the AI itself decides which existing section/block
 *   types to use, in what order and composition, from the FULL
 *   template-eligible name list (not a keyword-narrowed subset) — this is
 *   what lets it generalize to niches/requests retrieval-rules.json never
 *   anticipated. No settings, no content yet. Validated against the
 *   eligible candidate set (never an arbitrary invented type) before
 *   Stage 2 is allowed to run at all.
 *        │
 *        ▼
 *   Stage 2 — CONFIGURATION: fill in settings/content for EXACTLY the
 *   approved structure. Validated with the existing, unmodified
 *   validateOutput() (Phase 1) plus a plan-conformance check.
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

const instrumentation = require('./instrumentation');
const { buildCapabilityIndex } = require('./capability-index');
const { getTemplateEligibleSchemas, FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE, isEligibleForTemplate } = require('./retrieval');
const { makeAIRequest, validateOutput } = require('./ai-client');
const { briefToSummaryText } = require('./brief-logic');
const { selectGenerationContext } = require('./theme-state');
const { validateCandidate } = require('./validation');

const MAX_PLAN_SECTIONS = 10; // same homepage ceiling validateOutput() already enforces for the legacy path

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
function getAllowedBlockIds(sectionSchema) {
    return Array.isArray(sectionSchema.allowed_blocks)
        ? sectionSchema.allowed_blocks
        : (sectionSchema.allowed_blocks && typeof sectionSchema.allowed_blocks === 'object'
            ? Object.keys(sectionSchema.allowed_blocks)
            : []);
}

function lightweightCapabilityListing(retrievedSchemas) {
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

function buildPlanningSystemPrompt(templateName, capabilityListing, themeContext) {
    const forcedSectionId = FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE[templateName];

    let rules = `You are a Shopify theme STRUCTURE planner. Your only job is to decide WHICH existing sections and blocks to use and in what order — you do NOT write any settings, text, or content yet (that happens in a later step).

CRITICAL RULES:
1. You may ONLY use section types listed in AVAILABLE SECTIONS below, and block types listed in AVAILABLE BLOCKS below — copy each "id" value VERBATIM (exact spelling, exact hyphens/underscores).
2. Do NOT invent a section or block type that isn't listed. If nothing listed fits a need, omit it — do not approximate with a made-up type.
3. Each entry in AVAILABLE SECTIONS has its own "allowedBlockTypes" array — this is the COMPLETE and ONLY set of block ids that section accepts. A block type that "sounds like" it would fit (e.g. a generic "buttons"/"text-with-icon" block) is INVALID unless it literally appears in that specific section's "allowedBlockTypes". Never reuse a block id from one section's list inside a different section unless that section's own "allowedBlockTypes" also contains it.
`;

    if (forcedSectionId) {
        rules += `4. This is the "${templateName}" template: your plan MUST contain EXACTLY ONE section, of type "${forcedSectionId}", and nothing else.\n`;
    } else {
        rules += `4. Choose a coherent, non-repetitive set of at most ${MAX_PLAN_SECTIONS} sections for the "${templateName}" template. If a hero-like section is available in AVAILABLE SECTIONS, it typically works well first, but use your judgment.\n`;
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

    rules += `\n\nAVAILABLE SECTIONS:\n${JSON.stringify(capabilityListing.sections, null, 2)}\n\nAVAILABLE BLOCKS:\n${JSON.stringify(capabilityListing.blocks, null, 2)}`;

    return rules;
}

function buildPlanningUserPrompt(brief, templateName, repairErrors) {
    let prompt = `Merchant requirements:\n${briefToSummaryText(brief)}\n\nTarget template: ${templateName}\n\nProduce the GenerationPlan JSON now.`;
    if (repairErrors && repairErrors.length > 0) {
        prompt += `\n\nYour previous plan was invalid for these reasons: ${repairErrors.join('; ')}. Fix these issues and respond again with ONLY the corrected JSON object.`;
    }
    return prompt;
}

/**
 * Validates a GenerationPlan structurally AND against the retrieved
 * candidate set (never the full catalog — §12: "constrained to
 * capabilities that actually exist in the SELECTED schema set").
 */
function validateGenerationPlan(plan, retrievedSchemas, templateName) {
    if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        return { valid: false, errors: ['plan is not a JSON object'] };
    }

    const errors = [];
    if (plan.templateName !== templateName) {
        errors.push(`plan.templateName "${plan.templateName}" does not match the requested template "${templateName}"`);
    }
    if (!plan.sections || typeof plan.sections !== 'object' || Array.isArray(plan.sections)) {
        errors.push('plan.sections must be an object');
    }
    if (!Array.isArray(plan.order)) {
        errors.push('plan.order must be an array');
    }
    if (errors.length > 0) return { valid: false, errors };

    const sectionIds = Object.keys(plan.sections);
    if (sectionIds.length === 0) {
        errors.push('plan.sections must not be empty');
    }
    if (plan.order.length > MAX_PLAN_SECTIONS) {
        errors.push(`plan.order has ${plan.order.length} sections, maximum ${MAX_PLAN_SECTIONS} allowed`);
    }
    if (new Set(plan.order).size !== plan.order.length) {
        errors.push('plan.order contains duplicate section ids');
    }
    for (const id of plan.order) {
        if (!plan.sections.hasOwnProperty(id)) errors.push(`plan.order references unknown section id "${id}"`);
    }
    for (const id of sectionIds) {
        if (!plan.order.includes(id)) errors.push(`plan.sections["${id}"] is not listed in plan.order`);
    }

    const sectionById = new Map(retrievedSchemas.sectionSchemas.map(s => [s.id, s]));
    const blockById = new Map(retrievedSchemas.blockSchemas.map(b => [b.id, b]));

    const forcedSectionId = FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE[templateName];
    if (forcedSectionId && (sectionIds.length !== 1 || plan.sections[sectionIds[0]].type !== forcedSectionId)) {
        errors.push(`template "${templateName}" must use exactly one section of type "${forcedSectionId}"`);
    }

    for (const [id, section] of Object.entries(plan.sections)) {
        if (!section || typeof section !== 'object') {
            errors.push(`plan.sections["${id}"] must be an object`);
            continue;
        }
        if (!section.type || !sectionById.has(section.type)) {
            errors.push(`plan.sections["${id}"].type "${section.type}" is not part of the retrieved/relevant capabilities for this request`);
            continue;
        }
        const sectionSchema = sectionById.get(section.type);

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

/**
 * Runs Stage 1 to completion: one AI call, validated; a single bounded
 * repair retry if invalid; throws (does not continue to Stage 2) if the
 * repair attempt is also invalid — §21.
 */
async function runPlanningStage({ brief, templateName, retrievedSchemas, themeContext, requestId }) {
    const capabilityListing = lightweightCapabilityListing(retrievedSchemas);
    const systemPrompt = buildPlanningSystemPrompt(templateName, capabilityListing, themeContext);

    function parseAndValidate(content) {
        let plan;
        try {
            plan = JSON.parse(content);
        } catch (error) {
            return { plan: null, validation: { valid: false, errors: [`plan was not valid JSON: ${error.message}`] } };
        }
        return { plan, validation: validateGenerationPlan(plan, retrievedSchemas, templateName) };
    }

    const firstContent = await makeAIRequest(buildPlanningUserPrompt(brief, templateName, null), systemPrompt, 2, { requestId, callType: 'generation_plan' });
    let { plan, validation } = parseAndValidate(firstContent);
    let repaired = false;

    if (!validation.valid) {
        repaired = true;
        const repairContent = await makeAIRequest(buildPlanningUserPrompt(brief, templateName, validation.errors), systemPrompt, 2, { requestId, callType: 'generation_plan_repair' });
        ({ plan, validation } = parseAndValidate(repairContent));
        if (!validation.valid) {
            throw new Error(`Stage 1 (planning) produced an invalid GenerationPlan even after a repair attempt: ${validation.errors.join('; ')}`);
        }
    }

    return { plan, repaired, capabilityListing };
}

// ---------------------------------------------------------------------------
// Stage 2 — Configuration
// ---------------------------------------------------------------------------

function buildConfigurationSystemPrompt(plan, retrievedSchemas) {
    const usedSectionTypes = new Set(Object.values(plan.sections).map(s => s.type));
    const usedBlockTypes = new Set(Object.values(plan.sections).flatMap(s => Array.isArray(s.blockTypes) ? s.blockTypes : []));
    const scopedSectionSchemas = retrievedSchemas.sectionSchemas.filter(s => usedSectionTypes.has(s.id));
    const scopedBlockSchemas = retrievedSchemas.blockSchemas.filter(b => usedBlockTypes.has(b.id));

    const structureList = plan.order.map(id => {
        const s = plan.sections[id];
        const blocksNote = (s.blockTypes && s.blockTypes.length) ? `, blocks: [${s.blockTypes.join(', ')}]` : '';
        return `  - "${id}": type "${s.type}"${blocksNote}`;
    }).join('\n');

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
${JSON.stringify(scopedSectionSchemas, null, 2)}

SCOPED BLOCK SCHEMAS (only the types used in the approved structure):
${JSON.stringify(scopedBlockSchemas, null, 2)}

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

function buildConfigurationUserPrompt(brief, plan, themeContext, repairErrors) {
    let prompt = `Merchant requirements:\n${briefToSummaryText(brief)}\n\nGenerate the settings/content for the approved structure now.`;

    const colorKeys = Object.entries(themeContext.globalSettingsCurrent || {})
        .filter(([key]) => key.startsWith('colors_') || key.startsWith('gradient_'));
    if (colorKeys.length > 0) {
        prompt += `\n\nThe theme's current global colors (context only — do not output global settings yourself, only section/block content): ${JSON.stringify(Object.fromEntries(colorKeys))}.`;
    }

    if (repairErrors && repairErrors.length > 0) {
        prompt += `\n\nYour previous response was invalid for these reasons: ${repairErrors.join('; ')}. Fix these issues and respond again with ONLY the corrected JSON object.`;
    }
    return prompt;
}

function countBy(arr) {
    const map = new Map();
    for (const x of arr) map.set(x, (map.get(x) || 0) + 1);
    return map;
}

/**
 * Confirms Stage 2's output didn't silently drift from the approved plan
 * (structure/types/block composition) — validateOutput() alone wouldn't
 * catch this, since a *different but still valid* structure would still
 * pass generic schema validation.
 */
function matchesPlan(config, plan) {
    const errors = [];
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

/**
 * Runs Stage 2 to completion against an ALREADY-VALID plan: one AI call,
 * validated via the existing (unmodified) validateOutput() plus
 * matchesPlan(); a single bounded repair retry if invalid; throws if the
 * repair attempt is also invalid — §21.
 */
async function runConfigurationStage({ brief, plan, retrievedSchemas, themeContext, requestId }) {
    const systemPrompt = buildConfigurationSystemPrompt(plan, retrievedSchemas);

    function validate(aiOutput, repairAttempt) {
        const startTime = Date.now();
        const outputValidation = validateOutput(aiOutput, retrievedSchemas, { requestId });
        if (!outputValidation.valid) {
            instrumentation.logCandidateValidation({
                requestId, stage: 'staged_configuration', templateName: plan.templateName,
                valid: false, errorCount: 1, candidateChars: aiOutput.length, repairAttempt,
                durationMs: Date.now() - startTime
            });
            return { config: null, warnings: [], valid: false, errors: [outputValidation.error] };
        }
        const planValidation = matchesPlan(outputValidation.config, plan);
        if (!planValidation.valid) {
            instrumentation.logCandidateValidation({
                requestId, stage: 'staged_configuration', templateName: plan.templateName,
                valid: false, errorCount: planValidation.errors.length, candidateChars: aiOutput.length, repairAttempt,
                durationMs: Date.now() - startTime
            });
            return { config: null, warnings: outputValidation.warnings || [], valid: false, errors: planValidation.errors };
        }

        // Phase 6 — deep candidate validation (allowed_on, setting
        // type/enum/range, product/collection hallucination guard) layered
        // on top of the already-passed Phase 1/5 checks (§5's pipeline).
        const candidateValidation = validateCandidate(outputValidation.config, retrievedSchemas, { templateName: plan.templateName });
        instrumentation.logCandidateValidation({
            requestId, stage: 'staged_configuration', templateName: plan.templateName,
            valid: candidateValidation.valid,
            errorCount: candidateValidation.errors.length,
            warningCount: candidateValidation.warnings.length,
            errorCodes: [...new Set(candidateValidation.errors.map(e => e.code))],
            candidateChars: aiOutput.length,
            repairAttempt,
            durationMs: Date.now() - startTime
        });
        return {
            config: candidateValidation.valid ? outputValidation.config : null,
            warnings: outputValidation.warnings || [],
            valid: candidateValidation.valid,
            errors: candidateValidation.errors.map(e => `[${e.code}] ${e.path}: ${e.message}`)
        };
    }

    const firstOutput = await makeAIRequest(buildConfigurationUserPrompt(brief, plan, themeContext, null), systemPrompt, 3, { requestId, callType: 'staged_configuration' });
    let result = validate(firstOutput, 0);
    let repaired = false;

    if (!result.valid) {
        repaired = true;
        const repairOutput = await makeAIRequest(buildConfigurationUserPrompt(brief, plan, themeContext, result.errors), systemPrompt, 3, { requestId, callType: 'staged_configuration_repair' });
        result = validate(repairOutput, 1);
        if (!result.valid) {
            throw new Error(`Stage 2 (configuration) produced invalid output even after a repair attempt: ${result.errors.join('; ')}`);
        }
    }

    return { config: result.config, warnings: result.warnings, repaired };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

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
async function runStagedGeneration(options = {}) {
    const {
        brief,
        schemas,
        themeState = null,
        templateName = 'index',
        requestId = instrumentation.nextRequestId('staged')
    } = options;

    if (!brief) throw new Error('runStagedGeneration() requires a resolved WebsiteBrief');
    if (!schemas || !Array.isArray(schemas.sectionSchemas) || !Array.isArray(schemas.blockSchemas)) {
        throw new Error('runStagedGeneration() requires the full AI schema catalog ({sectionSchemas, blockSchemas})');
    }

    const startTime = Date.now();

    // Hard-constraint-only eligibility filter — the AI itself chooses which
    // of the eligible sections/blocks to use in Stage 1, not a keyword
    // matcher (see file header).
    const retrieved = getTemplateEligibleSchemas(schemas, templateName, requestId);

    // §7/§25 — bounded, deterministic ThemeState slice; never the whole state.
    const themeContext = themeState
        ? selectGenerationContext(themeState, templateName)
        : { templateName, templateExists: false, existingSectionOrder: [], existingSections: [], globalSettingsCurrent: {} };

    const { plan, repaired: planRepaired } = await runPlanningStage({ brief, templateName, retrievedSchemas: retrieved, themeContext, requestId });
    const { config, warnings, repaired: configRepaired } = await runConfigurationStage({ brief, plan, retrievedSchemas: retrieved, themeContext, requestId });

    const durationMs = Date.now() - startTime;

    instrumentation.logPipeline({
        requestId,
        success: true,
        stage: 'staged_generation',
        templateName,
        retrievalMode: retrieved.retrievalMeta.mode,
        selectedSectionCount: retrieved.retrievalMeta.selectedSectionCount,
        selectedBlockCount: retrieved.retrievalMeta.selectedBlockCount,
        planRepaired,
        configRepaired,
        aiCallCount: 2 + (planRepaired ? 1 : 0) + (configRepaired ? 1 : 0),
        durationMs
    });

    return {
        templateName,
        plan,
        config,
        warnings,
        retrievalMeta: retrieved.retrievalMeta,
        themeContext,
        planRepaired,
        configRepaired,
        aiCallCount: 2 + (planRepaired ? 1 : 0) + (configRepaired ? 1 : 0),
        durationMs
    };
}

module.exports = {
    MAX_PLAN_SECTIONS,
    lightweightCapabilityListing,
    buildPlanningSystemPrompt,
    buildPlanningUserPrompt,
    validateGenerationPlan,
    runPlanningStage,
    buildConfigurationSystemPrompt,
    buildConfigurationUserPrompt,
    matchesPlan,
    runConfigurationStage,
    runStagedGeneration
};
