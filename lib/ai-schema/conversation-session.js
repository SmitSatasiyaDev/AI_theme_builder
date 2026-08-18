/**
 * Rewritten port of the original ai-schema/conversation-session.js for the
 * multi-tenant SaaS. Everything except saveSession()/loadSession() is
 * copied verbatim (pure, no I/O) from
 * f:\theme-builder\AI_Schema\ai-schema\conversation-session.js.
 *
 * What changed and why: the original persists one JSON file per session
 * under ai-schema/output/edit-sessions/, keyed only by `session.sessionId`
 * — no tenant scoping at all. conversational-edit.js (ported verbatim,
 * Phase 4) calls `saveSession(session)` / `loadSession(sessionId)` with
 * that exact one-argument signature, so — matching the same approach
 * theme-state.js uses for buildThemeState/apply.js's `themeId` — tenant
 * scoping is encoded INTO the sessionId string itself
 * (composeSessionId/parseSessionId below) rather than by changing the
 * ported file's call sites. The caller that starts a session (the /api/edit
 * route) is responsible for generating sessionId via composeSessionId() so
 * every save/load call downstream can recover the owning store/user.
 */

const crypto = require('crypto');
const { eq } = require('drizzle-orm');
const instrumentation = require('./instrumentation');
const { serializeThemeState } = require('./theme-state');
const { db } = require('../../db');
const { conversationSessions } = require('../../db/schema/generation');

const SESSION_STATES = Object.freeze({
    IDLE: 'IDLE',
    UNDERSTANDING: 'UNDERSTANDING',
    NEEDS_CLARIFICATION: 'NEEDS_CLARIFICATION',
    READY_FOR_OPERATION: 'READY_FOR_OPERATION',
    APPLYING: 'APPLYING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED'
});

const CANCEL_PHRASES = ['cancel', 'never mind', 'nevermind', 'start over', 'forget it', 'reset', 'nvm'];

function normalize(text) {
    return (text || '').trim().toLowerCase().replace(/[.!]+$/, '');
}

function isCancelMessage(message) {
    const normalized = normalize(message);
    return CANCEL_PHRASES.includes(normalized);
}

function computeThemeStateVersion(themeState) {
    const serialized = serializeThemeState(themeState);
    return crypto.createHash('sha256').update(JSON.stringify(serialized)).digest('hex');
}

// --- Session shape, copied verbatim ---------------------------------------

function createSession({ sessionId, themeId } = {}) {
    const id = sessionId || instrumentation.nextRequestId('session');
    const now = new Date().toISOString();
    return {
        sessionId: id,
        themeId,
        status: SESSION_STATES.IDLE,
        currentIntent: null,
        pendingQuestion: null,
        pendingClarification: null,
        resolvedTarget: null,
        lastOperation: null,
        lastChangeSummary: null,
        lastMessage: null,
        lastResultStatus: null,
        themeStateVersion: null,
        turnCount: 0,
        createdAt: now,
        updatedAt: now
    };
}

function resetSession(session) {
    return {
        ...session,
        status: SESSION_STATES.IDLE,
        currentIntent: null,
        pendingQuestion: null,
        pendingClarification: null,
        resolvedTarget: null,
        lastOperation: null,
        lastChangeSummary: null,
        lastMessage: null,
        lastResultStatus: null
    };
}

function tokenize(text) {
    return (text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function matchCandidateFromAnswer(candidates, answerText) {
    const trimmed = (answerText || '').trim();

    if (/^\d+\.?$/.test(trimmed)) {
        const num = parseInt(trimmed, 10);
        if (num >= 1 && num <= candidates.length) return candidates[num - 1];
        return null;
    }

    const answerTokens = new Set(tokenize(trimmed));
    if (answerTokens.size === 0) return null;

    const scored = candidates.map(candidate => {
        const id = candidate.sectionId || candidate.blockId || '';
        const idTokens = tokenize(id.replace(/[-_]/g, ' '));
        const typeTokens = tokenize((candidate.type || '').replace(/[-_]/g, ' '));
        const candidateTokens = new Set([...idTokens, ...typeTokens]);
        let score = 0;
        for (const token of answerTokens) {
            if (candidateTokens.has(token)) score++;
        }
        return { candidate, score };
    }).filter(entry => entry.score > 0);

    if (scored.length === 0) return null;
    const topScore = Math.max(...scored.map(entry => entry.score));
    const top = scored.filter(entry => entry.score === topScore);
    return top.length === 1 ? top[0].candidate : null;
}

function mergeClarificationAnswer(pendingClarification, answerText) {
    if (!pendingClarification || !Array.isArray(pendingClarification.candidates) || pendingClarification.candidates.length === 0) {
        return { resolved: false, reason: 'NO_PENDING_CANDIDATES' };
    }
    const match = matchCandidateFromAnswer(pendingClarification.candidates, answerText);
    if (!match) return { resolved: false };
    return { resolved: true, match, kind: pendingClarification.kind };
}

// --- Rewritten: sessionId tenant-scoping + Postgres persistence ----------

const SESSION_ID_SEPARATOR = '::';

function composeSessionId(storeId, userId) {
    if (!storeId || !userId) throw new Error('composeSessionId() requires storeId and userId');
    return `${storeId}${SESSION_ID_SEPARATOR}${userId}${SESSION_ID_SEPARATOR}${crypto.randomUUID()}`;
}

function parseSessionId(sessionId) {
    const parts = (sessionId || '').split(SESSION_ID_SEPARATOR);
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
        throw new Error(`Invalid session id: "${sessionId}" (expected "storeId${SESSION_ID_SEPARATOR}userId${SESSION_ID_SEPARATOR}uuid")`);
    }
    return { storeId: parts[0], userId: parts[1] };
}

async function saveSession(session) {
    const { storeId, userId } = parseSessionId(session.sessionId);
    const toSave = { ...session, updatedAt: new Date().toISOString() };
    await db.insert(conversationSessions)
        .values({
            id: session.sessionId,
            storeId,
            userId,
            status: toSave.status,
            turnsJson: toSave,
            themeStateVersion: null
        })
        .onConflictDoUpdate({
            target: conversationSessions.id,
            set: {
                status: toSave.status,
                turnsJson: toSave,
                updatedAt: new Date()
            }
        });
    // conversationSessions.themeStateVersion is an integer column meant for
    // a monotonic counter, while the session's own themeStateVersion is a
    // sha256 content hash (computeThemeStateVersion above) — different
    // shapes, so it's intentionally left unset here rather than coerced;
    // the authoritative value lives in turnsJson.themeStateVersion.
    return toSave;
}

async function loadSession(sessionId) {
    const [row] = await db
        .select()
        .from(conversationSessions)
        .where(eq(conversationSessions.id, sessionId))
        .limit(1);
    return row ? row.turnsJson : null;
}

module.exports = {
    SESSION_STATES,
    computeThemeStateVersion,
    createSession,
    saveSession,
    loadSession,
    resetSession,
    isCancelMessage,
    matchCandidateFromAnswer,
    mergeClarificationAnswer,
    composeSessionId,
    parseSessionId
};
