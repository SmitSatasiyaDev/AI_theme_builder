import { Drop } from "liquidjs";
import { parseColor, formatColor, Rgb } from "./color";

// Shopify resolves typed settings before Liquid ever sees them: a `color` setting is a Color
// object with `.red`/`.green`/`.blue`, an `image_picker` is an Image with `.aspect_ratio`, a
// `link_list` is a LinkList with `.links`. Template JSON only stores the raw value — a hex
// string, a `shopify://` URL, a menu handle — so the preview has to do the same resolution or
// the theme reads properties off a plain string and silently renders nothing. Ported verbatim
// from the Shopforge preview renderer.

/** `{{ color }}` prints the hex; `{{ color.red }}` and friends read the components. */
export class ColorDrop extends Drop {
  private readonly rgb: Rgb | null;

  constructor(private readonly raw: string) {
    super();
    this.rgb = parseColor(raw);
  }

  valueOf(): string {
    return this.rgb ? formatColor(this.rgb) : "";
  }

  toString(): string {
    return this.valueOf();
  }

  get red() { return this.rgb?.r ?? 0; }
  get green() { return this.rgb?.g ?? 0; }
  get blue() { return this.rgb?.b ?? 0; }
  get alpha() { return this.rgb?.a ?? 0; }
  get rgb_string() { return this.rgb ? `${this.rgb.r}, ${this.rgb.g}, ${this.rgb.b}` : ""; }
  get rgba() { return this.rgb ? `rgba(${this.rgb.r}, ${this.rgb.g}, ${this.rgb.b}, ${this.rgb.a})` : ""; }

  get hue() { return this.hsl().h; }
  get saturation() { return this.hsl().s; }
  get lightness() { return this.hsl().l; }

  private hsl() {
    if (!this.rgb) return { h: 0, s: 0, l: 0 };
    const [r, g, b] = [this.rgb.r / 255, this.rgb.g / 255, this.rgb.b / 255];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l: Math.round(l * 100) };
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return { h: Math.round(h * 60), s: Math.round(s * 100), l: Math.round(l * 100) };
  }
}

/** `{{ image }}` prints its URL; the theme reads `.src`, `.width`, `.aspect_ratio`, `.alt`. */
export class ImageDrop extends Drop {
  readonly src: string;
  readonly url: string;
  readonly width = 1600;
  readonly height = 1600;
  readonly aspect_ratio = 1;
  readonly alt: string;
  readonly media_type = "image";
  readonly id: string;

  constructor(url: string, alt = "") {
    super();
    this.src = url;
    this.url = url;
    this.alt = alt;
    this.id = url;
  }

  get preview_image() {
    return { src: this.src, url: this.url, width: this.width, height: this.height, aspect_ratio: this.aspect_ratio };
  }

  valueOf(): string {
    return this.src;
  }

  toString(): string {
    return this.src;
  }
}

export interface LinkDrop {
  title: string;
  url: string;
  active: boolean;
  current: boolean;
  child_active: boolean;
  child_current: boolean;
  type: string;
  object: null;
  levels: number;
  links: LinkDrop[];
}

export interface LinkListDrop {
  handle: string;
  title: string;
  levels: number;
  links: LinkDrop[];
}

export function makeLink(title: string, url: string, links: LinkDrop[] = []): LinkDrop {
  return {
    title,
    url,
    active: false,
    current: false,
    child_active: false,
    child_current: false,
    type: "http_link",
    object: null,
    levels: links.length ? 1 : 0,
    links,
  };
}

/**
 * The preview has no store behind it, so there is no real navigation to read. These stand in
 * for the menus a connected store would provide, so header and footer render with the
 * structure a merchant would actually see rather than collapsing to nothing.
 */
export function defaultLinkLists(): Record<string, LinkListDrop> {
  const main: LinkListDrop = {
    handle: "main-menu",
    title: "Main menu",
    levels: 1,
    links: [
      makeLink("Home", "/"),
      makeLink("Catalog", "/collections/all"),
      makeLink("Contact", "/pages/contact"),
    ],
  };
  const footer: LinkListDrop = {
    handle: "footer",
    title: "Footer menu",
    levels: 0,
    links: [
      makeLink("Search", "/search"),
      makeLink("Privacy Policy", "/policies/privacy-policy"),
      makeLink("Refund Policy", "/policies/refund-policy"),
    ],
  };
  return { "main-menu": main, footer, "footer-menu": footer };
}

/** `font_picker` settings are objects the theme reads `.family`/`.weight`/`.style` from. */
export class FontDrop extends Drop {
  readonly family: string;
  readonly weight: number;
  readonly style: string;
  readonly fallback_families = "sans-serif";

  constructor(handle: string) {
    super();
    // Handles look like `assistant_n4` — family, then an n/i weight token.
    const [family, variant = "n4"] = String(handle ?? "").split("_");
    this.family = (family || "sans-serif").replace(/-/g, " ");
    this.weight = Number(variant.replace(/\D/g, "")) * 100 || 400;
    this.style = variant.startsWith("i") ? "italic" : "normal";
  }

  get system() {
    return false;
  }

  valueOf(): string {
    return this.family;
  }

  toString(): string {
    return this.family;
  }
}
