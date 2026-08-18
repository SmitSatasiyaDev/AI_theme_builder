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
    // lib/ai-schema/**/*.js is a deliberate CommonJS port of the original
    // ai-schema CLI tool (require()/module.exports, unchanged from source
    // where possible — see each file's header comment). scripts/worker.ts
    // and the theme/apply route require() into that library on purpose:
    // both the standalone tsx-run worker and Next's bundler need to
    // resolve the same relative paths, and tsx doesn't apply tsconfig's
    // `@/*` path alias the way Next's bundler does, so `import` there
    // would behave inconsistently across the two runtimes.
    files: [
      "lib/ai-schema/**/*.js",
      "scripts/worker.ts",
      "app/api/theme/apply/route.ts",
      "app/api/edit/route.ts",
      "app/api/edit/apply/route.ts",
    ],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
]);

export default eslintConfig;
