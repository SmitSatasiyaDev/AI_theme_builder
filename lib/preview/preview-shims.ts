// The preview iframe never runs the theme's JavaScript (no click-to-select DOM patching, just
// a static render — see components/preview-frame.tsx). The Base Theme, like every modern
// Shopify theme, ships markup that is hidden in CSS until its own JavaScript reveals it.
// Without these shims the page renders correctly and is then hidden by its own stylesheets,
// which reads as a blank preview. Ported verbatim from the Shopforge preview renderer.
//
// Each shim reproduces exactly what the theme's own JavaScript would have done on load —
// nothing more. They are applied to the final HTML, never to the theme's source files.

/**
 * The theme boots with `<html class="no-js">` and its first inline script swaps it for `js`
 * (layout/theme.liquid). `base.css` hides every `.no-js-hidden` element while `no-js` is
 * present, so without the swap those elements are `display: none`.
 */
function applyJsClass(html: string): string {
  return html.replace(
    /(<html\b[^>]*\bclass=")([^"]*)(")/i,
    (_match, before: string, classes: string, after: string) => {
      const swapped = classes.includes("no-js")
        ? classes.replace(/\bno-js\b/g, "js")
        : `${classes} js`.trim();
      return `${before}${swapped}${after}`;
    },
  );
}

/**
 * Load animations. The theme renders sections as `.animate-section.animate--hidden` with
 * `.animate-item` children at `opacity: 0`, and an IntersectionObserver adds `animate--shown`
 * once the section scrolls into view. With no JavaScript nothing is ever shown, so the
 * preview pins every animated item to its final (revealed) state.
 *
 * The theme's own `<noscript>` fallback covers the same ground, but it is not reliable across
 * browsers inside a sandboxed iframe, so the preview does not depend on it.
 */
const PREVIEW_STYLES = `
    /* Preview: the theme's JavaScript does not run in the preview iframe, so anything it
       would have revealed is pinned to its revealed state. */
    .animate-section.animate--hidden .animate-item,
    .animate-section .animate-item {
      opacity: 1 !important;
      filter: none !important;
      transform: none !important;
    }

    /* The browser treats a sandboxed iframe as scripting-disabled, so it renders every
       <noscript> block. Those hold the theme's no-JS fallbacks — a plain numbered slider
       nav in place of the real one, for instance — which would appear alongside the real
       controls. The preview presents the JS-enabled storefront, so they stay hidden. */
    noscript {
      display: none !important;
    }

    /* Product media gallery. base.css hides every slide that is not .is-active, and the
       theme's media-gallery element assigns that class on load — so with no JavaScript the
       whole gallery is display:none and the product page shows slider arrows around an empty
       box, even though the images are present and loading. Pin the first real slide open;
       variant-specific slides stay hidden, as they are on a live storefront until a variant
       is selected. */
    .product--thumbnail .product__media-item:not(.product__media-item--variant):first-child,
    .product--thumbnail_slider .product__media-item:not(.product__media-item--variant):first-child {
      display: block !important;
    }
`;

function injectPreviewStyles(html: string): string {
  const style = `<style data-preview-shim>${PREVIEW_STYLES}</style>`;
  return html.includes("</head>")
    ? html.replace("</head>", `${style}\n</head>`)
    : `${style}${html}`;
}

const HTML_ENTITIES: Record<string, string> = {
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#34;": '"',
  "&#39;": "'",
  "&amp;": "&",
};

/**
 * The product gallery's thumbnail list (snippets/product-media-gallery.liquid) pipes its
 * `<img>` markup through an extra `| escape` on top of `image_tag`'s own escaping — real Dawn
 * source, not a project-specific edit. On a live storefront the theme's own JavaScript reads
 * that escaped text back out and injects it as the real thumbnail image on load; with no
 * JavaScript running, the escaped markup is left showing as literal `&lt;img ...&gt;` text
 * instead of an image. This reproduces exactly that JS step: decode the escaped tag back into
 * real markup so the thumbnail renders like it does on a live storefront.
 */
function unescapeThumbnailImages(html: string): string {
  return html.replace(/&lt;img\b[\s\S]*?&gt;/g, (escaped) =>
    escaped.replace(/&lt;|&gt;|&quot;|&#34;|&#39;|&amp;/g, (entity) => HTML_ENTITIES[entity]),
  );
}

/** Applies every preview shim to a fully rendered page. */
export function applyPreviewShims(html: string): string {
  return injectPreviewStyles(applyJsClass(unescapeThumbnailImages(html)));
}
