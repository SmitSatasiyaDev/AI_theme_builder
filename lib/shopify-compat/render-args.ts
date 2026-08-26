// Shopify's `{% render %}` accepts a bare variable as shorthand for passing it under its own
// name: `{% render 'gallery', section %}` behaves like `section: section`. LiquidJS parses the
// same tag as `section: undefined`, which *shadows* the identically named global inside the
// snippet — the Base Theme's product media gallery reads `section.settings` that way and
// silently renders an empty gallery. Rewriting the shorthand to the explicit form at source
// level keeps the engine untouched and covers every call site, instead of editing the vendored
// theme files. Ported verbatim from the Shopforge preview renderer.

const RENDER_TAG = /(\{%-?\s*render\s+(?:'[^']*'|"[^"]*"))([\s\S]*?)(-?%\})/g;

export function normalizeRenderTagArgs(source: string): string {
  return source.replace(RENDER_TAG, (full, head: string, args: string, tail: string) => {
    if (!args.trim()) return full;
    return `${head}${normalizeArgs(args)}${tail}`;
  });
}

/**
 * Rewrites each top-level comma-separated argument that is a bare identifier to
 * `name: name`. Anything else — `key: value` pairs, `with x as y` clauses, quoted
 * strings containing commas — passes through byte-for-byte.
 */
function normalizeArgs(args: string): string {
  const pieces: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of args) {
    if (quote) {
      if (ch === quote) quote = null;
      current += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
    } else if (ch === ",") {
      pieces.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  pieces.push(current);

  return pieces
    .map((piece) => {
      const bare = piece.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*)$/);
      return bare ? `${bare[1]}${bare[2]}: ${bare[2]}${bare[3]}` : piece;
    })
    .join(",");
}
