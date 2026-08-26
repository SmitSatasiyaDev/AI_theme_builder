// Supports `color_extract` and `color_modify` in the Base Theme's {% style %} blocks.
// Handles the notations the theme actually emits: #rgb, #rrggbb, rgb()/rgba(), and Shopify's
// bare "r g b" color_scheme values. Ported verbatim from the Shopforge preview renderer.

export interface Rgb {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(input: unknown): Rgb | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  const hex = raw.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return {
      r: Number.parseInt(h.slice(0, 2), 16),
      g: Number.parseInt(h.slice(2, 4), 16),
      b: Number.parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  }

  const fn = raw.match(/^rgba?\(([^)]+)\)$/i);
  const parts = (fn ? fn[1] : raw).split(/[,\s/]+/).filter(Boolean).map(Number);
  if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
    return { r: parts[0], g: parts[1], b: parts[2], a: Number.isFinite(parts[3]) ? parts[3] : 1 };
  }
  return null;
}

function toHsl({ r, g, b }: Rgb) {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === rn ? ((gn - bn) / d + (gn < bn ? 6 : 0)) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

function fromHsl(h: number, s: number, l: number, a: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  return { r: Math.round((r1 + m) * 255), g: Math.round((g1 + m) * 255), b: Math.round((b1 + m) * 255), a };
}

export function formatColor({ r, g, b, a }: Rgb): string {
  const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
  return a >= 1
    ? `#${[r, g, b].map((n) => clamp(n).toString(16).padStart(2, "0")).join("")}`
    : `rgba(${clamp(r)}, ${clamp(g)}, ${clamp(b)}, ${a})`;
}

export function colorExtract(color: unknown, component: unknown): number | string {
  const rgb = parseColor(color);
  if (!rgb) return "";
  const hsl = toHsl(rgb);
  switch (String(component)) {
    case "red": return rgb.r;
    case "green": return rgb.g;
    case "blue": return rgb.b;
    case "alpha": return rgb.a;
    case "hue": return Math.round(hsl.h);
    case "saturation": return Math.round(hsl.s * 100);
    case "lightness": return Math.round(hsl.l * 100);
    default: return "";
  }
}

export function colorModify(color: unknown, component: unknown, value: unknown): string {
  const rgb = parseColor(color);
  const n = Number(value);
  if (!rgb || !Number.isFinite(n)) return String(color ?? "");
  const key = String(component);
  if (key === "red" || key === "green" || key === "blue") {
    return formatColor({ ...rgb, [key[0] as "r" | "g" | "b"]: n });
  }
  if (key === "alpha") return formatColor({ ...rgb, a: n });
  const hsl = toHsl(rgb);
  if (key === "hue") return formatColor(fromHsl(n, hsl.s, hsl.l, rgb.a));
  if (key === "saturation") return formatColor(fromHsl(hsl.h, n / 100, hsl.l, rgb.a));
  if (key === "lightness") return formatColor(fromHsl(hsl.h, hsl.s, n / 100, rgb.a));
  return formatColor(rgb);
}
