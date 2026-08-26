/**
 * Persistence for the chat-based generation-intake flow.
 *
 * Deliberately separate from conversation-session.ts rather than a
 * generalization of it: that file's Session type and save/load are shaped
 * around the targeted-edit flow (currentIntent, pendingClarification,
 * resolvedTarget, ...) and are consumed by conversational-edit.ts, so
 * widening them would put the working edit flow at risk for no gain. Only
 * composeSessionId/parseSessionId are reused — those are genuinely generic
 * (tenant scoping encoded into the id string, see that file's header).
 *
 * Both flows share the conversation_session table; a row's turnsJson is
 * distinguished by its `kind` discriminant, which loadIntakeSession checks
 * so an edit session id passed here is rejected rather than misread.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { briefs, conversationSessions } from "@/db/schema/generation";
import { parseSessionId } from "./conversation-session";
import type { Brief, IntakeSessionState } from "./types";

export function createIntakeSession(sessionId: string): IntakeSessionState {
    const now = new Date().toISOString();
    return {
        kind: "intake",
        sessionId,
        status: "COLLECTING",
        turnCount: 0,
        lastQuestion: null,
        lastMessage: null,
        jobId: null,
        createdAt: now,
        updatedAt: now
    };
}

export async function saveIntakeSession(state: IntakeSessionState): Promise<IntakeSessionState> {
    const { storeId, userId } = parseSessionId(state.sessionId);
    const toSave: IntakeSessionState = { ...state, updatedAt: new Date().toISOString() };
    await db
        .insert(conversationSessions)
        .values({
            id: state.sessionId,
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
    return toSave;
}

export async function loadIntakeSession(sessionId: string): Promise<IntakeSessionState | null> {
    const [row] = await db
        .select()
        .from(conversationSessions)
        .where(eq(conversationSessions.id, sessionId))
        .limit(1);
    if (!row) return null;

    const state = row.turnsJson as Partial<IntakeSessionState>;
    if (state?.kind !== "intake") {
        throw new Error(`Session "${sessionId}" is not a generation-intake session`);
    }
    return state as IntakeSessionState;
}

/**
 * One brief per session, so the session id doubles as the brief's primary
 * key — briefs.sessionId has no unique constraint of its own, and nothing
 * references briefs.id as a foreign key, which makes this the cleanest
 * upsert target (no read-before-write race).
 */
export async function saveBriefForSession(sessionId: string, brief: Brief): Promise<void> {
    await db
        .insert(briefs)
        .values({ id: sessionId, sessionId, briefJson: brief })
        .onConflictDoUpdate({
            target: briefs.id,
            set: { briefJson: brief, updatedAt: new Date() }
        });
}

export async function loadBriefForSession(sessionId: string): Promise<Brief | null> {
    const [row] = await db.select().from(briefs).where(eq(briefs.sessionId, sessionId)).limit(1);
    return row ? (row.briefJson as Brief) : null;
}
