import { Liquid } from "liquidjs";
import { TemplateReader } from "@/lib/preview/template-loader";
import { createThemeFS } from "./theme-fs";
import { registerShopifyTags } from "./tags";
import { registerShopifyFilters } from "./filters";

export interface EngineOptions {
  readTemplate: TemplateReader;
  locale: Record<string, unknown>;
  currency?: string | null;
}

/**
 * One LiquidJS engine configured to render the real Base Theme: Shopify's missing tags,
 * its non-native filters, and a filesystem that resolves `{% render %}` against the theme's
 * own snippets/ directory the way Shopify does. Ported verbatim from the Shopforge preview
 * renderer.
 */
export function createShopifyLiquid(options: EngineOptions): Liquid {
  const engine = new Liquid({
    cache: false,
    fs: createThemeFS(options.readTemplate),
    root: ["snippets"],
    extname: ".liquid",
    // Shopify resolves `{% render 'x' %}` from snippets/ regardless of the including file's
    // location, so relative resolution is off — otherwise a snippet rendering another
    // snippet would look in the wrong directory.
    relativeReference: false,
    // Shopify Liquid does not auto-escape output, and the theme relies on that for its
    // richtext settings and inline SVG snippets.
    outputEscape: undefined,
    // A missing setting is normal in a partially-configured section; it must render empty
    // rather than abort the whole page.
    strictVariables: false,
    strictFilters: false,
    lenientIf: true,
  });

  registerShopifyTags(engine);
  registerShopifyFilters(engine, { locale: options.locale, currency: options.currency });
  return engine;
}
