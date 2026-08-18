import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // lib/ai-schema/schema-data/*.json is read via fs at runtime (not
  // `import`), so Next's serverless file tracing wouldn't otherwise bundle
  // it — without this, a serverless deploy (e.g. Vercel) would 404/ENOENT
  // on these files even though `next build`/local `next start` work fine.
  outputFileTracingIncludes: {
    "/api/**": ["./lib/ai-schema/schema-data/**"],
  },
};

export default nextConfig;
