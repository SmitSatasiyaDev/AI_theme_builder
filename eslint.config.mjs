import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // lib/ai-schema/apply.js is a deliberate CommonJS port of the original
    // ai-schema CLI tool's Shopify-facing apply path (require()/
    // module.exports, unchanged from source — see its header comment; the
    // rest of lib/ai-schema/ was converted to TypeScript/ESM, apply.js was
    // deliberately left out of that pass). scripts/worker.ts require()s
    // into the library on purpose: it's a standalone tsx-run process, and
    // tsx doesn't apply tsconfig's `@/*` path alias the way Next's bundler
    // does, so `import` there would behave inconsistently across the two
    // runtimes — its header comment documents a second reason too (env-load
    // ordering).
    files: [
      "lib/ai-schema/apply.js",
      "scripts/worker.ts",
      "app/api/theme/apply/route.ts",
      "app/api/edit/apply/route.ts",
    ],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
