import { Bot, webhookCallback } from "grammy";
import { createBot, notify, sendPayMessage, COMMANDS } from "./bot.js";
import type { Config } from "./config.js";
import { BOT_INFO, Phone } from "./mock/telegram.js";
import { createMockClient, createSend21Client } from "./send21.js";
import { createApp } from "./server.js";
import { Shop } from "./shop.js";
import { Store } from "./store.js";

/** Wire everything from a Config. Used by index.ts and the tests. */
export function buildShop(cfg: Config, opts: { selfUrl?: string; log?: (l: string) => void; store?: Store } = {}) {
  const log = opts.log ?? console.log;
  const store = opts.store ?? new Store(cfg.dataFile);
  const mockSend21 = cfg.send21ApiKey ? null : createMockClient(cfg.publicUrl);
  const send21 = mockSend21 ?? createSend21Client({ apiBase: cfg.send21ApiBase, apiKey: cfg.send21ApiKey as string });
  const shop = new Shop(cfg.catalog, store, send21, { options: cfg.options, expiryHours: cfg.expiryHours, shortfallPercent: cfg.shortfallPercent, maxOpenPerChat: cfg.maxOpenPerChat, maxPerItem: 10 });

  const bot = cfg.telegramToken ? new Bot(cfg.telegramToken) : new Bot("mock", { botInfo: BOT_INFO });
  const phone = cfg.telegramToken
    ? null
    : new Phone(bot, [
        { id: 1001, title: cfg.catalog.shop, first_name: "Buyer", username: "buyer_demo" },
        { id: cfg.adminChatId ?? 2002, title: "seller alerts", first_name: "Shop", username: "shop_owner_demo" },
      ]);
  const deps = { shop, adminChatId: cfg.adminChatId, log };
  createBot(bot, deps);

  // Where the mock pay page posts its signed deliveries (this same server).
  const mockPay = mockSend21 ? { client: mockSend21, selfUrl: opts.selfUrl ?? `http://127.0.0.1:${cfg.port}` } : null;
  const app = createApp({
    shop,
    secret: cfg.webhookSecret,
    log,
    trustProxy: cfg.trustProxy,
    onChange: (order, outcome) => void notify(bot.api, deps, order, outcome),
    ...(mockPay ? { mockSend21: mockPay } : {}),
    ...(phone ? { phone } : {}),
    ...(cfg.telegramWebhookUrl ? { telegramWebhook: { path: "/telegram", handler: webhookCallback(bot, "express", { secretToken: cfg.telegramWebhookSecret! }) } } : {}),
  });

  /** Release stock of links that expired without a webhook, and tell the buyer. */
  const sweep = () => {
    const expired = store.transaction((d) => shop.sweep(d));
    for (const o of expired) void notify(bot.api, deps, o, "expired");
  };
  /** After a crash between "stock held" and "link created": same orderId = same Idempotency-Key = same link. */
  const resume = async () => {
    for (const o of shop.orders().filter((x) => x.status === "open" && !x.payUrl)) {
      try {
        const r = await shop.ensurePayLink(o);
        if (r.ok) await sendPayMessage(bot.api, shop, r.order);
      } catch (err) {
        log(`resume order #${o.number}: ${(err as Error).message}`);
      }
    }
  };
  return { app, bot, shop, store, phone, mockSend21, mockPay, sweep, resume, commands: COMMANDS };
}
