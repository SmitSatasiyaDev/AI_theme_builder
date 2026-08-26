// Shopify stores money as an integer number of cents, and every `| money` call site in the
// Base Theme assumes that. Ported from the Shopforge preview renderer verbatim (money.ts) —
// no AI-schema-saas-specific coupling.

const SYMBOLS: Record<string, string> = {
  USD: "$", CAD: "$", AUD: "$", NZD: "$", EUR: "€", GBP: "£",
  JPY: "¥", INR: "₹", BRL: "R$", MXN: "$", SEK: "kr", CHF: "CHF",
};

export function currencySymbol(code: string | null | undefined): string {
  return SYMBOLS[String(code ?? "USD").toUpperCase()] ?? "$";
}

export function toCents(amount: number | null | undefined): number | null {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return null;
  return Math.round(amount * 100);
}

function group(value: string): string {
  const [whole, fraction] = value.split(".");
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (fraction ? `.${fraction}` : "");
}

export function formatMoney(
  cents: unknown,
  { currency = "USD", trailingZeros = true, symbol = true, withCode = false } = {},
): string {
  const n = typeof cents === "number" ? cents : Number.parseFloat(String(cents));
  if (!Number.isFinite(n)) return "";
  const amount = n / 100;
  const fixed = amount.toFixed(2);
  const body = group(trailingZeros || !fixed.endsWith(".00") ? fixed : fixed.slice(0, -3));
  const head = symbol ? `${currencySymbol(currency)}${body}` : body;
  return withCode ? `${head} ${String(currency).toUpperCase()}` : head;
}
