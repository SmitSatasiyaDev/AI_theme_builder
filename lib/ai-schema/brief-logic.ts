/**
 * Phase 3 — WebsiteBrief model (pure logic subset).
 *
 * A WebsiteBrief holds the merchant's requirements as understood so far.
 * Every field uses the same per-field shape so callers can always tell
 * WHY a value is present (or absent) without guessing:
 *
 *   { value: <anything|null>, status: 'confirmed'|'inferred'|'missing', source: <string|null> }
 *
 *   - 'confirmed' — the merchant stated this directly (source: 'user').
 *   - 'inferred'  — the understanding call derived this from context
 *                   (source: 'ai_inference'), e.g. "premium pet wellness
 *                   store" implies targetAudience ~ "pet owners".
 *   - 'missing'   — no value yet.
 *
 * Only `businessType` is hard-blocking (BLOCKING_FIELD_KEYS) — see
 * AI_THEME_BUILDER_PHASE_PLAN.md Phase 3 spec: without knowing what kind of
 * store this is, nothing downstream can be meaningfully configured. Every
 * other field can receive a reasonable default later (Phase 5+), so its
 * absence never blocks READY_TO_GENERATE.
 *
 * This is a trimmed port of ai-schema/brief.js for the SaaS lib: it
 * contains ONLY the pure, in-memory logic from the source file. The
 * source's persistence layer (BRIEFS_DIR, saveBrief(), loadBrief(),
 * briefFilePath()) is deliberately NOT ported here — those functions do
 * filesystem I/O (plain JSON files under output/briefs/) that has no place
 * in this web app; a database-backed replacement is expected to be built
 * separately. None of the pure functions below depend on that persistence
 * layer for their behavior — they operate only on brief objects passed in
 * by the caller.
 */

import type { Brief, BriefField, BriefFieldStatus } from "./types";

export const BRIEF_FIELDS = [
    "businessType",
    "niche",
    "brandName",
    "targetAudience",
    "products",
    "brandPersonality",
    "visualDirection",
    "colorDirection",
    "contentTone",
    "requiredPages",
    "homepageGoals",
    "conversionGoals",
    "contentRequirements",
    "additionalRequirements"
];

export const BLOCKING_FIELD_KEYS = ["businessType"] as const;

const VALID_STATUSES = new Set<BriefFieldStatus>(["confirmed", "inferred", "missing"]);

export function createEmptyBrief(): Brief {
    const brief: Brief = {};
    for (const key of BRIEF_FIELDS) {
        brief[key] = { value: null, status: "missing", source: null };
    }
    return brief;
}

export function isFieldPresent(field: BriefField | undefined): boolean {
    return !!field && field.value !== null && field.value !== undefined &&
        field.value !== "" && field.status !== "missing";
}

/**
 * Merge one incoming field update into a brief field, never letting a
 * later 'inferred' overwrite an earlier 'confirmed' value for the same
 * field (a merchant's direct statement always outranks an AI guess), and
 * never letting an empty/missing incoming value erase a value already
 * known from a previous turn (Phase 3 spec: "must not restart from zero").
 */
export function mergeField(existing: BriefField | undefined, incoming: Partial<BriefField> | undefined): BriefField {
    if (!incoming || incoming.value === null || incoming.value === undefined || incoming.value === "") {
        return existing ?? { value: null, status: "missing", source: null };
    }
    if (existing && existing.status === "confirmed" && incoming.status !== "confirmed") {
        return existing;
    }
    return {
        value: incoming.value,
        status: incoming.status && VALID_STATUSES.has(incoming.status) ? incoming.status : "inferred",
        source: incoming.source || (incoming.status === "confirmed" ? "user" : "ai_inference")
    };
}

/**
 * Merge a partial brief (e.g. extracted from the latest understanding
 * call) into an existing brief, field by field. Unknown keys in `partial`
 * are ignored (defensive — the AI call is a schema, not a free field bag).
 */
export function mergeBrief(existingBrief: Brief | null | undefined, partial: Partial<Brief> | null | undefined): Brief {
    const base = existingBrief ? { ...existingBrief } : createEmptyBrief();
    const merged: Brief = {};
    for (const key of BRIEF_FIELDS) {
        merged[key] = mergeField(base[key], partial ? partial[key] : undefined);
    }
    return merged;
}

export function missingBlockingFields(brief: Brief): string[] {
    return BLOCKING_FIELD_KEYS.filter(key => !isFieldPresent(brief[key]));
}

export function isReady(brief: Brief): boolean {
    return missingBlockingFields(brief).length === 0;
}

/**
 * true only when the brief object has exactly the known fields, each with
 * a well-formed { value, status, source } shape. Used by clarification.js
 * to reject a malformed AI-extracted brief before it's trusted.
 */
export function isValidBriefShape(brief: unknown): brief is Brief {
    if (!brief || typeof brief !== "object" || Array.isArray(brief)) return false;
    const record = brief as Record<string, unknown>;
    for (const key of BRIEF_FIELDS) {
        const field = record[key];
        if (!field || typeof field !== "object" || Array.isArray(field)) return false;
        const f = field as Record<string, unknown>;
        if (!("value" in f) || !("status" in f)) return false;
        if (!VALID_STATUSES.has(f.status as BriefFieldStatus)) return false;
        if (f.status === "missing" && f.value !== null && f.value !== undefined && f.value !== "") {
            return false; // contradictory: claims missing but carries a value
        }
    }
    return true;
}

/**
 * Flattens a resolved WebsiteBrief into a single natural-language-ish
 * string — the form Phase 5's retrieval/generation prompts consume. Only
 * fields that actually carry a value are included (isFieldPresent), so an
 * empty/missing optional field never shows up as literal "null" text.
 */
export function briefToSummaryText(brief: Brief): string {
    const parts: string[] = [];
    for (const key of BRIEF_FIELDS) {
        const field = brief[key];
        if (isFieldPresent(field)) {
            const value = Array.isArray(field.value) ? field.value.join(", ") : field.value;
            parts.push(`${key}: ${value}`);
        }
    }
    return parts.join("; ");
}
