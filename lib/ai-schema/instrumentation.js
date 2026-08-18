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

const { randomUUID } = require('crypto');

function nextRequestId(prefix = 'req') {
    return `${prefix}_${randomUUID()}`;
}

function estimateTokensFromChars(chars) {
    if (!chars || chars < 0) return 0;
    return Math.ceil(chars / 4);
}

function logEvent(tag, payload) {
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
function logAICall({
    requestId,
    callType,
    model,
    promptChars = 0,
    outputChars = 0,
    durationMs,
    retryCount = 0,
    attempts = 1,
    success,
    error = null
}) {
    return logEvent('AI_CALL', {
        requestId,
        callType,
        model,
        promptChars,
        estimatedInputTokens: estimateTokensFromChars(promptChars),
        outputChars,
        estimatedOutputTokens: estimateTokensFromChars(outputChars),
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
function logValidation({
    requestId,
    valid,
    errorCount = 0,
    warningCount = 0,
    sectionCount = null,
    blockCount = null,
    error = null
}) {
    return logEvent('VALIDATION', {
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
function logPipeline(details) {
    return logEvent('PIPELINE', details);
}

/**
 * Log the result of one retrieval.js retrieveRelevantSchemas() call —
 * Phase 2's addition. Captures enough to answer "why did the AI see these
 * particular schemas" after the fact, and to directly compare full-load
 * vs. retrieved prompt footprint (details.fullSchemaChars vs.
 * details.retrievedSchemaChars / their estimated-token counterparts).
 */
function logRetrieval({
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
}) {
    return logEvent('RETRIEVAL', {
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
function logUnderstanding({
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
}) {
    return logEvent('UNDERSTANDING', {
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
function logThemeState({
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
}) {
    return logEvent('THEME_STATE', {
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
function logCandidateValidation({
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
}) {
    return logEvent('CANDIDATE_VALIDATION', {
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
function logMerge({
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
}) {
    return logEvent('MERGE', {
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
function logApply({
    requestId,
    dryRun = false,
    success,
    filesWritten = 0,
    targets = [],
    durationMs,
    error = null
}) {
    return logEvent('APPLY', {
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
function logOperation({
    requestId,
    operationId,
    operation,
    valid,
    errorCount = 0,
    changedCount = 0,
    durationMs
}) {
    return logEvent('OPERATION', {
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
function logOperationBatch({
    requestId,
    operationCount,
    valid,
    errorCount = 0,
    durationMs
}) {
    return logEvent('OPERATION_BATCH', {
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
function logEditPipeline({
    requestId,
    status,
    classification = null,
    targetStatus = null,
    operationCount = 0,
    repaired = false,
    aiCallCount = 0,
    durationMs
}) {
    return logEvent('EDIT_PIPELINE', {
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
 * Log one conversational-edit.js turn — Phase 9's addition. Captures enough
 * to answer "did this multi-turn conversation behave" after the fact
 * (classification, clarification, AI-call/repair bounds, theme-state
 * freshness) without logging full conversation history or full merchant
 * content (§34 — "do not log full conversation history/full ThemeState").
 */
function logConversationTurn({
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
}) {
    return logEvent('CONVERSATION_TURN', {
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

module.exports = {
    nextRequestId,
    estimateTokensFromChars,
    logAICall,
    logValidation,
    logPipeline,
    logRetrieval,
    logUnderstanding,
    logThemeState,
    logCandidateValidation,
    logMerge,
    logApply,
    logOperation,
    logOperationBatch,
    logEditPipeline,
    logConversationTurn
};
