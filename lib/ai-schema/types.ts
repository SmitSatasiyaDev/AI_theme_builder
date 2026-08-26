/**
 * Shared types for the lib/ai-schema/ theme-generation engine.
 *
 * These model the JSON shapes the schema catalog, generated theme
 * candidates, and ThemeState snapshots actually take at runtime. Where the
 * original JS genuinely treats a value as free-form JSON (merchant
 * settings values, arbitrary theme JSON), that stays `unknown`/
 * `Record<string, unknown>` rather than being forced into an invented
 * strict shape — the real source of truth for what's valid remains the
 * runtime validators in validation.js/operations.js, not these types.
 */

// ---------------------------------------------------------------------------
// AI schema catalog (lib/ai-schema/schema-data/**/*.json)
// ---------------------------------------------------------------------------

export interface SettingSchemaObject {
    type?: string;
    min?: number;
    max?: number;
    step?: number;
    default?: unknown;
    options?: Array<string | { value: string; label?: string }>;
    [key: string]: unknown;
}

export type SettingSchema =
    | string // shorthand type name, e.g. "text", "color", "image_picker"
    | string[] // enum of allowed literal option values
    | SettingSchemaObject;

export interface SectionSchema {
    id: string;
    label?: string;
    purpose?: string;
    category?: string;
    tags?: string[];
    allowed_on?: string[];
    settings?: Record<string, SettingSchema>;
    allowed_blocks?: string[] | Record<string, { _notes?: Record<string, string> } | unknown>;
    max_blocks?: number;
    _notes?: string;
    [key: string]: unknown;
}

export interface BlockSchema {
    id: string;
    label?: string;
    purpose?: string;
    category?: string;
    tags?: string[];
    settings?: Record<string, SettingSchema>;
    [key: string]: unknown;
}

export interface GlobalSchema {
    type: string;
    description?: string;
    settings: Record<string, SettingSchema>;
}

export interface SchemaCatalog {
    globalSchema: GlobalSchema;
    sectionSchemas: SectionSchema[];
    blockSchemas: BlockSchema[];
}

export interface RuleMatch {
    keyword: string;
    categories: string[];
    tags: string[];
    isDefault: boolean;
}

export interface RetrievalMeta {
    mode: string;
    templateName: string;
    fallbackReason: string | null;
    matchedCategories?: string[];
    matchedTags?: string[];
    ruleMatches?: RuleMatch[];
    defaultRuleApplied?: boolean;
    baselineHeroApplied?: boolean;
    forcedExclusiveApplied?: boolean;
    candidateSectionCount: number;
    selectedSectionCount: number;
    candidateBlockCount: number;
    selectedBlockCount: number;
    unresolvedBlockIds?: string[];
}

export interface RetrievedSchemaCatalog extends SchemaCatalog {
    retrievalMeta: RetrievalMeta;
}

// ---------------------------------------------------------------------------
// Generated theme candidate (AI output shape, and live theme JSON shape —
// both a section/block "instance" tree keyed by id, with an explicit order).
// ---------------------------------------------------------------------------

export interface BlockInstance {
    type: string;
    settings?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface SectionInstance {
    type: string;
    settings?: Record<string, unknown>;
    blocks?: Record<string, BlockInstance>;
    block_order?: string[];
    [key: string]: unknown;
}

export interface GenerationConfig {
    sections: Record<string, SectionInstance>;
    order: string[];
}

// ---------------------------------------------------------------------------
// Validation (validation.js / ai-client.js validateOutput)
// ---------------------------------------------------------------------------

export interface ValidationIssue {
    code: string;
    path: string;
    message: string;
}

export interface ValidationResult {
    valid: boolean;
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
}

export interface ValidateOutputResult {
    valid: boolean;
    config?: GenerationConfig;
    error?: string;
    warnings?: string[];
}

/**
 * theme-state.js's validateThemeState() predates validation.js's structured
 * {code,path,message} ValidationIssue convention and still returns plain
 * human-readable strings — kept as its own type rather than forced into
 * ValidationResult so the two aren't confused.
 */
export interface ThemeStateValidation {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

// ---------------------------------------------------------------------------
// ThemeState (theme-state.js)
// ---------------------------------------------------------------------------

export interface BlockClassification {
    type: string | undefined;
    knownToAI: boolean;
}

export interface SectionClassification {
    type: string | undefined;
    knownToAI: boolean;
    blockCount: number;
    blocks: Record<string, BlockClassification>;
}

export interface TemplateClassification {
    sections: Record<string, SectionClassification>;
}

export interface ThemeTemplateEntry {
    sourceFile: string;
    raw: GenerationConfig;
    classification: TemplateClassification;
}

export interface GlobalSettingsEntry {
    sourceFile: string;
    raw: {
        current?: Record<string, unknown>;
        presets?: Record<string, unknown>;
        platform_customizations?: Record<string, unknown>;
        [key: string]: unknown;
    };
}

export interface UnparseableTemplate {
    name: string;
    sourceFile: string;
    error: string;
}

export interface ThemeStateMeta {
    templateCount: number;
    sectionCount: number;
    blockCount: number;
    unknownSectionCount: number;
    unknownBlockCount: number;
    unparseableTemplates: UnparseableTemplate[];
    globalSettingsError: string | null;
}

export interface ThemeState {
    themeId: string;
    sourcePath?: string;
    schemaVersion: number;
    createdAt: string;
    updatedAt: string;
    templates: Record<string, ThemeTemplateEntry>;
    globalSettings: GlobalSettingsEntry | null;
    meta: ThemeStateMeta;
    validation?: ThemeStateValidation;
}

export interface GenerationContext {
    templateName: string;
    templateExists: boolean;
    existingSectionOrder: string[];
    existingSections: Array<{ id: string; type: string | undefined; knownToAI: boolean; blockCount: number }>;
    globalSettingsCurrent: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Merge (merge.js)
// ---------------------------------------------------------------------------

export interface MergeConflict {
    code: string;
    path: string;
    message: string;
}

export interface MergeTemplateSummary {
    addedSections: string[];
    updatedSections: string[];
    removedSections: string[];
    preservedSectionIds: string[];
}

export interface MergeSummary {
    changedFiles: string[];
    changedTemplates: string[];
    addedSections: string[];
    updatedSections: string[];
    removedSections: string[];
    changedSettings: string[];
    preservedUnknownComponents: string[];
}

export interface MergeResult {
    valid: boolean;
    conflicts: MergeConflict[];
    mergedThemeState: ThemeState | null;
    summary: MergeSummary | null;
}

// ---------------------------------------------------------------------------
// Structured operations (operations.js / edit-pipeline.js / conversational-edit.js)
// ---------------------------------------------------------------------------

export interface OperationTarget {
    templateName?: string;
    sectionId?: string;
    blockId?: string;
}

export interface OperationChanges {
    settings?: Record<string, unknown>;
    type?: string;
    position?: "start" | "end";
    [key: string]: unknown;
}

export interface Operation {
    operation: string;
    target?: OperationTarget;
    changes?: OperationChanges;
}

export interface ChangeSummary {
    operationId: string;
    operation: string;
    target: string;
    changed: string[];
    preserved: boolean;
}

/**
 * A human-checkable identity for whatever section a proposal/apply actually
 * touched — derived from the POST-execution ThemeState (deriveResolvedTarget
 * follows the same "always post-execution" rule for the same reason:
 * add_section's real id, and a since-changed order/position, only exist
 * after execution). Surfaced to the merchant alongside "Proposed change" so
 * a wrong target-resolution guess (§ edit-pipeline.js's AI-assisted
 * resolution) is visible BEFORE "Apply to store", not just discoverable
 * after the fact by comparing the live preview.
 */
export interface TargetSummary {
    templateName: string;
    sectionId: string;
    sectionType?: string;
    position?: number;
    totalSections?: number;
    preview?: string;
}

export type TargetResolutionCandidate = { sectionId: string; type: string | undefined; score?: number } | { blockId: string; type: string | undefined; score?: number };

export type SectionTargetResolution =
    | { status: "RESOLVED"; sectionId: string; section: SectionInstance }
    | { status: "NOT_FOUND" }
    | { status: "AMBIGUOUS"; candidates: Array<{ sectionId: string; type: string | undefined; score: number }> };

export type BlockTargetResolution =
    | { status: "RESOLVED"; blockId: string; block: BlockInstance }
    | { status: "NOT_FOUND" }
    | { status: "AMBIGUOUS"; candidates: Array<{ blockId: string; type: string | undefined; score: number }> };

export interface OperationValidationResult {
    valid: boolean;
    errors: ValidationIssue[];
}

export interface ApplyOperationResult {
    valid: boolean;
    errors: ValidationIssue[];
    themeState: ThemeState | null;
    changeSummary: ChangeSummary | null;
}

export interface ApplyOperationsResult {
    valid: boolean;
    errors: ValidationIssue[];
    themeState: ThemeState | null;
    changeSummaries: ChangeSummary[];
}

// ---------------------------------------------------------------------------
// WebsiteBrief (brief-logic.js)
// ---------------------------------------------------------------------------

export type BriefFieldStatus = "confirmed" | "inferred" | "missing";

export interface BriefField {
    value: unknown;
    status: BriefFieldStatus;
    source: string | null;
}

export type Brief = Record<string, BriefField>;

// ---------------------------------------------------------------------------
// Targeted editing (edit-pipeline.js / conversational-edit.js / conversation-session.js)
// ---------------------------------------------------------------------------

export interface TargetContext {
    sectionId: string;
    type: string;
    currentSettings: Record<string, unknown>;
    schemaSettings?: Record<string, SettingSchema>;
    block?: {
        blockId: string;
        type: string;
        currentSettings: Record<string, unknown>;
        schemaSettings?: Record<string, SettingSchema>;
    };
}

export interface ResolvedTarget {
    templateName: string | null;
    sectionId: string | null;
    type: string | null;
    blockId?: string;
    blockType?: string | null;
}

export type PendingClarification =
    | { kind: "intent" }
    | { kind: "value"; target: ResolvedTarget; templateName: string; questions: string[] }
    | { kind: "section" | "block"; candidates: TargetResolutionCandidate[]; templateName: string; sectionId?: string | null; questions: string[] };

/**
 * The shape returned by edit-pipeline.js/conversational-edit.js's various
 * turn-handling functions (runTargetedEdit, proposeAndExecuteForTarget,
 * runMultiOperationTurn) genuinely varies by `status` — rather than modeling
 * every branch as a separate type (which the original code itself doesn't
 * do either), this carries every field any branch can produce as optional,
 * matching the original's duck-typed result objects.
 */
export interface EditTurnResult {
    status: string;
    classification?: string;
    targetStatus?: string;
    templateName?: string;
    sectionId?: string;
    blockId?: string;
    candidates?: TargetResolutionCandidate[];
    questions?: string[];
    errors?: ValidationIssue[];
    operation?: Operation;
    operations?: Operation[];
    changeSummary?: ChangeSummary | null;
    changeSummaries?: ChangeSummary[];
    targetSummary?: TargetSummary | null;
    targetSummaries?: TargetSummary[];
    themeState?: ThemeState;
    applyResult?: unknown;
    repaired?: boolean;
    aiCallCount?: number;
}

export interface Session {
    sessionId: string;
    themeId: string;
    status: string;
    currentIntent: string | null;
    pendingQuestion: string | null;
    pendingClarification: PendingClarification | null;
    resolvedTarget: ResolvedTarget | null;
    lastOperation: (Operation & { id: string }) | null;
    /**
     * Every operation from the turn that produced `lastOperation` — a single
     * item for a single-op turn, all of them (in order) for a multi-op turn.
     * The current theme's real files on disk are the only live ThemeState
     * source now (see theme-state.ts's buildThemeState) — there is no cached
     * post-execution ThemeState to reuse at apply time, so `/api/edit/apply`
     * rebuilds fresh from disk and replays exactly these operations against
     * it via applyOperationsToThemeState() instead. Storing the operations
     * (not the resulting state) is what lets that replay be deterministic
     * and re-validate against whatever is actually on disk *now*.
     */
    lastOperations: (Operation & { id: string })[] | null;
    lastChangeSummary: ChangeSummary | null;
    lastMessage: string | null;
    lastResultStatus: string | null;
    themeStateVersion: string | null;
    turnCount: number;
    createdAt: string;
    updatedAt: string;
}

// ---------------------------------------------------------------------------
// Conversational generation intake (brief-intake.ts / generation-intake-session.ts)
// ---------------------------------------------------------------------------

/**
 * Session envelope for the chat-based initial-generation intake flow — a
 * sibling of Session above, not a variant of it. Session's fields
 * (currentIntent, pendingClarification, resolvedTarget, lastOperation, ...)
 * are shaped around editing an ALREADY-EXISTING theme; intake instead just
 * accretes a Brief turn by turn until it's ready to hand off to
 * runStagedGeneration(). Stored in the same conversation_session table's
 * turnsJson column as Session objects are (see generation-intake-session.ts),
 * distinguished at read time by the `kind` discriminant.
 */
export interface IntakeSessionState {
    kind: "intake";
    sessionId: string;
    status: "COLLECTING" | "GENERATING" | "FAILED";
    turnCount: number;
    lastQuestion: string | null;
    lastMessage: string | null;
    jobId: string | null;
    createdAt: string;
    updatedAt: string;
}

// ---------------------------------------------------------------------------
// Product/collection reference validation (validation.js / operations.js)
// ---------------------------------------------------------------------------

export interface KnownMerchantData {
    products?: string[];
    collections?: string[];
}

// ---------------------------------------------------------------------------
// Staged generation (generation.js)
// ---------------------------------------------------------------------------

export interface GenerationPlanSection {
    type: string;
    blockTypes?: string[];
}

export interface GenerationPlan {
    templateName: string;
    order: string[];
    sections: Record<string, GenerationPlanSection>;
}

export interface CapabilityListing {
    sections: Array<{ id: string; label: string; summary: string; hasBlocks: boolean; maxBlocks: number | null; allowedBlockTypes: string[] }>;
    blocks: Array<{ id: string; label: string; summary: string }>;
}

export interface PlainValidationResult {
    valid: boolean;
    errors: string[];
}

export interface StagedGenerationTimings {
    retrievalMs: number;
    planningMs: number;
    configurationMs: number;
    validationMs: number;
    totalMs: number;
}

export interface StagedGenerationResult {
    templateName: string;
    plan: GenerationPlan;
    config: GenerationConfig | null;
    warnings: string[];
    retrievalMeta: RetrievalMeta;
    themeContext: GenerationContext;
    planRepaired: boolean;
    configRepaired: boolean;
    aiCallCount: number;
    durationMs: number;
    // Added for pipeline-speed instrumentation (see generation.ts) — all
    // additive, existing fields above are unchanged.
    timings: StagedGenerationTimings;
    retryCount: number;
    deterministicFixCount: number;
    promptChars: number;
    outputChars: number;
    estimatedPromptTokens: number;
    estimatedOutputTokens: number;
}
