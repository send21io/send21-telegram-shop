import type { AddressInfo } from "node:net";
import type { Express } from "express";
import { buildShop } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { signV2 } from "../src/verify.js";

export const SECRET = "whsec_test_only_not_a_real_secret";
export const SOL = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
export const BUYER = 1001;
export const ADMIN = 2002;

/** Mock Telegram + mock send21, in-memory store, the sample catalog. */
export function testConfig(env: Record<string, string> = {}): Config {
  return { ...loadConfig({ PRODUCTS_FILE: "products.example.json", DATA_FILE: ":memory:", PAY_LIGHTNING: "shop@wallet.example", PAY_OPTIONS: `usdc-sol:${SOL}`, ...env }), webhookSecret: SECRET };
}

export async function listen(app: Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

/** The whole shop, listening on a random port. */
export async function world(env: Record<string, string> = {}, opts: Parameters<typeof buildShop>[1] = {}) {
  const logs: string[] = [];
  const w = buildShop(testConfig(env), { log: (l) => logs.push(l), ...opts });
  const server = await listen(w.app);
  if (w.mockPay) w.mockPay.selfUrl = server.url;
  const phone = w.phone!;
  const lastBot = (chat = BUYER) => [...phone.chats.get(chat)!.messages].reverse().find((m) => m.from === "bot")!;
  const text = (m: { spans: { t: string }[] }) => m.spans.map((s) => s.t).join("");
  const settle = () => new Promise((r) => setTimeout(r, 30)); // fire-and-forget notifications
  return { ...w, ...server, logs, phone, lastBot, text, settle };
}

/** /start, add items, ✅ checkout, send the note. Returns the stored order. */
export async function checkout(w: Awaited<ReturnType<typeof world>>, items: Record<string, number>, note = "Flat 2, 1 Example Street, 12345 Town", chat = BUYER) {
  await w.phone.send(chat, "/start");
  const cat = w.lastBot(chat);
  for (const [sku, n] of Object.entries(items)) for (let i = 0; i < n; i++) await w.phone.tap(chat, cat.id, `add:${sku}`);
  await w.phone.tap(chat, cat.id, "checkout");
  await w.phone.send(chat, note);
  return w.shop.orders().filter((o) => o.chatId === chat).sort((a, b) => b.number - a.number)[0];
}

/** draft.confirmed exactly matching an order. Shape from docs/webhooks "Payload". */
export function confirmedFor(o: { orderId: string; paymentRequestId: string | null; total: number; currency: string }, over: Record<string, unknown> = {}) {
  return {
    event: "draft.confirmed",
    data: {
      draftId: crypto.randomUUID(),
      status: "Confirmed",
      txId: "5hRk…sig",
      confirmations: 1,
      sentCurrency: "USDC",
      network: "Solana",
      amountSats: Math.round(o.total * 1e6),
      sentAmount: o.total.toFixed(6),
      fiatCurrency: o.currency,
      fiatAmount: o.total,
      paymentRequestId: o.paymentRequestId ?? undefined,
      orderId: o.orderId,
      occurredAt: new Date().toISOString(),
      ...over,
    },
  };
}

export function deliver(url: string, body: unknown, { deliveryId = crypto.randomUUID(), t = Math.floor(Date.now() / 1000), secret = SECRET, raw }: { deliveryId?: string; t?: number; secret?: string; raw?: string } = {}) {
  const payload = raw ?? JSON.stringify(body);
  return fetch(`${url}/webhooks/send21`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(payload, deliveryId, t, secret) },
    body: payload,
  });
}
