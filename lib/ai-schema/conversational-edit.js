/**
 * Phase 9 — Conversational Editing / Multi-Turn Change Workflow.
 *
 * Wraps Phase 8's targeted-edit machinery (`edit-pipeline.js`, unmodified
 * except for two additive fields on its NEEDS_CLARIFICATION results — see
 * that file) with the ONE thing it never had: turn-to-turn memory (§4 of
 * AI_THEME_BUILDER_PHASE9_PLAN.md). This file adds no new mutation logic —
 * every branch below ends by calling one of `operations.js`'s existing
 * validate/execute functions or `edit-pipeline.js`'s existing
 * `runTargetedEdit()`/`runOperationProposalStage()`, exactly the same
 * "propose, then let untouched deterministic code decide" split Phase 8
 * already established.
 *
 * A turn is exactly one of:
 *   CANCEL               - clears pending edit context, mutates nothing
 *   INITIAL_GENERATION   - routed straight back to the caller; Phase 9 never
 *                          touches the initial-generation pipeline (§17)
 *   CLARIFICATION_ANSWER - resumes a pending question from THIS session
 *   FOLLOW_UP            - resolves a reference ("it", "the button", ...)
 *                          against the session's last resolved target
 *   NEW_REQUEST           - a fresh, self-contained targeted edit
 *
 * §20 — every branch scopes the AI proposal to the smallest relevant
 * context (the resolved target's current settings + its own schema),
 * exactly like edit-pipeline.js already does; a follow-up NEVER re-sends
 * the whole ThemeState or the full schema catalog.
 */

const instrumentation = require('./instrumentation');
const {
    SESSION_STATES,
    computeThemeStateVersion,
    createSession,
    saveSession,
    loadSession,
    resetSession,
    isCancelMessage,
    mergeClarificationAnswer
} = require('./conversation-session');
const { saveThemeState, loadThemeState, DEFAULT_THEME_ID } = require('./theme-state');
const {
    EDIT_VERBS,
    classifyRequest,
    buildAmbiguityQuestion,
    hasChangeDetails,
    runOperationProposalStage,
    runTargetedEdit
} = require('./edit-pipeline');
const {
    resolveSectionTarget,
    resolveBlockTarget,
    applyOperationToThemeState,
    validateOperationOrder,
    applyOperationsToThemeState,
    generateOperationId
} = require('./operations');
const { applyThemeState } = require('./apply');

// §25 — a small, deterministic ceiling on AI-proposed operations per turn.
// Exceeding it never triggers a bigger AI call; it's rejected before any AI
// call is made at all (§26 — "no automatic full redesign").
const MAX_OPERATIONS_PER_TURN = 3;

// ---------------------------------------------------------------------------
// §14 — a small, deterministic reference vocabulary. Generic references
// ("it"/"that"/"this"/"the same one") resolve to the session's single most
// recent target with no ambiguity check (there is only ever one "most
// recent"). Type-hinted references ("the button"/"the heading"/"the hero")
// must match the last target's own type, or a sibling block's type within
// the same section, before resolving — never guessed across an unrelated
// component.
// ---------------------------------------------------------------------------

const REFERENCE_PATTERNS = [
    { regex: /\bthe button\b/i, typeHint: 'button' },
    { regex: /\bthe heading\b/i, typeHint: 'heading' },
    { regex: /\bthe hero\b/i, typeHint: 'hero' },
    { regex: /\bthe section\b/i, typeHint: 'section' },
    { regex: /\bthe same one\b/i, typeHint: null },
    { regex: /\bit\b/i, typeHint: null },
    { regex: /\bthat\b/i, typeHint: null },
    { regex: /\bthis\b/i, typeHint: null }
];

function detectReference(message) {
    const lower = (message || '').toLowerCase();
    for (const pattern of REFERENCE_PATTERNS) {
        if (pattern.regex.test(lower)) return pattern;
    }
    return null;
}

function containsReferenceWord(message) {
    return !!detectReference(message);
}

// A small, deterministic "continuation" vocabulary, distinct from the
// reference vocabulary above: these words don't identify WHICH target, but
// signal "in addition to what I just asked for" (Scenario 3: "Make the text
// white too"), which resolveFollowUpReference() treats the same as a plain
// "it"/"that" reference — resolve to the single most recent target.
const CONTINUATION_MARKERS = [/\btoo\b/i, /\balso\b/i, /\bas well\b/i];

function containsContinuationMarker(message) {
    return CONTINUATION_MARKERS.some(pattern => pattern.test(message || ''));
}

/**
 * Resolves a follow-up reference against the session's active edit context.
 * Returns one of:
 *   { status: 'RESOLVED', target: {templateName, sectionId, type, blockId?, blockType?} }
 *   { status: 'AMBIGUOUS', candidates, kind: 'block', templateName, sectionId }
 *   { status: 'NOT_FOUND' }
 */
function resolveFollowUpReference(session, message, themeState) {
    const last = session.resolvedTarget;
    if (!last || !last.sectionId) return { status: 'NOT_FOUND' };

    const ref = detectReference(message);

    // No explicit reference word (a bare continuation marker like "too"
    // routes here too), or a generic one ("it"/"that"/"this"/"the same
    // one") — §14: only resolve against the single most recent target,
    // never broader semantic memory.
    if (!ref || !ref.typeHint) {
        return { status: 'RESOLVED', target: last };
    }

    if (ref.typeHint === 'section') {
        return { status: 'RESOLVED', target: { templateName: last.templateName, sectionId: last.sectionId, type: last.type } };
    }

    if (last.blockId && (last.blockType || '').toLowerCase().includes(ref.typeHint)) {
        return { status: 'RESOLVED', target: last };
    }
    if (!last.blockId && (last.type || '').toLowerCase().includes(ref.typeHint)) {
        return { status: 'RESOLVED', target: { templateName: last.templateName, sectionId: last.sectionId, type: last.type } };
    }

    const template = themeState.templates[last.templateName];
    const section = template && template.raw.sections[last.sectionId];
    if (!section) return { status: 'NOT_FOUND' };

    const candidates = Object.entries(section.blocks || {})
        .filter(([, block]) => (block.type || '').toLowerCase().includes(ref.typeHint))
        .map(([blockId, block]) => ({ blockId, type: block.type }));

    if (candidates.length === 1) {
        return {
            status: 'RESOLVED',
            target: { templateName: last.templateName, sectionId: last.sectionId, type: last.type, blockId: candidates[0].blockId, blockType: candidates[0].type }
        };
    }
    if (candidates.length > 1) {
        return { status: 'AMBIGUOUS', candidates, kind: 'block', templateName: last.templateName, sectionId: last.sectionId };
    }
    return { status: 'NOT_FOUND' };
}

// ---------------------------------------------------------------------------
// §16 — new request vs. follow-up. Deterministic: only falls back to AI
// classification signals edit-pipeline.js already computes (classifyRequest,
// resolveSectionTarget) — no new NLP.
// ---------------------------------------------------------------------------

function classifyTurn(session, message, themeState, schemas, templateName) {
    if (isCancelMessage(message)) return 'CANCEL';
    if (session.status === SESSION_STATES.NEEDS_CLARIFICATION && session.pendingClarification) {
        return 'CLARIFICATION_ANSWER';
    }

    const classification = classifyRequest(message);
    if (classification === 'INITIAL_GENERATION') return 'INITIAL_GENERATION';

    const hasActiveContext = !!(session.resolvedTarget && session.resolvedTarget.sectionId) && session.status !== SESSION_STATES.IDLE;
    if (!hasActiveContext) return 'NEW_REQUEST';

    if (containsReferenceWord(message) || containsContinuationMarker(message)) return 'FOLLOW_UP';

    // No explicit reference/continuation signal. Default to NEW_REQUEST
    // (§16 — "if uncertain, ask/start fresh", never silently overload an
    // unrelated target) UNLESS the message explicitly names the SAME
    // section the session is already on, which is still unambiguously a
    // continuation. Critically, this does NOT treat "names no section at
    // all" as a continuation signal — an unrelated new request very often
    // shares no keyword with the active target either (Scenario 4: "Change
    // the product page layout." after a hero edit), so a blank match must
    // default to NEW_REQUEST, not FOLLOW_UP.
    const probe = resolveSectionTarget(themeState, session.resolvedTarget.templateName || templateName, message, schemas);
    if (probe.status === 'RESOLVED' && probe.sectionId === session.resolvedTarget.sectionId) return 'FOLLOW_UP';
    return 'NEW_REQUEST';
}

// ---------------------------------------------------------------------------
// §24/§25 — bounded, deterministic multi-op clause splitting. Only treats a
// message as multiple operations when EVERY split part independently looks
// like its own edit request (contains an edit verb) — a single "and" inside
// one clause ("the black and white banner") must not be split.
// ---------------------------------------------------------------------------

function splitBoundedClauses(message) {
    const parts = message.split(/\s*;\s*|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
    if (parts.length <= 1) return [message];
    const eachHasVerb = parts.every(part => EDIT_VERBS.some(verb => new RegExp(`\\b${verb}\\b`, 'i').test(part)));
    return eachHasVerb ? parts : [message];
}

// §10/§11 — hasChangeDetails() (a resolved target alone isn't enough to
// propose an operation when the intent says nothing about WHAT changed) now
// lives in edit-pipeline.js, imported above — runTargetedEdit() itself
// applies the same check on a FIRST-pass resolution now too, not just this
// file's second-round clarification-answer path below.

// ---------------------------------------------------------------------------
// Target-context construction for an ALREADY-known target (skips
// resolveSectionTarget/resolveBlockTarget's keyword matching entirely — the
// identity is already known from a prior turn). Mirrors edit-pipeline.js's
// own targetContext shape exactly, so runOperationProposalStage() sees the
// identical shape regardless of which path resolved the target.
// ---------------------------------------------------------------------------

function buildTargetContextFromResolved(themeState, schemas, templateName, target) {
    const template = themeState.templates[templateName];
    const section = template && target.sectionId ? template.raw.sections[target.sectionId] : null;
    if (!section) return null;

    const sectionSchema = schemas.sectionSchemas.find(s => s.id === section.type);
    const targetContext = {
        sectionId: target.sectionId,
        type: section.type,
        currentSettings: section.settings || {},
        schemaSettings: sectionSchema ? sectionSchema.settings : {}
    };

    if (target.blockId) {
        const block = (section.blocks || {})[target.blockId];
        if (!block) return null;
        const blockSchema = schemas.blockSchemas.find(b => b.id === block.type);
        targetContext.block = {
            blockId: target.blockId,
            type: block.type,
            currentSettings: block.settings || {},
            schemaSettings: blockSchema ? blockSchema.settings : {}
        };
    }

    return targetContext;
}

/**
 * Derives a session's next `resolvedTarget` from a just-executed
 * changeSummary (§21 — always the POST-execution identity, since
 * add_section/add_block auto-generate their real id during execution, not
 * during proposal).
 */
function deriveResolvedTarget(changeSummary, executedThemeState) {
    if (!changeSummary || changeSummary.target === 'globalSettings') {
        return { templateName: null, sectionId: null, type: 'globalSettings' };
    }
    const [templateName, sectionId, blockId] = changeSummary.target.split('.');
    const template = executedThemeState.templates[templateName];
    const section = template ? template.raw.sections[sectionId] : null;
    const target = { templateName, sectionId, type: section ? section.type : null };
    if (blockId) {
        const block = section && section.blocks ? section.blocks[blockId] : null;
        target.blockId = blockId;
        target.blockType = block ? block.type : null;
    }
    return target;
}

// ---------------------------------------------------------------------------
// §12/§19 — ONE bounded AI proposal call (+ at most one repair, inside
// runOperationProposalStage() itself, unmodified) against an ALREADY-known
// target. This is edit-pipeline.js's runTargetedEdit() steps 5-8, minus the
// resolution step it doesn't need here — the one piece of orchestration glue
// Phase 8 didn't expose an entry point for (confirmed gap, §4).
// ---------------------------------------------------------------------------

async function proposeAndExecuteForTarget(userPrompt, targetContext, ctx) {
    const { templateName, themeState, schemas, knownMerchantData = {}, requestId, autoApply, themeRoot, dryRunApply } = ctx;

    const { operation, validation, repaired } = await runOperationProposalStage({
        userPrompt, templateName, targetContext, candidatePool: null, themeState, schemas, knownMerchantData, requestId
    });

    if (!validation.valid) {
        return { status: 'FAILED', errors: validation.errors, operation, repaired };
    }

    const executed = applyOperationToThemeState(themeState, operation, { themeState, schemas, knownMerchantData, requestId });
    if (!executed.valid) {
        return { status: 'FAILED', errors: executed.errors, operation, repaired };
    }

    let applyResult = null;
    if (autoApply) {
        const changedTemplates = operation.operation === 'update_global_settings' ? [] : [operation.target.templateName];
        applyResult = await applyThemeState(executed.themeState, {
            themeRoot, changedTemplates, writeGlobalSettings: operation.operation === 'update_global_settings', dryRun: dryRunApply, requestId
        });
    }

    return {
        status: autoApply ? (dryRunApply ? 'DRY_RUN' : 'APPLIED') : 'PROPOSED',
        operation, changeSummary: executed.changeSummary, themeState: executed.themeState, applyResult, repaired
    };
}

// ---------------------------------------------------------------------------
// §24 — bounded multi-operation proposal: one resolution + one bounded
// proposal call PER CLAUSE, but nothing is executed until every clause has
// produced a validated operation. Only then does the whole batch go through
// operations.js's existing atomic runner (validateOperationOrder() +
// applyOperationsToThemeState(), both unmodified) — a failure on any clause
// leaves the ORIGINAL ThemeState completely untouched.
// ---------------------------------------------------------------------------

async function runMultiOperationTurn(clauses, session, ctx) {
    const { themeState, schemas, templateName, knownMerchantData = {}, requestId } = ctx;
    const operations = [];
    let aiCallCount = 0;
    let anyRepaired = false;

    for (const clause of clauses) {
        const sectionTarget = resolveSectionTarget(themeState, templateName, clause, schemas);
        if (sectionTarget.status !== 'RESOLVED') {
            return { status: 'FAILED', errors: [{ code: 'OPERATION_TARGET_NOT_FOUND', path: 'operations', message: `Could not resolve an existing target for: "${clause}"` }] };
        }
        const sectionSchema = schemas.sectionSchemas.find(s => s.id === sectionTarget.section.type);
        const targetContext = {
            sectionId: sectionTarget.sectionId,
            type: sectionTarget.section.type,
            currentSettings: sectionTarget.section.settings || {},
            schemaSettings: sectionSchema ? sectionSchema.settings : {}
        };
        const blockTarget = resolveBlockTarget(sectionTarget.section, clause, schemas);
        if (blockTarget.status === 'RESOLVED') {
            const blockSchema = schemas.blockSchemas.find(b => b.id === blockTarget.block.type);
            targetContext.block = {
                blockId: blockTarget.blockId, type: blockTarget.block.type,
                currentSettings: blockTarget.block.settings || {}, schemaSettings: blockSchema ? blockSchema.settings : {}
            };
        }

        const { operation, validation, repaired } = await runOperationProposalStage({
            userPrompt: clause, templateName, targetContext, candidatePool: null, themeState, schemas, knownMerchantData, requestId
        });
        aiCallCount += repaired ? 2 : 1;
        anyRepaired = anyRepaired || repaired;
        if (!validation.valid) {
            return { status: 'FAILED', errors: validation.errors, aiCallCount, repaired: anyRepaired };
        }
        operations.push(operation);
    }

    const orderErrors = validateOperationOrder(operations);
    if (orderErrors.length > 0) {
        return { status: 'FAILED', errors: orderErrors, aiCallCount, repaired: anyRepaired };
    }

    const executed = applyOperationsToThemeState(themeState, operations, { themeState, schemas, knownMerchantData, requestId });
    if (!executed.valid) {
        return { status: 'FAILED', errors: executed.errors, aiCallCount, repaired: anyRepaired };
    }

    let applyResult = null;
    if (ctx.autoApply) {
        const changedTemplates = [...new Set(operations.filter(o => o.operation !== 'update_global_settings').map(o => o.target.templateName))];
        const writeGlobalSettings = operations.some(o => o.operation === 'update_global_settings');
        applyResult = await applyThemeState(executed.themeState, { themeRoot: ctx.themeRoot, changedTemplates, writeGlobalSettings, dryRun: ctx.dryRunApply, requestId });
    }

    return {
        status: ctx.autoApply ? (ctx.dryRunApply ? 'DRY_RUN' : 'APPLIED') : 'PROPOSED',
        operations, changeSummaries: executed.changeSummaries, themeState: executed.themeState, applyResult,
        aiCallCount, repaired: anyRepaired
    };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * options:
 *   - sessionId: string. Omitted -> a new session is created.
 *   - themeId: default 'default' (theme-state.js's DEFAULT_THEME_ID).
 *   - themeState: a Phase 4 ThemeState for THIS turn. If omitted, the last
 *     ThemeState this session successfully saved (via saveThemeState(),
 *     theme-state.js) is loaded — §21, "the next user message must use the
 *     updated state."
 *   - schemas: REQUIRED, the full AI schema catalog.
 *   - templateName: default 'index', used only when no active target exists
 *     yet.
 *   - knownMerchantData / autoApply / themeRoot / dryRunApply: forwarded
 *     exactly as edit-pipeline.js's runTargetedEdit() already accepts them.
 */
async function runConversationalEdit(message, options = {}) {
    const {
        sessionId: inputSessionId,
        themeId = DEFAULT_THEME_ID,
        schemas,
        templateName: optionsTemplateName = 'index',
        knownMerchantData = {},
        autoApply = false,
        themeRoot,
        dryRunApply = false,
        requestId = instrumentation.nextRequestId('conversation')
    } = options;

    if (!schemas || !Array.isArray(schemas.sectionSchemas)) {
        throw new Error('runConversationalEdit() requires the full AI schema catalog');
    }
    if (!message || typeof message !== 'string' || !message.trim()) {
        throw new Error('runConversationalEdit() requires a non-empty message');
    }

    const startTime = Date.now();
    let session = inputSessionId ? await loadSession(inputSessionId) : null;
    if (!session) session = createSession({ sessionId: inputSessionId, themeId });

    let themeState = options.themeState;
    if (!themeState) {
        themeState = await loadThemeState(session.themeId);
        if (!themeState) {
            throw new Error('runConversationalEdit() requires a themeState — none was provided and none was previously saved for this session');
        }
    }

    const currentVersion = computeThemeStateVersion(themeState);

    // §22/§23 — stale editing context: the ThemeState changed since this
    // session last saw it. Re-resolve from scratch rather than trusting a
    // target that may no longer exist, instead of blindly reusing it.
    let staleContextDetected = false;
    if (session.themeStateVersion && session.themeStateVersion !== currentVersion) {
        staleContextDetected = true;
        session = { ...session, resolvedTarget: null, lastOperation: null, pendingClarification: null, pendingQuestion: null, status: SESSION_STATES.IDLE };
    }

    // §31 — idempotency: an EXACT repeat of the last message against an
    // unchanged ThemeState (e.g. a caller retry after a transport failure)
    // is treated as already-applied rather than re-executed.
    if (!staleContextDetected && session.status === SESSION_STATES.COMPLETED && session.lastMessage === message && session.themeStateVersion === currentVersion) {
        return {
            status: session.lastResultStatus || 'COMPLETED',
            sessionId: session.sessionId,
            idempotent: true,
            operation: session.lastOperation,
            changeSummary: session.lastChangeSummary,
            themeState
        };
    }

    session = { ...session, turnCount: session.turnCount + 1 };

    const activeTemplateName = (session.resolvedTarget && session.resolvedTarget.templateName) || optionsTemplateName;
    const turnType = classifyTurn(session, message, themeState, schemas, activeTemplateName);
    const ctx = { themeState, schemas, templateName: activeTemplateName, knownMerchantData, autoApply, themeRoot, dryRunApply, requestId };

    // `resultStatus` is always a SESSION_STATES value (drives classifyTurn()
    // on the NEXT turn); `extra.turnStatus`, when present, is the
    // finer-grained outcome the CALLER actually needs (PROPOSED/APPLIED/
    // DRY_RUN — Phase 8's own distinctions, preserved exactly) and is what's
    // returned as `status` instead. A COMPLETED session can still mean three
    // different things happened this turn; the session machine only needs
    // to know it finished successfully.
    async function finish(partialSession, resultStatus, extra = {}) {
        const { turnStatus, ...publicExtra } = extra;
        const returnedStatus = turnStatus || resultStatus;
        const finalSession = { ...partialSession, status: resultStatus, lastMessage: message, lastResultStatus: returnedStatus };
        await saveSession(finalSession);
        instrumentation.logConversationTurn({
            requestId, sessionId: finalSession.sessionId, turnCount: finalSession.turnCount,
            turnType, status: returnedStatus,
            clarificationCount: finalSession.pendingClarification ? 1 : 0,
            targetResolution: finalSession.resolvedTarget ? 'RESOLVED' : null,
            aiCallCount: extra.aiCallCount || 0, repaired: !!extra.repaired,
            operationCount: extra.operationCount || (extra.operation ? 1 : 0) || (extra.operations ? extra.operations.length : 0),
            operationTypes: extra.operationTypes || (extra.operation ? [extra.operation.operation] : (extra.operations || []).map(o => o.operation)),
            themeStateVersion: finalSession.themeStateVersion, durationMs: Date.now() - startTime
        });
        return { status: returnedStatus, sessionId: finalSession.sessionId, ...publicExtra };
    }

    // A NEEDS_CLARIFICATION/FAILED turn never mutates themeState, so nothing
    // upstream would otherwise persist it — but the NEXT turn (a
    // CLARIFICATION_ANSWER, or a fresh retry) still calls loadThemeState()
    // whenever this session isn't given a fresh one explicitly, and that
    // reads back whatever the LAST *successful* apply — for this themeId,
    // from ANY session — happened to leave on disk (or nothing at all).
    // Without re-persisting the exact ThemeState this turn resolved
    // against, a clarification answer can silently resolve against a
    // stale/unrelated snapshot instead of the one the question was actually
    // asked about (e.g. producing a correct-looking "Which section?" list
    // that doesn't match what a following turn actually sees).
    async function persistUnmutatedThemeState() {
        await saveThemeState({ ...themeState, themeId: session.themeId });
    }

    async function handleSingleTurnResult(result, resultSession) {
        if (result.status === 'AMBIGUOUS') {
            await persistUnmutatedThemeState();
            const pendingClarification = { kind: 'intent' };
            return finish({ ...resultSession, pendingClarification, pendingQuestion: 'What would you like to change?', themeStateVersion: currentVersion }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: ['What would you like to change?'] });
        }
        if (result.status === 'NEEDS_CLARIFICATION') {
            await persistUnmutatedThemeState();
            if (!result.candidates || result.candidates.length === 0) {
                // No fixed candidate list to match the answer against (e.g.
                // edit-pipeline.js's AI-assisted target resolution asking its
                // OWN open-ended question) — merge the answer into the
                // original intent and let resolution run again next turn,
                // same as a classification-level AMBIGUOUS turn already does,
                // rather than routing to mergeClarificationAnswer() which
                // requires real candidates to match against.
                const pendingClarification = { kind: 'intent' };
                return finish({ ...resultSession, pendingClarification, pendingQuestion: result.questions[0], themeStateVersion: currentVersion }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: result.questions });
            }
            const kind = result.candidates[0] && 'blockId' in result.candidates[0] ? 'block' : 'section';
            const pendingClarification = { kind, candidates: result.candidates, templateName: result.templateName || ctx.templateName, sectionId: result.sectionId || null, questions: result.questions };
            return finish({ ...resultSession, pendingClarification, pendingQuestion: result.questions[0], themeStateVersion: currentVersion }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: result.questions, candidates: result.candidates });
        }
        if (result.status === 'FAILED') {
            await persistUnmutatedThemeState();
            return finish({ ...resultSession, themeStateVersion: currentVersion }, SESSION_STATES.FAILED, { errors: result.errors, operation: result.operation, repaired: result.repaired });
        }
        // PROPOSED / APPLIED / DRY_RUN — saved keyed by THIS SESSION's
        // themeId, never whatever `.themeId` the input ThemeState object
        // happened to carry (saveThemeState()/loadThemeState() are keyed by
        // that field; a mismatch would silently save to one file and load
        // from another on the next turn).
        await saveThemeState({ ...result.themeState, themeId: resultSession.themeId });
        const updatedSession = {
            ...resultSession,
            currentIntent: null, pendingClarification: null, pendingQuestion: null,
            resolvedTarget: deriveResolvedTarget(result.changeSummary, result.themeState),
            lastOperation: { ...result.operation, id: generateOperationId(result.operation) },
            lastChangeSummary: result.changeSummary,
            themeStateVersion: computeThemeStateVersion(result.themeState)
        };
        return finish(updatedSession, SESSION_STATES.COMPLETED, {
            turnStatus: result.status, // PROPOSED | APPLIED | DRY_RUN
            operation: result.operation, changeSummary: result.changeSummary,
            themeState: result.themeState, applyResult: result.applyResult, repaired: result.repaired
        });
    }

    async function handleMultiTurnResult(result, resultSession) {
        if (result.status === 'FAILED') {
            await persistUnmutatedThemeState();
            return finish({ ...resultSession, themeStateVersion: currentVersion }, SESSION_STATES.FAILED, { errors: result.errors, aiCallCount: result.aiCallCount, repaired: result.repaired });
        }
        await saveThemeState({ ...result.themeState, themeId: resultSession.themeId });
        const lastSummary = result.changeSummaries[result.changeSummaries.length - 1];
        const lastOp = result.operations[result.operations.length - 1];
        const updatedSession = {
            ...resultSession,
            currentIntent: null, pendingClarification: null, pendingQuestion: null,
            resolvedTarget: deriveResolvedTarget(lastSummary, result.themeState),
            lastOperation: { ...lastOp, id: generateOperationId(lastOp) },
            lastChangeSummary: lastSummary,
            themeStateVersion: computeThemeStateVersion(result.themeState)
        };
        return finish(updatedSession, SESSION_STATES.COMPLETED, {
            turnStatus: result.status, // PROPOSED | APPLIED | DRY_RUN
            operations: result.operations, changeSummaries: result.changeSummaries,
            themeState: result.themeState, applyResult: result.applyResult, aiCallCount: result.aiCallCount, repaired: result.repaired
        });
    }

    // -----------------------------------------------------------------------
    if (turnType === 'CANCEL') {
        return finish(resetSession(session), SESSION_STATES.IDLE, { message: "Okay — I've cleared that." });
    }

    if (turnType === 'INITIAL_GENERATION') {
        return finish(session, 'INITIAL_GENERATION', {});
    }

    if (turnType === 'CLARIFICATION_ANSWER') {
        const pending = session.pendingClarification;

        if (pending.kind === 'intent') {
            // §7/§8 — the original intent survives clarification; the
            // answer is MERGED into it, never treated as an unrelated
            // fresh request.
            const mergedMessage = `${session.currentIntent} ${message}`.trim();
            const result = await runTargetedEdit(mergedMessage, ctx);
            return handleSingleTurnResult(result, { ...session, currentIntent: mergedMessage });
        }

        if (pending.kind === 'value') {
            // §9/§10 — second-round answer to "what would you like to
            // change?" against an ALREADY-resolved target (§9's exact
            // "resolvedTarget = announcement banner; change = text color"
            // example) — never re-resolved from scratch, which could
            // re-trigger the same target ambiguity this session already
            // answered.
            const mergedMessage = `${session.currentIntent} ${message}`.trim();
            const targetContext = buildTargetContextFromResolved(themeState, schemas, pending.templateName, pending.target);
            if (!targetContext) {
                const question = "That target doesn't exist anymore — what would you like to change?";
                return finish({ ...session, currentIntent: mergedMessage, pendingClarification: { kind: 'intent' }, pendingQuestion: question }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: [question] });
            }
            const result = await proposeAndExecuteForTarget(mergedMessage, targetContext, { ...ctx, templateName: pending.templateName });
            return handleSingleTurnResult(result, { ...session, currentIntent: mergedMessage });
        }

        // kind === 'section' | 'block' — first-round answer resolving WHICH
        // target the merchant meant.
        const merge = mergeClarificationAnswer(pending, message);
        if (!merge.resolved) {
            const question = (pending.questions && pending.questions[0]) || `Which ${pending.kind} did you mean?`;
            return finish({ ...session, pendingQuestion: question }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: [question], candidates: pending.candidates });
        }

        const target = {
            templateName: pending.templateName,
            sectionId: pending.kind === 'block' ? pending.sectionId : merge.match.sectionId,
            blockId: pending.kind === 'block' ? merge.match.blockId : undefined
        };
        const targetContext = buildTargetContextFromResolved(themeState, schemas, pending.templateName, target);
        if (!targetContext) {
            const question = "That target doesn't exist anymore — what would you like to change?";
            return finish({ ...session, currentIntent: message, pendingClarification: { kind: 'intent' }, pendingQuestion: question }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: [question] });
        }
        target.type = targetContext.type;
        if (targetContext.block) target.blockType = targetContext.block.type;

        if (!hasChangeDetails(session.currentIntent, target)) {
            const question = 'What would you like to change?';
            const valueClarification = { kind: 'value', target, templateName: pending.templateName, questions: [question] };
            return finish({ ...session, resolvedTarget: target, pendingClarification: valueClarification, pendingQuestion: question }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: [question] });
        }

        const result = await proposeAndExecuteForTarget(session.currentIntent, targetContext, { ...ctx, templateName: pending.templateName });
        return handleSingleTurnResult(result, session);
    }

    if (turnType === 'FOLLOW_UP') {
        const resolution = resolveFollowUpReference(session, message, themeState);
        if (resolution.status === 'AMBIGUOUS') {
            const questions = [buildAmbiguityQuestion(resolution.candidates, resolution.kind)];
            const pendingClarification = { kind: resolution.kind, candidates: resolution.candidates, templateName: resolution.templateName, sectionId: resolution.sectionId, questions };
            return finish({ ...session, currentIntent: message, pendingClarification, pendingQuestion: questions[0] }, SESSION_STATES.NEEDS_CLARIFICATION, { questions, candidates: resolution.candidates });
        }
        if (resolution.status !== 'RESOLVED') {
            const question = 'What would you like to change?';
            return finish({ ...session, currentIntent: message, pendingClarification: { kind: 'intent' }, pendingQuestion: question }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: [question] });
        }
        const targetContext = buildTargetContextFromResolved(themeState, schemas, resolution.target.templateName, resolution.target);
        if (!targetContext) {
            const question = "That target doesn't exist anymore — what would you like to change?";
            return finish({ ...session, currentIntent: message, pendingClarification: { kind: 'intent' }, pendingQuestion: question }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: [question] });
        }
        const result = await proposeAndExecuteForTarget(message, targetContext, { ...ctx, templateName: resolution.target.templateName });
        return handleSingleTurnResult(result, session);
    }

    // NEW_REQUEST
    const clauses = splitBoundedClauses(message);
    if (clauses.length > 1) {
        if (clauses.length > MAX_OPERATIONS_PER_TURN) {
            return finish(session, 'TOO_MANY_OPERATIONS', { message: "That includes several changes. Let's handle them in smaller steps." });
        }
        const result = await runMultiOperationTurn(clauses, session, ctx);
        return handleMultiTurnResult(result, { ...session, currentIntent: message });
    }

    const result = await runTargetedEdit(message, ctx);
    return handleSingleTurnResult(result, { ...session, currentIntent: message });
}

module.exports = {
    MAX_OPERATIONS_PER_TURN,
    detectReference,
    containsReferenceWord,
    containsContinuationMarker,
    resolveFollowUpReference,
    classifyTurn,
    splitBoundedClauses,
    buildTargetContextFromResolved,
    deriveResolvedTarget,
    proposeAndExecuteForTarget,
    runMultiOperationTurn,
    runConversationalEdit
};
