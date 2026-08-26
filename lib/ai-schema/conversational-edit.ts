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

import * as instrumentation from "./instrumentation";
import {
    SESSION_STATES,
    computeThemeStateVersion,
    createSession,
    saveSession,
    loadSession,
    resetSession,
    isCancelMessage,
    mergeClarificationAnswer
} from "./conversation-session";
import { DEFAULT_THEME_ID } from "./theme-state";
import {
    EDIT_VERBS,
    classifyRequest,
    buildAmbiguityQuestion,
    buildClarificationRetryQuestion,
    hasChangeDetails,
    runOperationProposalStage,
    runTargetedEdit,
    buildTargetSummary,
    extractSectionTextPreview
} from "./edit-pipeline";
import {
    resolveSectionTarget,
    resolveBlockTarget,
    applyOperationToThemeState,
    validateOperationOrder,
    applyOperationsToThemeState,
    generateOperationId
} from "./operations";
// apply.js stays plain CommonJS (out of scope — Shopify-facing apply path);
// esModuleInterop lets this named import work against its `module.exports`.
import { applyThemeState } from "./apply";
import type {
    ChangeSummary,
    EditTurnResult,
    KnownMerchantData,
    Operation,
    PendingClarification,
    ResolvedTarget,
    SchemaCatalog,
    Session,
    TargetContext,
    ThemeState
} from "./types";

// §25 — a small, deterministic ceiling on AI-proposed operations per turn.
// Exceeding it never triggers a bigger AI call; it's rejected before any AI
// call is made at all (§26 — "no automatic full redesign").
export const MAX_OPERATIONS_PER_TURN = 3;

// ---------------------------------------------------------------------------
// §14 — a small, deterministic reference vocabulary. Generic references
// ("it"/"that"/"this"/"the same one") resolve to the session's single most
// recent target with no ambiguity check (there is only ever one "most
// recent"). Type-hinted references ("the button"/"the heading"/"the hero")
// must match the last target's own type, or a sibling block's type within
// the same section, before resolving — never guessed across an unrelated
// component.
// ---------------------------------------------------------------------------

interface ReferencePattern {
    regex: RegExp;
    typeHint: string | null;
}

const REFERENCE_PATTERNS: ReferencePattern[] = [
    { regex: /\bthe button\b/i, typeHint: "button" },
    { regex: /\bthe heading\b/i, typeHint: "heading" },
    { regex: /\bthe hero\b/i, typeHint: "hero" },
    { regex: /\bthe section\b/i, typeHint: "section" },
    { regex: /\bthe same one\b/i, typeHint: null },
    { regex: /\bit\b/i, typeHint: null },
    { regex: /\bthat\b/i, typeHint: null },
    { regex: /\bthis\b/i, typeHint: null }
];

export function detectReference(message: string | undefined): ReferencePattern | null {
    const lower = (message || "").toLowerCase();
    for (const pattern of REFERENCE_PATTERNS) {
        if (pattern.regex.test(lower)) return pattern;
    }
    return null;
}

export function containsReferenceWord(message: string | undefined): boolean {
    return !!detectReference(message);
}

// A small, deterministic "continuation" vocabulary, distinct from the
// reference vocabulary above: these words don't identify WHICH target, but
// signal "in addition to what I just asked for" (Scenario 3: "Make the text
// white too"), which resolveFollowUpReference() treats the same as a plain
// "it"/"that" reference — resolve to the single most recent target.
const CONTINUATION_MARKERS = [/\btoo\b/i, /\balso\b/i, /\bas well\b/i];

export function containsContinuationMarker(message: string | undefined): boolean {
    return CONTINUATION_MARKERS.some(pattern => pattern.test(message || ""));
}

type FollowUpResolution =
    | { status: "RESOLVED"; target: ResolvedTarget }
    | { status: "AMBIGUOUS"; candidates: Array<{ blockId: string; type: string | undefined }>; kind: "block"; templateName: string | null; sectionId: string | null }
    | { status: "NOT_FOUND" };

/**
 * Resolves a follow-up reference against the session's active edit context.
 * Returns one of:
 *   { status: 'RESOLVED', target: {templateName, sectionId, type, blockId?, blockType?} }
 *   { status: 'AMBIGUOUS', candidates, kind: 'block', templateName, sectionId }
 *   { status: 'NOT_FOUND' }
 */
export function resolveFollowUpReference(session: Session, message: string | undefined, themeState: ThemeState): FollowUpResolution {
    const last = session.resolvedTarget;
    if (!last || !last.sectionId) return { status: "NOT_FOUND" };

    const ref = detectReference(message);

    // No explicit reference word (a bare continuation marker like "too"
    // routes here too), or a generic one ("it"/"that"/"this"/"the same
    // one") — §14: only resolve against the single most recent target,
    // never broader semantic memory.
    if (!ref || !ref.typeHint) {
        return { status: "RESOLVED", target: last };
    }

    if (ref.typeHint === "section") {
        return { status: "RESOLVED", target: { templateName: last.templateName, sectionId: last.sectionId, type: last.type } };
    }

    if (last.blockId && (last.blockType || "").toLowerCase().includes(ref.typeHint)) {
        return { status: "RESOLVED", target: last };
    }
    if (!last.blockId && (last.type || "").toLowerCase().includes(ref.typeHint)) {
        return { status: "RESOLVED", target: { templateName: last.templateName, sectionId: last.sectionId, type: last.type } };
    }

    const template = last.templateName ? themeState.templates[last.templateName] : undefined;
    const section = template && last.sectionId ? template.raw.sections[last.sectionId] : null;
    if (!section) return { status: "NOT_FOUND" };

    const candidates = Object.entries(section.blocks || {})
        .filter(([, block]) => (block.type || "").toLowerCase().includes(ref.typeHint!))
        .map(([blockId, block]) => ({ blockId, type: block.type }));

    if (candidates.length === 1) {
        return {
            status: "RESOLVED",
            target: { templateName: last.templateName, sectionId: last.sectionId, type: last.type, blockId: candidates[0].blockId, blockType: candidates[0].type }
        };
    }
    if (candidates.length > 1) {
        return { status: "AMBIGUOUS", candidates, kind: "block", templateName: last.templateName, sectionId: last.sectionId };
    }
    return { status: "NOT_FOUND" };
}

// ---------------------------------------------------------------------------
// §16 — new request vs. follow-up. Deterministic: only falls back to AI
// classification signals edit-pipeline.js already computes (classifyRequest,
// resolveSectionTarget) — no new NLP.
// ---------------------------------------------------------------------------

export function classifyTurn(session: Session, message: string, themeState: ThemeState, schemas: SchemaCatalog, templateName: string): string {
    if (isCancelMessage(message)) return "CANCEL";
    if (session.status === SESSION_STATES.NEEDS_CLARIFICATION && session.pendingClarification) {
        return "CLARIFICATION_ANSWER";
    }

    const classification = classifyRequest(message);
    if (classification === "INITIAL_GENERATION") return "INITIAL_GENERATION";

    const hasActiveContext = !!(session.resolvedTarget && session.resolvedTarget.sectionId) && session.status !== SESSION_STATES.IDLE;
    if (!hasActiveContext) return "NEW_REQUEST";

    if (containsReferenceWord(message) || containsContinuationMarker(message)) return "FOLLOW_UP";

    // No explicit reference/continuation signal. Default to NEW_REQUEST
    // (§16 — "if uncertain, ask/start fresh", never silently overload an
    // unrelated target) UNLESS the message explicitly names the SAME
    // section the session is already on, which is still unambiguously a
    // continuation. Critically, this does NOT treat "names no section at
    // all" as a continuation signal — an unrelated new request very often
    // shares no keyword with the active target either (Scenario 4: "Change
    // the product page layout." after a hero edit), so a blank match must
    // default to NEW_REQUEST, not FOLLOW_UP.
    const probe = resolveSectionTarget(themeState, session.resolvedTarget!.templateName || templateName, message, schemas);
    if (probe.status === "RESOLVED" && probe.sectionId === session.resolvedTarget!.sectionId) return "FOLLOW_UP";
    return "NEW_REQUEST";
}

// ---------------------------------------------------------------------------
// §24/§25 — bounded, deterministic multi-op clause splitting. Only treats a
// message as multiple operations when EVERY split part independently looks
// like its own edit request (contains an edit verb) — a single "and" inside
// one clause ("the black and white banner") must not be split.
// ---------------------------------------------------------------------------

export function splitBoundedClauses(message: string): string[] {
    const parts = message.split(/\s*;\s*|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
    if (parts.length <= 1) return [message];
    const eachHasVerb = parts.every(part => EDIT_VERBS.some(verb => new RegExp(`\\b${verb}\\b`, "i").test(part)));
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

export function buildTargetContextFromResolved(themeState: ThemeState, schemas: SchemaCatalog, templateName: string | null, target: ResolvedTarget): TargetContext | null {
    const template = templateName ? themeState.templates[templateName] : undefined;
    const section = template && target.sectionId ? template.raw.sections[target.sectionId] : null;
    if (!section) return null;

    const sectionSchema = schemas.sectionSchemas.find(s => s.id === section.type);
    const targetContext: TargetContext = {
        sectionId: target.sectionId!,
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
export function deriveResolvedTarget(changeSummary: ChangeSummary | null | undefined, executedThemeState: ThemeState): ResolvedTarget {
    if (!changeSummary || changeSummary.target === "globalSettings") {
        return { templateName: null, sectionId: null, type: "globalSettings" };
    }
    const [templateName, sectionId, blockId] = changeSummary.target.split(".");
    const template = executedThemeState.templates[templateName];
    const section = template ? template.raw.sections[sectionId] : null;
    const target: ResolvedTarget = { templateName, sectionId, type: section ? section.type : null };
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

interface TurnContext {
    templateName: string;
    themeState: ThemeState;
    schemas: SchemaCatalog;
    knownMerchantData?: KnownMerchantData;
    requestId: string;
    autoApply?: boolean;
    themeRoot?: string;
    dryRunApply?: boolean;
}

export async function proposeAndExecuteForTarget(userPrompt: string, targetContext: TargetContext, ctx: TurnContext): Promise<EditTurnResult> {
    const { templateName, themeState, schemas, knownMerchantData = {}, requestId, autoApply, themeRoot, dryRunApply } = ctx;

    const { operation, validation, repaired } = await runOperationProposalStage({
        userPrompt, templateName, targetContext, candidatePool: null, themeState, schemas, knownMerchantData, requestId
    });

    if (!validation.valid) {
        return { status: "FAILED", errors: validation.errors, operation: operation ?? undefined, repaired };
    }

    const executed = applyOperationToThemeState(themeState, operation!, { themeState, schemas, knownMerchantData, requestId });
    if (!executed.valid) {
        return { status: "FAILED", errors: executed.errors, operation: operation ?? undefined, repaired };
    }

    let applyResult: unknown = null;
    if (autoApply) {
        const changedTemplates = operation!.operation === "update_global_settings" ? [] : [operation!.target!.templateName!];
        applyResult = await applyThemeState(executed.themeState, {
            themeRoot, changedTemplates, writeGlobalSettings: operation!.operation === "update_global_settings", dryRun: dryRunApply, requestId
        });
    }

    return {
        status: autoApply ? (dryRunApply ? "DRY_RUN" : "APPLIED") : "PROPOSED",
        operation: operation!, changeSummary: executed.changeSummary,
        targetSummary: buildTargetSummary(executed.themeState!, executed.changeSummary),
        themeState: executed.themeState!, applyResult, repaired
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

export async function runMultiOperationTurn(clauses: string[], session: Session, ctx: TurnContext): Promise<EditTurnResult> {
    const { themeState, schemas, templateName, knownMerchantData = {}, requestId } = ctx;
    void session;
    const operations: Operation[] = [];
    let aiCallCount = 0;
    let anyRepaired = false;

    for (const clause of clauses) {
        const sectionTarget = resolveSectionTarget(themeState, templateName, clause, schemas);
        if (sectionTarget.status !== "RESOLVED") {
            return { status: "FAILED", errors: [{ code: "OPERATION_TARGET_NOT_FOUND", path: "operations", message: `Could not resolve an existing target for: "${clause}"` }] };
        }
        const sectionSchema = schemas.sectionSchemas.find(s => s.id === sectionTarget.section.type);
        const targetContext: TargetContext = {
            sectionId: sectionTarget.sectionId,
            type: sectionTarget.section.type,
            currentSettings: sectionTarget.section.settings || {},
            schemaSettings: sectionSchema ? sectionSchema.settings : {}
        };
        const blockTarget = resolveBlockTarget(sectionTarget.section, clause, schemas);
        if (blockTarget.status === "RESOLVED") {
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
            return { status: "FAILED", errors: validation.errors, aiCallCount, repaired: anyRepaired };
        }
        operations.push(operation!);
    }

    const orderErrors = validateOperationOrder(operations);
    if (orderErrors.length > 0) {
        return { status: "FAILED", errors: orderErrors, aiCallCount, repaired: anyRepaired };
    }

    const executed = applyOperationsToThemeState(themeState, operations, { themeState, schemas, knownMerchantData, requestId });
    if (!executed.valid) {
        return { status: "FAILED", errors: executed.errors, aiCallCount, repaired: anyRepaired };
    }

    let applyResult: unknown = null;
    if (ctx.autoApply) {
        const changedTemplates = [...new Set(operations.filter(o => o.operation !== "update_global_settings").map(o => o.target!.templateName!))];
        const writeGlobalSettings = operations.some(o => o.operation === "update_global_settings");
        applyResult = await applyThemeState(executed.themeState, { themeRoot: ctx.themeRoot, changedTemplates, writeGlobalSettings, dryRun: ctx.dryRunApply, requestId });
    }

    return {
        status: ctx.autoApply ? (ctx.dryRunApply ? "DRY_RUN" : "APPLIED") : "PROPOSED",
        operations, changeSummaries: executed.changeSummaries,
        targetSummaries: executed.changeSummaries.map(cs => buildTargetSummary(executed.themeState!, cs)).filter((t): t is NonNullable<typeof t> => t !== null),
        themeState: executed.themeState!, applyResult,
        aiCallCount, repaired: anyRepaired
    };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface RunConversationalEditOptions {
    sessionId?: string;
    themeId?: string;
    /**
     * REQUIRED. The theme's real files on disk are the single source of
     * truth for the current live theme (see theme-state.ts's
     * buildThemeState) — this file no longer has any fallback that loads a
     * cached ThemeState instead, so every caller must build a fresh one
     * (buildThemeState()) and pass it in for EVERY turn, not just the first.
     * Passing a ThemeState left over from an earlier turn/request risks
     * reintroducing the exact staleness bug this design removed: an edit
     * silently applied against content that no longer matches the real
     * files.
     */
    themeState: ThemeState;
    schemas: SchemaCatalog;
    templateName?: string;
    knownMerchantData?: KnownMerchantData;
    autoApply?: boolean;
    themeRoot?: string;
    dryRunApply?: boolean;
    requestId?: string;
}

export interface ConversationalEditResult {
    status: string;
    sessionId: string;
    [key: string]: unknown;
}

/**
 * options:
 *   - sessionId: string. Omitted -> a new session is created.
 *   - themeId: default 'default' (theme-state.js's DEFAULT_THEME_ID).
 *   - themeState: REQUIRED — a Phase 4 ThemeState freshly rebuilt from the
 *     real theme files on disk for THIS turn (see the interface doc above).
 *   - schemas: REQUIRED, the full AI schema catalog.
 *   - templateName: default 'index', used only when no active target exists
 *     yet.
 *   - knownMerchantData / autoApply / themeRoot / dryRunApply: forwarded
 *     exactly as edit-pipeline.js's runTargetedEdit() already accepts them.
 */
export async function runConversationalEdit(message: string, options: RunConversationalEditOptions): Promise<ConversationalEditResult> {
    const {
        sessionId: inputSessionId,
        themeId = DEFAULT_THEME_ID,
        schemas,
        templateName: optionsTemplateName = "index",
        knownMerchantData = {},
        autoApply = false,
        themeRoot,
        dryRunApply = false,
        requestId = instrumentation.nextRequestId("conversation")
    } = options;

    if (!schemas || !Array.isArray(schemas.sectionSchemas)) {
        throw new Error("runConversationalEdit() requires the full AI schema catalog");
    }
    if (!message || typeof message !== "string" || !message.trim()) {
        throw new Error("runConversationalEdit() requires a non-empty message");
    }

    const startTime = Date.now();
    let session = inputSessionId ? await loadSession(inputSessionId) : null;
    if (!session) session = createSession({ sessionId: inputSessionId, themeId });

    const { themeState } = options;
    if (!themeState) {
        throw new Error("runConversationalEdit() requires a themeState — build one fresh from disk (theme-state.js's buildThemeState()) and pass it for every turn.");
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
            status: session.lastResultStatus || "COMPLETED",
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
    const ctx: TurnContext = { themeState, schemas, templateName: activeTemplateName, knownMerchantData, autoApply, themeRoot, dryRunApply, requestId };

    // `resultStatus` is always a SESSION_STATES value (drives classifyTurn()
    // on the NEXT turn); `extra.turnStatus`, when present, is the
    // finer-grained outcome the CALLER actually needs (PROPOSED/APPLIED/
    // DRY_RUN — Phase 8's own distinctions, preserved exactly) and is what's
    // returned as `status` instead. A COMPLETED session can still mean three
    // different things happened this turn; the session machine only needs
    // to know it finished successfully.
    async function finish(partialSession: Session, resultStatus: string, extra: Record<string, unknown> = {}): Promise<ConversationalEditResult> {
        const { turnStatus, ...publicExtra } = extra;
        const returnedStatus = (turnStatus as string) || resultStatus;
        const finalSession: Session = { ...partialSession, status: resultStatus, lastMessage: message, lastResultStatus: returnedStatus };
        await saveSession(finalSession);
        const extraOperation = extra.operation as Operation | undefined;
        const extraOperations = extra.operations as Operation[] | undefined;
        instrumentation.logConversationTurn({
            requestId, sessionId: finalSession.sessionId, turnCount: finalSession.turnCount,
            turnType, status: returnedStatus,
            clarificationCount: finalSession.pendingClarification ? 1 : 0,
            targetResolution: finalSession.resolvedTarget ? "RESOLVED" : null,
            aiCallCount: (extra.aiCallCount as number) || 0, repaired: !!extra.repaired,
            operationCount: (extra.operationCount as number) || (extraOperation ? 1 : 0) || (extraOperations ? extraOperations.length : 0),
            operationTypes: (extra.operationTypes as string[]) || (extraOperation ? [extraOperation.operation] : (extraOperations || []).map(o => o.operation)),
            themeStateVersion: finalSession.themeStateVersion, durationMs: Date.now() - startTime
        });
        return { status: returnedStatus, sessionId: finalSession.sessionId, ...publicExtra };
    }

    // A NEEDS_CLARIFICATION/AMBIGUOUS/FAILED turn never mutates themeState,
    // so there is nothing new to persist for it — the real theme files on
    // disk are unaffected either way, and the NEXT turn (a
    // CLARIFICATION_ANSWER or a fresh retry) always gets a themeState
    // rebuilt fresh from disk by its caller (see the interface doc on
    // RunConversationalEditOptions.themeState), never a snapshot this
    // function would otherwise need to have stashed itself.

    async function handleSingleTurnResult(result: EditTurnResult, resultSession: Session): Promise<ConversationalEditResult> {
        if (result.status === "AMBIGUOUS") {
            const pendingClarification: PendingClarification = { kind: "intent" };
            return finish({ ...resultSession, pendingClarification, pendingQuestion: "What would you like to change?", themeStateVersion: currentVersion }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: ["What would you like to change?"] });
        }
        if (result.status === "NEEDS_CLARIFICATION") {
            if (result.sectionId && (!result.candidates || result.candidates.length === 0)) {
                // A target is already resolved (edit-pipeline.js's
                // hasChangeDetails() check — the section/block is known,
                // only the NEW VALUE is missing) — attach it as a 'value'
                // clarification so the next answer goes straight to
                // proposeAndExecuteForTarget() against this exact target,
                // instead of degrading to 'intent' and re-running target
                // resolution from scratch on the merged text (wasteful, and
                // risks landing on a different target than the one already
                // confirmed here).
                const target: ResolvedTarget = { templateName: result.templateName || ctx.templateName, sectionId: result.sectionId, type: null, blockId: result.blockId };
                const pendingClarification: PendingClarification = { kind: "value", target, templateName: result.templateName || ctx.templateName, questions: result.questions! };
                return finish({ ...resultSession, resolvedTarget: target, pendingClarification, pendingQuestion: result.questions![0], themeStateVersion: currentVersion }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: result.questions });
            }
            if (!result.candidates || result.candidates.length === 0) {
                // No fixed candidate list to match the answer against (e.g.
                // edit-pipeline.js's AI-assisted target resolution asking its
                // OWN open-ended question) — merge the answer into the
                // original intent and let resolution run again next turn,
                // same as a classification-level AMBIGUOUS turn already does,
                // rather than routing to mergeClarificationAnswer() which
                // requires real candidates to match against.
                const pendingClarification: PendingClarification = { kind: "intent" };
                return finish({ ...resultSession, pendingClarification, pendingQuestion: result.questions![0], themeStateVersion: currentVersion }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: result.questions });
            }
            const kind = result.candidates[0] && "blockId" in result.candidates[0] ? "block" : "section";
            const pendingClarification: PendingClarification = { kind, candidates: result.candidates, templateName: result.templateName || ctx.templateName, sectionId: result.sectionId || null, questions: result.questions! };
            return finish({ ...resultSession, pendingClarification, pendingQuestion: result.questions![0], themeStateVersion: currentVersion }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: result.questions, candidates: result.candidates });
        }
        if (result.status === "FAILED") {
            return finish({ ...resultSession, themeStateVersion: currentVersion }, SESSION_STATES.FAILED, { errors: result.errors, operation: result.operation, repaired: result.repaired });
        }
        // PROPOSED / APPLIED / DRY_RUN. The mutated `result.themeState` is
        // never persisted anywhere — /api/edit/apply rebuilds a fresh
        // ThemeState from disk at apply time and replays `lastOperations`
        // (operations.js's applyOperationToThemeState() is deterministic:
        // same operation + same base state always produces the same
        // result), so there is nothing here for a later request to reuse.
        const operationWithId = { ...result.operation!, id: generateOperationId(result.operation!) };
        const updatedSession: Session = {
            ...resultSession,
            currentIntent: null, pendingClarification: null, pendingQuestion: null,
            resolvedTarget: deriveResolvedTarget(result.changeSummary, result.themeState!),
            lastOperation: operationWithId,
            lastOperations: [operationWithId],
            lastChangeSummary: result.changeSummary ?? null,
            themeStateVersion: computeThemeStateVersion(result.themeState!)
        };
        return finish(updatedSession, SESSION_STATES.COMPLETED, {
            turnStatus: result.status, // PROPOSED | APPLIED | DRY_RUN
            operation: result.operation, changeSummary: result.changeSummary, targetSummary: result.targetSummary,
            themeState: result.themeState, applyResult: result.applyResult, repaired: result.repaired
        });
    }

    async function handleMultiTurnResult(result: EditTurnResult, resultSession: Session): Promise<ConversationalEditResult> {
        if (result.status === "FAILED") {
            return finish({ ...resultSession, themeStateVersion: currentVersion }, SESSION_STATES.FAILED, { errors: result.errors, aiCallCount: result.aiCallCount, repaired: result.repaired });
        }
        const lastSummary = result.changeSummaries![result.changeSummaries!.length - 1];
        const lastOp = result.operations![result.operations!.length - 1];
        const updatedSession: Session = {
            ...resultSession,
            currentIntent: null, pendingClarification: null, pendingQuestion: null,
            resolvedTarget: deriveResolvedTarget(lastSummary, result.themeState!),
            lastOperation: { ...lastOp, id: generateOperationId(lastOp) },
            lastOperations: result.operations!.map(op => ({ ...op, id: generateOperationId(op) })),
            lastChangeSummary: lastSummary,
            themeStateVersion: computeThemeStateVersion(result.themeState!)
        };
        return finish(updatedSession, SESSION_STATES.COMPLETED, {
            turnStatus: result.status, // PROPOSED | APPLIED | DRY_RUN
            operations: result.operations, changeSummaries: result.changeSummaries, targetSummaries: result.targetSummaries,
            themeState: result.themeState, applyResult: result.applyResult, aiCallCount: result.aiCallCount, repaired: result.repaired
        });
    }

    // -----------------------------------------------------------------------
    if (turnType === "CANCEL") {
        return finish(resetSession(session), SESSION_STATES.IDLE, { message: "Okay — I've cleared that." });
    }

    if (turnType === "INITIAL_GENERATION") {
        return finish(session, "INITIAL_GENERATION", {});
    }

    if (turnType === "CLARIFICATION_ANSWER") {
        const pending = session.pendingClarification!;

        if (pending.kind === "intent") {
            // §7/§8 — the original intent survives clarification; the
            // answer is MERGED into it, never treated as an unrelated
            // fresh request.
            const mergedMessage = `${session.currentIntent} ${message}`.trim();
            const result = await runTargetedEdit(mergedMessage, ctx);
            return handleSingleTurnResult(result, { ...session, currentIntent: mergedMessage });
        }

        if (pending.kind === "value") {
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
                return finish({ ...session, currentIntent: mergedMessage, pendingClarification: { kind: "intent" }, pendingQuestion: question }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: [question] });
            }
            const result = await proposeAndExecuteForTarget(mergedMessage, targetContext, { ...ctx, templateName: pending.templateName });
            return handleSingleTurnResult(result, { ...session, currentIntent: mergedMessage });
        }

        // kind === 'section' | 'block' — first-round answer resolving WHICH
        // target the merchant meant.
        const merge = mergeClarificationAnswer(pending, message);
        if (!merge.resolved) {
            // Narrow to the options the merchant actually named on a
            // MULTIPLE_SELECTED retry (e.g. "1 and 3") so the follow-up asks
            // about just those two, not the full original list — and either
            // way, never repeat the exact same question text (see
            // buildClarificationRetryQuestion's own note on why that reads
            // as the bot ignoring the answer).
            const retryCandidates = merge.reason === "MULTIPLE_SELECTED" && merge.candidates ? merge.candidates : pending.candidates;
            const question = buildClarificationRetryQuestion(merge.reason, retryCandidates, pending.kind, schemas);
            const narrowedClarification: PendingClarification = { ...pending, candidates: retryCandidates, questions: [question] };
            return finish({ ...session, pendingClarification: narrowedClarification, pendingQuestion: question }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: [question], candidates: retryCandidates });
        }

        const match = merge.match!;
        const target: ResolvedTarget = {
            templateName: pending.templateName,
            sectionId: pending.kind === "block" ? (pending.sectionId ?? null) : ("sectionId" in match ? match.sectionId : null),
            type: null,
            blockId: pending.kind === "block" ? ("blockId" in match ? match.blockId : undefined) : undefined
        };
        const targetContext = buildTargetContextFromResolved(themeState, schemas, pending.templateName, target);
        if (!targetContext) {
            const question = "That target doesn't exist anymore — what would you like to change?";
            return finish({ ...session, currentIntent: message, pendingClarification: { kind: "intent" }, pendingQuestion: question }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: [question] });
        }
        target.type = targetContext.type;
        if (targetContext.block) target.blockType = targetContext.block.type;

        if (!hasChangeDetails(session.currentIntent, {
            ...target,
            contentPreview: extractSectionTextPreview(targetContext.block ? targetContext.block.currentSettings : targetContext.currentSettings)
        })) {
            const question = "What would you like to change?";
            const valueClarification: PendingClarification = { kind: "value", target, templateName: pending.templateName, questions: [question] };
            return finish({ ...session, resolvedTarget: target, pendingClarification: valueClarification, pendingQuestion: question }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: [question] });
        }

        const result = await proposeAndExecuteForTarget(session.currentIntent!, targetContext, { ...ctx, templateName: pending.templateName });
        return handleSingleTurnResult(result, session);
    }

    if (turnType === "FOLLOW_UP") {
        const resolution = resolveFollowUpReference(session, message, themeState);
        if (resolution.status === "AMBIGUOUS") {
            const questions = [buildAmbiguityQuestion(resolution.candidates, resolution.kind, schemas)];
            const pendingClarification: PendingClarification = { kind: resolution.kind, candidates: resolution.candidates, templateName: resolution.templateName || "", sectionId: resolution.sectionId, questions };
            return finish({ ...session, currentIntent: message, pendingClarification, pendingQuestion: questions[0] }, SESSION_STATES.NEEDS_CLARIFICATION, { questions, candidates: resolution.candidates });
        }
        if (resolution.status !== "RESOLVED") {
            const question = "What would you like to change?";
            return finish({ ...session, currentIntent: message, pendingClarification: { kind: "intent" }, pendingQuestion: question }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: [question] });
        }
        const targetContext = buildTargetContextFromResolved(themeState, schemas, resolution.target.templateName, resolution.target);
        if (!targetContext) {
            const question = "That target doesn't exist anymore — what would you like to change?";
            return finish({ ...session, currentIntent: message, pendingClarification: { kind: "intent" }, pendingQuestion: question }, SESSION_STATES.NEEDS_CLARIFICATION, { questions: [question] });
        }
        const result = await proposeAndExecuteForTarget(message, targetContext, { ...ctx, templateName: resolution.target.templateName || ctx.templateName });
        return handleSingleTurnResult(result, session);
    }

    // NEW_REQUEST
    const clauses = splitBoundedClauses(message);
    if (clauses.length > 1) {
        if (clauses.length > MAX_OPERATIONS_PER_TURN) {
            return finish(session, "TOO_MANY_OPERATIONS", { message: "That includes several changes. Let's handle them in smaller steps." });
        }
        const result = await runMultiOperationTurn(clauses, session, ctx);
        return handleMultiTurnResult(result, { ...session, currentIntent: message });
    }

    const result = await runTargetedEdit(message, ctx);
    return handleSingleTurnResult(result, { ...session, currentIntent: message });
}
