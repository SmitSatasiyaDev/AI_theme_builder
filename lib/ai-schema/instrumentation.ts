/**
 * Phase 1 — lightweight instrumentation/logging helper.
 *
 * Pure measurement layer: every function here only computes numbers and
 * writes a structured console.log line. Nothing in this file changes
 * control flow, return values, or error behavior of the pipeline it's
 * wired into. Char-based token estimates use the same chars/4 heuristic
 * already used informally in AUDIT.md so later phases have a consistent
 * baseline to compare against.
 */

import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

export function nextRequestId(prefix = "req"): string {
    return `${prefix}_${randomUUID()}`;
}

// ---------------------------------------------------------------------------
// Full AI call tracing — OFF by default (opt-in via AI_DEBUG_LOG=true). This
// is deliberately separate from logAICall() above: logAICall's console line
// exists precisely BECAUSE it never logs full prompt/response content (see
// §32/§34 in this file's other log*() functions) — merchant content, full
// section text, etc. This one exists for the opposite reason: local
// debugging of "what did we actually send the AI, and what did it actually
// say back," so it writes full system/user prompts and the full raw
// response to a file (never the console, never enabled by default) — a
// developer opts in locally, and AI_DEBUG_LOG_PATH defaults under
// gitignored logs/ so it's never committed.
// ---------------------------------------------------------------------------

const AI_DEBUG_LOG_ENABLED = process.env.AI_DEBUG_LOG === "true";
const AI_DEBUG_LOG_PATH = process.env.AI_DEBUG_LOG_PATH || path.join(process.cwd(), "logs", "ai-debug.jsonl");
let debugLogDirEnsured = false;

export interface AITokenUsage {
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
}

/**
 * Appends ONE full record of an AI provider call to AI_DEBUG_LOG_PATH (JSON
 * Lines — one JSON object per line, easy to tail/grep). No-op unless
 * AI_DEBUG_LOG=true is set, and never throws — a logging failure must never
 * break the pipeline it's observing.
 */
export function logAICallDetail({
    requestId,
    callType,
    model,
    systemPrompt,
    userPrompt,
    responseContent = null,
    usage = null,
    durationMs,
    retryCount = 0,
    attempts = 1,
    success,
    error = null
}: {
    requestId?: string;
    callType?: string;
    model?: string;
    systemPrompt?: string;
    userPrompt?: string;
    responseContent?: string | null;
    usage?: AITokenUsage | null;
    durationMs?: number;
    retryCount?: number;
    attempts?: number;
    success?: boolean;
    error?: string | null;
}): void {
    if (!AI_DEBUG_LOG_ENABLED) return;
    try {
        if (!debugLogDirEnsured) {
            fs.mkdirSync(path.dirname(AI_DEBUG_LOG_PATH), { recursive: true });
            debugLogDirEnsured = true;
        }
        const entry = {
            timestamp: new Date().toISOString(),
            requestId,
            callType,
            model,
            durationMs,
            retryCount,
            attempts,
            success,
            error,
            usage,
            systemPrompt,
            userPrompt,
            responseContent
        };
        fs.appendFileSync(AI_DEBUG_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
    } catch (loggingError) {
        console.warn(`⚠️  AI_DEBUG_LOG write failed: ${(loggingError as Error).message}`);
    }
}

export function estimateTokensFromChars(chars: number | null | undefined): number {
    if (!chars || chars < 0) return 0;
    return Math.ceil(chars / 4);
}

function logEvent(tag: string, payload: Record<string, unknown>): Record<string, unknown> {
    const entry = {
        timestamp: new Date().toISOString(),
        ...payload
    };
    console.log(`[${tag}] ${JSON.stringify(entry)}`);
    return entry;
}

/**
 * Log one AI provider call (OpenRouter request/response cycle).
 */
export function logAICall({
    requestId,
    callType,
    model,
    promptChars = 0,
    outputChars = 0,
    usage = null,
    durationMs,
    retryCount = 0,
    attempts = 1,
    success,
    error = null
}: {
    requestId?: string;
    callType?: string;
    model?: string;
    promptChars?: number;
    outputChars?: number;
    usage?: AITokenUsage | null;
    durationMs?: number;
    retryCount?: number;
    attempts?: number;
    success?: boolean;
    error?: string | null;
}) {
    return logEvent("AI_CALL", {
        requestId,
        callType,
        model,
        promptChars,
        estimatedInputTokens: estimateTokensFromChars(promptChars),
        outputChars,
        estimatedOutputTokens: estimateTokensFromChars(outputChars),
        // Real usage from the provider's response, when it returned one —
        // estimatedInput/OutputTokens above are the chars/4 fallback used
        // when it didn't (see this file's header).
        promptTokens: usage ? usage.promptTokens ?? null : null,
        completionTokens: usage ? usage.completionTokens ?? null : null,
        totalTokens: usage ? usage.totalTokens ?? null : null,
        durationMs,
        retryCount,
        attempts,
        success,
        error
    });
}

/**
 * Log the result of validateOutput() for one generation attempt.
 */
export function logValidation({
    requestId,
    valid,
    errorCount = 0,
    warningCount = 0,
    sectionCount = null,
    blockCount = null,
    error = null
}: {
    requestId?: string;
    valid?: boolean;
    errorCount?: number;
    warningCount?: number;
    sectionCount?: number | null;
    blockCount?: number | null;
    error?: string | null;
}) {
    return logEvent("VALIDATION", {
        requestId,
        valid,
        errorCount,
        warningCount,
        sectionCount,
        blockCount,
        error
    });
}

/**
 * Log a pipeline-level summary (one per runFullPipeline invocation).
 */
export function logPipeline(details: Record<string, unknown>) {
    return logEvent("PIPELINE", details);
}

/**
 * Log the result of one retrieval.js retrieveRelevantSchemas() call —
 * Phase 2's addition. Captures enough to answer "why did the AI see these
 * particular schemas" after the fact, and to directly compare full-load
 * vs. retrieved prompt footprint (details.fullSchemaChars vs.
 * details.retrievedSchemaChars / their estimated-token counterparts).
 */
export function logRetrieval({
    requestId,
    mode,
    templateName,
    fallbackReason = null,
    ruleMatches = [],
    defaultRuleApplied = false,
    baselineHeroApplied = false,
    candidateSectionCount = 0,
    selectedSectionCount = 0,
    candidateBlockCount = 0,
    selectedBlockCount = 0,
    fullSchemaChars = 0,
    retrievedSchemaChars = 0,
    estimatedFullTokens = 0,
    estimatedRetrievedTokens = 0
}: {
    requestId?: string;
    mode?: string;
    templateName?: string;
    fallbackReason?: string | null;
    ruleMatches?: unknown[];
    defaultRuleApplied?: boolean;
    baselineHeroApplied?: boolean;
    candidateSectionCount?: number;
    selectedSectionCount?: number;
    candidateBlockCount?: number;
    selectedBlockCount?: number;
    fullSchemaChars?: number;
    retrievedSchemaChars?: number;
    estimatedFullTokens?: number;
    estimatedRetrievedTokens?: number;
}) {
    return logEvent("RETRIEVAL", {
        requestId,
        mode,
        templateName,
        fallbackReason,
        ruleMatchCount: ruleMatches.length,
        ruleMatches,
        defaultRuleApplied,
        baselineHeroApplied,
        candidateSectionCount,
        selectedSectionCount,
        candidateBlockCount,
        selectedBlockCount,
        fullSchemaChars,
        retrievedSchemaChars,
        estimatedFullTokens,
        estimatedRetrievedTokens
    });
}

/**
 * Log the result of one clarification.js understandRequest() call — Phase
 * 3's addition. Captures enough to answer "did clarification behave" after
 * the fact: how many rounds/questions it took, whether missing blocking
 * info remained, and how big the (deliberately small — see clarification.js
 * for why the full schema catalog is never sent here) understanding prompt
 * was, so it can be compared against the cost of the main generation call.
 */
export function logUnderstanding({
    requestId,
    sessionId,
    status,
    round = 0,
    questionCount = 0,
    missingBlockingCount = 0,
    inputChars = 0,
    outputChars = 0,
    durationMs,
    retryCount = 0,
    repaired = false
}: {
    requestId?: string;
    sessionId?: string;
    status?: string;
    round?: number;
    questionCount?: number;
    missingBlockingCount?: number;
    inputChars?: number;
    outputChars?: number;
    durationMs?: number;
    retryCount?: number;
    repaired?: boolean;
}) {
    return logEvent("UNDERSTANDING", {
        requestId,
        sessionId,
        status,
        round,
        questionCount,
        missingBlockingCount,
        inputChars,
        estimatedInputTokens: estimateTokensFromChars(inputChars),
        outputChars,
        estimatedOutputTokens: estimateTokensFromChars(outputChars),
        durationMs,
        retryCount,
        repaired
    });
}

/**
 * Log the result of one theme-state.js buildThemeState() call — Phase 4's
 * addition. No AI call happens here (ThemeState construction is pure
 * deterministic application logic, see theme-state.js), so this only
 * records structural measurements: how much of the live theme was read,
 * how much of it the AI schema catalog actually recognizes, and how the
 * resulting state validated.
 */
export function logThemeState({
    requestId,
    themeId,
    templateCount = 0,
    sectionCount = 0,
    blockCount = 0,
    unknownSectionCount = 0,
    unknownBlockCount = 0,
    unparseableTemplateCount = 0,
    stateChars = 0,
    buildDurationMs,
    valid = null,
    errorCount = 0,
    warningCount = 0
}: {
    requestId?: string;
    themeId?: string;
    templateCount?: number;
    sectionCount?: number;
    blockCount?: number;
    unknownSectionCount?: number;
    unknownBlockCount?: number;
    unparseableTemplateCount?: number;
    stateChars?: number;
    buildDurationMs?: number;
    valid?: boolean | null;
    errorCount?: number;
    warningCount?: number;
}) {
    return logEvent("THEME_STATE", {
        requestId,
        themeId,
        templateCount,
        sectionCount,
        blockCount,
        unknownSectionCount,
        unknownBlockCount,
        unparseableTemplateCount,
        stateChars,
        estimatedStateTokens: estimateTokensFromChars(stateChars),
        buildDurationMs,
        valid,
        errorCount,
        warningCount
    });
}

/**
 * Log the result of one validation.js validateCandidate() call — Phase 6's
 * addition. Deterministic, no AI call (see validation.js), so this only
 * records measurements: how big the candidate was, how validation broke
 * down by stage/error-code, and — for callers that wire this into a bounded
 * repair loop (generation.js, 1-generate-theme.js) — how many repair
 * attempts were made and whether the final attempt succeeded (§28).
 */
export function logCandidateValidation({
    requestId,
    stage,
    templateName,
    valid,
    errorCount = 0,
    warningCount = 0,
    errorCodes = [],
    candidateChars = 0,
    repairAttempt = 0,
    durationMs
}: {
    requestId?: string;
    stage?: string;
    templateName?: string;
    valid?: boolean;
    errorCount?: number;
    warningCount?: number;
    errorCodes?: unknown[];
    candidateChars?: number;
    repairAttempt?: number;
    durationMs?: number;
}) {
    return logEvent("CANDIDATE_VALIDATION", {
        requestId,
        stage,
        templateName,
        valid,
        errorCount,
        warningCount,
        errorCodes,
        candidateChars,
        repairAttempt,
        durationMs
    });
}

/**
 * Log the result of one merge.js mergeThemeState() call — Phase 7's
 * addition. Deterministic, no AI call, no I/O (see merge.js), so this only
 * records structural measurements: how the merge broke down and whether it
 * failed closed on a conflict.
 */
export function logMerge({
    requestId,
    templateName,
    valid,
    conflictCount = 0,
    conflictCodes = [],
    addedSectionCount = 0,
    updatedSectionCount = 0,
    removedSectionCount = 0,
    changedSettingCount = 0,
    preservedUnknownCount = 0,
    durationMs
}: {
    requestId?: string;
    templateName?: string;
    valid?: boolean;
    conflictCount?: number;
    conflictCodes?: unknown[];
    addedSectionCount?: number;
    updatedSectionCount?: number;
    removedSectionCount?: number;
    changedSettingCount?: number;
    preservedUnknownCount?: number;
    durationMs?: number;
}) {
    return logEvent("MERGE", {
        requestId,
        templateName,
        valid,
        conflictCount,
        conflictCodes,
        addedSectionCount,
        updatedSectionCount,
        removedSectionCount,
        changedSettingCount,
        preservedUnknownCount,
        durationMs
    });
}

/**
 * Log the result of one apply.js applyThemeState() call — Phase 7's
 * addition. Never logs full file contents (§32 — "do not log complete
 * theme JSON"), only paths/counts/timing.
 */
export function logApply({
    requestId,
    dryRun = false,
    success,
    filesWritten = 0,
    targets = [],
    durationMs,
    error = null
}: {
    requestId?: string;
    dryRun?: boolean;
    success?: boolean;
    filesWritten?: number;
    targets?: unknown[];
    durationMs?: number;
    error?: string | null;
}) {
    return logEvent("APPLY", {
        requestId,
        dryRun,
        success,
        filesWritten,
        targets,
        durationMs,
        error
    });
}

/**
 * Log the result of one operations.js applyOperationToThemeState() call —
 * Phase 8's addition. No AI call happens inside operations.js itself (see
 * that file), so this only records validation/execution measurements for
 * ONE operation.
 */
export function logOperation({
    requestId,
    operationId,
    operation,
    valid,
    errorCount = 0,
    changedCount = 0,
    durationMs
}: {
    requestId?: string;
    operationId?: string;
    operation?: unknown;
    valid?: boolean;
    errorCount?: number;
    changedCount?: number;
    durationMs?: number;
}) {
    return logEvent("OPERATION", {
        requestId,
        operationId,
        operation,
        valid,
        errorCount,
        changedCount,
        durationMs
    });
}

/**
 * Log the result of one applyOperationsToThemeState() batch call — how many
 * operations, whether the whole batch committed atomically or was rejected.
 */
export function logOperationBatch({
    requestId,
    operationCount,
    valid,
    errorCount = 0,
    durationMs
}: {
    requestId?: string;
    operationCount?: number;
    valid?: boolean;
    errorCount?: number;
    durationMs?: number;
}) {
    return logEvent("OPERATION_BATCH", {
        requestId,
        operationCount,
        valid,
        errorCount,
        durationMs
    });
}

/**
 * Log one edit-pipeline.js targeted-edit run — Phase 8's orchestration
 * layer. Captures classification, target-resolution, and AI-proposal
 * outcomes without logging full merchant content.
 */
export function logEditPipeline({
    requestId,
    status,
    classification = null,
    targetStatus = null,
    operationCount = 0,
    repaired = false,
    aiCallCount = 0,
    durationMs
}: {
    requestId?: string;
    status?: string;
    classification?: string | null;
    targetStatus?: string | null;
    operationCount?: number;
    repaired?: boolean;
    aiCallCount?: number;
    durationMs?: number;
}) {
    return logEvent("EDIT_PIPELINE", {
        requestId,
        status,
        classification,
        targetStatus,
        operationCount,
        repaired,
        aiCallCount,
        durationMs
    });
}

/**
 * Log ONE consolidated end-to-end summary for a worker.js generation job —
 * both templates combined. Everything in here is already logged piecemeal
 * by the calls above (AI_CALL/RETRIEVAL/CANDIDATE_VALIDATION/MERGE/PIPELINE)
 * — this is purely a single, easy-to-grep line answering "where did the
 * time/AI calls/tokens for this job actually go" without reconstructing it
 * from many separate log lines by hand.
 */
export function logGenerationSummary({
    requestId,
    jobId,
    retrievalMs,
    indexPlanningMs,
    productPlanningMs,
    indexConfigurationMs,
    productConfigurationMs,
    validationMs,
    mergeMs,
    totalMs,
    aiCallCount,
    retryCount,
    deterministicFixCount,
    promptChars = 0,
    outputChars = 0
}: {
    requestId?: string;
    jobId?: string;
    retrievalMs?: number;
    indexPlanningMs?: number;
    productPlanningMs?: number;
    indexConfigurationMs?: number;
    productConfigurationMs?: number;
    validationMs?: number;
    mergeMs?: number;
    totalMs?: number;
    aiCallCount?: number;
    retryCount?: number;
    deterministicFixCount?: number;
    promptChars?: number;
    outputChars?: number;
}) {
    return logEvent("GENERATION_SUMMARY", {
        requestId,
        jobId,
        retrievalMs,
        indexPlanningMs,
        productPlanningMs,
        indexConfigurationMs,
        productConfigurationMs,
        validationMs,
        mergeMs,
        totalMs,
        aiCallCount,
        retryCount,
        deterministicFixCount,
        promptChars,
        estimatedPromptTokens: estimateTokensFromChars(promptChars),
        outputChars,
        estimatedOutputTokens: estimateTokensFromChars(outputChars)
    });
}

/**
 * Log one conversational-edit.js turn — Phase 9's addition. Captures enough
 * to answer "did this multi-turn conversation behave" after the fact
 * (classification, clarification, AI-call/repair bounds, theme-state
 * freshness) without logging full conversation history or full merchant
 * content (§34 — "do not log full conversation history/full ThemeState").
 */
export function logConversationTurn({
    requestId,
    sessionId,
    turnCount = 0,
    turnType,
    status,
    clarificationCount = 0,
    targetResolution = null,
    aiCallCount = 0,
    repaired = false,
    operationCount = 0,
    operationTypes = [],
    themeStateVersion = null,
    durationMs
}: {
    requestId?: string;
    sessionId?: string;
    turnCount?: number;
    turnType?: string;
    status?: string;
    clarificationCount?: number;
    targetResolution?: unknown;
    aiCallCount?: number;
    repaired?: boolean;
    operationCount?: number;
    operationTypes?: unknown[];
    themeStateVersion?: string | null;
    durationMs?: number;
}) {
    return logEvent("CONVERSATION_TURN", {
        requestId,
        sessionId,
        turnCount,
        turnType,
        status,
        clarificationCount,
        targetResolution,
        aiCallCount,
        repaired,
        operationCount,
        operationTypes,
        themeStateVersion,
        durationMs
    });
}
