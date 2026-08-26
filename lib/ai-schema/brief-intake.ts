/**
 * Conversational generation intake — turns a chat message into WebsiteBrief
 * field updates, and decides what (if anything) to ask next.
 *
 * Mirrors generation.ts's Stage 1/2 pattern: one AI call, validated; a
 * single bounded repair retry if invalid; throws (fails closed) if the
 * repair attempt is also invalid. The caller (app/api/generate/chat/route.ts)
 * is responsible for turning that throw into a friendly chat response rather
 * than a hard error — a transient AI hiccup on one turn shouldn't dead-end
 * a conversation the way an invalid Stage 1/2 plan is allowed to abort a
 * background generation job.
 *
 * This module never talks to runStagedGeneration() directly — it only
 * produces an updated Brief. Readiness (isIntakeComplete below) is a
 * deterministic, non-AI decision the caller makes with the merged brief.
 */

import { makeAIRequest, OPENROUTER_FAST_MODEL } from "./ai-client";
import { BRIEF_FIELDS, isFieldPresent, isReady, mergeBrief, briefToSummaryText } from "./brief-logic";
import type { Brief, BriefField, BriefFieldStatus } from "./types";

const FIELD_DESCRIPTIONS: Record<string, string> = {
    businessType: "what kind of store/product line this is (e.g. 'pet supplements', 'handmade candles')",
    niche: "a more specific sub-category or angle within the business type",
    brandName: "the merchant's brand or store name, if mentioned",
    targetAudience: "who the store is for (e.g. 'new dog owners', 'busy professionals')",
    products: "the specific product(s) being sold",
    brandPersonality: "the brand's character/voice (e.g. 'playful and bold', 'calm and premium')",
    visualDirection: "desired visual style (e.g. 'minimal and modern', 'warm and rustic')",
    colorDirection: "any color preference mentioned (e.g. 'earthy tones', 'black and gold')",
    contentTone: "tone of the on-site copy (e.g. 'friendly', 'clinical and precise')",
    requiredPages: "specific pages the merchant wants beyond the homepage",
    homepageGoals: "what the homepage should accomplish (e.g. 'build trust', 'drive first purchase')",
    conversionGoals: "the primary action the store wants visitors to take",
    contentRequirements: "specific content the merchant wants included (e.g. reviews, a newsletter signup)",
    additionalRequirements: "anything else notable that doesn't fit the fields above"
};

const PRIORITY_FIELD_KEYS = ["businessType", "products", "brandPersonality", "visualDirection"];
const MAX_INTAKE_TURNS = 4;

/**
 * Whether enough of the brief is known to hand off to generation.
 *
 * MAX_INTAKE_TURNS is checked FIRST, ahead of any field requirement: a
 * merchant who answers every question with "not sure yet" would otherwise
 * never satisfy isReady() and would be asked forever. Below that ceiling,
 * businessType is required (same bar as brief-logic.ts's isReady()) plus a
 * small set of higher-leverage fields — what's being sold, brand character,
 * visual style — since those are what most change section choice and copy
 * tone. See finalizeBrief() for what happens when the ceiling is hit with
 * businessType still unknown.
 */
export function isIntakeComplete(brief: Brief, turnCount: number): boolean {
    if (turnCount >= MAX_INTAKE_TURNS) return true;
    if (!isReady(brief)) return false;
    return PRIORITY_FIELD_KEYS.every((key) => isFieldPresent(brief[key]));
}

/**
 * businessType is the one field the generation pipeline can't do anything
 * sensible without — briefToSummaryText() would otherwise hand the planner
 * an empty string. When the turn ceiling is reached and the merchant still
 * hasn't given one, fall back to the same generic default generate-cli.ts
 * uses for its --type flag rather than dead-ending the conversation.
 */
export function finalizeBrief(brief: Brief): Brief {
    if (isFieldPresent(brief.businessType)) return brief;
    return {
        ...brief,
        businessType: { value: "general store", status: "inferred", source: "intake_default" }
    };
}

function buildIntakeSystemPrompt(currentBrief: Brief): string {
    const fieldList = BRIEF_FIELDS.map((key) => `- "${key}": ${FIELD_DESCRIPTIONS[key]}`).join("\n");
    const known = briefToSummaryText(currentBrief);

    let prompt = `You are gathering requirements for an AI-generated Shopify store homepage, one short chat message at a time. Your job each turn is to (a) extract any of the fields below that the merchant's message states or clearly implies, and (b) ask ONE natural follow-up question if more high-value information would help, or null if you have enough for now.

FIELDS (extract only ones actually present in the message — do not guess wildly):
${fieldList}

Respond ONLY with valid JSON (no markdown, no explanation) in this exact shape:
{
  "fields": {
    "<fieldKey>": { "value": "<extracted value>", "status": "confirmed" | "inferred" }
  },
  "question": "<one natural-language follow-up question>" | null
}
Rules:
- Only include a key in "fields" if this message states or clearly implies it. Never include a field you're unsure about.
- Use "confirmed" only when the merchant said it directly in this message. Use "inferred" when you're deducing it from context.
- Never invent a field key outside the list above.
- Ask at most one question, phrased naturally (never a numbered list).
- If ${JSON.stringify(PRIORITY_FIELD_KEYS)} are already known (see below) and nothing critical is missing, set "question" to null.`;

    if (known) {
        prompt += `\n\nAlready known about this store so far (do not re-ask about these): ${known}`;
    } else {
        prompt += `\n\nNothing is known about this store yet — this is the first message.`;
    }

    return prompt;
}

function buildIntakeUserPrompt(message: string, repairErrors: string[] | null): string {
    let prompt = message;
    if (repairErrors && repairErrors.length > 0) {
        prompt += `\n\n(Your previous response was invalid for these reasons: ${repairErrors.join("; ")}. Respond again with ONLY the corrected JSON object.)`;
    }
    return prompt;
}

interface ParsedIntakeResponse {
    fields: Partial<Brief>;
    question: string | null;
}

function parseAndValidate(content: string | undefined): { parsed: ParsedIntakeResponse | null; errors: string[] } {
    let raw: unknown;
    try {
        raw = JSON.parse(content!);
    } catch (error) {
        return { parsed: null, errors: [`response was not valid JSON: ${(error as Error).message}`] };
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { parsed: null, errors: ["response is not a JSON object"] };
    }
    const r = raw as { fields?: unknown; question?: unknown };
    const errors: string[] = [];

    const fieldsInput = r.fields && typeof r.fields === "object" && !Array.isArray(r.fields) ? (r.fields as Record<string, unknown>) : null;
    if (!fieldsInput) {
        errors.push('"fields" must be an object');
    }
    if (r.question !== null && typeof r.question !== "string") {
        errors.push('"question" must be a string or null');
    }
    if (errors.length > 0) return { parsed: null, errors };

    const fields: Partial<Brief> = {};
    for (const [key, value] of Object.entries(fieldsInput!)) {
        if (!BRIEF_FIELDS.includes(key)) {
            errors.push(`"${key}" is not a known brief field`);
            continue;
        }
        if (!value || typeof value !== "object" || Array.isArray(value)) {
            errors.push(`fields["${key}"] must be an object`);
            continue;
        }
        const f = value as { value?: unknown; status?: unknown };
        if (f.value === undefined || f.value === null || f.value === "") {
            errors.push(`fields["${key}"].value must be a non-empty value`);
            continue;
        }
        if (f.status !== "confirmed" && f.status !== "inferred") {
            errors.push(`fields["${key}"].status must be "confirmed" or "inferred"`);
            continue;
        }
        fields[key] = { value: f.value, status: f.status as BriefFieldStatus, source: f.status === "confirmed" ? "user" : "ai_inference" } as BriefField;
    }

    if (errors.length > 0) return { parsed: null, errors };
    return { parsed: { fields, question: (r.question as string | null) ?? null }, errors: [] };
}

export interface BriefIntakeResult {
    brief: Brief;
    question: string | null;
    repaired: boolean;
}

export async function runBriefIntakeTurn({
    message,
    currentBrief,
    requestId
}: {
    message: string;
    currentBrief: Brief;
    requestId: string;
}): Promise<BriefIntakeResult> {
    const systemPrompt = buildIntakeSystemPrompt(currentBrief);

    // Pure field-extraction from a short chat message — well within a fast
    // model's reach, and each intake turn is a blocking round trip the
    // merchant is actively waiting on, so this is one of the highest-value
    // places to trade model tier for latency without touching the two
    // structural/creative calls in generation.ts.
    const firstContent = await makeAIRequest(buildIntakeUserPrompt(message, null), systemPrompt, 2, {
        requestId,
        callType: "brief_intake",
        model: OPENROUTER_FAST_MODEL
    });
    let { parsed, errors } = parseAndValidate(firstContent);
    let repaired = false;

    if (!parsed) {
        repaired = true;
        const repairContent = await makeAIRequest(buildIntakeUserPrompt(message, errors), systemPrompt, 2, {
            requestId,
            callType: "brief_intake_repair",
            model: OPENROUTER_FAST_MODEL
        });
        ({ parsed, errors } = parseAndValidate(repairContent));
        if (!parsed) {
            throw new Error(`Brief intake produced an invalid response even after a repair attempt: ${errors.join("; ")}`);
        }
    }

    return {
        brief: mergeBrief(currentBrief, parsed.fields),
        question: parsed.question,
        repaired
    };
}
