import { formatFiat, fiatDecimals, isFiat, parseTotal } from "./currencies.js";
import { cleanText, isEmoji } from "./sanitize.js";
import type { Catalog, Product } from "./types.js";

// products.json: the shop name, its currency and what it sells.
//   { "shop": "...", "currency": "EUR", "products": [{ "sku", "name", "emoji", "price", "stock", "photo"?, "digital"? }] }

const SKU = /^[a-z0-9][a-z0-9-]{0,23}$/;

export function loadCatalog(raw: unknown): Catalog {
  const fail = (msg: string): never => {
    throw new Error(`products.json: ${msg}`);
  };
  const c = (raw ?? {}) as { shop?: unknown; currency?: unknown; products?: unknown };
  const shop = cleanText(c.shop, 40) ?? fail("shop: plain text, max 40");
  const currency = String(c.currency ?? "").toUpperCase();
  if (!isFiat(currency)) fail(`currency "${String(c.currency)}" is not supported`);
  if (!Array.isArray(c.products) || !c.products.length) fail("list at least one product");
  const products = (c.products as Record<string, unknown>[]).map((p, i): Product => {
    const sku = String(p.sku ?? "");
    if (!SKU.test(sku)) fail(`product ${i + 1}: sku a-z, 0-9 and dashes, max 24`);
    const name = cleanText(p.name, 40) ?? fail(`${sku}: name plain text, max 40`);
    const emoji = isEmoji(p.emoji) ? p.emoji : fail(`${sku}: emoji must be one emoji`);
    const price = parseTotal(p.price, currency, 100_000);
    if (!price.ok) fail(`${sku}: price ${price.error}`);
    const stock = Number(p.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > 100_000) fail(`${sku}: stock is a whole number`);
    if (p.photo !== undefined && !(typeof p.photo === "string" && /^https:\/\/[^\s<>"]+$/.test(p.photo))) fail(`${sku}: photo must be an https URL`);
    return { sku, name, emoji, price: (price as { amount: number }).amount, stock, digital: p.digital === true, ...(p.photo ? { photo: p.photo as string } : {}) };
  });
  if (new Set(products.map((p) => p.sku)).size !== products.length) fail("a sku is listed twice");
  return { shop, currency, products };
}

/** Sum in minor units, so 3 × 4.10 stays 12.30. */
export function lineTotal(price: number, qty: number, currency: string): number {
  const scale = 10 ** fiatDecimals(currency);
  return (Math.round(price * scale) * qty) / scale;
}

export function sumItems(items: { price: number; qty: number }[], currency: string): number {
  const scale = 10 ** fiatDecimals(currency);
  return items.reduce((n, i) => n + Math.round(i.price * scale) * i.qty, 0) / scale;
}

export const money = formatFiat;
