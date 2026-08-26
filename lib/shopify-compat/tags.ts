import type { Liquid, Context, Emitter, TagToken, TopLevelToken, Template } from "liquidjs";

// Shopify-native Liquid tags LiquidJS has no equivalent for: {% style %}, {% form %},
// {% content_for %}, {% paginate %}, plus the theme-authoring metadata tags ({% schema %},
// {% javascript %}, {% stylesheet %}) which must parse and then produce nothing in the
// preview. Ported verbatim from the Shopforge preview renderer.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Nesting depth for `{% content_for 'blocks' %}`, carried in the render context. */
const BLOCK_DEPTH = "__sf_block_depth";
const MAX_BLOCK_DEPTH = 8;

/** Buffers everything up to `end<name>` so the tag can wrap or discard its body. */
function parseBlock(self: any, name: string, remainTokens: TopLevelToken[]) {
  self.templates = [];
  const stream = self.liquid.parser
    .parseStream(remainTokens)
    .on(`tag:end${name}`, () => stream.stop())
    .on("template", (tpl: Template) => self.templates.push(tpl))
    .on("end", () => {
      throw new Error(`{% ${name} %} is not closed`);
    });
  stream.start();
}

/** A block tag whose body is parsed (so it must be valid Liquid) but never rendered. */
function discardedBlock(name: string) {
  return {
    parse(this: any, _token: TagToken, remainTokens: TopLevelToken[]) {
      parseBlock(this, name, remainTokens);
    },
    render() {
      /* intentionally empty — authoring metadata, not page output */
    },
  };
}

/** A block tag whose rendered body is wrapped in a fixed element. */
function wrappedBlock(name: string, open: string, close: string) {
  return {
    parse(this: any, _token: TagToken, remainTokens: TopLevelToken[]) {
      parseBlock(this, name, remainTokens);
    },
    *render(this: any, ctx: Context, emitter: Emitter): any {
      emitter.write(open);
      yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
      emitter.write(close);
    },
  };
}

/** `{% form 'product', product, id: 'x', class: 'y' %}` — attribute hash after the first two positional args. */
function parseFormAttrs(args: string): { kind: string; attrs: string } {
  const kindMatch = args.match(/^\s*['"]([^'"]+)['"]/);
  const kind = kindMatch ? kindMatch[1] : "form";
  const attrs: string[] = [];
  for (const [, key, quoted, bare] of args.matchAll(/(\w+)\s*:\s*(?:['"]([^'"]*)['"]|([\w.-]+))/g)) {
    if (key === "id" || key === "class") attrs.push(`${key}="${quoted ?? bare}"`);
  }
  return { kind, attrs: attrs.length ? ` ${attrs.join(" ")}` : "" };
}

export function registerShopifyTags(engine: Liquid) {
  // Inline CSS. Shopify scopes it to the section; the preview just emits the <style>.
  engine.registerTag("style", wrappedBlock("style", "<style>", "</style>"));

  // Theme-authoring metadata: parsed for validity, dropped from the rendered page.
  engine.registerTag("schema", discardedBlock("schema"));
  engine.registerTag("javascript", discardedBlock("javascript"));
  engine.registerTag("stylesheet", discardedBlock("stylesheet"));

  // The preview iframe runs without allow-scripts, so a form can never submit — it is
  // rendered for layout fidelity only, deliberately without an action.
  engine.registerTag("form", {
    parse(this: any, token: TagToken, remainTokens: TopLevelToken[]) {
      this.args = token.args;
      parseBlock(this, "form", remainTokens);
    },
    *render(this: any, ctx: Context, emitter: Emitter): any {
      const { kind, attrs } = parseFormAttrs(this.args);
      emitter.write(`<form method="post" data-sf-form="${kind}"${attrs}>`);
      yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
      emitter.write("</form>");
    },
  });

  // `{% paginate x by n %}` — the preview renders a single page, so the body renders once
  // with a `paginate` drop shaped enough for the theme's pagination guards.
  engine.registerTag("paginate", {
    parse(this: any, token: TagToken, remainTokens: TopLevelToken[]) {
      this.args = token.args;
      parseBlock(this, "paginate", remainTokens);
    },
    *render(this: any, ctx: Context, emitter: Emitter): any {
      const perPage = Number.parseInt(this.args.match(/by\s+(\d+)/)?.[1] ?? "50", 10);
      ctx.push({
        paginate: { current_page: 1, pages: 1, items: perPage, parts: [], next: null, previous: null },
      });
      yield this.liquid.renderer.renderTemplates(this.templates, ctx, emitter);
      ctx.pop();
    },
  });

  // `{% content_for 'blocks' %}` — Online Store 2.0 theme blocks. Each block instance
  // renders blocks/<type>.liquid with `block` in scope, in block_order order.
  //
  // Theme blocks nest: blocks/column.liquid itself calls {% content_for 'blocks' %} to
  // render its children. The container is therefore the nearest `block` in scope, falling
  // back to `section` at the top level — resolving against `section.blocks` at every depth
  // would re-render the same list forever.
  engine.registerTag("content_for", {
    parse(this: any, token: TagToken) {
      this.args = token.args;
    },
    *render(this: any, ctx: Context, emitter: Emitter): any {
      const target = this.args.match(/^\s*['"]([^'"]+)['"]/)?.[1];
      if (target !== "blocks" && target !== "block") return;

      const depth = Number(ctx.getSync([BLOCK_DEPTH]) ?? 0);
      if (depth >= MAX_BLOCK_DEPTH) return; // backstop against a self-referential block graph

      const container = (ctx.getSync(["block"]) ?? ctx.getSync(["section"])) as
        | { blocks?: unknown }
        | undefined;
      const blocks = Array.isArray(container?.blocks) ? (container.blocks as any[]) : [];

      for (const block of blocks) {
        if (!block?.type) continue;
        let source: string;
        try {
          source = yield this.liquid.options.fs.readFile(`blocks/${block.type}.liquid`);
        } catch {
          continue; // a block type this theme doesn't ship is skipped, never fatal
        }
        ctx.push({ block, [BLOCK_DEPTH]: depth + 1 });
        yield this.liquid.renderer.renderTemplates(this.liquid.parse(source), ctx, emitter);
        ctx.pop();
      }
    },
  });

  // `{% section 'name' %}` — render a section file standalone (used from layout/theme.liquid).
  engine.registerTag("section", {
    parse(this: any, token: TagToken) {
      this.args = token.args;
    },
    *render(this: any, ctx: Context, emitter: Emitter): any {
      const name = this.args.match(/^\s*['"]([^'"]+)['"]/)?.[1];
      if (!name) return;
      let source: string;
      try {
        source = yield this.liquid.options.fs.readFile(`sections/${name}.liquid`);
      } catch {
        return;
      }
      ctx.push({ section: { id: name, settings: {}, blocks: [] } });
      yield this.liquid.renderer.renderTemplates(this.liquid.parse(source), ctx, emitter);
      ctx.pop();
    },
  });

  // `{% sections 'header-group' %}` — section groups are resolved by the template renderer,
  // which injects the rendered group under `content_for_<name>`; nothing to emit here.
  engine.registerTag("sections", {
    parse(this: any, token: TagToken) {
      this.args = token.args;
    },
    *render(this: any, ctx: Context, emitter: Emitter): any {
      const name = this.args.match(/^\s*['"]([^'"]+)['"]/)?.[1];
      if (!name) return;
      const rendered = ctx.getSync([`content_for_${name.replace(/-/g, "_")}`]);
      if (typeof rendered === "string") emitter.write(rendered);
    },
  });
}
