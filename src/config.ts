import "dotenv/config";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { loadCatalog } from "./catalog.js";
import { checkAddress, coinById } from "./currencies.js";
import type { Catalog, PayOption } from "./types.js";

export interface Config {
  /** null = mock Telegram: the bot runs against the local 📱 /phone page. */
  telegramToken: string | null;
  /** Set to use a Telegram webhook instead of long polling (needs TELEGRAM_WEBHOOK_SECRET). */
  telegramWebhookUrl: string | null;
  telegramWebhookSecret: string | null;
  /** Your own chat with the bot: gets 💰 new-order and 🚩 alerts, may use /orders. */
  adminChatId: number | null;
  /** null = mock send21: pay links open the local /mock/pay page. */
  send21ApiKey: string | null;
  send21ApiBase: string;
  webhookSecret: string;
  port: number;
  publicUrl: string;
  trustProxy: boolean;
  catalog: Catalog;
  options: PayOption[];
  expiryHours: number;
  shortfallPercent: number;
  maxOpenPerChat: number;
  dataFile: string;
}

const num = (v: string | undefined, def: number, min: number, max: number, name: string): number => {
  const n = v === undefined || v === "" ? def : Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return n;
};

/**
 * PAY_LIGHTNING=name@your-wallet.com and PAY_OPTIONS=usdc-sol:<address>,eth-base:<address>
 * (coin ids from src/currencies.ts). Your own addresses only.
 */
export function parseOptions(lightning: string | undefined, list: string | undefined): PayOption[] {
  const entries: [string, string][] = [];
  if (lightning?.trim()) entries.push(["btc-ln", lightning.trim()]);
  for (const part of (list ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    if (i < 1) throw new Error(`PAY_OPTIONS: "${part}" should be coin:address`);
    entries.push([part.slice(0, i), part.slice(i + 1)]);
  }
  const options: PayOption[] = [];
  for (const [id, raw] of entries) {
    const coin = coinById(id);
    if (!coin) throw new Error(`PAY_OPTIONS: unknown coin "${id}"`);
    if (options.some((o) => o.currency === coin.currency && o.network === coin.network && o.method === coin.method)) throw new Error(`PAY_OPTIONS: ${id} twice`);
    const address = checkAddress(coin, raw);
    if (!address.ok) throw new Error(`PAY_OPTIONS ${id}: ${address.error}`);
    options.push({ currency: coin.currency, network: coin.network, address: address.address, ...(coin.method ? { method: coin.method } : {}) });
  }
  return options;
}

// Sample receiving options for mock mode only. Never sent to send21.
const MOCK_LIGHTNING = "shop@wallet.example";
const MOCK_OPTIONS = "usdc-sol:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU,usdt-eth:0x52908400098527886E0F7030069857D2E4169EE7,eth-base:0x52908400098527886E0F7030069857D2E4169EE7";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const telegramToken = env.TELEGRAM_BOT_TOKEN?.trim() || null;
  if (telegramToken && !/^\d+:[\w-]{30,}$/.test(telegramToken)) throw new Error("TELEGRAM_BOT_TOKEN looks wrong (ask @BotFather)");
  const telegramWebhookUrl = env.TELEGRAM_WEBHOOK_URL?.trim().replace(/\/$/, "") || null;
  const telegramWebhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim() || null;
  if (telegramWebhookUrl) {
    if (!telegramToken) throw new Error("TELEGRAM_WEBHOOK_URL needs TELEGRAM_BOT_TOKEN");
    if (!telegramWebhookUrl.startsWith("https://")) throw new Error("TELEGRAM_WEBHOOK_URL must be https");
    if (!telegramWebhookSecret || !/^[A-Za-z0-9_-]{32,256}$/.test(telegramWebhookSecret)) throw new Error("TELEGRAM_WEBHOOK_SECRET: 32+ of A-Z a-z 0-9 _ -");
  }
  const admin = env.ADMIN_CHAT_ID?.trim();
  if (admin && !/^-?\d{1,20}$/.test(admin)) throw new Error("ADMIN_CHAT_ID is a number (send /whoami to the bot)");

  const apiKey = env.SEND21_API_KEY?.trim() || null;
  if (apiKey && !apiKey.startsWith("s21_")) throw new Error("SEND21_API_KEY should start with s21_");
  const secret = env.SEND21_WEBHOOK_SECRET?.trim();
  if (apiKey && !secret) throw new Error("SEND21_WEBHOOK_SECRET is missing (npm run webhook:register)");
  const port = num(env.PORT, 3000, 1, 65535, "PORT");
  const publicUrl = (env.PUBLIC_URL?.trim() || `http://localhost:${port}`).replace(/\/$/, "");

  // No products.json yet: run with the sample catalog so the mock works out of the box.
  const productsFile = env.PRODUCTS_FILE?.trim() || (existsSync("./products.json") ? "./products.json" : "./products.example.json");
  let rawCatalog: unknown;
  try {
    rawCatalog = JSON.parse(readFileSync(productsFile, "utf8"));
  } catch (err) {
    throw new Error(`${productsFile}: ${(err as Error).message}`);
  }
  const catalog = loadCatalog(rawCatalog);

  const configured = parseOptions(env.PAY_LIGHTNING, env.PAY_OPTIONS);
  const options = configured.length ? configured : !apiKey ? parseOptions(MOCK_LIGHTNING, MOCK_OPTIONS) : [];
  if (!options.length) throw new Error("Set PAY_LIGHTNING and/or PAY_OPTIONS to your own receiving addresses");

  return {
    telegramToken,
    telegramWebhookUrl,
    telegramWebhookSecret,
    adminChatId: admin ? Number(admin) : telegramToken ? null : 2002, // the mock seller chat
    send21ApiKey: apiKey,
    send21ApiBase: env.SEND21_API_BASE?.trim() || "https://send21.io",
    webhookSecret: secret || randomBytes(32).toString("hex"),
    port,
    publicUrl,
    trustProxy: env.TRUST_PROXY === "1",
    catalog,
    options,
    expiryHours: Math.round(num(env.SHOP_EXPIRY_HOURS, 2, 1, 72, "SHOP_EXPIRY_HOURS")),
    shortfallPercent: num(env.SHOP_SHORTFALL_PERCENT, 1, 0, 10, "SHOP_SHORTFALL_PERCENT"),
    maxOpenPerChat: Math.round(num(env.SHOP_MAX_OPEN_ORDERS, 3, 1, 20, "SHOP_MAX_OPEN_ORDERS")),
    dataFile: env.DATA_FILE?.trim() || "./data/shop.json",
  };
}
