/**
 * Phase 8 — Targeted Editing Orchestration.
 *
 * Wires together: deterministic request classification (§29/§30) →
 * deterministic target resolution against ThemeState (operations.js, §8/§9)
 * → clarification on ambiguity (§10/§23) → ONE bounded AI operation
 * PROPOSAL scoped to just the resolved target (§12) → deterministic
 * validation/execution (operations.js, unmodified) → optional Phase 7
 * apply (§26).
 *
 * The split this file preserves, matching §24 exactly (and the same split
 * Phase 5 already established for GenerationPlan): the AI PROPOSES one
 * operation object; this file's `runOperationProposalStage()` never trusts
 * it directly — `operations.js`'s `validateOperation()`/
 * `applyOperationToThemeState()` (both untouched, reused as-is) are the
 * only code that decides whether a proposal is safe and the only code that
 * actually mutates a ThemeState. This file adds no new mutation logic of
 * its own.
 *
 * §27 — a targeted edit must never fall into Phase 7's full-structure
 * replacement path. It doesn't: `runTargetedEdit()`'s optional apply step
 * calls `apply.js`'s `applyThemeState()` DIRECTLY on the
 * operation-mutated ThemeState, never `merge.js`. `merge.js`'s two
 * policies (splice-by-type / full-structure-replace) exist specifically to
 * reconcile a whole-template INITIAL GENERATION candidate against existing
 * state (see merge.js's file header) — an operation's result is neither of
 * those; `executeOperation()` in operations.js already knows precisely
 * what changed and what to preserve, so there is nothing left for
 * merge.js's policy logic to decide. This is the one Phase 7 boundary
 * worth calling out explicitly, per §27's own warning.
 */

const instrumentation = require('./instrumentation');
const { retrieveRelevantSchemas } = require('./retrieval');
const { makeAIRequest } = require('./ai-client');
const {
    OPERATION_TYPES,
    resolveSectionTarget,
    resolveBlockTarget,
    validateOperation,
    applyOperationToThemeState
} = require('./operations');
const { applyThemeState } = require('./apply');

// ---------------------------------------------------------------------------
// §29/§30 — deterministic request classification. Intentionally small: a
// short, curated verb list, not NLP. "Do not over-classify" — an unclear
// request routes to AMBIGUOUS (clarification), never a guessed operation
// count.
// ---------------------------------------------------------------------------

const CREATE_SIGNAL_PHRASES = ['create a', 'create an', 'build a', 'build me', 'design a', 'generate a', 'make me a store', 'make a store', 'make a homepage', 'redesign', 'entire store', 'whole store', 'entire homepage'];
const EDIT_VERBS = ['change', 'update', 'remove', 'delete', 'add', 'move', 'replace', 'edit', 'modify', 'set'];

// A request only has a legitimate reason to target NO existing section when
// it's asking to CREATE one — everything else (update/remove/a vague "change
// one section" with no section named) needs an existing target, so a
// NOT_FOUND resolution there must ask which section rather than let the AI
// guess an operation with zero grounding.
const ADD_SIGNAL_VERBS = ['add', 'create', 'insert', 'new'];

// A removal is a complete instruction the moment its target is identified —
// "remove the testimonials section" has nothing left to ask about, unlike
// an update/add which still needs to say what the new value/content is.
// hasChangeDetails() would otherwise see nothing but generic words + the
// target's own identity left after stripping and (wrongly) ask "what would
// you like to change?" for a request that never needed an answer.
const REMOVE_SIGNAL_VERBS = ['remove', 'delete'];

function classifyRequest(userPrompt) {
    const lower = (userPrompt || '').toLowerCase();
    if (CREATE_SIGNAL_PHRASES.some(phrase => lower.includes(phrase))) {
        return 'INITIAL_GENERATION';
    }
    if (EDIT_VERBS.some(verb => new RegExp(`\\b${verb}\\b`).test(lower))) {
        return 'TARGETED_EDIT';
    }
    return 'AMBIGUOUS';
}

// ---------------------------------------------------------------------------
// §10 — clarification question shape, matching clarification.js's existing
// protocol (an array of plain-text questions) rather than inventing a
// second question format.
// ---------------------------------------------------------------------------

function buildAmbiguityQuestion(candidates, kind) {
    const options = candidates.map((c, i) => `${i + 1}. ${c.sectionId || c.blockId} (${c.type})`).join('\n');
    return `Which ${kind} did you mean?\n${options}`;
}

// ---------------------------------------------------------------------------
// §10/§11 — minimal clarification. A resolved target alone isn't enough to
// propose an operation when the intent is purely "change the banner" — no
// AI call is bounded/cheap enough to justify guessing WHAT changed when the
// merchant never said. Deterministic, not NLP: strip generic edit verbs and
// the target's own id/type tokens from the intent; if anything real is left
// over, there's enough to propose from ("Change the hero heading to Healthy
// nutrition for every dog." skips this question entirely); if nothing is
// left, ask exactly one question instead of spending an AI call on a guess.
// Shared by runTargetedEdit() below (a target resolved on the FIRST pass —
// including via the AI-assisted resolution above, or via a merged-intent
// retry) and conversational-edit.js (a target resolved via a SECOND-round
// clarification answer) — same rule, one definition, either path.
// ---------------------------------------------------------------------------

const GENERIC_INTENT_WORDS = new Set([
    'the', 'a', 'an', 'to', 'of', 'on', 'for', 'my', 'this', 'that', 'it',
    'please', 'i', 'want', 'would', 'like', 'me', 'can', 'you', 'need', 'is',
    // Structural/vague nouns naming WHAT KIND of thing is being touched
    // (already established by the resolved target itself), not WHAT the
    // new value should be.
    'one', 'some', 'section', 'block', 'content',
    // WHERE, not WHAT — answers "which area of the theme", the same
    // question target RESOLUTION already asks, not "what should it say/look
    // like now" (what hasChangeDetails() actually needs to see).
    'homepage', 'home', 'page', 'template', 'site', 'store', 'website'
]);

function intentTokenize(text) {
    return (text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hasChangeDetails(intentText, target) {
    const targetTokens = new Set(intentTokenize([target.sectionId, target.blockId, target.type, target.blockType]
        .filter(Boolean).join(' ').replace(/[-_]/g, ' ')));
    const remaining = intentTokenize(intentText).filter(token =>
        !GENERIC_INTENT_WORDS.has(token) && !targetTokens.has(token) && !EDIT_VERBS.includes(token));
    return remaining.length > 0;
}

// ---------------------------------------------------------------------------
// §12 — bounded operation-proposal prompt. Scoped to the resolved target's
// CURRENT settings + its own schema (never the whole ThemeState, never the
// whole catalog); for add-shaped requests where nothing resolved, scoped to
// Phase 2's deterministic retrieval pool for this template (already
// bounded, already tested) rather than the full 69-schema catalog.
// ---------------------------------------------------------------------------

function buildProposalSystemPrompt(templateName, targetContext, candidatePool) {
    let rules = `You are a Shopify theme EDITOR. The merchant wants exactly ONE targeted change to their EXISTING theme. Propose exactly ONE structured operation as JSON:
{
  "operation": "<one of: ${OPERATION_TYPES.join(', ')}>",
  "target": { "templateName": "${templateName}", "sectionId": "<existing section id, if editing/removing one>", "blockId": "<existing block id, if editing/removing one>" },
  "changes": { "settings": { }, "type": "<existing schema type id, only for add_section/add_block>", "position": "start|end" }
}

CRITICAL RULES:
1. If the operation targets an EXISTING section or block, target.sectionId/target.blockId MUST be copied VERBATIM from CURRENT TARGET CONTEXT below — never invent an id.
2. changes.settings must use ONLY setting keys defined by the relevant schema below, and must include ONLY the settings that are actually changing — do not restate settings that aren't changing.
3. For add_section/add_block, changes.type must be copied VERBATIM from an "id" listed in AVAILABLE TYPES below.
4. Never invent a product handle, collection handle, or other merchant-specific data — leave such a setting out of changes entirely if you don't know a real value.
5. Return ONLY the JSON object — no explanation, no markdown.
6. If the request does not clearly map to exactly one of the supported operation types, still propose your best single guess — validation will catch anything unsafe.`;

    if (targetContext) {
        rules += `\n\nCURRENT TARGET CONTEXT (the existing component you are most likely editing):\n${JSON.stringify(targetContext, null, 2)}`;
    }
    if (candidatePool) {
        rules += `\n\nAVAILABLE TYPES (for add_section/add_block only):\n${JSON.stringify(candidatePool, null, 2)}`;
    }
    return rules;
}

function buildProposalUserPrompt(userPrompt, repairErrors) {
    let prompt = `Merchant request: "${userPrompt}"\n\nProduce the operation JSON now.`;
    if (repairErrors && repairErrors.length > 0) {
        prompt += `\n\nYour previous response was invalid for these reasons: ${repairErrors.join('; ')}. Fix these issues and respond again with ONLY the corrected JSON object.`;
    }
    return prompt;
}

// ---------------------------------------------------------------------------
// Target resolution — when NOTHING in the default template matches by
// keyword overlap at all, that's exactly the case where a merchant's own
// wording can't be trusted to deterministic scoring: a word like "footer"
// might name the actual target ("change the footer text"), or might just be
// a LANDMARK for locating something else entirely ("the section before the
// footer"). Keyword overlap can't tell those apart — only understanding the
// sentence can. So this is the one place a bounded AI call gets to make that
// judgment call itself, across every template's sections at once, and is
// EXPLICITLY allowed to say "I'm not sure" with its own clarifying question
// instead of guessing — deterministic code still never trusts its answer
// without checking the id it names actually exists (§8/§9's rule, applied
// here too).
// ---------------------------------------------------------------------------

function buildSectionListingAcrossTemplates(themeState) {
    const listing = [];
    for (const [templateName, template] of Object.entries(themeState.templates || {})) {
        for (const [sectionId, section] of Object.entries((template.raw && template.raw.sections) || {})) {
            listing.push({ templateName, sectionId, type: section.type });
        }
    }
    return listing;
}

function buildTargetResolutionSystemPrompt(sectionListing) {
    return `You are helping locate WHICH EXISTING section of a Shopify theme a merchant's edit request refers to. The merchant's own words may be vague, or may name another area only as a LANDMARK for finding something else ("the section before the footer", "above the header") rather than naming that area as the actual target — use your judgment about what they actually mean, not just keyword overlap.

Respond with EXACTLY ONE JSON object, in ONE of these two shapes:
{"confident": true, "templateName": "<templateName>", "sectionId": "<sectionId>"}
{"confident": false, "clarifyingQuestion": "<optional: one short question to ask the merchant, if you have a specific one in mind>"}

CRITICAL RULES:
1. templateName/sectionId, if given, MUST be copied VERBATIM from EXISTING SECTIONS below — never invent one.
2. Only set confident:true if you are reasonably sure which ONE section is meant. If multiple sections could equally match, or nothing clearly matches, set confident:false instead of guessing.
3. When confident:false, include "clarifyingQuestion" if you have a specific, useful question to ask — omit it if you don't; a generic fallback will be used instead.
4. Return ONLY the JSON object — no explanation, no markdown.

EXISTING SECTIONS (every section in every template/page of this theme):
${JSON.stringify(sectionListing)}`;
}

function buildTargetResolutionUserPrompt(userPrompt, repairErrors) {
    let prompt = `Merchant request: "${userPrompt}"\n\nProduce the JSON now.`;
    if (repairErrors && repairErrors.length > 0) {
        prompt += `\n\nYour previous response was invalid for these reasons: ${repairErrors.join('; ')}. Fix these issues and respond again with ONLY the corrected JSON object.`;
    }
    return prompt;
}

function validateTargetResolution(resolution, themeState) {
    if (!resolution || typeof resolution !== 'object') {
        return { valid: false, errors: [{ message: 'response is not a JSON object' }] };
    }
    if (typeof resolution.confident !== 'boolean') {
        return { valid: false, errors: [{ message: '"confident" must be a boolean' }] };
    }
    if (resolution.confident === true) {
        const { templateName, sectionId } = resolution;
        if (typeof templateName !== 'string' || typeof sectionId !== 'string') {
            return { valid: false, errors: [{ message: 'confident:true requires string "templateName" and "sectionId"' }] };
        }
        const template = themeState.templates[templateName];
        const section = template && template.raw.sections[sectionId];
        if (!section) {
            return { valid: false, errors: [{ message: `"${templateName}"."${sectionId}" does not exist — templateName/sectionId must be copied verbatim from EXISTING SECTIONS` }] };
        }
        return { valid: true, errors: [] };
    }
    if (resolution.clarifyingQuestion !== undefined && (typeof resolution.clarifyingQuestion !== 'string' || !resolution.clarifyingQuestion.trim())) {
        return { valid: false, errors: [{ message: 'if present, "clarifyingQuestion" must be a non-empty string' }] };
    }
    return { valid: true, errors: [] };
}

/**
 * ONE bounded AI call, ONE bounded repair — same shape as
 * runOperationProposalStage() below. Deterministic code (validateTargetResolution
 * above) is what actually decides whether the AI's pick is trustworthy; this
 * function never returns a target that doesn't verifiably exist.
 */
async function runTargetResolutionStage({ userPrompt, themeState, requestId }) {
    const sectionListing = buildSectionListingAcrossTemplates(themeState);
    const systemPrompt = buildTargetResolutionSystemPrompt(sectionListing);

    function parseAndValidate(content) {
        let resolution;
        try {
            resolution = JSON.parse(content);
        } catch (error) {
            return { resolution: null, validation: { valid: false, errors: [{ message: `not valid JSON: ${error.message}` }] } };
        }
        return { resolution, validation: validateTargetResolution(resolution, themeState) };
    }

    const firstContent = await makeAIRequest(buildTargetResolutionUserPrompt(userPrompt, null), systemPrompt, 2, { requestId, callType: 'target_resolution' });
    let { resolution, validation } = parseAndValidate(firstContent);
    let repaired = false;

    if (!validation.valid) {
        repaired = true;
        const repairErrors = validation.errors.map(e => e.message);
        const repairContent = await makeAIRequest(buildTargetResolutionUserPrompt(userPrompt, repairErrors), systemPrompt, 2, { requestId, callType: 'target_resolution_repair' });
        ({ resolution, validation } = parseAndValidate(repairContent));
    }

    return { resolution, validation, repaired };
}

/**
 * ONE bounded AI call, ONE bounded repair — the exact same shape
 * generation.js's runPlanningStage() already established for GenerationPlan
 * (§21's "bounded recovery" architecture, reused, not reinvented).
 */
async function runOperationProposalStage({ userPrompt, templateName, targetContext, candidatePool, themeState, schemas, knownMerchantData, requestId }) {
    const systemPrompt = buildProposalSystemPrompt(templateName, targetContext, candidatePool);
    const validationContext = { themeState, schemas, knownMerchantData };

    function parseAndValidate(content) {
        let operation;
        try {
            operation = JSON.parse(content);
        } catch (error) {
            return { operation: null, validation: { valid: false, errors: [{ code: 'OPERATION_INVALID', path: 'operation', message: `not valid JSON: ${error.message}` }] } };
        }
        return { operation, validation: validateOperation(operation, validationContext) };
    }

    const firstContent = await makeAIRequest(buildProposalUserPrompt(userPrompt, null), systemPrompt, 2, { requestId, callType: 'operation_proposal' });
    let { operation, validation } = parseAndValidate(firstContent);
    let repaired = false;

    if (!validation.valid) {
        repaired = true;
        const repairErrors = validation.errors.map(e => e.message);
        const repairContent = await makeAIRequest(buildProposalUserPrompt(userPrompt, repairErrors), systemPrompt, 2, { requestId, callType: 'operation_proposal_repair' });
        ({ operation, validation } = parseAndValidate(repairContent));
    }

    return { operation, validation, repaired };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * options:
 *   - themeState: REQUIRED, a Phase 4 ThemeState.
 *   - schemas: REQUIRED, the full AI schema catalog.
 *   - templateName: default 'index'.
 *   - knownMerchantData: optional {products:[], collections:[]}.
 *   - autoApply: if true, a successfully executed operation is also
 *     persisted via apply.js (still an explicit, opt-in step — §22's
 *     "apply must be explicit" applies here exactly as it does in
 *     1-generate-theme.js).
 *   - themeRoot / dryRunApply: forwarded to applyThemeState() when
 *     autoApply is set.
 */
async function runTargetedEdit(userPrompt, options = {}) {
    const {
        themeState,
        schemas,
        knownMerchantData = {},
        autoApply = false,
        themeRoot,
        dryRunApply = false,
        requestId = instrumentation.nextRequestId('edit')
    } = options;
    // Mutable: an AI-assisted resolution below (§10/§29) can switch this to
    // a DIFFERENT template than the one the turn started in, when the
    // merchant's own wording named no section in the default scope.
    let templateName = options.templateName || 'index';

    if (!themeState) throw new Error('runTargetedEdit() requires a ThemeState');
    if (!schemas || !Array.isArray(schemas.sectionSchemas)) throw new Error('runTargetedEdit() requires the full AI schema catalog');

    const startTime = Date.now();
    const classification = classifyRequest(userPrompt);

    if (classification !== 'TARGETED_EDIT') {
        instrumentation.logEditPipeline({ requestId, status: classification, classification, durationMs: Date.now() - startTime });
        return { status: classification, classification };
    }

    // §8/§9 — deterministic target resolution against ThemeState, using the
    // raw request text as the natural-language query. An exact existing
    // section id embedded in the prompt (unlikely from a human, common from
    // a programmatic caller) short-circuits via resolveSectionTarget()'s own
    // exact-match fast path.
    let sectionTarget = resolveSectionTarget(themeState, templateName, userPrompt, schemas);

    // Keyword-overlap scoring can fail two different ways — a tie
    // (AMBIGUOUS, e.g. a generic word like "content" happens to sit in
    // several sections' category tags) or nothing at all (NOT_FOUND) — and
    // either way, understanding what the merchant actually meant needs more
    // than word overlap: "the section before the footer" and "the footer
    // section" share every keyword but mean different things. So BOTH cases
    // give a bounded AI call first say at resolving it (across every
    // template, not just this one), and it's EXPLICITLY allowed to say "not
    // confident" with its own clarifying question rather than guess —
    // deterministic code still never trusts its pick without checking the
    // id it names actually exists (validateTargetResolution). This does NOT
    // apply when the template itself isn't present in the ThemeState at all
    // — that's the legitimate shape of a global-settings-only request (no
    // section is ever the target for update_global_settings), which must
    // still reach the AI proposal below.
    const targetTemplate = themeState.templates[templateName];
    let resolutionAiCallCount = 0;
    if ((sectionTarget.status === 'AMBIGUOUS' || sectionTarget.status === 'NOT_FOUND') && targetTemplate) {
        const looksLikeAdd = sectionTarget.status === 'NOT_FOUND' && ADD_SIGNAL_VERBS.some(verb => new RegExp(`\\b${verb}\\b`, 'i').test(userPrompt));
        if (!looksLikeAdd) {
            const { resolution, validation: resolutionValidation, repaired: resolutionRepaired } = await runTargetResolutionStage({ userPrompt, themeState, requestId });
            resolutionAiCallCount = resolutionRepaired ? 2 : 1;

            if (resolutionValidation.valid && resolution.confident === true) {
                // The AI identified an existing target — possibly in a
                // DIFFERENT template than this turn started in — so switch
                // scope to match and resolve it via the exact-id fast path
                // (already verified to exist by validateTargetResolution).
                templateName = resolution.templateName;
                sectionTarget = resolveSectionTarget(themeState, templateName, resolution.sectionId, schemas);
            } else {
                // Not confident (or an invalid/hallucinated response even
                // after one repair attempt) — ask the merchant instead of
                // guessing. Prefer the AI's own open-ended question (merged
                // into the intent and re-resolved next turn — no fixed list
                // to match a free-text answer against); if even that's
                // unusable, an AMBIGUOUS tie still has real (if imperfect)
                // tied candidates to fall back to, which is a better last
                // resort than a generic prompt with nothing behind it.
                const useDeterministicFallback = !(resolutionValidation.valid && resolution.clarifyingQuestion) && sectionTarget.status === 'AMBIGUOUS';
                const result = useDeterministicFallback
                    ? {
                        status: 'NEEDS_CLARIFICATION',
                        classification,
                        targetStatus: sectionTarget.status,
                        templateName,
                        candidates: sectionTarget.candidates,
                        questions: [buildAmbiguityQuestion(sectionTarget.candidates, 'section')]
                    }
                    : {
                        status: 'NEEDS_CLARIFICATION',
                        classification,
                        targetStatus: sectionTarget.status,
                        templateName,
                        candidates: [],
                        questions: [(resolutionValidation.valid && resolution.clarifyingQuestion) ? resolution.clarifyingQuestion : 'Which section would you like to change?']
                    };
                instrumentation.logEditPipeline({ requestId, status: result.status, classification, targetStatus: sectionTarget.status, aiCallCount: resolutionAiCallCount, repaired: resolutionRepaired, durationMs: Date.now() - startTime });
                return result;
            }
        }
        // else: add-shaped NOT_FOUND — no AI resolution call, proceed
        // straight to the operation-proposal stage below with candidatePool,
        // same as before this change.
    }

    let targetContext = null;
    if (sectionTarget.status === 'RESOLVED') {
        const sectionSchema = schemas.sectionSchemas.find(s => s.id === sectionTarget.section.type);
        targetContext = {
            sectionId: sectionTarget.sectionId,
            type: sectionTarget.section.type,
            currentSettings: sectionTarget.section.settings || {},
            schemaSettings: sectionSchema ? sectionSchema.settings : {}
        };

        const blockTarget = resolveBlockTarget(sectionTarget.section, userPrompt, schemas);
        if (blockTarget.status === 'AMBIGUOUS') {
            const result = {
                status: 'NEEDS_CLARIFICATION',
                classification,
                targetStatus: blockTarget.status,
                templateName,
                sectionId: sectionTarget.sectionId,
                candidates: blockTarget.candidates,
                questions: [buildAmbiguityQuestion(blockTarget.candidates, 'block')]
            };
            instrumentation.logEditPipeline({ requestId, status: result.status, classification, targetStatus: blockTarget.status, durationMs: Date.now() - startTime });
            return result;
        }
        if (blockTarget.status === 'RESOLVED') {
            const blockSchema = schemas.blockSchemas.find(b => b.id === blockTarget.block.type);
            targetContext.block = {
                blockId: blockTarget.blockId,
                type: blockTarget.block.type,
                currentSettings: blockTarget.block.settings || {},
                schemaSettings: blockSchema ? blockSchema.settings : {}
            };
        }

        // §10/§11 — a target now exists, but the request may still say
        // nothing about WHAT to change (e.g. the merchant's original words
        // were purely "change one section content", and the AI-assisted
        // resolution above only figured out WHICH section that meant — it
        // never supplied a value either). Ask rather than let the
        // operation-proposal call below guess a value nobody asked for. The
        // answer merges into currentIntent and comes back through here
        // again (conversational-edit.js's 'intent'-kind clarification), so
        // this naturally keeps asking follow-ups until there's something
        // concrete to act on.
        const looksLikeRemove = REMOVE_SIGNAL_VERBS.some(verb => new RegExp(`\\b${verb}\\b`, 'i').test(userPrompt));
        if (!looksLikeRemove && !hasChangeDetails(userPrompt, {
            sectionId: targetContext.sectionId,
            type: targetContext.type,
            blockId: targetContext.block ? targetContext.block.blockId : undefined,
            blockType: targetContext.block ? targetContext.block.type : undefined
        })) {
            const result = {
                status: 'NEEDS_CLARIFICATION',
                classification,
                targetStatus: sectionTarget.status,
                templateName,
                candidates: [],
                questions: ['What would you like to change?']
            };
            instrumentation.logEditPipeline({ requestId, status: result.status, classification, targetStatus: sectionTarget.status, aiCallCount: resolutionAiCallCount, durationMs: Date.now() - startTime });
            return result;
        }
    }

    // §12 — bounded candidate pool for add-shaped requests, reusing Phase 2
    // retrieval rather than sending the full 69-schema catalog.
    const retrieved = retrieveRelevantSchemas(schemas, { userPrompt, templateName, requestId });
    const candidatePool = {
        sections: retrieved.sectionSchemas.map(s => ({ id: s.id, label: s.label, summary: s.purpose })),
        blocks: retrieved.blockSchemas.map(b => ({ id: b.id, label: b.label, summary: b.purpose }))
    };

    const { operation, validation, repaired } = await runOperationProposalStage({
        userPrompt, templateName, targetContext, candidatePool, themeState, schemas, knownMerchantData, requestId
    });

    if (!validation.valid) {
        const result = { status: 'FAILED', classification, targetStatus: sectionTarget.status, errors: validation.errors, operation, repaired };
        instrumentation.logEditPipeline({ requestId, status: 'FAILED', classification, targetStatus: sectionTarget.status, operationCount: 1, repaired, aiCallCount: resolutionAiCallCount + (repaired ? 2 : 1), durationMs: Date.now() - startTime });
        return result;
    }

    const executed = applyOperationToThemeState(themeState, operation, { themeState, schemas, knownMerchantData, requestId });
    if (!executed.valid) {
        const result = { status: 'FAILED', classification, targetStatus: sectionTarget.status, errors: executed.errors, operation, repaired };
        instrumentation.logEditPipeline({ requestId, status: 'FAILED', classification, targetStatus: sectionTarget.status, operationCount: 1, repaired, aiCallCount: resolutionAiCallCount + (repaired ? 2 : 1), durationMs: Date.now() - startTime });
        return result;
    }

    let applyResult = null;
    if (autoApply) {
        const changedTemplates = operation.operation === 'update_global_settings' ? [] : [operation.target.templateName];
        applyResult = await applyThemeState(executed.themeState, {
            themeRoot,
            changedTemplates,
            writeGlobalSettings: operation.operation === 'update_global_settings',
            dryRun: dryRunApply,
            requestId
        });
    }

    const result = {
        status: autoApply ? (dryRunApply ? 'DRY_RUN' : 'APPLIED') : 'PROPOSED',
        classification,
        targetStatus: sectionTarget.status,
        operation,
        changeSummary: executed.changeSummary,
        themeState: executed.themeState,
        applyResult,
        repaired
    };
    instrumentation.logEditPipeline({ requestId, status: result.status, classification, targetStatus: sectionTarget.status, operationCount: 1, repaired, aiCallCount: resolutionAiCallCount + (repaired ? 2 : 1), durationMs: Date.now() - startTime });
    return result;
}

module.exports = {
    CREATE_SIGNAL_PHRASES,
    EDIT_VERBS,
    ADD_SIGNAL_VERBS,
    classifyRequest,
    buildAmbiguityQuestion,
    GENERIC_INTENT_WORDS,
    hasChangeDetails,
    buildProposalSystemPrompt,
    buildProposalUserPrompt,
    runOperationProposalStage,
    buildSectionListingAcrossTemplates,
    buildTargetResolutionSystemPrompt,
    buildTargetResolutionUserPrompt,
    validateTargetResolution,
    runTargetResolutionStage,
    runTargetedEdit
};
