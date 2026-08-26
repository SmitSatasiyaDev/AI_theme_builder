import type { FS } from "liquidjs";
import { TemplateReader } from "@/lib/preview/template-loader";

/**
 * LiquidJS filesystem backed by a TemplateReader, so `{% render %}` resolves the Base
 * Theme's real snippets. The reader is async-only (reads off LOCAL_THEME_ROOT via
 * lib/ai-schema/local-theme-fs.ts), so the *Sync members throw rather than lie; every render
 * path through this engine uses async `render()`. Ported verbatim from the Shopforge preview
 * renderer.
 */
export function createThemeFS(readTemplate: TemplateReader): FS {
  const missing = new Set<string>();

  const syncUnsupported = (): never => {
    throw new Error("The theme filesystem is async-only; use render(), not renderSync().");
  };

  return {
    sep: "/",
    dirname: (file: string) => file.split("/").slice(0, -1).join("/"),
    resolve: (dir: string, file: string, ext: string) => {
      const name = file.endsWith(ext) ? file : `${file}${ext}`;
      return dir ? `${dir.replace(/\/$/, "")}/${name}` : name;
    },
    readFile: (filepath: string) => readTemplate(filepath),
    exists: async (filepath: string) => {
      if (missing.has(filepath)) return false;
      try {
        await readTemplate(filepath);
        return true;
      } catch {
        missing.add(filepath);
        return false;
      }
    },
    readFileSync: syncUnsupported,
    existsSync: syncUnsupported,
  };
}
