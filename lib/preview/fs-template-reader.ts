import { readFile } from "node:fs/promises";
import path from "node:path";
import { getThemeRoot } from "@/lib/ai-schema/local-theme-fs";
import { TemplateReader } from "./template-loader";

/**
 * Reads theme .liquid/.json source files straight off LOCAL_THEME_ROOT — the same on-disk
 * theme checkout generation/apply already read and write (lib/ai-schema/local-theme-fs.ts).
 * Adapted from Shopforge's fs-template-reader.ts, which reads from a vendored
 * public/base-theme instead; here the root is resolved per-call since LOCAL_THEME_ROOT is
 * validated lazily (see getThemeRoot()'s doc comment).
 */
export function createLocalThemeReader(): TemplateReader {
  const cache = new Map<string, Promise<string>>();
  return async (relativePath: string) => {
    let entry = cache.get(relativePath);
    if (!entry) {
      entry = getThemeRoot().then((root) => readFile(path.join(root, relativePath), "utf-8"));
      cache.set(relativePath, entry);
    }
    return entry;
  };
}
