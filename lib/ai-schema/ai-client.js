/**
 * AI Schema Implementation Example with OpenRouter
 *
 * This shows how to use the AI schema files to constrain
 * AI-generated theme configurations.
 *
 * Trimmed port of ai-schema/example-implementation.js for the SaaS lib:
 * only the pure/in-memory + read-only-schema-loading exports are included
 * here (loadSchemas, buildSystemPrompt, makeAIRequest, validateOutput,
 * loadGlobalSettings, detectNicheAndGetColors, generateAIColorPalette,
 * COLOR_PALETTES). generateThemeFiles/generateSectionImages (which write to
 * local disk under ai-schema/output/...) and the CLI main()/entry-point
 * block are intentionally NOT ported — out of scope for this port. The
 * schema-loading paths below are repointed at ./schema-data/ (see Task 1)
 * instead of __dirname directly; everything else is unchanged from source.
 */

const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();
const instrumentation = require('./instrumentation');
const { retrieveRelevantSchemas } = require('./retrieval');

// Configuration
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'moonshotai/kimi-k2.5';
const DEBUG = process.env.DEBUG === 'true';

/**
 * Load every schema file from disk (global + all sections + all blocks),
 * unconditionally. This is the FULL_SCHEMA_MODE behavior that existed
 * before Phase 2 and remains the default/fallback — see loadSchemas() below.
 *
 * File lists are sorted before reading so iteration order is deterministic
 * across filesystems (fs.readdir() order is not guaranteed). This used to
 * matter for a duplicate block id ("row", defined by both result_row.json
 * and row.json — see PHASE2_REPORT.md "Known limitations"); that collision
 * was fixed by merging both into a single flat row.json and deleting
 * result_row.json, but sorting is kept as good practice for any future
 * id-keyed lookup over these directories.
 */
async function loadAllSchemasFromDisk() {
    const schemasDir = path.join(__dirname, 'schema-data');

    try {
        const globalSchema = JSON.parse(
            await fs.readFile(path.join(schemasDir, 'global.json'), 'utf8')
        );

        // Load all section schemas
        const sectionsDir = path.join(schemasDir, 'sections');
        let sectionSchemas = [];
        try {
            const sectionFiles = (await fs.readdir(sectionsDir)).sort();
            sectionSchemas = await Promise.all(
                sectionFiles
                    .filter(f => f.endsWith('.json'))
                    .map(async f => {
                        const content = await fs.readFile(path.join(sectionsDir, f), 'utf8');
                        return JSON.parse(content);
                    })
            );
        } catch (error) {
            console.warn(`⚠️  Warning: Could not load sections from ${sectionsDir}:`, error.message);
        }

        // Load all block schemas
        const blocksDir = path.join(schemasDir, 'blocks');
        let blockSchemas = [];
        try {
            const blockFiles = (await fs.readdir(blocksDir)).sort();
            blockSchemas = await Promise.all(
                blockFiles
                    .filter(f => f.endsWith('.json'))
                    .map(async f => {
                        const content = await fs.readFile(path.join(blocksDir, f), 'utf8');
                        return JSON.parse(content);
                    })
            );
        } catch (error) {
            console.warn(`⚠️  Warning: Could not load blocks from ${blocksDir}:`, error.message);
        }

        if (DEBUG) {
            console.log('Debug: Loaded sections:', sectionSchemas.map(s => s.id));
            console.log('Debug: Loaded blocks:', blockSchemas.map(b => b.id));
        }

        return { globalSchema, sectionSchemas, blockSchemas };
    } catch (error) {
        throw new Error(`Failed to load schemas: ${error.message}`);
    }
}

/**
 * Load schemas for a generation request.
 *
 * Two modes, both built on loadAllSchemasFromDisk():
 *   - loadSchemas() / loadSchemas({}) — FULL_SCHEMA_MODE (unchanged default
 *     behavior from before Phase 2: every section/block schema on disk).
 *   - loadSchemas({ retrieval: { userPrompt, templateName, requestId } }) —
 *     RETRIEVAL_MODE: deterministically selects the relevant subset via
 *     retrieval.js, falling back to the full set internally if retrieval
 *     can't produce a usable candidate pool (see retrieval.js for when).
 *
 * The zero-arg call remains byte-for-byte identical to Phase 1's behavior —
 * same return shape, same content — so existing callers and the Phase 1
 * regression suite are unaffected.
 */
async function loadSchemas(options = {}) {
    const fullSchemas = await loadAllSchemasFromDisk();

    if (!options.retrieval) {
        return fullSchemas;
    }

    return retrieveRelevantSchemas(fullSchemas, options.retrieval);
}

/**
 * Build the AI system prompt with schema constraints
 */
function buildSystemPrompt(schemas) {
    const { globalSchema, sectionSchemas, blockSchemas } = schemas;

    return `You are an AI Shopify theme configurator.
Your job is to generate valid Shopify theme section configurations based on user requests.

CRITICAL RULES:
1. You can ONLY use sections, blocks, and settings defined in the schemas below
2. Do NOT invent new sections, blocks, or settings that don't exist
   - Every section/block "type" you output MUST be copied VERBATIM from the "id" field of a schema in AVAILABLE SECTIONS/AVAILABLE BLOCKS below — exact spelling, exact hyphens vs underscores
   - Do NOT guess a type from a block's label, purpose, or from wording used elsewhere in these rules — always copy the literal "id" value
   - Example: the schema id is "icon-with-text" (hyphens) — using "icon_with_text" (underscore) is WRONG and will fail to upload to Shopify
3. Return ONLY valid JSON - no explanations, no markdown
4. If a requested section doesn't exist, omit it silently or suggest the closest match
5. All setting values must match the allowed options in the schema
6. READ AND FOLLOW "_notes" field in schemas - they contain IMPORTANT constraints:
   - If a field has "_notes", you MUST follow those instructions
   - Example: If "_notes" says "Must be wrap with p tag", wrap the value with <p> tags
   - These are critical for proper rendering
7. RICHTEXT FIELDS - EXTREMELY IMPORTANT:
   - ALL fields with type "richtext" MUST have content wrapped in HTML tags
   - Valid tags: <p>, <ul>, <ol>, <h1>-<h6>
   - Example: "text": "<p>Your content here</p>"
   - NEVER use plain text without tags: "text": "Plain text" ❌ WRONG
   - ALWAYS wrap in tags: "text": "<p>Plain text</p>" ✅ CORRECT
8. MAX_BLOCKS LIMIT - CRITICAL:
   - If a section has "max_blocks" in its schema, NEVER exceed that limit
   - Example: If max_blocks is 3, add MAXIMUM 3 blocks only
   - Exceeding max_blocks will cause upload failure
   - Check the section schema for max_blocks before adding blocks
9. IMAGE FIELDS - CRITICAL:
   - For any setting of type "image" or "image_picker", ALWAYS leave the value as an empty string ""
   - NEVER invent a filename (e.g. "product-photo.jpg") or a fake URL — these are not real Shopify-hosted images and will fail to upload
   - An empty string means "no image selected yet" — the merchant will pick a real image in Shopify admin afterward
10. HOMEPAGE STRUCTURE (for index template):
   - MUST include EXACTLY 10 sections (this is mandatory)
   - FIRST section MUST ALWAYS be "slideshow" (hero section)
   - When a section has blocks, MUST include "block_order" array
   - block_order must list all blocks in the order they appear
   - Example: "block_order": ["slide-1", "slide-2"]
11. VARIETY & CREATIVITY - EXTREMELY IMPORTANT:
   - BE CREATIVE! Don't use the same sections every time (except first slideshow)
   - VARY section order based on the niche and user prompt (after the slideshow)
   - Mix different section types - use diverse sections from available list
   - MUST use at least 8 different section types in the 10 sections
   - Available sections: slideshow, icon-bar, featured-collection, image-with-text, results, testimonials, newsletter, collage, section-divider, vertical-ticker, horizontal-ticker, custom-columns, content-tabs, comparison-table, contact-form
   - RANDOMIZE content for EACH block/section: Use unique, varied text
   - For horizontal-ticker: Each text block MUST have DIFFERENT content (not repeated text)
   - For testimonials: Each testimonial MUST have different author, quote, and rating
   - For icon-bar columns: Each column MUST have unique title and description
   - Adapt section selection to niche:
     * Fashion/Jewelry: Use collage, image-with-text, testimonials, horizontal-ticker
     * Tech/Gadgets: Use featured-collection, results (stats), comparison-table, content-tabs
     * Food/Organic: Use horizontal-ticker (certifications), testimonials, icon-bar (benefits)
     * Services: Use results (achievements), testimonials, contact-form, custom-columns
   - Change alignment and layout settings between generations
   - If generating multiple times, MUST create different configurations each time
12. PRODUCT PAGE STRUCTURE (for product template):
   - MUST use "main-product" section as the ONLY section
   - Product page is block-based - all content goes in blocks inside main-product section
   - MUST include 12-18 blocks in logical order for product pages
   - Essential blocks (ALWAYS include): product_title, product_price, product_product-variant-picker-block, product_buy-buttons, product_description
   - Trust blocks (highly recommended): review-avatars, rating-stars, payment-badges, product_shipping-checkpoints
   - Conversion blocks (choose based on niche): product_urgency, product_inventory, product_clickable-discount, countdown-timer
   - Additional blocks (choose 3-5): product_award-badge, product_sticky-atc, product_share-button, product_subscription, product_bundle-offer, product_custom-product-field, product_tabs, collapsible-row
   - Typical block order: product_award-badge → review-avatars → product_title → product_price → rating-stars → product_description → product_product-variant-picker-block → product_quantity-selector → product_buy-buttons → product_shipping-checkpoints → payment-badges → product_estimated-shipping → product_tabs OR collapsible-row → product_share-button
   - Adapt blocks to niche:
     * Fashion/Jewelry: product_sizing-chart, product_custom-product-field (engraving), review-avatars, product_urgency
     * Electronics: rating-stars, product_tabs (specs), product_bundle-offer, product_subscription
     * Food/Organic: product_shipping-checkpoints, product_subscription, icon-with-text (benefits)
     * Luxury: product_award-badge, review-avatars, product_estimated-shipping, payment-badges
   - Each block must have unique, descriptive ID (e.g., "award-badge-1", "title", "price", "variant-picker", "buy-buttons-1")
   - Do NOT use "tab" or "accordion" as a block type — they don't exist in this theme; use "product_tabs" or "collapsible-row" instead

AVAILABLE GLOBAL SETTINGS:
${JSON.stringify(globalSchema, null, 2)}

AVAILABLE SECTIONS:
${JSON.stringify(sectionSchemas, null, 2)}

AVAILABLE BLOCKS:
${JSON.stringify(blockSchemas, null, 2)}

OUTPUT FORMAT:
Your response must be a JSON object with this structure:
{
  "sections": {
    "section-id-1": {
      "type": "section-type",
      "settings": {
        // section settings here
      },
      // if blocks are allowed in this section
      "blocks": {
        "block-id-1": {
          "type": "block-type",
          "settings": {
            // block settings here
          }
        }
      },
      // IMPORTANT: if section has blocks, include block_order array
      "block_order": ["block-id-1", "block-id-2"]
    }
  },
  "order": ["section-id-1", "section-id-2", "section-id-3"]
}

IMPORTANT: The order array should contain AT MOST 10 sections for optimal homepage performance.`;
}

/**
 * Make an AI request to OpenRouter with retry logic
 */
async function makeAIRequest(userPrompt, systemPrompt, maxRetries = 3, context = {}) {
    if (!OPENROUTER_API_KEY) {
        throw new Error('OPENROUTER_API_KEY not set in environment. Please set it in .env file');
    }

    if (!userPrompt || typeof userPrompt !== 'string') {
        throw new Error('Invalid user prompt: must be a non-empty string');
    }

    const { requestId = instrumentation.nextRequestId('gen'), callType = 'main_generation' } = context;
    const startTime = Date.now();
    const promptChars = (systemPrompt ? systemPrompt.length : 0) + userPrompt.length;

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
                    messages: [
                        {
                            role: 'system',
                            content: systemPrompt
                        },
                        {
                            role: 'user',
                            content: userPrompt
                        }
                    ],
                    temperature: 0.8,
                    response_format: { type: 'json_object' }
                })
            });

            if (!response.ok) {
                const error = await response.text();
                if (attempt < maxRetries && response.status >= 500) {
                    // Retry on server errors
                    const delay = Math.pow(2, attempt - 1) * 1000;
                    console.warn(`⚠️  Attempt ${attempt} failed (${response.status}). Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                throw new Error(`OpenRouter API error (${response.status}): ${error}`);
            }

            const data = await response.json();

            if (!data.choices || !data.choices[0] || !data.choices[0].message) {
                throw new Error('Invalid API response format: missing choices or message');
            }

            const content = data.choices[0].message.content;
            instrumentation.logAICall({
                requestId,
                callType,
                model: OPENROUTER_MODEL,
                promptChars,
                outputChars: content ? content.length : 0,
                durationMs: Date.now() - startTime,
                retryCount: attempt - 1,
                attempts: attempt,
                success: true
            });
            return content;
        } catch (error) {
            if (attempt === maxRetries) {
                instrumentation.logAICall({
                    requestId,
                    callType,
                    model: OPENROUTER_MODEL,
                    promptChars,
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
            console.warn(`⚠️  Attempt ${attempt} failed: ${error.message}. Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

/**
 * Validate AI output against schemas (comprehensive validation)
 */
function validateOutput(output, schemas, context = {}) {
    const { requestId = instrumentation.nextRequestId('val') } = context;
    try {
        if (!output || typeof output !== 'string') {
            throw new Error('Invalid output: must be a non-empty string');
        }

        const config = JSON.parse(output);

        // Validate structure
        if (!config.sections || typeof config.sections !== 'object') {
            throw new Error('Invalid output: missing sections object');
        }

        if (!Array.isArray(config.order)) {
            throw new Error('Invalid output: missing order array');
        }

        // Validate homepage best practice: maximum 10 sections
        if (config.order.length > 10) {
            throw new Error(`Invalid output: Homepage has ${config.order.length} sections. Maximum 10 sections recommended for optimal performance and user experience.`);
        }

        if (config.order.length === 0) {
            throw new Error('Invalid output: order array must contain at least 1 section');
        }

        // Create lookup maps for fast validation
        const sectionMap = new Map(schemas.sectionSchemas.map(s => [s.id, s]));
        const blockMap = new Map(schemas.blockSchemas.map(b => [b.id, b]));

        const errors = [];
        const warnings = [];
        let totalBlockCount = 0;

        // Validate each section
        for (const [sectionId, section] of Object.entries(config.sections)) {
            if (!section.type) {
                errors.push(`Section "${sectionId}": missing type property`);
                continue;
            }

            if (!sectionMap.has(section.type)) {
                errors.push(`Section "${sectionId}": unknown section type "${section.type}" — this section type doesn't exist in any schema and will fail to upload to Shopify`);
                continue;
            }

            const sectionSchema = sectionMap.get(section.type);

            // Check for section-level notes
            if (sectionSchema._notes) {
                if (DEBUG) {
                    console.log(`📝 Section "${sectionId}" notes:`, sectionSchema._notes);
                }
            }

            // Validate image_picker/image settings aren't hallucinated filenames
            if (sectionSchema.settings && section.settings) {
                for (const [settingKey, settingType] of Object.entries(sectionSchema.settings)) {
                    if (settingType === 'image_picker' || settingType === 'image') {
                        const value = section.settings[settingKey];
                        if (value && typeof value === 'string' && !value.startsWith('shopify://') && !/^https?:\/\//.test(value)) {
                            errors.push(`Section "${sectionId}" (type: "${section.type}"): setting "${settingKey}" has invalid image value "${value}" — image_picker settings must be left as an empty string ("") unless a real Shopify-hosted image URL is available. Do not invent filenames.`);
                        }
                    }
                }
            }

            // Validate blocks if section has blocks
            if (section.blocks && typeof section.blocks === 'object') {
                const blockIds = Object.keys(section.blocks);
                totalBlockCount += blockIds.length;

                // Check max_blocks limit
                if (sectionSchema.max_blocks && blockIds.length > sectionSchema.max_blocks) {
                    errors.push(`Section "${sectionId}" (type: "${section.type}"): has ${blockIds.length} blocks but maximum allowed is ${sectionSchema.max_blocks}`);
                }

                // Ensure block_order exists when there are blocks
                if (blockIds.length > 0) {
                    if (!Array.isArray(section.block_order)) {
                        errors.push(`Section "${sectionId}": has ${blockIds.length} blocks but missing "block_order" array`);
                    } else {
                        // Validate block_order references valid blocks
                        for (const blockId of section.block_order) {
                            if (!section.blocks.hasOwnProperty(blockId)) {
                                errors.push(`Section "${sectionId}": block_order references unknown block "${blockId}"`);
                            }
                        }
                        // Validate all blocks are in block_order
                        for (const blockId of blockIds) {
                            if (!section.block_order.includes(blockId)) {
                                errors.push(`Section "${sectionId}": block "${blockId}" not listed in block_order`);
                            }
                        }
                    }
                }

                for (const [blockId, block] of Object.entries(section.blocks)) {
                    if (!block.type) {
                        errors.push(`Block "${blockId}" in section "${sectionId}": missing type property`);
                        continue;
                    }

                    // Check if block type is allowed in this section
                    if (sectionSchema.allowed_blocks) {
                        let allowedBlocksList = [];
                        let blockSchemaDetails = null;

                        if (Array.isArray(sectionSchema.allowed_blocks)) {
                            // Format: ["block-type-1", "block-type-2"]
                            allowedBlocksList = sectionSchema.allowed_blocks;
                        } else if (typeof sectionSchema.allowed_blocks === 'object') {
                            // Format: { "block-type-1": {...}, "block-type-2": {...} }
                            allowedBlocksList = Object.keys(sectionSchema.allowed_blocks);
                            blockSchemaDetails = sectionSchema.allowed_blocks[block.type];
                        }

                        if (allowedBlocksList.length > 0 && !allowedBlocksList.includes(block.type)) {
                            errors.push(`Block "${blockId}" (type: "${block.type}") is not allowed in section "${sectionId}" — this block type doesn't exist in the real theme's blocks folder for this section and will fail to upload to Shopify. Allowed blocks: ${allowedBlocksList.join(', ')}`);
                        }

                        // Check block-level notes
                        if (blockSchemaDetails && blockSchemaDetails._notes) {
                            if (DEBUG) {
                                console.log(`📝 Block "${blockId}" (type: "${block.type}") notes:`, blockSchemaDetails._notes);
                            }
                            // Add warnings for richtext fields that need p tag wrapping
                            if (blockSchemaDetails._notes.text && blockSchemaDetails._notes.text.includes('p tag')) {
                                warnings.push(`Block "${blockId}": ${blockSchemaDetails._notes.text}`);
                            }
                        }
                    }

                    if (!blockMap.has(block.type)) {
                        errors.push(`Block "${blockId}": unknown block type "${block.type}" — this block type doesn't exist in any schema and will fail to upload to Shopify`);
                    } else {
                        // Validate image_picker/image settings aren't hallucinated filenames
                        const blockSchema = blockMap.get(block.type);
                        if (blockSchema.settings && block.settings) {
                            for (const [settingKey, settingType] of Object.entries(blockSchema.settings)) {
                                if (settingType === 'image_picker' || settingType === 'image') {
                                    const value = block.settings[settingKey];
                                    if (value && typeof value === 'string' && !value.startsWith('shopify://') && !/^https?:\/\//.test(value)) {
                                        errors.push(`Block "${blockId}" (type: "${block.type}"): setting "${settingKey}" has invalid image value "${value}" — image_picker settings must be left as an empty string ("") unless a real Shopify-hosted image URL is available. Do not invent filenames.`);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Validate order references valid sections
        for (const sectionId of config.order) {
            if (!config.sections.hasOwnProperty(sectionId)) {
                errors.push(`Order references unknown section "${sectionId}"`);
            }
        }

        if (errors.length > 0) {
            instrumentation.logValidation({
                requestId,
                valid: false,
                errorCount: errors.length,
                warningCount: warnings.length,
                sectionCount: config.order.length,
                blockCount: totalBlockCount,
                error: errors.join('; ')
            });
            return { valid: false, error: errors.join('; '), warnings };
        }

        instrumentation.logValidation({
            requestId,
            valid: true,
            errorCount: 0,
            warningCount: warnings.length,
            sectionCount: config.order.length,
            blockCount: totalBlockCount
        });
        return { valid: true, config, warnings };
    } catch (error) {
        instrumentation.logValidation({
            requestId,
            valid: false,
            errorCount: 1,
            error: error.message
        });
        return { valid: false, error: error.message };
    }
}

/**
 * Color palettes for different niches/themes
 */
const COLOR_PALETTES = {
    luxury: {
        colors_accent_1: "#2C1810",
        colors_accent_2: "#8B7355",
        colors_text: "#1A1A1A",
        colors_background_1: "#FFFFFF",
        colors_background_2: "#F5F1E8",
        colors_solid_button_labels: "#FFFFFF",
        gradient_accent_1: "linear-gradient(135deg, #2C1810 0%, #5C4033 100%)"
    },
    modern: {
        colors_accent_1: "#1B1B1B",
        colors_accent_2: "#666666",
        colors_text: "#333333",
        colors_background_1: "#FFFFFF",
        colors_background_2: "#F7F7F7",
        colors_solid_button_labels: "#FFFFFF",
        gradient_accent_1: "linear-gradient(135deg, #1B1B1B 0%, #4A4A4A 100%)"
    },
    vibrant: {
        colors_accent_1: "#FF6B35",
        colors_accent_2: "#F7931E",
        colors_text: "#2C3E50",
        colors_background_1: "#FFFFFF",
        colors_background_2: "#FFF8F3",
        colors_solid_button_labels: "#FFFFFF",
        gradient_accent_1: "linear-gradient(135deg, #FF6B35 0%, #F7931E 100%)"
    },
    nature: {
        colors_accent_1: "#2D5016",
        colors_accent_2: "#6B8E23",
        colors_text: "#1A3A1A",
        colors_background_1: "#FFFFFF",
        colors_background_2: "#F0F5E8",
        colors_solid_button_labels: "#FFFFFF",
        gradient_accent_1: "linear-gradient(135deg, #2D5016 0%, #6B8E23 100%)"
    },
    tech: {
        colors_accent_1: "#0066CC",
        colors_accent_2: "#00D9FF",
        colors_text: "#0A0E27",
        colors_background_1: "#FFFFFF",
        colors_background_2: "#F0F4FF",
        colors_solid_button_labels: "#FFFFFF",
        gradient_accent_1: "linear-gradient(135deg, #0066CC 0%, #00D9FF 100%)"
    },
    feminine: {
        colors_accent_1: "#D946A6",
        colors_accent_2: "#F472B6",
        colors_text: "#3D2645",
        colors_background_1: "#FFFFFF",
        colors_background_2: "#FDF4FF",
        colors_solid_button_labels: "#FFFFFF",
        gradient_accent_1: "linear-gradient(135deg, #D946A6 0%, #F472B6 100%)"
    }
};

/**
 * Ask AI to suggest custom color palette based on user prompt
 */
async function generateAIColorPalette(userPrompt, maxRetries = 2, context = {}) {
    const { requestId = instrumentation.nextRequestId('color'), callType = 'color_palette' } = context;
    const startTime = Date.now();

    if (!OPENROUTER_API_KEY) {
        if (DEBUG) console.log('⚠️  No OPENROUTER_API_KEY, skipping AI color generation');
        return null;
    }

    try {
        const colorPrompt = `You are a professional UI/UX color designer. Based on this store description, suggest a beautiful color palette for a Shopify store.

Store Description: "${userPrompt}"

Respond ONLY with valid JSON (no markdown, no explanation):
{
  "niche": "brief niche name",
  "description": "why these colors work",
  "colors_accent_1": "#hexcolor",
  "colors_accent_2": "#hexcolor",
  "colors_text": "#hexcolor",
  "colors_background_1": "#hexcolor",
  "colors_background_2": "#hexcolor",
  "colors_solid_button_labels": "#hexcolor",
  "gradient_accent_1": "linear-gradient(135deg, #color1 0%, #color2 100%)"
}

IMPORTANT:
- Primary colors should be vibrant and match the store niche
- Avoid pure black (#000000) or white (#FFFFFF) as primary/secondary colors
- Ensure good contrast for accessibility`;

        // Use direct fetch instead of makeAIRequest for more control
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
                messages: [
                    {
                        role: 'user',
                        content: colorPrompt
                    }
                ],
                temperature: 0.7,
                response_format: { type: 'json_object' }
            })
        });

        if (!response.ok) {
            const error = await response.text();
            console.warn(`⚠️  Color generation API error: ${error}`);
            instrumentation.logAICall({
                requestId, callType, model: OPENROUTER_MODEL,
                promptChars: userPrompt.length, outputChars: 0,
                durationMs: Date.now() - startTime, success: false, error
            });
            return null;
        }

        const data = await response.json();
        const content = data.choices?.[0]?.message?.content;

        if (!content) {
            console.warn('⚠️  No content in AI color response');
            instrumentation.logAICall({
                requestId, callType, model: OPENROUTER_MODEL,
                promptChars: userPrompt.length, outputChars: 0,
                durationMs: Date.now() - startTime, success: false, error: 'No content in AI color response'
            });
            return null;
        }

        if (DEBUG) {
            console.log('🔍 Raw AI color response:', content.substring(0, 200));
        }

        const colorPalette = JSON.parse(content);

        // Validate that we got the required color fields
        if (!colorPalette.colors_accent_1 || !colorPalette.colors_accent_2) {
            console.warn('⚠️  AI color palette missing required fields, using fallback');
            instrumentation.logAICall({
                requestId, callType, model: OPENROUTER_MODEL,
                promptChars: userPrompt.length, outputChars: content.length,
                durationMs: Date.now() - startTime, success: false, error: 'AI color palette missing required fields'
            });
            return null;
        }

        if (DEBUG) {
            console.log(`🎨 AI Generated Color Palette for niche: ${colorPalette.niche || 'custom'}`);
            console.log(`   Primary: ${colorPalette.colors_accent_1}`);
            console.log(`   Secondary: ${colorPalette.colors_accent_2}`);
            console.log(`   Reason: ${colorPalette.description || 'N/A'}`);
        }

        instrumentation.logAICall({
            requestId, callType, model: OPENROUTER_MODEL,
            promptChars: userPrompt.length, outputChars: content.length,
            durationMs: Date.now() - startTime, success: true
        });
        return colorPalette;
    } catch (error) {
        console.warn(`⚠️  AI color generation failed: ${error.message}`);
        instrumentation.logAICall({
            requestId, callType, model: OPENROUTER_MODEL,
            promptChars: userPrompt.length, outputChars: 0,
            durationMs: Date.now() - startTime, success: false, error: error.message
        });
        return null;
    }
}

/**
 * Detect niche and get colors from AI or predefined palettes
 */
function detectNicheAndGetColors(userPrompt) {
    const prompt = userPrompt.toLowerCase();

    const nicheKeywords = {
        luxury: ['luxury', 'premium', 'high-end', 'exclusive', 'gold', 'elegant', 'sophisticated'],
        modern: ['modern', 'minimalist', 'clean', 'professional', 'corporate', 'sleek', 'contemporary'],
        vibrant: ['vibrant', 'colorful', 'energetic', 'playful', 'bold', 'bright', 'fun', 'dynamic'],
        nature: ['natural', 'organic', 'eco', 'green', 'sustainable', 'earth', 'outdoor', 'nature'],
        tech: ['tech', 'technology', 'startup', 'digital', 'innovation', 'software', 'futuristic'],
        feminine: ['feminine', 'beauty', 'fashion', 'cosmetic', 'women', 'delicate', 'elegant']
    };

    // Find matching niche
    for (const [niche, keywords] of Object.entries(nicheKeywords)) {
        if (keywords.some(keyword => prompt.includes(keyword))) {
            if (DEBUG) {
                console.log(`🎨 Detected niche: "${niche}" - Using corresponding color palette`);
            }
            return { niche, colors: COLOR_PALETTES[niche] };
        }
    }

    // Default to modern if no match
    if (DEBUG) {
        console.log(`🎨 No niche detected - Using default modern palette`);
    }
    return { niche: 'modern', colors: COLOR_PALETTES.modern };
}

/**
 * Load global settings from global.json and convert to settings_data.json format
 */
async function loadGlobalSettings(customColors = null) {
    const globalPath = path.join(__dirname, 'schema-data', 'global.json');

    try {
        const globalData = JSON.parse(await fs.readFile(globalPath, 'utf8'));

        if (!globalData.settings || typeof globalData.settings !== 'object') {
            throw new Error('Invalid global.json: missing settings object');
        }

        // Use custom colors if provided, otherwise use defaults
        const presetColors = customColors || {
            colors_solid_button_labels: "#FDFBF7",
            colors_accent_1: "#9B046F",
            gradient_accent_1: "",
            colors_accent_2: "#5E3653",
            gradient_accent_2: "linear-gradient(320deg, rgba(134, 16, 106, 1), rgba(94, 54, 83, 1) 100%)",
            colors_text: "#2E2A39",
            colors_outline_button_labels: "#2E2A39",
            colors_background_1: "#FFFFFF",
            colors_background_2: "#F3F3F3"
        };

        // Build current settings with default values
        const current = {};

        for (const [key, setting] of Object.entries(globalData.settings)) {
            if (typeof setting === 'string') {
                // Simple type like "color"
                if (setting === 'color') {
                    // Use preset color if available, otherwise use a sensible default
                    current[key] = presetColors[key] || '#121212';
                } else {
                    current[key] = '';
                }
            } else if (setting && typeof setting === 'object' && setting.type === 'range') {
                // Range has a default value
                current[key] = setting.default !== undefined ? setting.default : setting.min;
            } else if (setting && typeof setting === 'object' && setting.type === 'font_picker') {
                current[key] = 'assistant_n4';
            } else {
                current[key] = (setting && setting.default) || '';
            }
        }

        // Add standard fields
        current.disable_inspect = true;
        current.logo_width = 200;
        current.mobile_logo_width = 130;

        // Build presets with custom colors
        const presets = {
            "Default": {
                logo_width: 70,
                ...presetColors
            }
        };

        // Build platform customizations
        const platform_customizations = {
            custom_css: []
        };

        return {
            current,
            presets,
            platform_customizations
        };
    } catch (error) {
        console.warn('⚠️  Could not load global.json, using minimal settings:', error.message);
        return {
            current: {
                disable_inspect: true,
                logo_width: 200,
                mobile_logo_width: 130
            },
            presets: {},
            platform_customizations: { custom_css: [] }
        };
    }
}

module.exports = {
    loadSchemas,
    buildSystemPrompt,
    makeAIRequest,
    validateOutput,
    loadGlobalSettings,
    detectNicheAndGetColors,
    generateAIColorPalette,
    COLOR_PALETTES
};
