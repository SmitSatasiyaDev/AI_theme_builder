/**
 * Phase 2 — Deterministic Retrieval.
 *
 * Pure application logic. No LLM call decides what to retrieve (Phase 2
 * spec §18) — this module only does string matching against
 * retrieval-rules.json and set/array operations against the in-memory
 * capability index built fresh from whatever schemas were just loaded off
 * disk (see capability-index.js's file-level comment on why that's always
 * computed fresh, never read back from a cached file).
 *
 *   User prompt + template
 *        |
 *        v
 *   template filter (allowed_on)          <- always safe/deterministic;
 *        |                                    effectively the first time
 *        v                                    allowed_on is enforced anywhere
 *   keyword -> category/tag matching       <- retrieval-rules.json
 *        |
 *        v
 *   force-include one baseline hero section (if the template has one and
 *   none was already matched — mirrors the existing "first section must
 *   be slideshow" convention already hardcoded into buildSystemPrompt())
 *        |
 *        v
 *   fallback check (too small / zero confidence / no hero available)
 *      |                                  |
 *      | fallback triggers                | otherwise
 *      v                                  v
 *   return the FULL schema set        pull full schema for each selected
 *   unfiltered (safety net;               section, then transitively pull
 *   FULL_SCHEMA_MODE, identical           only the block schemas its own
 *   to pre-Phase-2 behavior)              allowed_blocks references
 *                                             |
 *                                             v
 *                                     return the selected subset
 */
import * as instrumentation from "./instrumentation";
import { buildCapabilityIndex } from "./capability-index";
import RULES from "./schema-data/retrieval-rules.json";
import type { SchemaCatalog, SectionSchema, RetrievedSchemaCatalog, RuleMatch } from "./types";

// Tied to an existing, already-hardcoded invariant in buildSystemPrompt()'s
// prose rules ("MUST use at least 8 different section types in the 10
// sections" — example-implementation.js rule 11): if retrieval can't offer
// at least that many index-eligible candidates, the AI could not satisfy
// that existing rule even in principle, so falling back to the full set is
// the only safe choice. Other templates don't carry that same variety
// requirement in the current prompt (e.g. "product" is explicitly always
// exactly one section - main-product - by rule 12), so they get a much
// lower floor: just "did we find at least one relevant, eligible section."
export const MIN_SECTIONS_FLOOR: Record<string, number> = { index: 8 };
export const DEFAULT_MIN_SECTIONS_FLOOR = 1;

// Discovered while implementing retrieval: most sections declare "product"
// in allowed_on too (they're valid ADDITIONS to a product page, not
// exclusive to product pages — confirmed against the real alternate
// product templates like templates/product.pet-health-supplement.json,
// which have many sections beyond main-product). So template-filtering
// alone leaves ~15 of 16 sections eligible for "product", which would let
// keyword matching select sections other than main-product — but
// buildSystemPrompt()'s existing rule 12 hardcodes "MUST use main-product
// section as the ONLY section" for the product template. Sending the AI a
// retrieval-selected set that could include other sections would contradict
// an existing, unchanged prompt rule for no benefit. So for any template
// with a forced-exclusive section, retrieval short-circuits straight to
// that one section (still running keyword matching for instrumentation/
// logging, just not for selection) rather than running the general
// floor/fallback logic — this is exactly "preserve the existing hardcoded
// default behavior where appropriate" (Phase 2 spec §11).
export const FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE: Record<string, string> = { product: "main-product", "footer-group": "footer" };

function normalize(text: string | undefined): string {
    return (text || "").toLowerCase();
}

export interface MatchRulesResult {
    matchedCategories: string[];
    matchedTags: string[];
    ruleMatches: RuleMatch[];
    defaultApplied: boolean;
}

/**
 * Deterministic keyword matching against retrieval-rules.json. Returns
 * every rule that hit (for instrumentation/debugging), plus the union of
 * categories/tags they contributed.
 */
export function matchRules(userPrompt: string, rulesConfig: typeof RULES = RULES): MatchRulesResult {
    const lower = normalize(userPrompt);
    const matchedCategories = new Set<string>();
    const matchedTags = new Set<string>();
    const ruleMatches: RuleMatch[] = [];

    for (const rule of rulesConfig.rules) {
        const hitKeyword = rule.keywords.find(k => lower.includes(k.toLowerCase()));
        if (hitKeyword) {
            ruleMatches.push({ keyword: hitKeyword, categories: rule.categories, tags: rule.tags || [], isDefault: false });
            rule.categories.forEach(c => matchedCategories.add(c));
            (rule.tags || []).forEach(t => matchedTags.add(t));
        }
    }

    let defaultApplied = false;
    if (rulesConfig.defaultRule) {
        const hitKeyword = rulesConfig.defaultRule.keywords.find(k => lower.includes(k.toLowerCase()));
        if (hitKeyword) {
            defaultApplied = true;
            ruleMatches.push({ keyword: hitKeyword, categories: rulesConfig.defaultRule.categories, tags: rulesConfig.defaultRule.tags || [], isDefault: true });
            rulesConfig.defaultRule.categories.forEach(c => matchedCategories.add(c));
        }
    }

    return {
        matchedCategories: [...matchedCategories],
        matchedTags: [...matchedTags],
        ruleMatches,
        defaultApplied
    };
}

export function isEligibleForTemplate(sectionEntry: { allowed_on?: string[] }, templateName: string): boolean {
    if (!Array.isArray(sectionEntry.allowed_on) || sectionEntry.allowed_on.length === 0) {
        // Defensive default: a schema with no declared allowed_on restricts
        // nothing today (none of the current 16 are actually missing it),
        // so treat it as eligible everywhere rather than silently excluding
        // a mis-authored schema from every template.
        return true;
    }
    return sectionEntry.allowed_on.includes(templateName);
}

function schemaCharCount(sectionSchemas: unknown, blockSchemas: unknown): number {
    return JSON.stringify(sectionSchemas).length + JSON.stringify(blockSchemas).length;
}

function allowedBlockIds(section: SectionSchema): string[] {
    return Array.isArray(section.allowed_blocks)
        ? section.allowed_blocks
        : (section.allowed_blocks && typeof section.allowed_blocks === "object"
            ? Object.keys(section.allowed_blocks)
            : []);
}

export interface RetrievalOptions {
    userPrompt?: string;
    templateName?: string;
    requestId?: string;
}

/**
 * fullSchemas: { globalSchema, sectionSchemas, blockSchemas } — the
 * complete, unfiltered set just read off disk by loadAllSchemasFromDisk().
 * options: { userPrompt, templateName = 'index', requestId }
 */
export function retrieveRelevantSchemas(fullSchemas: SchemaCatalog, options: RetrievalOptions = {}): RetrievedSchemaCatalog {
    const { userPrompt = "", templateName = "index", requestId = instrumentation.nextRequestId("retrieval") } = options;

    const index = buildCapabilityIndex(fullSchemas);
    const templateEligibleSections = index.sections.filter(s => isEligibleForTemplate(s, templateName));

    // Keyword matching runs regardless of the forced-section path below, so
    // ruleMatches/matchedCategories are always present in the logged/returned
    // meta for debugging — they just don't drive selection when a template
    // has a forced-exclusive section.
    const { matchedCategories, matchedTags, ruleMatches, defaultApplied } = matchRules(userPrompt);

    const forcedSectionId = FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE[templateName];
    const forcedEntry = forcedSectionId
        ? templateEligibleSections.find(s => s.id === forcedSectionId)
        : null;

    let selectedEntries: typeof templateEligibleSections;
    let baselineHeroApplied = false;
    let forcedExclusiveApplied = false;

    if (forcedEntry) {
        // e.g. templateName === 'product' -> always exactly main-product,
        // matching buildSystemPrompt()'s existing rule 12 ("MUST use
        // main-product section as the ONLY section"). See the comment on
        // FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE above for why.
        selectedEntries = [forcedEntry];
        forcedExclusiveApplied = true;
    } else {
        selectedEntries = templateEligibleSections.filter(s =>
            matchedCategories.includes(s.category) || s.tags.some(t => matchedTags.includes(t))
        );

        const heroCandidates = templateEligibleSections.filter(s => s.category === "hero");
        if (heroCandidates.length > 0 && !selectedEntries.some(s => s.category === "hero")) {
            selectedEntries = [heroCandidates[0], ...selectedEntries];
            baselineHeroApplied = true;
        }

        // Dedupe while preserving order (hero first if it was force-included).
        const seenIds = new Set<string>();
        selectedEntries = selectedEntries.filter(s => {
            if (seenIds.has(s.id)) return false;
            seenIds.add(s.id);
            return true;
        });
    }

    const heroCandidatesForFallbackCheck = templateEligibleSections.filter(s => s.category === "hero");
    const floor = MIN_SECTIONS_FLOOR[templateName] ?? DEFAULT_MIN_SECTIONS_FLOOR;
    const noHeroAvailable = !forcedEntry && templateEligibleSections.length > 0 && heroCandidatesForFallbackCheck.length === 0;

    let fallbackReason: string | null = null;
    if (forcedEntry) {
        // Forced-exclusive selection is always usable by construction —
        // never subject to the floor/confidence/hero checks below.
        fallbackReason = null;
    } else if (templateEligibleSections.length === 0) {
        fallbackReason = `no sections declare "${templateName}" in allowed_on — nothing is eligible for this template today`;
    } else if (ruleMatches.length === 0) {
        fallbackReason = "no retrieval rules matched the prompt (zero confidence)";
    } else if (selectedEntries.length < floor) {
        fallbackReason = `selected section count ${selectedEntries.length} is below the floor of ${floor} required for template "${templateName}"`;
    } else if (noHeroAvailable) {
        fallbackReason = `no hero-category section is eligible for template "${templateName}" among ${templateEligibleSections.length} candidates`;
    }

    const fullCharCount = schemaCharCount(fullSchemas.sectionSchemas, fullSchemas.blockSchemas);

    if (fallbackReason) {
        instrumentation.logRetrieval({
            requestId,
            mode: "FULL_FALLBACK",
            templateName,
            fallbackReason,
            ruleMatches,
            defaultRuleApplied: defaultApplied,
            baselineHeroApplied: false,
            candidateSectionCount: templateEligibleSections.length,
            selectedSectionCount: fullSchemas.sectionSchemas.length,
            candidateBlockCount: fullSchemas.blockSchemas.length,
            selectedBlockCount: fullSchemas.blockSchemas.length,
            fullSchemaChars: fullCharCount,
            retrievedSchemaChars: fullCharCount,
            estimatedFullTokens: instrumentation.estimateTokensFromChars(fullCharCount),
            estimatedRetrievedTokens: instrumentation.estimateTokensFromChars(fullCharCount)
        });

        return {
            globalSchema: fullSchemas.globalSchema,
            sectionSchemas: fullSchemas.sectionSchemas,
            blockSchemas: fullSchemas.blockSchemas,
            retrievalMeta: {
                mode: "FULL_FALLBACK",
                templateName,
                fallbackReason,
                matchedCategories,
                matchedTags,
                ruleMatches,
                defaultRuleApplied: defaultApplied,
                baselineHeroApplied: false,
                candidateSectionCount: templateEligibleSections.length,
                selectedSectionCount: fullSchemas.sectionSchemas.length,
                candidateBlockCount: fullSchemas.blockSchemas.length,
                selectedBlockCount: fullSchemas.blockSchemas.length
            }
        };
    }

    // Resolve selected section entries back to their full schema objects.
    const sectionById = new Map(fullSchemas.sectionSchemas.map(s => [s.id, s]));
    // Last-one-wins, matching validateOutput()'s existing Map semantics for
    // the duplicate "row" id (see PHASE2_REPORT.md).
    const blockById = new Map<string, SchemaCatalog["blockSchemas"][number]>();
    fullSchemas.blockSchemas.forEach(b => blockById.set(b.id, b));

    const selectedSections = selectedEntries
        .map(e => sectionById.get(e.id))
        .filter((s): s is SectionSchema => Boolean(s));

    const neededBlockIds = new Set<string>();
    const unresolvedBlockIds = new Set<string>();
    for (const section of selectedSections) {
        for (const blockId of allowedBlockIds(section)) {
            if (blockById.has(blockId)) {
                neededBlockIds.add(blockId);
            } else {
                // Documented, pre-existing coverage gap — e.g. main-product's
                // allowed_blocks lists several ids (e.g. "reviews",
                // "product_complementary") with no matching block schema
                // file. Not a retrieval bug; see PHASE2_REPORT.md.
                unresolvedBlockIds.add(blockId);
            }
        }
    }
    const selectedBlocks = [...neededBlockIds].map(id => blockById.get(id)!);

    const retrievedCharCount = schemaCharCount(selectedSections, selectedBlocks);

    instrumentation.logRetrieval({
        requestId,
        mode: "RETRIEVAL",
        templateName,
        fallbackReason: null,
        ruleMatches,
        defaultRuleApplied: defaultApplied,
        baselineHeroApplied,
        candidateSectionCount: templateEligibleSections.length,
        selectedSectionCount: selectedSections.length,
        candidateBlockCount: fullSchemas.blockSchemas.length,
        selectedBlockCount: selectedBlocks.length,
        fullSchemaChars: fullCharCount,
        retrievedSchemaChars: retrievedCharCount,
        estimatedFullTokens: instrumentation.estimateTokensFromChars(fullCharCount),
        estimatedRetrievedTokens: instrumentation.estimateTokensFromChars(retrievedCharCount)
    });

    return {
        globalSchema: fullSchemas.globalSchema,
        sectionSchemas: selectedSections,
        blockSchemas: selectedBlocks,
        retrievalMeta: {
            mode: "RETRIEVAL",
            templateName,
            fallbackReason: null,
            matchedCategories,
            matchedTags,
            ruleMatches,
            defaultRuleApplied: defaultApplied,
            baselineHeroApplied,
            forcedExclusiveApplied,
            candidateSectionCount: templateEligibleSections.length,
            selectedSectionCount: selectedSections.length,
            candidateBlockCount: fullSchemas.blockSchemas.length,
            selectedBlockCount: selectedBlocks.length,
            unresolvedBlockIds: [...unresolvedBlockIds]
        }
    };
}

/**
 * getTemplateEligibleSchemas — used by Phase 5 staged generation's Planning
 * stage (generation.js). Unlike retrieveRelevantSchemas() above, this does
 * NO keyword matching and applies NO relevance judgment of its own — it
 * only enforces the two hard, non-negotiable constraints (allowed_on
 * template eligibility, and the forced-exclusive-section rule) and hands
 * back everything else that's eligible. The actual choice of which of
 * those eligible sections/blocks to use is left entirely to the AI in the
 * Planning stage, which sees every eligible name (not a pre-filtered
 * keyword-matched subset) — this is what lets staged generation generalize
 * to niches/requests no one anticipated when retrieval-rules.json was
 * written, instead of being bottlenecked by it.
 *
 * fullSchemas: { globalSchema, sectionSchemas, blockSchemas } — the
 * complete, unfiltered set just read off disk.
 */
export function getTemplateEligibleSchemas(
    fullSchemas: SchemaCatalog,
    templateName = "index",
    requestId: string = instrumentation.nextRequestId("eligibility")
): RetrievedSchemaCatalog {
    const templateEligibleSections = fullSchemas.sectionSchemas.filter(s => isEligibleForTemplate(s, templateName));

    const fullCharCount = schemaCharCount(fullSchemas.sectionSchemas, fullSchemas.blockSchemas);

    // Same gap documented in retrieveRelevantSchemas()'s FULL_FALLBACK path:
    // some templates (collection/blog/article/cart/search today) have no
    // schemas declaring them in allowed_on at all. Falling back to the full
    // catalog here preserves generation for those templates rather than
    // handing the Planning stage an empty candidate pool it can't plan
    // anything from.
    if (templateEligibleSections.length === 0) {
        instrumentation.logRetrieval({
            requestId,
            mode: "ELIGIBILITY_FALLBACK_FULL",
            templateName,
            fallbackReason: `no sections declare "${templateName}" in allowed_on — nothing is eligible for this template today`,
            candidateSectionCount: 0,
            selectedSectionCount: fullSchemas.sectionSchemas.length,
            candidateBlockCount: fullSchemas.blockSchemas.length,
            selectedBlockCount: fullSchemas.blockSchemas.length,
            fullSchemaChars: fullCharCount,
            retrievedSchemaChars: fullCharCount,
            estimatedFullTokens: instrumentation.estimateTokensFromChars(fullCharCount),
            estimatedRetrievedTokens: instrumentation.estimateTokensFromChars(fullCharCount)
        });

        return {
            globalSchema: fullSchemas.globalSchema,
            sectionSchemas: fullSchemas.sectionSchemas,
            blockSchemas: fullSchemas.blockSchemas,
            retrievalMeta: {
                mode: "ELIGIBILITY_FALLBACK_FULL",
                templateName,
                fallbackReason: `no sections declare "${templateName}" in allowed_on — nothing is eligible for this template today`,
                forcedExclusiveApplied: false,
                candidateSectionCount: 0,
                selectedSectionCount: fullSchemas.sectionSchemas.length,
                candidateBlockCount: fullSchemas.blockSchemas.length,
                selectedBlockCount: fullSchemas.blockSchemas.length
            }
        };
    }

    const forcedSectionId = FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE[templateName];
    const forcedEntry = forcedSectionId
        ? templateEligibleSections.find(s => s.id === forcedSectionId)
        : null;

    const selectedSections = forcedEntry ? [forcedEntry] : templateEligibleSections;

    const blockById = new Map<string, SchemaCatalog["blockSchemas"][number]>();
    fullSchemas.blockSchemas.forEach(b => blockById.set(b.id, b));

    const neededBlockIds = new Set<string>();
    const unresolvedBlockIds = new Set<string>();
    for (const section of selectedSections) {
        for (const blockId of allowedBlockIds(section)) {
            if (blockById.has(blockId)) {
                neededBlockIds.add(blockId);
            } else {
                unresolvedBlockIds.add(blockId);
            }
        }
    }
    const selectedBlocks = [...neededBlockIds].map(id => blockById.get(id)!);

    const retrievedCharCount = schemaCharCount(selectedSections, selectedBlocks);
    const mode = forcedEntry ? "ELIGIBILITY_FORCED_EXCLUSIVE" : "ELIGIBILITY_ONLY";

    instrumentation.logRetrieval({
        requestId,
        mode,
        templateName,
        fallbackReason: null,
        candidateSectionCount: templateEligibleSections.length,
        selectedSectionCount: selectedSections.length,
        candidateBlockCount: fullSchemas.blockSchemas.length,
        selectedBlockCount: selectedBlocks.length,
        fullSchemaChars: fullCharCount,
        retrievedSchemaChars: retrievedCharCount,
        estimatedFullTokens: instrumentation.estimateTokensFromChars(fullCharCount),
        estimatedRetrievedTokens: instrumentation.estimateTokensFromChars(retrievedCharCount)
    });

    return {
        globalSchema: fullSchemas.globalSchema,
        sectionSchemas: selectedSections,
        blockSchemas: selectedBlocks,
        retrievalMeta: {
            mode,
            templateName,
            fallbackReason: null,
            forcedExclusiveApplied: !!forcedEntry,
            candidateSectionCount: templateEligibleSections.length,
            selectedSectionCount: selectedSections.length,
            candidateBlockCount: fullSchemas.blockSchemas.length,
            selectedBlockCount: selectedBlocks.length,
            unresolvedBlockIds: [...unresolvedBlockIds]
        }
    };
}

/**
 * Narrows an already-template-eligible candidate set (getTemplateEligibleSchemas()'s
 * output) down to a small, keyword-relevant subset for Stage 1 Planning's prompt —
 * reusing the SAME deterministic keyword→category/tag matching retrieveRelevantSchemas()
 * uses above, rather than inventing a second selection algorithm.
 *
 * This is intentionally a NARROWING pass on top of the eligible envelope, not a
 * replacement for it: unlike retrieveRelevantSchemas()'s own FULL_FALLBACK (which
 * returns the entire unfiltered catalog, including sections ineligible for this
 * template), every fallback branch here returns `eligible` unchanged — so the worst
 * case is exactly today's staged-generation behavior (the full template-eligible set),
 * never anything broader. Planning only ever loses candidates here, never gains
 * ineligible ones.
 *
 * Skipped (returns `eligible` as-is) when:
 *   - the template already resolved to a forced-exclusive single section (nothing to
 *     narrow — see FORCED_EXCLUSIVE_SECTION_BY_TEMPLATE)
 *   - the eligible set is already at or below the template's floor (narrowing further
 *     could only shrink below the minimum variety the plan needs)
 *   - no retrieval rule matched the brief text at all (zero confidence — narrowing on
 *     no signal risks silently excluding something the merchant actually needs)
 *   - the confident match still lands below the floor
 */
export function narrowEligibleSchemasForPlanning(
    eligible: RetrievedSchemaCatalog,
    templateName: string,
    userPrompt: string,
    requestId: string = instrumentation.nextRequestId("planning-narrow")
): RetrievedSchemaCatalog {
    if (eligible.retrievalMeta.forcedExclusiveApplied) return eligible;

    const floor = MIN_SECTIONS_FLOOR[templateName] ?? DEFAULT_MIN_SECTIONS_FLOOR;
    if (eligible.sectionSchemas.length <= floor) return eligible;

    const { matchedCategories, matchedTags, ruleMatches, defaultApplied } = matchRules(userPrompt);
    const fullCharCount = schemaCharCount(eligible.sectionSchemas, eligible.blockSchemas);

    if (ruleMatches.length === 0) {
        instrumentation.logRetrieval({
            requestId, mode: "PLANNING_NARROW_SKIPPED", templateName,
            fallbackReason: "no retrieval rules matched the brief text (zero confidence) — planning sees the full eligible set",
            candidateSectionCount: eligible.sectionSchemas.length, selectedSectionCount: eligible.sectionSchemas.length,
            candidateBlockCount: eligible.blockSchemas.length, selectedBlockCount: eligible.blockSchemas.length,
            fullSchemaChars: fullCharCount, retrievedSchemaChars: fullCharCount,
            estimatedFullTokens: instrumentation.estimateTokensFromChars(fullCharCount),
            estimatedRetrievedTokens: instrumentation.estimateTokensFromChars(fullCharCount)
        });
        return eligible;
    }

    const index = buildCapabilityIndex(eligible);
    let selectedIds = index.sections
        .filter(s => matchedCategories.includes(s.category) || s.tags.some(t => matchedTags.includes(t)))
        .map(s => s.id);

    const heroIds = index.sections.filter(s => s.category === "hero").map(s => s.id);
    let baselineHeroApplied = false;
    if (heroIds.length > 0 && !selectedIds.includes(heroIds[0]) && !selectedIds.some(id => heroIds.includes(id))) {
        selectedIds = [heroIds[0], ...selectedIds];
        baselineHeroApplied = true;
    }
    selectedIds = [...new Set(selectedIds)];

    if (selectedIds.length < floor) {
        instrumentation.logRetrieval({
            requestId, mode: "PLANNING_NARROW_BELOW_FLOOR", templateName,
            fallbackReason: `narrowed section count ${selectedIds.length} is below the floor of ${floor} — planning sees the full eligible set`,
            ruleMatches, defaultRuleApplied: defaultApplied,
            candidateSectionCount: eligible.sectionSchemas.length, selectedSectionCount: eligible.sectionSchemas.length,
            candidateBlockCount: eligible.blockSchemas.length, selectedBlockCount: eligible.blockSchemas.length,
            fullSchemaChars: fullCharCount, retrievedSchemaChars: fullCharCount,
            estimatedFullTokens: instrumentation.estimateTokensFromChars(fullCharCount),
            estimatedRetrievedTokens: instrumentation.estimateTokensFromChars(fullCharCount)
        });
        return eligible;
    }

    const sectionById = new Map(eligible.sectionSchemas.map(s => [s.id, s]));
    const selectedSections = selectedIds
        .map(id => sectionById.get(id))
        .filter((s): s is SectionSchema => Boolean(s));

    const neededBlockIds = new Set<string>();
    for (const section of selectedSections) {
        for (const blockId of allowedBlockIds(section)) neededBlockIds.add(blockId);
    }
    const selectedBlocks = eligible.blockSchemas.filter(b => neededBlockIds.has(b.id));
    const narrowedCharCount = schemaCharCount(selectedSections, selectedBlocks);

    instrumentation.logRetrieval({
        requestId, mode: "PLANNING_NARROWED", templateName, fallbackReason: null,
        ruleMatches, defaultRuleApplied: defaultApplied, baselineHeroApplied,
        candidateSectionCount: eligible.sectionSchemas.length, selectedSectionCount: selectedSections.length,
        candidateBlockCount: eligible.blockSchemas.length, selectedBlockCount: selectedBlocks.length,
        fullSchemaChars: fullCharCount, retrievedSchemaChars: narrowedCharCount,
        estimatedFullTokens: instrumentation.estimateTokensFromChars(fullCharCount),
        estimatedRetrievedTokens: instrumentation.estimateTokensFromChars(narrowedCharCount)
    });

    return {
        globalSchema: eligible.globalSchema,
        sectionSchemas: selectedSections,
        blockSchemas: selectedBlocks,
        retrievalMeta: {
            ...eligible.retrievalMeta,
            mode: "PLANNING_NARROWED",
            matchedCategories,
            matchedTags,
            ruleMatches,
            defaultRuleApplied: defaultApplied,
            baselineHeroApplied,
            selectedSectionCount: selectedSections.length,
            selectedBlockCount: selectedBlocks.length
        }
    };
}
