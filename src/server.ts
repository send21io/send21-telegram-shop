import { createHash, randomUUID } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Express, type RequestHandler } from "express";
import { formatFiat } from "./currencies.js";
import type { Phone } from "./mock/telegram.js";
import type { createMockClient } from "./send21.js";
import type { Outcome, Shop } from "./shop.js";
import { Store } from "./store.js";
import type { Order } from "./types.js";
import { signV2, verifySignatureV2 } from "./verify.js";

export interface AppDeps {
  shop: Shop;
  /** The send21 webhook signing secret. */
  secret: string;
  /** Called after a webhook change is on disk. Must not throw. */
  onChange: (order: Order, outcome: Outcome) => void;
  log?: (line: string) => void;
  /** Real Telegram in webhook mode: grammY's express handler (checks the secret token header). */
  telegramWebhook?: { path: string; handler: RequestHandler };
  /** Mock send21: /mock/pay/<token> simulates payments with signed deliveries. */
  mockSend21?: { client: ReturnType<typeof createMockClient>; selfUrl: string };
  /** Mock Telegram: the 📱 /phone page and its API. */
  phone?: Phone;
  trustProxy?: boolean;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(HERE, HERE.includes(`${sep}dist${sep}`) ? "../../public" : "../public");
const CSP = "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
export const esc = (s: unknown) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function createApp(deps: AppDeps): Express {
  const { shop, secret, onChange, log = console.log, mockSend21, phone, telegramWebhook, trustProxy = false } = deps;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);
  app.use((_req, res, next) => {
    res.set({ "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
    next();
  });
  app.get("/healthz", (_req, res) => {
    res.json({ ok: true, send21: mockSend21 ? "mock" : "live", telegram: phone ? "mock" : telegramWebhook ? "webhook" : "polling" });
  });

  // ---------- send21 webhook: raw bytes, the signature covers the exact body ----------
  app.post("/webhooks/send21", express.raw({ type: () => true, limit: "64kb" }), (req, res) => {
    const raw: Buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const deliveryId = req.get("x-send21-delivery");
    // 1. Signature V2 + 300 s window. Nothing is stored for a request that fails.
    if (!verifySignatureV2(raw, req.get("x-send21-signature-v2"), deliveryId, secret)) {
      res.status(401).json({ error: "invalid signature" });
      return;
    }
    let body: { event?: unknown; data?: unknown };
    try {
      body = JSON.parse(raw.toString("utf8"));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
    } catch {
      res.status(400).json({ error: "invalid json" });
      return;
    }
    // 2 + 3. Dedupe (delivery id + body hash) and apply the change in ONE write.
    const eventKey = createHash("sha256").update(raw).digest("hex");
    let applied: ReturnType<Shop["applyEvent"]> | null;
    try {
      applied = shop.store.transaction((d) => (Store.remember(d, deliveryId as string, eventKey) ? shop.applyEvent(d, body) : null));
    } catch (err) {
      log(`webhook: store write failed, send21 will retry: ${(err as Error).message}`);
      res.status(500).json({ error: "try again" });
      return;
    }
    if (applied === null) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }
    log(`webhook ${String(body.event)} ${deliveryId}: ${applied.outcome}`);
    res.status(200).json({ ok: true, outcome: applied.outcome });
    // 4. Only now, after the 2xx is decided and the state is on disk: tell people.
    if (applied.order && applied.order.status !== applied.before) onChange(applied.order, applied.outcome);
  });

  if (telegramWebhook) app.post(telegramWebhook.path, express.json({ limit: "1mb" }), telegramWebhook.handler);
  if (mockSend21) mountMockPay(app, secret, mockSend21, !!phone);
  if (phone) mountPhone(app, phone);
  app.use(express.static(PUBLIC_DIR, { index: false }));
  app.get("/", (_req, res) => {
    if (phone) res.redirect(302, "/phone");
    else res.type("text").send("🛍️ send21 telegram shop: talk to the bot on Telegram.");
  });
  return app;
}

// ---------- mock Telegram: the 📱 phone page ----------

function mountPhone(app: Express, phone: Phone): void {
  const json = express.json({ limit: "4kb" });
  app.get("/phone", (_req, res) => {
    res.sendFile(resolve(PUBLIC_DIR, "phone.html"));
  });
  app.get("/phone/api/state", (req, res) => {
    res.set("Cache-Control", "no-store").json({ chats: phone.state(Number(req.query.since) || 0) });
  });
  app.post("/phone/api/send", json, async (req, res) => {
    const { chat, text } = (req.body ?? {}) as { chat?: unknown; text?: unknown };
    if (!phone.chats.has(Number(chat)) || typeof text !== "string" || !text.trim() || text.length > 500) {
      res.status(400).json({ error: "chat and text (max 500)" });
      return;
    }
    await phone.send(Number(chat), text.trim());
    res.json({ ok: true });
  });
  app.post("/phone/api/tap", json, async (req, res) => {
    const { chat, message, data } = (req.body ?? {}) as { chat?: unknown; message?: unknown; data?: unknown };
    if (!phone.chats.has(Number(chat)) || typeof data !== "string") {
      res.status(400).json({ error: "chat, message and data" });
      return;
    }
    const ok = await phone.tap(Number(chat), Number(message), data);
    res.status(ok ? 200 : 404).json({ ok });
  });
}

// ---------- mock send21: a tiny local "pay page" that sends signed deliveries ----------

const page = (body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>mock pay · send21</title><link rel="stylesheet" href="/pay.css"><main class="pay">${body}</main></html>`;

function mountMockPay(app: Express, secret: string, mock: NonNullable<AppDeps["mockSend21"]>, hasPhone: boolean): void {
  const { client } = mock;
  const back = hasPhone ? `<a class="go" href="/phone">📱 back to the chat</a>` : `<p>↩️ go back to Telegram</p>`;
  app.get("/mock/pay/:token", (req, res) => {
    const entry = client.requests.get(req.params.token);
    if (!entry) {
      res.status(404).type("html").send(page("<p>🤷 unknown pay link</p>"));
      return;
    }
    const t = esc(req.params.token);
    const coins = entry.body.options.map((o, i) => `<option value="${i}">${esc(`${o.currency.toUpperCase()} · ${o.method ?? o.network}`)}</option>`).join("");
    res.type("html").send(
      page(`<p class="mock">🧪 mock send21 · no real money</p><p class="big">${esc(formatFiat(entry.body.fiatAmount, entry.body.fiatCurrency))}</p><p>${esc(entry.body.memo)}</p>
${[["seen", "👀 start paying"], ["paid", "✅ pay"], ["short", "⚠️ pay 5% short"], ["expire", "⌛ let it expire"]].map(([a, l]) => `<form class="row" method="post" action="/mock/pay/${t}/${a}"><select name="coin" aria-label="coin">${coins}</select><button>${l}</button></form>`).join("")}
${back}`),
    );
  });

  app.post("/mock/pay/:token/:action", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
    const entry = client.requests.get(req.params.token);
    if (!entry) {
      res.status(404).type("html").send(page("<p>🤷 unknown pay link</p>"));
      return;
    }
    const body = mockEvent(entry, Number((req.body as { coin?: string })?.coin ?? 0), req.params.action);
    const raw = JSON.stringify(body);
    const deliveryId = randomUUID();
    const r = await fetch(`${mock.selfUrl}/webhooks/send21`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-send21-event": body.event, "x-send21-delivery": deliveryId, "x-send21-signature-v2": signV2(raw, deliveryId, Math.floor(Date.now() / 1000), secret) },
      body: raw,
    });
    res.type("html").send(page(`<p class="big">${r.ok ? "📨" : "❌"}</p><p>${esc(r.ok ? `sent ${body.event}` : String(r.status))}</p>${back}<p class="foot"><a href="/mock/pay/${esc(req.params.token)}">↩️ pay page</a></p>`));
  });
}

/** A webhook body shaped like send21's (docs/webhooks "Payload"), for one simulated action. */
export function mockEvent(entry: NonNullable<ReturnType<ReturnType<typeof createMockClient>["requests"]["get"]>>, coin: number, action: string) {
  const option = entry.body.options[coin] ?? entry.body.options[0]!;
  const units = option.currency === "Btc" ? 1e8 : option.currency === "Sol" || option.currency === "Eth" ? 1e9 : 1e6;
  const price = option.currency === "Btc" ? 60000 : option.currency === "Eth" ? 3000 : option.currency === "Sol" ? 150 : 1;
  const amountSats = Math.max(1, Math.round((entry.body.fiatAmount / price) * units));
  const base = {
    draftId: randomUUID(),
    paymentRequestId: entry.response.id,
    orderId: entry.body.orderId,
    sentCurrency: option.currency.toUpperCase(),
    network: option.network,
    fiatCurrency: entry.body.fiatCurrency,
    fiatAmount: entry.body.fiatAmount,
    amountSats,
    sentAmount: (amountSats / units).toFixed(Math.log10(units)),
    occurredAt: new Date().toISOString(),
  };
  return action === "paid"
    ? { event: "draft.confirmed", data: { ...base, status: "Confirmed", txId: `mock-${randomUUID()}`, confirmations: 1 } }
    : action === "seen"
      ? { event: "draft.seen", data: { ...base, status: "Seen", txId: `mock-${randomUUID()}`, confirmations: 0 } }
      : action === "short"
        ? { event: "draft.amount_mismatch", data: { ...base, status: "AwaitingPayment", reviewState: "pending", receivedAmountSats: Math.round(amountSats * 0.95) } }
        : { event: "payment_request.expired", data: { paymentRequestId: entry.response.id, orderId: entry.body.orderId, opened: true, quoteRequested: false } };
}
