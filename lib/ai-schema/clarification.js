/**
 * Phase 3 — Request Understanding + Clarification Loop.
 *
 * Sits BEFORE theme generation (see AI_THEME_BUILDER_PHASE_PLAN.md's Phase
 * 3 section and AI_THEME_BUILDER_PHASE3_PLAN.md). Its only job is to decide
 * whether a merchant's request carries enough information to generate a
 * meaningful theme, and if not, ask a small number of targeted questions.
 * It never generates section/block JSON, Liquid, CSS, or JS — see "No
 * Theme Generation" in the plan. `1-generate-theme.js`'s STEP 0 is the only
 * caller that should invoke understandRequest() in the real pipeline.
 *
 * AI call shape deliberately mirrors generateAIColorPalette() in
 * example-implementation.js — a single JSON-mode user turn, direct fetch,
 * no system prompt, no full schema catalog attached (Phase 3 spec §13:
 * "the understanding stage should not require the full 16 section / 53
 * block schemas"). This keeps the call in the same cheap cost tier as the
 * existing color call, not anywhere near the ~60K-char main generation
 * prompt.
 */

const instrumentation = require('./instrumentation');
const brief = require('./brief');

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'moonshotai/kimi-k2.5';
const DEBUG = process.env.DEBUG === 'true';

// Phase 3 spec: "capped at 2 rounds / ~3 questions per round to prevent
// deadlock." Exceeding either cap does not error — understandRequest()
// forces status to READY with whatever brief it has, rather than looping
// forever waiting on an answer that may never come. See "Known
// limitations" in PHASE3_REPORT.md.
const MAX_CLARIFICATION_ROUNDS = 2;
const MAX_QUESTIONS_PER_ROUND = 3;

const VALID_STATUSES = new Set(['READY', 'NEEDS_CLARIFICATION']);

function buildUnderstandingPrompt(conversationText, repairErrors = null) {
    const fieldList = brief.BRIEF_FIELDS.map(f => `"${f}"`).join(', ');

    let prompt = `You are a requirements analyst for a Shopify store website builder. Read the merchant's request below and extract what you can — do not invent facts that aren't stated or clearly implied.

Merchant conversation so far:
"""
${conversationText}
"""

Extract a structured brief with these fields: ${fieldList}.

For EACH field, output one of:
  - { "value": <string or array of strings>, "status": "confirmed", "source": "user" }   — merchant stated this directly
  - { "value": <string or array of strings>, "status": "inferred", "source": "ai_inference" } — reasonably implied by context (e.g. "premium pet wellness store" implies targetAudience ~ "pet owners")
  - { "value": null, "status": "missing", "source": null } — no information available

RULES:
- "businessType" (what kind of store/product this is) is the ONLY field that blocks generation if missing — treat it as required.
- Every other field is optional: if it's missing, a reasonable default can be applied later. Do NOT ask about optional fields unless they materially change what would be generated.
- Extract MULTIPLE pieces of information from a single message when present — do not under-extract.
- Never ask about information already given, even earlier in the conversation.
- If businessType is present (stated or clearly inferable) and nothing else materially missing, status is "READY".
- If businessType is missing, or something else genuinely material and unresolvable is missing, status is "NEEDS_CLARIFICATION".
- Questions must be minimal (at most ${MAX_QUESTIONS_PER_ROUND}), grouped logically, phrased in plain merchant-friendly language (no internal field names), and must not repeat anything already answered.

Respond ONLY with valid JSON (no markdown, no explanation) in this exact shape:
{
  "status": "READY" | "NEEDS_CLARIFICATION",
  "brief": {
    ${brief.BRIEF_FIELDS.map(f => `"${f}": { "value": ..., "status": "confirmed|inferred|missing", "source": "user|ai_inference|null" }`).join(',\n    ')}
  },
  "missing": ["<field keys that are genuinely material and still missing>"],
  "questions": ["<at most ${MAX_QUESTIONS_PER_ROUND} targeted, minimal questions — empty array if status is READY>"]
}`;

    if (repairErrors && repairErrors.length > 0) {
        prompt += `\n\nYour previous response was invalid for these reasons: ${repairErrors.join('; ')}. Fix these issues and respond again with ONLY the corrected JSON object.`;
    }

    return prompt;
}

/**
 * Single JSON-mode call to OpenRouter. Unlike generateAIColorPalette()
 * (which falls back to a predefined palette on failure), there is no safe
 * fallback for "what is this store about" — so this throws on exhausted
 * retries rather than returning null, and callers must handle the error
 * explicitly (Phase 3 spec §17: "Invalid output must not silently
 * continue").
 */
async function requestUnderstanding(conversationText, options = {}) {
    const { maxRetries = 2, requestId = instrumentation.nextRequestId('understand'), callType = 'request_understanding', repairErrors = null } = options;

    if (!OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY not set in environment. Please set it in .env file');
    }
    if (!conversationText || typeof conversationText !== 'string') {
        throw new Error('Invalid conversationText: must be a non-empty string');
    }

    const prompt = buildUnderstandingPrompt(conversationText, repairErrors);
    const startTime = Date.now();

    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'Content-Type': 'application/json',
                    'HTTP-Referer': 'https://github.com/Debutifycorp/EcomSkale',
                    'X-Title': 'Shopify Theme AI Configurator'
                },
                body: JSON.stringify({
                    model: OPENROUTER_MODEL,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.3,
                    response_format: { type: 'json_object' }
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                if (attempt < maxRetries && response.status >= 500) {
                    const delay = Math.pow(2, attempt - 1) * 1000;
                    if (DEBUG) console.warn(`⚠️  Understanding call attempt ${attempt} failed (${response.status}). Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                throw new Error(`OpenRouter API error (${response.status}): ${errorText}`);
            }

            const data = await response.json();
            const content = data.choices?.[0]?.message?.content;
            if (!content) {
                throw new Error('Invalid API response: missing choices/message/content');
            }

            let parsed;
            try {
                parsed = JSON.parse(content);
            } catch (parseError) {
                throw new Error(`Understanding response was not valid JSON: ${parseError.message}`);
            }

            instrumentation.logAICall({
                requestId,
                callType,
                model: OPENROUTER_MODEL,
                promptChars: prompt.length,
                outputChars: content.length,
                durationMs: Date.now() - startTime,
                retryCount: attempt - 1,
                attempts: attempt,
                success: true
            });

            return parsed;
        } catch (error) {
            lastError = error;
            if (attempt === maxRetries) {
                instrumentation.logAICall({
                    requestId,
                    callType,
                    model: OPENROUTER_MODEL,
                    promptChars: prompt.length,
                    outputChars: 0,
                    durationMs: Date.now() - startTime,
                    retryCount: attempt - 1,
                    attempts: attempt,
                    success: false,
                    error: error.message
                });
                throw error;
            }
            const delay = Math.pow(2, attempt) * 1000;
            if (DEBUG) console.warn(`⚠️  Understanding call attempt ${attempt} failed: ${error.message}. Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    throw lastError || new Error('Understanding call failed for an unknown reason');
}

/**
 * Validates the structured understanding result before anything trusts it
 * (Phase 3 spec §17). Returns { valid: true } or { valid: false, errors }.
 */
function validateUnderstandingResult(result) {
    const errors = [];

    if (!result || typeof result !== 'object' || Array.isArray(result)) {
        return { valid: false, errors: ['result is not a JSON object'] };
    }

    if (!VALID_STATUSES.has(result.status)) {
        errors.push(`status must be "READY" or "NEEDS_CLARIFICATION", got ${JSON.stringify(result.status)}`);
    }

    if (!brief.isValidBriefShape(result.brief)) {
        errors.push('brief is missing, malformed, or contains a field with an invalid {value,status,source} shape');
    }

    if (!Array.isArray(result.missing) || !result.missing.every(m => typeof m === 'string')) {
        errors.push('missing must be an array of strings');
    }

    if (!Array.isArray(result.questions) || !result.questions.every(q => typeof q === 'string')) {
        errors.push('questions must be an array of strings');
    } else if (result.questions.length > MAX_QUESTIONS_PER_ROUND + 2) {
        // Small tolerance above the prompt's own cap — understandRequest()
        // truncates to MAX_QUESTIONS_PER_ROUND regardless; this only
        // rejects wildly non-minimal output (e.g. one question per field).
        errors.push(`questions array has ${result.questions.length} entries, expected at most ${MAX_QUESTIONS_PER_ROUND} (not minimal)`);
    }

    // Contradictory state (Phase 3 spec §17 example): READY while a
    // blocking field is still missing.
    if (result.status === 'READY' && brief.isValidBriefShape(result.brief)) {
        const stillMissing = brief.missingBlockingFields(result.brief);
        if (stillMissing.length > 0) {
            errors.push(`status is READY but blocking field(s) still missing: ${stillMissing.join(', ')}`);
        }
    }

    // Contradictory state: NEEDS_CLARIFICATION with no questions to ask.
    if (result.status === 'NEEDS_CLARIFICATION' && Array.isArray(result.questions) && result.questions.length === 0) {
        errors.push('status is NEEDS_CLARIFICATION but questions array is empty');
    }

    return { valid: errors.length === 0, errors };
}

function buildConversationText(originalRequest, previousAnswers, currentAnswer) {
    const parts = [`Original request: ${originalRequest}`];
    previousAnswers.forEach((answer, i) => {
        parts.push(`Merchant answer ${i + 1}: ${answer}`);
    });
    if (currentAnswer) {
        parts.push(`Merchant answer ${previousAnswers.length + 1}: ${currentAnswer}`);
    }
    return parts.join('\n');
}

function normalizeQuestion(q) {
    return q.trim().toLowerCase().replace(/\s+/g, ' ');
}

function dedupeAgainstAsked(questions, askedQuestions) {
    const askedNormalized = new Set(askedQuestions.map(normalizeQuestion));
    const seen = new Set();
    return questions.filter(q => {
        const norm = normalizeQuestion(q);
        if (askedNormalized.has(norm) || seen.has(norm)) return false;
        seen.add(norm);
        return true;
    });
}

/**
 * Runs one turn of request understanding, merging with any prior state for
 * the given session (Phase 3 spec §10, multi-turn clarification).
 *
 * options:
 *   - sessionId: string — identifies the conversation. Auto-generated if
 *     omitted (treated as a fresh, single-turn session).
 *   - message: string — REQUIRED. The merchant's original request on turn
 *     1, or their latest answer on subsequent turns.
 *   - context: { requestId } — plumbed into instrumentation, matching the
 *     existing convention in example-implementation.js.
 *
 * Returns:
 *   { sessionId, status, brief, questions, missing, round }
 */
async function understandRequest(message, options = {}) {
    if (!message || typeof message !== 'string' || !message.trim()) {
        throw new Error('understandRequest() requires a non-empty message');
    }

    const sessionId = options.sessionId || instrumentation.nextRequestId('session');
    const requestId = (options.context && options.context.requestId) || instrumentation.nextRequestId('understand');

    const existingState = await brief.loadBrief(sessionId);
    const isFirstTurn = !existingState;

    const originalRequest = isFirstTurn ? message : existingState.originalRequest;
    const previousAnswers = isFirstTurn ? [] : existingState.answers;
    const priorBrief = isFirstTurn ? brief.createEmptyBrief() : existingState.brief;
    const askedQuestions = isFirstTurn ? [] : existingState.askedQuestions;
    const priorRound = isFirstTurn ? 0 : existingState.round;

    const conversationText = buildConversationText(originalRequest, previousAnswers, isFirstTurn ? null : message);
    const startTime = Date.now();

    let result = await requestUnderstanding(conversationText, { requestId, callType: 'request_understanding' });
    let validation = validateUnderstandingResult(result);
    let repaired = false;
    let retryCount = 0;

    if (!validation.valid) {
        // Bounded repair retry only — never an unlimited loop (Phase 3
        // spec §12).
        repaired = true;
        retryCount = 1;
        result = await requestUnderstanding(conversationText, {
            requestId,
            callType: 'request_understanding_repair',
            repairErrors: validation.errors
        });
        validation = validateUnderstandingResult(result);
        if (!validation.valid) {
            throw new Error(`Understanding call produced invalid output even after a repair attempt: ${validation.errors.join('; ')}`);
        }
    }

    const mergedBrief = brief.mergeBrief(priorBrief, result.brief);
    const newAnswers = isFirstTurn ? [] : [...previousAnswers, message];

    const rawQuestions = Array.isArray(result.questions) ? result.questions : [];
    const freshQuestions = dedupeAgainstAsked(rawQuestions, askedQuestions).slice(0, MAX_QUESTIONS_PER_ROUND);

    const readyByBrief = brief.isReady(mergedBrief);
    const roundsExhausted = priorRound >= MAX_CLARIFICATION_ROUNDS;

    let status, questions, round;
    if (readyByBrief || freshQuestions.length === 0 || roundsExhausted) {
        status = 'READY';
        questions = [];
        round = priorRound;
    } else {
        status = 'NEEDS_CLARIFICATION';
        questions = freshQuestions;
        round = priorRound + 1;
    }

    const missing = brief.missingBlockingFields(mergedBrief);

    const newState = {
        sessionId,
        originalRequest,
        answers: newAnswers,
        brief: mergedBrief,
        askedQuestions: [...askedQuestions, ...questions],
        round,
        status
    };
    await brief.saveBrief(sessionId, newState);

    instrumentation.logUnderstanding({
        requestId,
        sessionId,
        status,
        round,
        questionCount: questions.length,
        missingBlockingCount: missing.length,
        inputChars: conversationText.length,
        outputChars: JSON.stringify(result).length,
        durationMs: Date.now() - startTime,
        retryCount,
        repaired
    });

    return { sessionId, status, brief: mergedBrief, questions, missing, round };
}

module.exports = {
    MAX_CLARIFICATION_ROUNDS,
    MAX_QUESTIONS_PER_ROUND,
    buildUnderstandingPrompt,
    buildConversationText,
    requestUnderstanding,
    validateUnderstandingResult,
    understandRequest
};
