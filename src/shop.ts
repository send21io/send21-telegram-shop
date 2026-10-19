import { randomBytes } from "node:crypto";
import { sumItems } from "./catalog.js";
import { toMinor } from "./currencies.js";
import { cleanText } from "./sanitize.js";
import type { Send21Client } from "./send21.js";
import type { Store, StoreData } from "./store.js";
import { HOLDS_STOCK, type Catalog, type ChatState, type Order, type OrderItem, type OrderStatus, type PayOption } from "./types.js";

// The shop, without Telegram: carts, stock, checkout and webhooks.
// Stock is never a counter: available = stock - items of orders that hold it,
// computed inside the same store transaction that reserves it.

export interface ShopConfig {
  options: PayOption[];
  expiryHours: number;
  shortfallPercent: number;
  /** Unpaid orders one chat may have at once (stops one person from hoarding stock). */
  maxOpenPerChat: number;
  maxPerItem: number;
}

export const ORDER_ID = /^tg-([a-z0-9]{10})$/;
const GRACE_MS = 15 * 60_000;
const newId = () => {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(randomBytes(10), (b) => abc[b % 36]).join("");
};

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export class Shop {
  constructor(
    readonly catalog: Catalog,
    readonly store: Store,
    private readonly send21: Send21Client,
    readonly cfg: ShopConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  product = (sku: string) => this.catalog.products.find((p) => p.sku === sku);

  /** Items not held by any order. */
  available(sku: string, d: Readonly<StoreData> = this.store.read((x) => x)): number {
    const p = this.product(sku);
    if (!p) return 0;
    let held = 0;
    for (const o of Object.values(d.orders)) if (HOLDS_STOCK.includes(o.status)) for (const i of o.items) if (i.sku === sku) held += i.qty;
    return Math.max(0, p.stock - held);
  }

  chat(chatId: number, d: Readonly<StoreData> = this.store.read((x) => x)): ChatState {
    return d.chats[String(chatId)] ?? { cart: {}, pending: null };
  }

  /** Cart lines with prices from the catalog (never from the chat). */
  cartItems(chatId: number, d: Readonly<StoreData> = this.store.read((x) => x)): OrderItem[] {
    return Object.entries(this.chat(chatId, d).cart)
      .map(([sku, qty]) => ({ p: this.product(sku), qty }))
      .filter((x): x is { p: NonNullable<typeof x.p>; qty: number } => !!x.p && x.qty > 0)
      .map(({ p, qty }) => ({ sku: p.sku, name: p.name, emoji: p.emoji, qty, price: p.price }));
  }

  total(items: OrderItem[]): number {
    return sumItems(items, this.catalog.currency);
  }

  private setChat(d: StoreData, chatId: number, patch: Partial<ChatState>) {
    d.chats[String(chatId)] = { ...this.chat(chatId, d), ...patch };
  }

  add(chatId: number, sku: string): Result<{ qty: number }> {
    return this.store.transaction((d) => {
      const p = this.product(sku);
      if (!p) return { ok: false, error: "🤷 not in the shop" };
      const cart = { ...this.chat(chatId, d).cart };
      const qty = (cart[sku] ?? 0) + 1;
      if (qty > this.available(sku, d)) return { ok: false, error: `😢 only ${this.available(sku, d)} ${p.name} left` };
      if (qty > this.cfg.maxPerItem) return { ok: false, error: `✋ max ${this.cfg.maxPerItem} per order` };
      cart[sku] = qty;
      this.setChat(d, chatId, { cart, pending: null });
      return { ok: true, qty };
    });
  }

  remove(chatId: number, sku: string): Result<{ qty: number }> {
    return this.store.transaction((d) => {
      const cart = { ...this.chat(chatId, d).cart };
      const qty = Math.max(0, (cart[sku] ?? 0) - 1);
      if (qty) cart[sku] = qty;
      else delete cart[sku];
      this.setChat(d, chatId, { cart, pending: null });
      return { ok: true, qty };
    });
  }

  setCatalogMessage(chatId: number, messageId: number) {
    this.store.transaction((d) => this.setChat(d, chatId, { catalogMessageId: messageId }));
  }

  /** ✅ checkout: freeze the cart and wait for the shipping note. */
  startCheckout(chatId: number): Result<{ items: OrderItem[]; total: number }> {
    return this.store.transaction((d) => {
      this.sweep(d);
      const items = this.cartItems(chatId, d);
      if (!items.length) return { ok: false, error: "🛒 your cart is empty" };
      const open = Object.values(d.orders).filter((o) => o.chatId === chatId && ["open", "seen"].includes(o.status)).length;
      if (open >= this.cfg.maxOpenPerChat) return { ok: false, error: `⏳ you have ${open} unpaid orders. Pay or let one expire first.` };
      this.setChat(d, chatId, { pending: { id: newId(), items } });
      return { ok: true, items, total: this.total(items) };
    });
  }

  /**
   * The note arrived: reserve stock, store the order, then create ONE pay link.
   * The order id was fixed at ✅ checkout, so a repeated note (or a retried
   * Telegram update) returns the same order and the same link.
   */
  async placeOrder(chatId: number, buyer: string, rawNote: string): Promise<Result<{ order: Order }>> {
    const note = /^digital$/i.test(rawNote.trim()) ? "digital" : cleanText(rawNote, 200);
    if (!note) return { ok: false, error: "✏️ shipping note: plain text, max 200, no links. Or tap 📦 digital." };
    const step = this.store.transaction((d): Result<{ order: Order }> => {
      this.sweep(d);
      const pending = this.chat(chatId, d).pending;
      if (!pending) return { ok: false, error: "🛒 tap ✅ checkout first" };
      const existing = d.orders[pending.id];
      if (existing) return { ok: true, order: existing };
      // "digital" skips the address, so only an all-digital cart may use it.
      const physical = pending.items.find((i) => !this.catalog.products.find((p) => p.sku === i.sku)?.digital);
      if (note === "digital" && physical) return { ok: false, error: `📦 ${physical.emoji} ${physical.name} ships: reply with a name and address.` };
      for (const item of pending.items) {
        if (this.available(item.sku, d) < item.qty) return { ok: false, error: `😢 ${item.emoji} ${item.name} just sold out. Check your 🛒 cart.` };
      }
      const nowIso = this.now().toISOString();
      d.seq += 1;
      const order: Order = {
        id: pending.id,
        number: d.seq,
        orderId: `tg-${pending.id}`,
        chatId,
        buyer: cleanText(buyer, 64) ?? "buyer",
        items: pending.items,
        total: this.total(pending.items),
        currency: this.catalog.currency,
        note,
        options: this.cfg.options,
        status: "open", // holds stock from now on
        paymentRequestId: null,
        payUrl: null,
        expiresAt: new Date(this.now().getTime() + this.cfg.expiryHours * 3600_000).toISOString(),
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      d.orders[order.id] = order;
      this.setChat(d, chatId, { cart: {}, pending: null });
      return { ok: true, order };
    });
    if (!step.ok) return step;
    // Stock is held. Only now: one pay link for the whole order.
    return this.ensurePayLink(step.order);
  }

  /** Create the pay link for a stored order, or return the one it has. Safe to retry: the orderId is the Idempotency-Key. */
  async ensurePayLink(order: Order): Promise<Result<{ order: Order }>> {
    if (order.payUrl) return { ok: true, order };
    if (order.status !== "open") return { ok: false, error: "⌛ this order is closed" };
    try {
      const pr = await this.send21.createPaymentRequest(
        {
          fiatCurrency: order.currency,
          fiatAmount: order.total,
          orderId: order.orderId,
          memo: `🛍️ Order #${order.number} · ${this.catalog.shop}`.slice(0, 140),
          options: order.options,
          expiryHours: this.cfg.expiryHours,
          declineNote: "The order is cancelled and the items go back on the shelf.",
          reuseOpenForOrder: true, // belt and braces next to the Idempotency-Key: one open link per order
          ...(this.cfg.shortfallPercent > 0 ? { shortfallPolicy: { absorbUpToPercent: this.cfg.shortfallPercent, absorbedBy: "receiver" as const } } : {}),
        },
        order.orderId,
      );
      const payUrl = this.send21.payUrl(pr.payPath);
      return { ok: true, order: this.patch(order.id, { paymentRequestId: pr.id, payUrl, expiresAt: pr.expiresAt ?? order.expiresAt }) };
    } catch (err) {
      // send21 refused or did not answer: release the stock. A later retry of the same order is refused (status failed).
      this.patch(order.id, { status: "failed", problems: [String((err as Error).message).slice(0, 200)] });
      throw err;
    }
  }

  private patch(id: string, patch: Partial<Order>): Order {
    return this.store.transaction((d) => {
      d.orders[id] = { ...d.orders[id]!, ...patch, updatedAt: this.now().toISOString() };
      return d.orders[id]!;
    });
  }

  /** Release stock of open links that expired without a webhook (lost delivery). */
  sweep(d: StoreData, now = this.now()): Order[] {
    const out: Order[] = [];
    for (const o of Object.values(d.orders)) {
      if (["open", "seen"].includes(o.status) && o.expiresAt && Date.parse(o.expiresAt) + GRACE_MS < now.getTime()) {
        d.orders[o.id] = { ...o, status: "expired", updatedAt: now.toISOString() };
        out.push(d.orders[o.id]!);
      }
    }
    return out;
  }

  orders(): Order[] {
    return this.store.read((d) => Object.values(d.orders));
  }

  /** Apply one verified, de-duplicated event. Call inside store.transaction() with Store.remember(). */
  applyEvent(d: StoreData, body: { event?: unknown; data?: unknown }): { outcome: Outcome; order?: Order; before?: OrderStatus } {
    const event = typeof body.event === "string" ? body.event : "";
    if (event === "test") return { outcome: "test" };
    const data = (body.data && typeof body.data === "object" ? body.data : {}) as DraftEventData;
    const m = typeof data.orderId === "string" ? ORDER_ID.exec(data.orderId) : null;
    if (data.orderId && !m) return { outcome: "unknown_order" }; // another integration on the same account
    const order = m ? d.orders[m[1]!] : Object.values(d.orders).find((o) => !!data.paymentRequestId && o.paymentRequestId === data.paymentRequestId);
    if (!order || !order.paymentRequestId || (data.paymentRequestId && data.paymentRequestId !== order.paymentRequestId)) return { outcome: "unknown_order" };
    const nowIso = this.now().toISOString();
    const before = order.status;
    const set = (status: OrderStatus, extra: Partial<Order> = {}) => {
      d.orders[order.id] = { ...order, ...extra, status, updatedAt: nowIso };
      return { outcome: status, order: d.orders[order.id], before };
    };
    const is = (...s: OrderStatus[]) => s.includes(order.status);
    const same = { outcome: "unchanged" as const, order, before };

    switch (event) {
      case "draft.confirmed": {
        if (order.status === "paid") return { outcome: "already_paid", order, before };
        const problems = checkPaymentAgainstOrder(data, order);
        if (problems.length) return set("flagged", { problems });
        return set("paid", {
          problems: undefined,
          paid: {
            currency: String(data.sentCurrency),
            network: String(data.network),
            amount: data.receivedAmount ?? data.sentAmount ?? null,
            txId: String(data.txId),
            differentAmount: data.receivedAmountSats !== undefined && data.receivedAmountSats !== data.amountSats,
            // Its stock was released before: it may have been sold to someone else meanwhile.
            late: ["expired", "declined", "failed"].includes(order.status),
            at: nowIso,
          },
        });
      }
      case "draft.seen":
        return is("open") ? set("seen") : same;
      case "draft.amount_mismatch":
        return is("open", "seen", "expired") ? set("review") : same;
      case "draft.mismatch_accepted":
        return is("paid", "declined") ? same : set("accepted");
      case "draft.mismatch_rejected":
        return is("paid") ? same : set("declined");
      case "draft.mismatch_unresolved":
        return is("open", "seen", "review", "expired") ? set("unresolved") : same;
      case "draft.expired":
        if (data.reviewState === "unresolved") return is("open", "seen", "review", "expired") ? set("unresolved") : same;
        return is("open", "seen") ? set("expired") : same;
      case "payment_request.expired":
        return is("open", "seen") ? set("expired") : same;
      default:
        return { outcome: "ignored", order, before }; // draft.created, draft.cancelled, draft.mismatch_reminder
    }
  }
}

export type Outcome = "test" | "ignored" | "unknown_order" | "unchanged" | "already_paid" | OrderStatus;

/** Fields of a draft webhook payload the shop reads (docs/webhooks "Payload"). */
export interface DraftEventData {
  status?: string;
  txId?: string;
  sentCurrency?: string;
  network?: string;
  amountSats?: number;
  sentAmount?: string;
  receivedAmountSats?: number;
  receivedAmount?: string;
  fiatCurrency?: string;
  fiatAmount?: number;
  paymentRequestId?: string;
  orderId?: string;
  reviewState?: string;
}

const eq = (a: unknown, b: unknown) => String(a ?? "").toLowerCase() === String(b ?? "").toLowerCase();
const isPosInt = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** A draft.confirmed must be exactly this order. Empty = OK. */
export function checkPaymentAgainstOrder(data: DraftEventData, order: Order): string[] {
  const problems: string[] = [];
  if (data.orderId !== order.orderId) problems.push(`orderId ${data.orderId} != ${order.orderId}`);
  if (!order.paymentRequestId || data.paymentRequestId !== order.paymentRequestId) problems.push(`pay link ${data.paymentRequestId} != ${order.paymentRequestId}`);
  if (data.status !== "Confirmed") problems.push(`status ${data.status} != Confirmed`);
  if (!data.txId) problems.push("no txId");
  if (!eq(data.fiatCurrency, order.currency)) problems.push(`fiat ${data.fiatCurrency} != ${order.currency}`);
  if (typeof data.fiatAmount !== "number" || toMinor(data.fiatAmount, order.currency) !== toMinor(order.total, order.currency)) problems.push(`amount ${data.fiatAmount} != ${order.total}`);
  if (!isPosInt(data.amountSats)) problems.push("no amountSats");
  if (data.receivedAmountSats !== undefined && !isPosInt(data.receivedAmountSats)) problems.push("bad receivedAmountSats");
  // sentCurrency is upper case in payloads ("USDC"), options use API enums ("Usdc").
  if (!order.options.some((o) => eq(o.currency, data.sentCurrency) && eq(o.network, data.network))) problems.push(`asset ${data.sentCurrency} on ${data.network} was not offered`);
  return problems;
}
