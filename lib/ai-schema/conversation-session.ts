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

import crypto from "crypto";
import { eq } from "drizzle-orm";
import * as instrumentation from "./instrumentation";
import { serializeThemeState } from "./theme-state";
import { db } from "@/db";
import { conversationSessions } from "@/db/schema/generation";
import type { PendingClarification, Session, TargetResolutionCandidate, ThemeState } from "./types";

export const SESSION_STATES = Object.freeze({
    IDLE: "IDLE",
    UNDERSTANDING: "UNDERSTANDING",
    NEEDS_CLARIFICATION: "NEEDS_CLARIFICATION",
    READY_FOR_OPERATION: "READY_FOR_OPERATION",
    APPLYING: "APPLYING",
    COMPLETED: "COMPLETED",
    FAILED: "FAILED"
});

const CANCEL_PHRASES = ["cancel", "never mind", "nevermind", "start over", "forget it", "reset", "nvm"];

function normalize(text: string | undefined): string {
    return (text || "").trim().toLowerCase().replace(/[.!]+$/, "");
}

export function isCancelMessage(message: string | undefined): boolean {
    const normalized = normalize(message);
    return CANCEL_PHRASES.includes(normalized);
}

export function computeThemeStateVersion(themeState: ThemeState): string {
    const serialized = serializeThemeState(themeState);
    return crypto.createHash("sha256").update(JSON.stringify(serialized)).digest("hex");
}

// --- Session shape, copied verbatim ---------------------------------------

export function createSession({ sessionId, themeId }: { sessionId?: string; themeId?: string } = {}): Session {
    const id = sessionId || instrumentation.nextRequestId("session");
    const now = new Date().toISOString();
    return {
        sessionId: id,
        themeId: themeId!,
        status: SESSION_STATES.IDLE,
        currentIntent: null,
        pendingQuestion: null,
        pendingClarification: null,
        resolvedTarget: null,
        lastOperation: null,
        lastOperations: null,
        lastChangeSummary: null,
        lastMessage: null,
        lastResultStatus: null,
        themeStateVersion: null,
        turnCount: 0,
        createdAt: now,
        updatedAt: now
    };
}

export function resetSession(session: Session): Session {
    return {
        ...session,
        status: SESSION_STATES.IDLE,
        currentIntent: null,
        pendingQuestion: null,
        pendingClarification: null,
        resolvedTarget: null,
        lastOperation: null,
        lastOperations: null,
        lastChangeSummary: null,
        lastMessage: null,
        lastResultStatus: null
    };
}

function tokenize(text: string | undefined): string[] {
    return (text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export type CandidateMatchResult =
    | { type: "single"; candidate: TargetResolutionCandidate }
    // Merchant named more than one option ("1 and 3", "heading and text
    // both") — a turn only ever edits ONE target, so this is surfaced
    // distinctly from "none" rather than silently falling through to the
    // same dead-end as an answer that matched nothing at all.
    | { type: "multiple"; candidates: TargetResolutionCandidate[] }
    | { type: "none" };

export function matchCandidateFromAnswer(candidates: TargetResolutionCandidate[], answerText: string | undefined): CandidateMatchResult {
    const trimmed = (answerText || "").trim();

    if (/^\d+\.?$/.test(trimmed)) {
        const num = parseInt(trimmed, 10);
        if (num >= 1 && num <= candidates.length) return { type: "single", candidate: candidates[num - 1] };
        return { type: "none" };
    }

    // Several numbers named together ("1 and 3", "1, 3", "1 & 2") previously
    // matched nothing at all (the single-bare-number check above only fires
    // when the ENTIRE answer is one digit) and fell all the way through to
    // token scoring, where digits never match any id/type token either —
    // the merchant's answer was heard, just discarded.
    const numberMatches = trimmed.match(/\b\d+\b/g);
    if (numberMatches && numberMatches.length > 1) {
        const picked = [...new Set(numberMatches.map(n => parseInt(n, 10)))]
            .filter(n => n >= 1 && n <= candidates.length)
            .map(n => candidates[n - 1]);
        if (picked.length > 1) return { type: "multiple", candidates: picked };
        if (picked.length === 1) return { type: "single", candidate: picked[0] };
        return { type: "none" };
    }

    const answerTokens = new Set(tokenize(trimmed));
    if (answerTokens.size === 0) return { type: "none" };

    const scored = candidates.map(candidate => {
        const id = ("sectionId" in candidate ? candidate.sectionId : candidate.blockId) || "";
        const idTokens = tokenize(id.replace(/[-_]/g, " "));
        const typeTokens = tokenize((candidate.type || "").replace(/[-_]/g, " "));
        const candidateTokens = new Set([...idTokens, ...typeTokens]);
        let score = 0;
        for (const token of answerTokens) {
            if (candidateTokens.has(token)) score++;
        }
        return { candidate, score };
    }).filter(entry => entry.score > 0);

    if (scored.length === 0) return { type: "none" };
    const topScore = Math.max(...scored.map(entry => entry.score));
    const top = scored.filter(entry => entry.score === topScore);
    if (top.length === 1) return { type: "single", candidate: top[0].candidate };
    // A tie ("heading and text both" scores equally against both "Heading"
    // and "Text") is the same "named more than one" case as the multi-number
    // branch above, not a failed match.
    return { type: "multiple", candidates: top.map(entry => entry.candidate) };
}

export function mergeClarificationAnswer(pendingClarification: PendingClarification | null, answerText: string | undefined): { resolved: boolean; reason?: string; match?: TargetResolutionCandidate; candidates?: TargetResolutionCandidate[]; kind?: string } {
    if (!pendingClarification || !("candidates" in pendingClarification) || !Array.isArray(pendingClarification.candidates) || pendingClarification.candidates.length === 0) {
        return { resolved: false, reason: "NO_PENDING_CANDIDATES" };
    }
    const result = matchCandidateFromAnswer(pendingClarification.candidates, answerText);
    if (result.type === "single") return { resolved: true, match: result.candidate, kind: pendingClarification.kind };
    if (result.type === "multiple") return { resolved: false, reason: "MULTIPLE_SELECTED", candidates: result.candidates, kind: pendingClarification.kind };
    return { resolved: false, reason: "NO_MATCH" };
}

// --- Rewritten: sessionId tenant-scoping + Postgres persistence ----------

const SESSION_ID_SEPARATOR = "::";

export function composeSessionId(storeId: string, userId: string): string {
    if (!storeId || !userId) throw new Error("composeSessionId() requires storeId and userId");
    return `${storeId}${SESSION_ID_SEPARATOR}${userId}${SESSION_ID_SEPARATOR}${crypto.randomUUID()}`;
}

export function parseSessionId(sessionId: string | null | undefined): { storeId: string; userId: string } {
    const parts = (sessionId || "").split(SESSION_ID_SEPARATOR);
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
        throw new Error(`Invalid session id: "${sessionId}" (expected "storeId${SESSION_ID_SEPARATOR}userId${SESSION_ID_SEPARATOR}uuid")`);
    }
    return { storeId: parts[0], userId: parts[1] };
}

/**
 * The session id a chat request should continue: the client-supplied one when it belongs to
 * `storeId`, a fresh one when none was supplied, or null when the supplied id belongs to a
 * different store (the caller must reject the request).
 */
export function resolveRequestedSessionId(requestedSessionId: string | undefined, storeId: string, userId: string): string | null {
    if (!requestedSessionId) return composeSessionId(storeId, userId);
    return parseSessionId(requestedSessionId).storeId === storeId ? requestedSessionId : null;
}

export async function saveSession(session: Session): Promise<Session> {
    const { storeId, userId } = parseSessionId(session.sessionId);
    const toSave: Session = { ...session, updatedAt: new Date().toISOString() };
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

export async function loadSession(sessionId: string): Promise<Session | null> {
    const [row] = await db
        .select()
        .from(conversationSessions)
        .where(eq(conversationSessions.id, sessionId))
        .limit(1);
    return row ? (row.turnsJson as Session) : null;
}
