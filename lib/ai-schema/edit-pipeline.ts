/**
 * Phase 8 — Targeted Editing Orchestration.
 *
 * Wires together: deterministic request classification (§29/§30) →
 * deterministic target resolution against ThemeState (operations.js, §8/§9)
 * → clarification on ambiguity (§10/§23) → ONE bounded AI operation
 * PROPOSAL scoped to just the resolved target (§12) → deterministic
 * validation/execution (operations.js, unmodified) → optional Phase 7
 * apply (§26).
 *
 * The split this file preserves, matching §24 exactly (and the same split
 * Phase 5 already established for GenerationPlan): the AI PROPOSES one
 * operation object; this file's `runOperationProposalStage()` never trusts
 * it directly — `operations.js`'s `validateOperation()`/
 * `applyOperationToThemeState()` (both untouched, reused as-is) are the
 * only code that decides whether a proposal is safe and the only code that
 * actually mutates a ThemeState. This file adds no new mutation logic of
 * its own.
 *
 * §27 — a targeted edit must never fall into Phase 7's full-structure
 * replacement path. It doesn't: `runTargetedEdit()`'s optional apply step
 * calls `apply.js`'s `applyThemeState()` DIRECTLY on the
 * operation-mutated ThemeState, never `merge.js`. `merge.js`'s two
 * policies (splice-by-type / full-structure-replace) exist specifically to
 * reconcile a whole-template INITIAL GENERATION candidate against existing
 * state (see merge.js's file header) — an operation's result is neither of
 * those; `executeOperation()` in operations.js already knows precisely
 * what changed and what to preserve, so there is nothing left for
 * merge.js's policy logic to decide. This is the one Phase 7 boundary
 * worth calling out explicitly, per §27's own warning.
 */

import * as instrumentation from "./instrumentation";
import { retrieveRelevantSchemas } from "./retrieval";
import { makeAIRequest } from "./ai-client";
import {
    OPERATION_TYPES,
    resolveSectionTarget,
    resolveBlockTarget,
    validateOperation,
    applyOperationToThemeState,
    applyTargetsForOperations
} from "./operations";
// apply.js stays plain CommonJS (out of scope — Shopify-facing apply path);
// esModuleInterop lets this named import work against its `module.exports`.
import { applyThemeState } from "./apply";
import type {
    ChangeSummary,
    EditTurnResult,
    KnownMerchantData,
    Operation,
    SchemaCatalog,
    SectionTargetResolution,
    TargetContext,
    TargetResolutionCandidate,
    TargetSummary,
    ThemeState,
    ValidationIssue
} from "./types";

// ---------------------------------------------------------------------------
// §29/§30 — deterministic request classification. Intentionally small: a
// short, curated verb list, not NLP. "Do not over-classify" — an unclear
// request routes to AMBIGUOUS (clarification), never a guessed operation
// count.
// ---------------------------------------------------------------------------

export const CREATE_SIGNAL_PHRASES = ["create a", "create an", "build a", "build me", "design a", "generate a", "make me a store", "make a store", "make a homepage", "redesign", "entire store", "whole store", "entire homepage"];
export const EDIT_VERBS = ["change", "update", "remove", "delete", "add", "move", "replace", "edit", "modify", "set"];

// A request only has a legitimate reason to target NO existing section when
// it's asking to CREATE one — everything else (update/remove/a vague "change
// one section" with no section named) needs an existing target, so a
// NOT_FOUND resolution there must ask which section rather than let the AI
// guess an operation with zero grounding.
export const ADD_SIGNAL_VERBS = ["add", "create", "insert", "new"];

// A removal is a complete instruction the moment its target is identified —
// "remove the testimonials section" has nothing left to ask about, unlike
// an update/add which still needs to say what the new value/content is.
// hasChangeDetails() would otherwise see nothing but generic words + the
// target's own identity left after stripping and (wrongly) ask "what would
// you like to change?" for a request that never needed an answer.
const REMOVE_SIGNAL_VERBS = ["remove", "delete"];

export function classifyRequest(userPrompt: string): "INITIAL_GENERATION" | "TARGETED_EDIT" | "AMBIGUOUS" {
    const lower = (userPrompt || "").toLowerCase();
    if (CREATE_SIGNAL_PHRASES.some(phrase => lower.includes(phrase))) {
        return "INITIAL_GENERATION";
    }
    if (EDIT_VERBS.some(verb => new RegExp(`\\b${verb}\\b`).test(lower))) {
        return "TARGETED_EDIT";
    }
    return "AMBIGUOUS";
}

// ---------------------------------------------------------------------------
// §10 — clarification question shape, matching clarification.js's existing
// protocol (an array of plain-text questions) rather than inventing a
// second question format.
// ---------------------------------------------------------------------------

// Merchant-facing labels never surface a raw id/type token (e.g.
// "product_price_block (product_price)") — those are internal identifiers
// with no meaning to someone who didn't write the schema. Prefer the
// schema's own human-readable `label`; if a block/section type has none,
// fall back to turning its id into words rather than printing the id itself.
function wordsOf(value: string | undefined): string[] {
    return (value || "").toLowerCase().replace(/[_-]+/g, " ").trim().split(/\s+/).filter(Boolean);
}

function titleCase(words: string[]): string {
    return words.map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

// Two candidates can share the same underlying type (e.g. three separate
// "collapsible-row" blocks for care/shipping/materials info) — the schema
// label alone would print the same text three times and leave the merchant
// unable to tell them apart. When a label repeats within this candidate
// list, append whatever the id itself adds beyond the label/type words
// (dropping generic filler like "block"/"section") so each option stays
// distinct without ever printing the raw id.
function describeCandidateOptions(candidates: TargetResolutionCandidate[], schemas: SchemaCatalog): string {
    const FILLER = new Set(["block", "section"]);
    const described = candidates.map(candidate => {
        const id = "sectionId" in candidate ? candidate.sectionId : candidate.blockId;
        const type = candidate.type;
        const schema = "sectionId" in candidate
            ? schemas.sectionSchemas.find(s => s.id === type)
            : schemas.blockSchemas.find(b => b.id === type);
        const label = schema?.label || titleCase(wordsOf(type || id)) || id;
        return { label, idWords: wordsOf(id), labelWords: new Set(wordsOf(label)) };
    });

    const labelCounts = new Map<string, number>();
    described.forEach(d => labelCounts.set(d.label, (labelCounts.get(d.label) || 0) + 1));

    return described.map((d, i) => {
        if ((labelCounts.get(d.label) || 0) <= 1) return `${i + 1}. ${d.label}`;
        const distinguishing = d.idWords.filter(word => !d.labelWords.has(word) && !FILLER.has(word));
        return distinguishing.length > 0 ? `${i + 1}. ${d.label} (${titleCase(distinguishing)})` : `${i + 1}. ${d.label}`;
    }).join("\n");
}

export function buildAmbiguityQuestion(candidates: TargetResolutionCandidate[], kind: string, schemas: SchemaCatalog): string {
    return `I found a few ${kind}s that could match — which one did you mean?\n${describeCandidateOptions(candidates, schemas)}`;
}

// A retry after an unresolved clarification answer must never repeat the
// exact same question text — that's what reads as "the bot isn't listening"
// (§ chatbox trust: an identical prompt gives the merchant zero signal their
// answer was even received). Two known reasons an answer fails to resolve:
// they named MORE THAN ONE option ("1 and 3", "heading and text both" — a
// turn only ever edits one target), or their answer didn't match anything
// this system understands. Each gets its own wording, and the
// MULTIPLE_SELECTED case narrows the option list down to just the ones they
// named, rather than repeating the full original list.
export function buildClarificationRetryQuestion(reason: string | undefined, candidates: TargetResolutionCandidate[], kind: string, schemas: SchemaCatalog): string {
    if (reason === "MULTIPLE_SELECTED") {
        return `I can only change one ${kind} at a time — which of these did you mean?\n${describeCandidateOptions(candidates, schemas)}`;
    }
    return `Sorry, I didn't catch that — please reply with just the number of the ${kind} you meant:\n${describeCandidateOptions(candidates, schemas)}`;
}

// ---------------------------------------------------------------------------
// §10/§11 — minimal clarification. A resolved target alone isn't enough to
// propose an operation when the intent is purely "change the banner" — no
// AI call is bounded/cheap enough to justify guessing WHAT changed when the
// merchant never said. Deterministic, not NLP: strip generic edit verbs and
// the target's own id/type tokens from the intent; if anything real is left
// over, there's enough to propose from ("Change the hero heading to Healthy
// nutrition for every dog." skips this question entirely); if nothing is
// left, ask exactly one question instead of spending an AI call on a guess.
// Shared by runTargetedEdit() below (a target resolved on the FIRST pass —
// including via the AI-assisted resolution above, or via a merged-intent
// retry) and conversational-edit.js (a target resolved via a SECOND-round
// clarification answer) — same rule, one definition, either path.
// ---------------------------------------------------------------------------

export const GENERIC_INTENT_WORDS = new Set([
    "the", "a", "an", "to", "of", "on", "for", "my", "this", "that", "it",
    "please", "i", "want", "would", "like", "me", "can", "you", "need", "is",
    // Structural/vague nouns naming WHAT KIND of thing is being touched
    // (already established by the resolved target itself), not WHAT the
    // new value should be.
    "one", "some", "section", "sections", "block", "content",
    // WHERE, not WHAT — answers "which area of the theme", the same
    // question target RESOLUTION already asks, not "what should it say/look
    // like now" (what hasChangeDetails() actually needs to see).
    "homepage", "home", "page", "template", "site", "store", "website"
]);

function intentTokenize(text: string | undefined): string[] {
    return (text || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function hasChangeDetails(intentText: string | null | undefined, target: { sectionId?: string | null; blockId?: string | null; type?: string | null; blockType?: string | null; contentPreview?: string | null }): boolean {
    // A resolved target's own identity now includes its VISIBLE text (e.g.
    // preview "Why Choose Us" from target-resolution matching that same
    // phrase in the merchant's own words, see buildSectionListingAcrossTemplates
    // above) — those words named/located the section, they didn't say what
    // it should become, so they must be stripped just like sectionId/type
    // already are. Without this, "change the Why Choose Us section's
    // content" leaves "why choose us" as its own "remaining" tokens once the
    // generic words are gone, and this wrongly reports a real instruction
    // was given when nothing about the NEW value was ever said.
    const targetTokens = new Set(intentTokenize([target.sectionId, target.blockId, target.type, target.blockType, target.contentPreview]
        .filter(Boolean).join(" ").replace(/[-_]/g, " ")));
    const remaining = intentTokenize(intentText || undefined).filter(token =>
        !GENERIC_INTENT_WORDS.has(token) && !targetTokens.has(token) && !EDIT_VERBS.includes(token));
    return remaining.length > 0;
}

// ---------------------------------------------------------------------------
// §12 — bounded operation-proposal prompt. Scoped to the resolved target's
// CURRENT settings + its own schema (never the whole ThemeState, never the
// whole catalog); for add-shaped requests where nothing resolved, scoped to
// Phase 2's deterministic retrieval pool for this template (already
// bounded, already tested) rather than the full 69-schema catalog.
// ---------------------------------------------------------------------------

interface CandidatePool {
    sections: Array<{ id: string; label?: string; summary?: string }>;
    blocks: Array<{ id: string; label?: string; summary?: string }>;
}

export function buildProposalSystemPrompt(templateName: string, targetContext: TargetContext | null, candidatePool: CandidatePool | null): string {
    let rules = `You are a Shopify theme EDITOR. The merchant wants exactly ONE targeted change to their EXISTING theme. Propose exactly ONE structured operation as JSON:
{
  "operation": "<one of: ${OPERATION_TYPES.join(", ")}>",
  "target": { "templateName": "${templateName}", "sectionId": "<existing section id, if editing/removing one>", "blockId": "<existing block id, if editing/removing one>" },
  "changes": { "settings": { }, "type": "<existing schema type id, only for add_section/add_block>", "position": "start|end" }
}

CRITICAL RULES:
1. If the operation targets an EXISTING section or block, target.sectionId/target.blockId MUST be copied VERBATIM from CURRENT TARGET CONTEXT below — never invent an id.
2. changes.settings must use ONLY setting keys defined by the relevant schema below, and must include ONLY the settings that are actually changing — do not restate settings that aren't changing.
3. For add_section/add_block, changes.type must be copied VERBATIM from an "id" listed in AVAILABLE TYPES below.
4. Never invent a product handle, collection handle, or other merchant-specific data — leave such a setting out of changes entirely if you don't know a real value.
5. Return ONLY the JSON object — no explanation, no markdown.
6. If the request does not clearly map to exactly one of the supported operation types, still propose your best single guess — validation will catch anything unsafe.`;

    if (targetContext) {
        rules += `\n\nCURRENT TARGET CONTEXT (the existing component you are most likely editing):\n${JSON.stringify(targetContext)}`;
    }
    if (candidatePool) {
        rules += `\n\nAVAILABLE TYPES (for add_section/add_block only):\n${JSON.stringify(candidatePool)}`;
    }
    return rules;
}

export function buildProposalUserPrompt(userPrompt: string, repairErrors: string[] | null): string {
    let prompt = `Merchant request: "${userPrompt}"\n\nProduce the operation JSON now.`;
    if (repairErrors && repairErrors.length > 0) {
        prompt += `\n\nYour previous response was invalid for these reasons: ${repairErrors.join("; ")}. Fix these issues and respond again with ONLY the corrected JSON object.`;
    }
    return prompt;
}

// ---------------------------------------------------------------------------
// Target resolution — when NOTHING in the default template matches by
// keyword overlap at all, that's exactly the case where a merchant's own
// wording can't be trusted to deterministic scoring: a word like "footer"
// might name the actual target ("change the footer text"), or might just be
// a LANDMARK for locating something else entirely ("the section before the
// footer"). Keyword overlap can't tell those apart — only understanding the
// sentence can. So this is the one place a bounded AI call gets to make that
// judgment call itself, across every template's sections at once, and is
// EXPLICITLY allowed to say "I'm not sure" with its own clarifying question
// instead of guessing — deterministic code still never trusts its answer
// without checking the id it names actually exists (§8/§9's rule, applied
// here too).
// ---------------------------------------------------------------------------

export interface SectionListingEntry {
    templateName: string;
    sectionId: string;
    type: string;
    /** 1-based position within the page's rendered section order. */
    position: number;
    totalSections: number;
    previousSectionId: string | null;
    nextSectionId: string | null;
    /** Visible on-page text (headings/body copy), for matching a merchant's
     *  description of what a section SAYS rather than what it's called. */
    preview: string;
}

// Non-content string setting values (hex colors, raw numbers/units, layout
// enums like "center"/"large") that would otherwise pollute the preview —
// settings.js's SectionSchema doesn't tag which settings are free text vs.
// an enum, so this is a stoplist rather than a schema-driven filter; it only
// ever drops known non-content tokens, never real copy.
const NON_CONTENT_VALUE_PATTERN = /^#[0-9a-f]{3,8}$|^\d+(\.\d+)?(px|%|em|rem)?$/i;
const NON_CONTENT_VALUE_WORDS = new Set([
    "left", "right", "center", "top", "bottom", "middle",
    "small", "medium", "large", "none", "auto",
    "vertical", "horizontal", "true", "false"
]);

// A merchant describes a section by what it's called (id/type), where it
// sits on the page (position, "after the slider"), or what it visibly says
// ("Why Choose Us") — often the last of those three, since that's what they
// actually see. Only id/type used to reach the AI candidate listing before
// this; a free-text chatbox needs all three, since there's no fixed
// vocabulary a merchant's own words are guaranteed to hit.
export function extractSectionTextPreview(settings: Record<string, unknown> | undefined | null, maxLength = 180): string {
    if (!settings) return "";
    const strings = Object.values(settings)
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map(value => value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())
        .filter(value => value && !NON_CONTENT_VALUE_PATTERN.test(value) && !NON_CONTENT_VALUE_WORDS.has(value.toLowerCase()));
    const joined = strings.join(" | ");
    return joined.length > maxLength ? `${joined.slice(0, maxLength)}…` : joined;
}

export function buildSectionListingAcrossTemplates(themeState: ThemeState): SectionListingEntry[] {
    const listing: SectionListingEntry[] = [];
    for (const [templateName, template] of Object.entries(themeState.templates || {})) {
        const sections = (template.raw && template.raw.sections) || {};
        // Rendered page order (template.raw.order), not JSON key-insertion
        // order — those two routinely differ, and position/"after X" only
        // means anything relative to the order the merchant actually sees.
        const order = (template.raw && template.raw.order && template.raw.order.length > 0)
            ? template.raw.order.filter(id => Object.prototype.hasOwnProperty.call(sections, id))
            : Object.keys(sections);
        order.forEach((sectionId, index) => {
            const section = sections[sectionId];
            listing.push({
                templateName,
                sectionId,
                type: section.type,
                position: index + 1,
                totalSections: order.length,
                previousSectionId: index > 0 ? order[index - 1] : null,
                nextSectionId: index < order.length - 1 ? order[index + 1] : null,
                preview: extractSectionTextPreview(section.settings)
            });
        });
    }
    return listing;
}

export function buildTargetResolutionSystemPrompt(sectionListing: SectionListingEntry[]): string {
    return `You are helping locate WHICH EXISTING section of a Shopify theme a merchant's edit request refers to. This is a free-text chatbox — the merchant can describe the section any way they like: by its visible text/heading ("the Why Choose Us section"), by its position on the page ("the second section", "the one right after the slider"), by what it's called (id/type), or vaguely. Their own words may also name another area only as a LANDMARK for finding something else ("the section before the footer") rather than as the actual target — use your judgment about what they actually mean, not just keyword overlap.

Each entry below is one existing section:
- templateName/sectionId/type: its identity.
- position/totalSections: its 1-based position in the page's actual rendered order (e.g. position 2 of 6 = "the second section").
- previousSectionId/nextSectionId: its neighbors, for landmark phrasing ("after X", "before Y", "right after the slider").
- preview: the actual visible text (headings/body copy) rendered on the page for that section — this is usually the strongest signal, since merchants describe sections by what they say, not by an internal id.

Respond with EXACTLY ONE JSON object, in ONE of these two shapes:
{"confident": true, "templateName": "<templateName>", "sectionId": "<sectionId>"}
{"confident": false, "clarifyingQuestion": "<optional: one short question to ask the merchant, if you have a specific one in mind>"}

CRITICAL RULES:
1. templateName/sectionId, if given, MUST be copied VERBATIM from EXISTING SECTIONS below — never invent one.
2. Only set confident:true if you are reasonably sure which ONE section is meant. If multiple sections could equally match, or nothing clearly matches, set confident:false instead of guessing.
3. When confident:false, include "clarifyingQuestion" if you have a specific, useful question to ask — omit it if you don't; a generic fallback will be used instead.
4. Return ONLY the JSON object — no explanation, no markdown.

EXISTING SECTIONS (every section in every template/page of this theme):
${JSON.stringify(sectionListing)}`;
}

export function buildTargetResolutionUserPrompt(userPrompt: string, repairErrors: string[] | null): string {
    let prompt = `Merchant request: "${userPrompt}"\n\nProduce the JSON now.`;
    if (repairErrors && repairErrors.length > 0) {
        prompt += `\n\nYour previous response was invalid for these reasons: ${repairErrors.join("; ")}. Fix these issues and respond again with ONLY the corrected JSON object.`;
    }
    return prompt;
}

export interface TargetResolutionAI {
    confident: boolean;
    templateName?: string;
    sectionId?: string;
    clarifyingQuestion?: string;
}

interface MessageValidationResult {
    valid: boolean;
    errors: Array<{ message: string }>;
}

export function validateTargetResolution(resolution: unknown, themeState: ThemeState): MessageValidationResult {
    if (!resolution || typeof resolution !== "object") {
        return { valid: false, errors: [{ message: "response is not a JSON object" }] };
    }
    const r = resolution as Partial<TargetResolutionAI>;
    if (typeof r.confident !== "boolean") {
        return { valid: false, errors: [{ message: '"confident" must be a boolean' }] };
    }
    if (r.confident === true) {
        const { templateName, sectionId } = r;
        if (typeof templateName !== "string" || typeof sectionId !== "string") {
            return { valid: false, errors: [{ message: 'confident:true requires string "templateName" and "sectionId"' }] };
        }
        const template = themeState.templates[templateName];
        const section = template && template.raw.sections[sectionId];
        if (!section) {
            return { valid: false, errors: [{ message: `"${templateName}"."${sectionId}" does not exist — templateName/sectionId must be copied verbatim from EXISTING SECTIONS` }] };
        }
        return { valid: true, errors: [] };
    }
    if (r.clarifyingQuestion !== undefined && (typeof r.clarifyingQuestion !== "string" || !r.clarifyingQuestion.trim())) {
        return { valid: false, errors: [{ message: 'if present, "clarifyingQuestion" must be a non-empty string' }] };
    }
    return { valid: true, errors: [] };
}

/**
 * ONE bounded AI call, ONE bounded repair — same shape as
 * runOperationProposalStage() below. Deterministic code (validateTargetResolution
 * above) is what actually decides whether the AI's pick is trustworthy; this
 * function never returns a target that doesn't verifiably exist.
 */
export async function runTargetResolutionStage({ userPrompt, themeState, requestId }: { userPrompt: string; themeState: ThemeState; requestId: string }): Promise<{ resolution: TargetResolutionAI | null; validation: MessageValidationResult; repaired: boolean }> {
    const sectionListing = buildSectionListingAcrossTemplates(themeState);
    const systemPrompt = buildTargetResolutionSystemPrompt(sectionListing);

    function parseAndValidate(content: string | undefined): { resolution: TargetResolutionAI | null; validation: MessageValidationResult } {
        let resolution: TargetResolutionAI;
        try {
            resolution = JSON.parse(content!);
        } catch (error) {
            return { resolution: null, validation: { valid: false, errors: [{ message: `not valid JSON: ${(error as Error).message}` }] } };
        }
        return { resolution, validation: validateTargetResolution(resolution, themeState) };
    }

    const firstContent = await makeAIRequest(buildTargetResolutionUserPrompt(userPrompt, null), systemPrompt, 2, { requestId, callType: "target_resolution" });
    let { resolution, validation } = parseAndValidate(firstContent);
    let repaired = false;

    if (!validation.valid) {
        repaired = true;
        const repairErrors = validation.errors.map(e => e.message);
        const repairContent = await makeAIRequest(buildTargetResolutionUserPrompt(userPrompt, repairErrors), systemPrompt, 2, { requestId, callType: "target_resolution_repair" });
        ({ resolution, validation } = parseAndValidate(repairContent));
    }

    return { resolution, validation, repaired };
}

// ---------------------------------------------------------------------------
// A merchant-checkable identity for whatever a just-executed operation
// actually touched — same order/preview signals as the section listing
// above, computed post-execution (deriveResolvedTarget's ChangeSummary.target
// already follows this rule, for the same reason: add_section's real id only
// exists after execution). Shared by every call site that builds a final
// PROPOSED/APPLIED EditTurnResult (this file's runTargetedEdit, and
// conversational-edit.js's proposeAndExecuteForTarget/runMultiOperationTurn)
// so the chat can show "this is the section that actually changed" —
// visible text and page position included — before the merchant hits Apply.
// ---------------------------------------------------------------------------

export function buildTargetSummary(themeState: ThemeState, changeSummary: ChangeSummary | null | undefined): TargetSummary | null {
    if (!changeSummary || changeSummary.target === "globalSettings") return null;
    const [templateName, sectionId] = changeSummary.target.split(".");
    if (!templateName || !sectionId) return null;

    const template = themeState.templates[templateName];
    const sections = (template && template.raw && template.raw.sections) || {};
    const section = sections[sectionId];
    // remove_section: the section no longer exists post-execution — still
    // worth naming what was removed, just with no position/preview left.
    if (!section) return { templateName, sectionId };

    const order = (template.raw.order && template.raw.order.length > 0)
        ? template.raw.order.filter(id => Object.prototype.hasOwnProperty.call(sections, id))
        : Object.keys(sections);
    const index = order.indexOf(sectionId);

    return {
        templateName,
        sectionId,
        sectionType: section.type,
        position: index >= 0 ? index + 1 : undefined,
        totalSections: index >= 0 ? order.length : undefined,
        preview: extractSectionTextPreview(section.settings)
    };
}

/**
 * ONE bounded AI call, ONE bounded repair — the exact same shape
 * generation.js's runPlanningStage() already established for GenerationPlan
 * (§21's "bounded recovery" architecture, reused, not reinvented).
 */
export async function runOperationProposalStage({ userPrompt, templateName, targetContext, candidatePool, themeState, schemas, knownMerchantData, requestId }: {
    userPrompt: string;
    templateName: string;
    targetContext: TargetContext | null;
    candidatePool: CandidatePool | null;
    themeState: ThemeState;
    schemas: SchemaCatalog;
    knownMerchantData?: KnownMerchantData;
    requestId: string;
}): Promise<{ operation: Operation | null; validation: { valid: boolean; errors: ValidationIssue[] }; repaired: boolean }> {
    const systemPrompt = buildProposalSystemPrompt(templateName, targetContext, candidatePool);
    const validationContext = { themeState, schemas, knownMerchantData };

    function parseAndValidate(content: string | undefined): { operation: Operation | null; validation: { valid: boolean; errors: ValidationIssue[] } } {
        let operation: Operation;
        try {
            operation = JSON.parse(content!);
        } catch (error) {
            return { operation: null, validation: { valid: false, errors: [{ code: "OPERATION_INVALID", path: "operation", message: `not valid JSON: ${(error as Error).message}` }] } };
        }
        return { operation, validation: validateOperation(operation, validationContext) };
    }

    const firstContent = await makeAIRequest(buildProposalUserPrompt(userPrompt, null), systemPrompt, 2, { requestId, callType: "operation_proposal" });
    let { operation, validation } = parseAndValidate(firstContent);
    let repaired = false;

    if (!validation.valid) {
        repaired = true;
        const repairErrors = validation.errors.map(e => e.message);
        const repairContent = await makeAIRequest(buildProposalUserPrompt(userPrompt, repairErrors), systemPrompt, 2, { requestId, callType: "operation_proposal_repair" });
        ({ operation, validation } = parseAndValidate(repairContent));
    }

    return { operation, validation, repaired };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface RunTargetedEditOptions {
    themeState: ThemeState;
    schemas: SchemaCatalog;
    knownMerchantData?: KnownMerchantData;
    autoApply?: boolean;
    themeRoot?: string;
    dryRunApply?: boolean;
    requestId?: string;
    templateName?: string;
}

/**
 * options:
 *   - themeState: REQUIRED, a Phase 4 ThemeState.
 *   - schemas: REQUIRED, the full AI schema catalog.
 *   - templateName: default 'index'.
 *   - knownMerchantData: optional {products:[], collections:[]}.
 *   - autoApply: if true, a successfully executed operation is also
 *     persisted via apply.js (still an explicit, opt-in step — §22's
 *     "apply must be explicit" applies here exactly as it does in
 *     1-generate-theme.js).
 *   - themeRoot / dryRunApply: forwarded to applyThemeState() when
 *     autoApply is set.
 */
export async function runTargetedEdit(userPrompt: string, options: RunTargetedEditOptions): Promise<EditTurnResult> {
    const {
        themeState,
        schemas,
        knownMerchantData = {},
        autoApply = false,
        themeRoot,
        dryRunApply = false,
        requestId = instrumentation.nextRequestId("edit")
    } = options;
    // Mutable: an AI-assisted resolution below (§10/§29) can switch this to
    // a DIFFERENT template than the one the turn started in, when the
    // merchant's own wording named no section in the default scope.
    let templateName = options.templateName || "index";

    if (!themeState) throw new Error("runTargetedEdit() requires a ThemeState");
    if (!schemas || !Array.isArray(schemas.sectionSchemas)) throw new Error("runTargetedEdit() requires the full AI schema catalog");

    const startTime = Date.now();
    const classification = classifyRequest(userPrompt);

    if (classification !== "TARGETED_EDIT") {
        instrumentation.logEditPipeline({ requestId, status: classification, classification, durationMs: Date.now() - startTime });
        return { status: classification, classification };
    }

    // §8/§9 — deterministic target resolution against ThemeState, using the
    // raw request text as the natural-language query. An exact existing
    // section id embedded in the prompt (unlikely from a human, common from
    // a programmatic caller) short-circuits via resolveSectionTarget()'s own
    // exact-match fast path.
    let sectionTarget: SectionTargetResolution = resolveSectionTarget(themeState, templateName, userPrompt, schemas);

    // Keyword-overlap scoring can fail two different ways — a tie
    // (AMBIGUOUS, e.g. a generic word like "content" happens to sit in
    // several sections' category tags) or nothing at all (NOT_FOUND) — and
    // either way, understanding what the merchant actually meant needs more
    // than word overlap: "the section before the footer" and "the footer
    // section" share every keyword but mean different things. So BOTH cases
    // give a bounded AI call first say at resolving it (across every
    // template, not just this one), and it's EXPLICITLY allowed to say "not
    // confident" with its own clarifying question rather than guess —
    // deterministic code still never trusts its pick without checking the
    // id it names actually exists (validateTargetResolution). This does NOT
    // apply when the template itself isn't present in the ThemeState at all
    // — that's the legitimate shape of a global-settings-only request (no
    // section is ever the target for update_global_settings), which must
    // still reach the AI proposal below.
    const targetTemplate = themeState.templates[templateName];
    let resolutionAiCallCount = 0;
    if ((sectionTarget.status === "AMBIGUOUS" || sectionTarget.status === "NOT_FOUND") && targetTemplate) {
        const looksLikeAdd = sectionTarget.status === "NOT_FOUND" && ADD_SIGNAL_VERBS.some(verb => new RegExp(`\\b${verb}\\b`, "i").test(userPrompt));
        if (!looksLikeAdd) {
            const { resolution, validation: resolutionValidation, repaired: resolutionRepaired } = await runTargetResolutionStage({ userPrompt, themeState, requestId });
            resolutionAiCallCount = resolutionRepaired ? 2 : 1;

            if (resolutionValidation.valid && resolution && resolution.confident === true) {
                // The AI identified an existing target — possibly in a
                // DIFFERENT template than this turn started in — so switch
                // scope to match and resolve it via the exact-id fast path
                // (already verified to exist by validateTargetResolution).
                templateName = resolution.templateName!;
                sectionTarget = resolveSectionTarget(themeState, templateName, resolution.sectionId!, schemas);
            } else {
                // Not confident (or an invalid/hallucinated response even
                // after one repair attempt) — ask the merchant instead of
                // guessing. Prefer the AI's own open-ended question (merged
                // into the intent and re-resolved next turn — no fixed list
                // to match a free-text answer against); if even that's
                // unusable, an AMBIGUOUS tie still has real (if imperfect)
                // tied candidates to fall back to, which is a better last
                // resort than a generic prompt with nothing behind it.
                const useDeterministicFallback = !(resolutionValidation.valid && resolution && resolution.clarifyingQuestion) && sectionTarget.status === "AMBIGUOUS";
                const result: EditTurnResult = useDeterministicFallback && sectionTarget.status === "AMBIGUOUS"
                    ? {
                        status: "NEEDS_CLARIFICATION",
                        classification,
                        targetStatus: sectionTarget.status,
                        templateName,
                        candidates: sectionTarget.candidates,
                        questions: [buildAmbiguityQuestion(sectionTarget.candidates, "section", schemas)]
                    }
                    : {
                        status: "NEEDS_CLARIFICATION",
                        classification,
                        targetStatus: sectionTarget.status,
                        templateName,
                        candidates: [],
                        questions: [(resolutionValidation.valid && resolution && resolution.clarifyingQuestion) ? resolution.clarifyingQuestion : "Which section would you like to change?"]
                    };
                instrumentation.logEditPipeline({ requestId, status: result.status, classification, targetStatus: sectionTarget.status, aiCallCount: resolutionAiCallCount, repaired: resolutionRepaired, durationMs: Date.now() - startTime });
                return result;
            }
        }
        // else: add-shaped NOT_FOUND — no AI resolution call, proceed
        // straight to the operation-proposal stage below with candidatePool,
        // same as before this change.
    }

    let targetContext: TargetContext | null = null;
    if (sectionTarget.status === "RESOLVED") {
        const sectionSchema = schemas.sectionSchemas.find(s => s.id === sectionTarget.section.type);
        targetContext = {
            sectionId: sectionTarget.sectionId,
            type: sectionTarget.section.type,
            currentSettings: sectionTarget.section.settings || {},
            schemaSettings: sectionSchema ? sectionSchema.settings : {}
        };

        const blockTarget = resolveBlockTarget(sectionTarget.section, userPrompt, schemas);
        if (blockTarget.status === "AMBIGUOUS") {
            const result: EditTurnResult = {
                status: "NEEDS_CLARIFICATION",
                classification,
                targetStatus: blockTarget.status,
                templateName,
                sectionId: sectionTarget.sectionId,
                candidates: blockTarget.candidates,
                questions: [buildAmbiguityQuestion(blockTarget.candidates, "block", schemas)]
            };
            instrumentation.logEditPipeline({ requestId, status: result.status, classification, targetStatus: blockTarget.status, durationMs: Date.now() - startTime });
            return result;
        }
        if (blockTarget.status === "RESOLVED") {
            const blockSchema = schemas.blockSchemas.find(b => b.id === blockTarget.block.type);
            targetContext.block = {
                blockId: blockTarget.blockId,
                type: blockTarget.block.type,
                currentSettings: blockTarget.block.settings || {},
                schemaSettings: blockSchema ? blockSchema.settings : {}
            };
        }

        // §10/§11 — a target now exists, but the request may still say
        // nothing about WHAT to change (e.g. the merchant's original words
        // were purely "change one section content", and the AI-assisted
        // resolution above only figured out WHICH section that meant — it
        // never supplied a value either). Ask rather than let the
        // operation-proposal call below guess a value nobody asked for.
        // sectionId/blockId travel with the result so conversational-edit.js
        // can attach them to a 'value'-kind clarification (a target is
        // already known — only the new value is missing) instead of
        // degrading to a generic 'intent' clarification, which would
        // re-run target resolution FROM SCRATCH on the merged answer next
        // turn: wasteful, and it risks landing on a DIFFERENT target than
        // the one already confirmed here.
        const looksLikeRemove = REMOVE_SIGNAL_VERBS.some(verb => new RegExp(`\\b${verb}\\b`, "i").test(userPrompt));
        if (!looksLikeRemove && !hasChangeDetails(userPrompt, {
            sectionId: targetContext.sectionId,
            type: targetContext.type,
            blockId: targetContext.block ? targetContext.block.blockId : undefined,
            blockType: targetContext.block ? targetContext.block.type : undefined,
            contentPreview: extractSectionTextPreview(targetContext.block ? targetContext.block.currentSettings : targetContext.currentSettings)
        })) {
            const result: EditTurnResult = {
                status: "NEEDS_CLARIFICATION",
                classification,
                targetStatus: sectionTarget.status,
                templateName,
                sectionId: targetContext.sectionId,
                blockId: targetContext.block ? targetContext.block.blockId : undefined,
                candidates: [],
                questions: ["What would you like to change?"]
            };
            instrumentation.logEditPipeline({ requestId, status: result.status, classification, targetStatus: sectionTarget.status, aiCallCount: resolutionAiCallCount, durationMs: Date.now() - startTime });
            return result;
        }
    }

    // §12 — bounded candidate pool for add-shaped requests, reusing Phase 2
    // retrieval rather than sending the full 69-schema catalog.
    const retrieved = retrieveRelevantSchemas(schemas, { userPrompt, templateName, requestId });
    const candidatePool: CandidatePool = {
        sections: retrieved.sectionSchemas.map(s => ({ id: s.id, label: s.label, summary: s.purpose })),
        blocks: retrieved.blockSchemas.map(b => ({ id: b.id, label: b.label, summary: b.purpose }))
    };

    const { operation, validation, repaired } = await runOperationProposalStage({
        userPrompt, templateName, targetContext, candidatePool, themeState, schemas, knownMerchantData, requestId
    });

    if (!validation.valid) {
        const result: EditTurnResult = { status: "FAILED", classification, targetStatus: sectionTarget.status, errors: validation.errors, operation: operation ?? undefined, repaired };
        instrumentation.logEditPipeline({ requestId, status: "FAILED", classification, targetStatus: sectionTarget.status, operationCount: 1, repaired, aiCallCount: resolutionAiCallCount + (repaired ? 2 : 1), durationMs: Date.now() - startTime });
        return result;
    }

    const executed = applyOperationToThemeState(themeState, operation!, { themeState, schemas, knownMerchantData, requestId });
    if (!executed.valid) {
        const result: EditTurnResult = { status: "FAILED", classification, targetStatus: sectionTarget.status, errors: executed.errors, operation: operation ?? undefined, repaired };
        instrumentation.logEditPipeline({ requestId, status: "FAILED", classification, targetStatus: sectionTarget.status, operationCount: 1, repaired, aiCallCount: resolutionAiCallCount + (repaired ? 2 : 1), durationMs: Date.now() - startTime });
        return result;
    }

    let applyResult: unknown = null;
    if (autoApply) {
        applyResult = await applyThemeState(executed.themeState, {
            themeRoot,
            ...applyTargetsForOperations([operation!]),
            dryRun: dryRunApply,
            requestId
        });
    }

    const result: EditTurnResult = {
        status: autoApply ? (dryRunApply ? "DRY_RUN" : "APPLIED") : "PROPOSED",
        classification,
        targetStatus: sectionTarget.status,
        operation: operation!,
        changeSummary: executed.changeSummary,
        targetSummary: buildTargetSummary(executed.themeState!, executed.changeSummary),
        themeState: executed.themeState!,
        applyResult,
        repaired
    };
    instrumentation.logEditPipeline({ requestId, status: result.status, classification, targetStatus: sectionTarget.status, operationCount: 1, repaired, aiCallCount: resolutionAiCallCount + (repaired ? 2 : 1), durationMs: Date.now() - startTime });
    return result;
}
