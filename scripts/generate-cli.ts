// `pnpm generate "<prompt>"` — run the worker's generation pipeline straight
// from the terminal: no browser, no sign-up, no Shopify OAuth, no queue and
// no database rows. Useful for exercising the AI side of the app on its own.
//
//   pnpm generate "modern coffee shop, warm tones, big hero"
//   pnpm generate --type restaurant "brunch spot, menu + gallery"
//   pnpm generate --template product "..."   generate a different template
//   pnpm generate --apply "..."              write the result into the theme
//   pnpm generate --out-dir theme_out "..."  write it into a COPY of the theme
//   pnpm generate --out result.json "..."    dump the full result JSON
//
// This mirrors processGenerateTheme() in scripts/worker.ts step for step; the
// only things it skips are the DB reads/writes that track a job. It works
// without a connected store because theme I/O goes through
// lib/ai-schema/local-theme-fs.ts, which reads and writes the checkout at
// LOCAL_THEME_ROOT and ignores the shopDomain/accessToken/themeId it is
// handed (see that file's header). Those are passed as placeholders below.
//
// require(), not import, for the same reason as scripts/worker.ts: ai-client
// reads OPENROUTER_API_KEY at module scope, and ESM imports are hoisted above
// the process.loadEnvFile() call that puts it there.

try {
  process.loadEnvFile();
} catch {
  // no .env file present in cwd — assume the environment is already set
}

import type { MergeResult, ValidationResult } from "../lib/ai-schema/types";

const { LOCAL_THEME_ID } = require("../lib/ai-schema/local-theme-fs");
const { loadSchemas } = require("../lib/ai-schema/ai-client");
const { buildThemeState } = require("../lib/ai-schema/theme-state");
const { runStagedGeneration } = require("../lib/ai-schema/generation");
const { validateCandidate } = require("../lib/ai-schema/validation");
const { mergeThemeState } = require("../lib/ai-schema/merge");
const { createEmptyBrief } = require("../lib/ai-schema/brief-logic");
const { applyThemeState } = require("../lib/ai-schema/apply");

const { writeFileSync } = require("node:fs") as typeof import("node:fs");
const { cp, mkdir, readdir } = require("node:fs/promises") as typeof import("node:fs/promises");
const { resolve } = require("node:path") as typeof import("node:path");

// Accepted and ignored by local-theme-fs — kept only because buildThemeState()
// and applyThemeState() still require the live-Shopify argument shape.
const PLACEHOLDER_SHOP = "cli.local";
const PLACEHOLDER_TOKEN = "cli";

const HELP = `pnpm generate — run the AI generation pipeline from the terminal

  pnpm generate "<prompt>"                     report only, write nothing
  pnpm generate --apply "<prompt>"             write into LOCAL_THEME_ROOT
  pnpm generate --out-dir theme_out "<prompt>" write into a copy of the theme

Options:
  --type <business type>   defaults to "general"
  --template <name>        template to generate, defaults to "index"
  --out <file.json>        write the full result JSON to a file
  --apply                  write the merged theme state to LOCAL_THEME_ROOT,
                           overwriting the vendored theme in place
  --out-dir <dir>          copy the whole theme there first and write into
                           that copy instead, leaving LOCAL_THEME_ROOT
                           untouched. Preview it with:
                             shopify theme dev --path <dir>
                           An existing <dir> is reused as-is (so successive
                           runs build on it); --fresh re-copies from scratch.
  --fresh                  with --out-dir, re-copy the theme before running
  -h, --help               this help

Needs OPENROUTER_API_KEY and LOCAL_THEME_ROOT in .env. Every run makes real
(paid) OpenRouter calls. With neither --apply nor --out-dir, no theme file is
written at all.`;

type Args = {
  prompt: string;
  businessType: string;
  templateName: string;
  out: string | null;
  outDir: string | null;
  apply: boolean;
  fresh: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    prompt: "",
    businessType: "general",
    templateName: "index",
    out: null,
    outDir: null,
    apply: false,
    fresh: false,
    help: false,
  };
  const words: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") args.help = true;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--fresh") args.fresh = true;
    else if (arg === "--type") args.businessType = argv[++i] ?? args.businessType;
    else if (arg === "--template") args.templateName = argv[++i] ?? args.templateName;
    else if (arg === "--out") args.out = argv[++i] ?? null;
    else if (arg === "--out-dir") args.outDir = argv[++i] ?? null;
    else words.push(arg);
  }
  // Quoting is optional: everything that isn't a flag is the prompt.
  args.prompt = words.join(" ").trim();
  return args;
}

/**
 * Copy the theme checkout to `dir` and point LOCAL_THEME_ROOT at the copy, so
 * both the read and the write in this run target it and the vendored theme is
 * never touched. This has to happen before the first theme read: getThemeRoot()
 * in local-theme-fs.ts caches the resolved root for the life of the process, so
 * the env var is only read once.
 */
async function prepareOutDir(dir: string, fresh: boolean): Promise<string> {
  const source = (process.env.LOCAL_THEME_ROOT || "").trim();
  if (!source) {
    throw new Error("LOCAL_THEME_ROOT is not set — nothing to copy from (see .env.example)");
  }
  const target = resolve(dir);
  if (resolve(source) === target) {
    throw new Error("--out-dir is LOCAL_THEME_ROOT itself; use --apply to write in place");
  }

  const existing = await readdir(target).catch(() => null);
  if (existing === null || existing.length === 0 || fresh) {
    await mkdir(target, { recursive: true });
    // force:true so --fresh overwrites a previous copy rather than merging
    // two generations of the same theme.
    await cp(resolve(source), target, { recursive: true, force: true });
    console.log(`  copied theme -> ${target}`);
  } else {
    console.log(`  reusing existing ${target} (pass --fresh to re-copy)`);
  }

  process.env.LOCAL_THEME_ROOT = target;
  return target;
}

function heading(text: string): void {
  console.log(`\n\x1b[1m${text}\x1b[0m`);
}

function listIssues(label: string, issues: ValidationResult["errors"]): void {
  if (issues.length === 0) return;
  console.log(`  ${label}:`);
  for (const issue of issues) {
    console.log(`    - ${issue.path ? `${issue.path}: ` : ""}${issue.message}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  if (!args.prompt) {
    console.error('A prompt is required, e.g. pnpm generate "modern coffee shop"');
    console.error("Run `pnpm generate -h` for the full usage.");
    return 1;
  }
  if (!process.env.OPENROUTER_API_KEY) {
    console.error("OPENROUTER_API_KEY is not set (expected in .env — see .env.example)");
    return 1;
  }

  const requestId = `cli-${process.pid}`;
  console.log(`prompt:   ${args.prompt}`);
  console.log(`type:     ${args.businessType}`);
  console.log(`template: ${args.templateName}`);

  heading("1. Reading the local theme");
  const outDir = args.outDir ? await prepareOutDir(args.outDir, args.fresh) : null;
  const schemas = await loadSchemas();
  const themeState = await buildThemeState({
    shopDomain: PLACEHOLDER_SHOP,
    accessToken: PLACEHOLDER_TOKEN,
    themeId: LOCAL_THEME_ID,
    schemas,
    context: { requestId },
  });
  const templateNames = Object.keys(themeState.templates ?? {});
  console.log(`  ${templateNames.length} template(s) read from LOCAL_THEME_ROOT: ${templateNames.join(", ") || "none"}`);
  console.log(`  catalog: ${schemas.sectionSchemas.length} sections, ${schemas.blockSchemas.length} blocks`);

  heading("2. Generating (AI calls — this is the slow part)");
  const brief = createEmptyBrief();
  brief.businessType = { value: args.businessType, status: "confirmed", source: "user" };
  brief.additionalRequirements = { value: args.prompt, status: "confirmed", source: "user" };

  const generated = await runStagedGeneration({
    brief,
    schemas,
    themeState,
    templateName: args.templateName,
    requestId,
  });
  console.log(
    `  ${generated.aiCallCount} AI call(s) in ${(generated.durationMs / 1000).toFixed(1)}s` +
      `${generated.planRepaired ? ", plan repaired" : ""}${generated.configRepaired ? ", config repaired" : ""}`,
  );
  const order: string[] = generated.config?.order ?? [];
  console.log(`  ${order.length} section(s):`);
  for (const id of order) {
    console.log(`    - ${id} (${generated.config.sections?.[id]?.type ?? "?"})`);
  }
  for (const warning of generated.warnings ?? []) console.log(`  warning: ${warning}`);

  heading("3. Validating");
  const candidateValidation: ValidationResult = validateCandidate(generated.config, schemas, {
    templateName: args.templateName,
    themeState,
  });
  console.log(
    `  ${candidateValidation.valid ? "valid" : "INVALID"} — ` +
      `${candidateValidation.errors.length} error(s), ${candidateValidation.warnings.length} warning(s)`,
  );
  listIssues("errors", candidateValidation.errors);
  listIssues("warnings", candidateValidation.warnings);

  heading("4. Merging into the theme state");
  // Same acknowledgement the worker passes: a fresh homepage deliberately
  // replaces the template's existing section structure.
  const merged: MergeResult = mergeThemeState(themeState, {
    templateName: args.templateName,
    candidate: generated.config,
    candidateValidation,
    acknowledgeUnknownSectionReplacement: true,
    requestId,
  });
  if (!merged.valid) {
    console.error("  merge failed:");
    for (const c of merged.conflicts) console.error(`    [${c.code}] ${c.message}`);
    return 1;
  }
  const summary = merged.summary!;
  console.log(`  changed files:    ${summary.changedFiles.join(", ") || "none"}`);
  console.log(`  added sections:   ${summary.addedSections.length}`);
  console.log(`  updated sections: ${summary.updatedSections.length}`);
  console.log(`  removed sections: ${summary.removedSections.length}`);

  const write = args.apply || outDir !== null;
  heading(write ? `5. Writing to ${outDir ?? "LOCAL_THEME_ROOT"}` : "5. Apply (dry run)");
  const applyResult = await applyThemeState(merged.mergedThemeState, {
    shopDomain: PLACEHOLDER_SHOP,
    accessToken: PLACEHOLDER_TOKEN,
    themeId: LOCAL_THEME_ID,
    changedTemplates: summary.changedTemplates,
    writeGlobalSettings: summary.changedSettings.length > 0,
    dryRun: !write,
    requestId,
  });
  if (write) {
    console.log(`  wrote: ${applyResult.filesWritten.join(", ") || "nothing"}`);
    if (outDir) console.log(`\n  preview it with:  shopify theme dev --path ${outDir}`);
  } else {
    console.log(`  would write: ${applyResult.targets.join(", ") || "nothing"}`);
    console.log("  (re-run with --apply, or --out-dir <dir>, to actually write)");
  }

  if (args.out) {
    writeFileSync(
      args.out,
      `${JSON.stringify(
        {
          templateName: args.templateName,
          plan: generated.plan,
          config: generated.config,
          warnings: generated.warnings,
          candidateValidation,
          mergeSummary: summary,
          mergedThemeState: merged.mergedThemeState,
          apply: applyResult,
        },
        null,
        2,
      )}\n`,
    );
    console.log(`\nfull result written to ${args.out}`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`\n${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  },
);
