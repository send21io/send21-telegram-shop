import { describe, expect, it } from "vitest";
import { loadConfig, parseOptions } from "../src/config.js";
import { COINS, coinFor } from "../src/currencies.js";
import { SOL } from "./helpers.js";

const base = { PRODUCTS_FILE: "products.example.json" };
const EVM = "0x52908400098527886E0F7030069857D2E4169EE7";

describe("coins", () => {
  it("only lists real send21 pairs: USDT on Solana and Ethereum only, no USDT or BTC on Base", () => {
    const pairs = COINS.map((c) => `${c.currency}/${c.network}`);
    for (const bad of ["Usdt/Tron", "Usdt/Arbitrum", "Usdt/Polygon", "Usdt/Base", "Btc/Base"]) expect(pairs).not.toContain(bad);
    expect(COINS.filter((c) => c.currency === "Usdt").map((c) => c.network).sort()).toEqual(["Ethereum", "Solana"]);
    expect(coinFor("Btc", "Mainnet", "Lightning")?.id).toBe("btc-ln");
  });

  it("parses PAY_OPTIONS and refuses unknown pairs and bad addresses", () => {
    expect(parseOptions("shop@wallet.example", `usdc-sol:${SOL},usdt-eth:${EVM}`)).toEqual([
      { currency: "Btc", network: "Mainnet", address: "shop@wallet.example", method: "Lightning" },
      { currency: "Usdc", network: "Solana", address: SOL },
      { currency: "Usdt", network: "Ethereum", address: EVM },
    ]);
    expect(() => parseOptions("", `usdt-tron:${EVM}`)).toThrow(/unknown coin/);
    expect(() => parseOptions("", `usdt-base:${EVM}`)).toThrow(/unknown coin/);
    expect(() => parseOptions("", `usdc-sol:${EVM}`)).toThrow(/usdc-sol/);
    expect(() => parseOptions("", `usdc-sol:${SOL},usdc-sol:${SOL}`)).toThrow(/twice/);
  });
});

describe("config", () => {
  it("needs no keys at all: mock Telegram, mock send21, sample addresses", () => {
    const c = loadConfig(base);
    expect(c.telegramToken).toBeNull();
    expect(c.send21ApiKey).toBeNull();
    expect(c.adminChatId).toBe(2002);
    expect(c.options.length).toBeGreaterThan(0);
    expect(c.expiryHours).toBe(2);
  });

  it("with a real send21 key: needs the webhook secret and your own addresses", () => {
    expect(() => loadConfig({ ...base, SEND21_API_KEY: "s21_x" })).toThrow(/SEND21_WEBHOOK_SECRET/);
    expect(() => loadConfig({ ...base, SEND21_API_KEY: "s21_x", SEND21_WEBHOOK_SECRET: "s" })).toThrow(/PAY_LIGHTNING/);
    expect(() => loadConfig({ ...base, SEND21_API_KEY: "nope" })).toThrow(/s21_/);
  });

  it("checks the Telegram settings", () => {
    const token = `123456:${"A".repeat(35)}`;
    expect(() => loadConfig({ ...base, TELEGRAM_BOT_TOKEN: "nope" })).toThrow(/BotFather/);
    expect(loadConfig({ ...base, TELEGRAM_BOT_TOKEN: token }).adminChatId).toBeNull();
    expect(() => loadConfig({ ...base, TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_URL: "http://x.example" })).toThrow(/https/);
    expect(() => loadConfig({ ...base, TELEGRAM_BOT_TOKEN: token, TELEGRAM_WEBHOOK_URL: "https://x.example", TELEGRAM_WEBHOOK_SECRET: "short" })).toThrow(/SECRET/);
    expect(() => loadConfig({ ...base, TELEGRAM_WEBHOOK_URL: "https://x.example" })).toThrow(/TOKEN/);
    expect(() => loadConfig({ ...base, ADMIN_CHAT_ID: "me" })).toThrow(/number/);
    expect(() => loadConfig({ ...base, SHOP_EXPIRY_HOURS: "0" })).toThrow(/SHOP_EXPIRY_HOURS/);
  });
});
