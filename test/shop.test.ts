import { describe, expect, it, vi } from "vitest";
import { Send21Error } from "../src/send21.js";
import { ADMIN, BUYER, checkout, world } from "./helpers.js";

const OTHER = ADMIN; // a second person in the mock (the seller chat can shop too)

describe("cart and stock", () => {
  it("cannot add more than is on the shelf", async () => {
    const w = await world();
    for (let i = 0; i < 3; i++) expect(w.shop.add(BUYER, "hoodie").ok).toBe(true);
    expect(w.shop.add(BUYER, "hoodie")).toEqual({ ok: false, error: "😢 only 3 Hoodie left" });
    expect(w.shop.add(BUYER, "nope").ok).toBe(false);
    expect(w.shop.remove(BUYER, "hoodie")).toEqual({ ok: true, qty: 2 });
    await w.close();
  });

  it("limits one item per order", async () => {
    const w = await world();
    for (let i = 0; i < 10; i++) w.shop.add(BUYER, "sticker-pack");
    expect(w.shop.add(BUYER, "sticker-pack")).toEqual({ ok: false, error: "✋ max 10 per order" });
    await w.close();
  });

  it("reserves stock at checkout: the next buyer sees what is left", async () => {
    const w = await world();
    const o = await checkout(w, { hoodie: 2 });
    expect(o?.status).toBe("open");
    expect(w.shop.available("hoodie")).toBe(1);
    w.shop.add(OTHER, "hoodie");
    expect(w.shop.add(OTHER, "hoodie").ok).toBe(false);
    await w.close();
  });

  it("two carts, one hoodie left: the first note wins, the second hears it sold out", async () => {
    const w = await world();
    for (const chat of [BUYER, OTHER]) {
      for (let i = 0; i < 3; i++) w.shop.add(chat, "hoodie");
      expect(w.shop.startCheckout(chat).ok).toBe(true);
    }
    const [a, b] = await Promise.all([w.shop.placeOrder(BUYER, "@a", "Street 1"), w.shop.placeOrder(OTHER, "@b", "Street 2")]);
    expect(a.ok).toBe(true);
    expect(b).toEqual({ ok: false, error: "😢 🧥 Hoodie just sold out. Check your 🛒 cart." });
    expect(w.shop.available("hoodie")).toBe(0);
    expect(w.mockSend21!.requests.size).toBe(1);
    await w.close();
  });

  it("releases stock when the pay link expires, and refuses a 4th unpaid order", async () => {
    const w = await world({ SHOP_MAX_OPEN_ORDERS: "1" });
    await checkout(w, { hoodie: 1 });
    w.shop.add(BUYER, "sticker-pack");
    expect(w.shop.startCheckout(BUYER)).toEqual({ ok: false, error: "⏳ you have 1 unpaid orders. Pay or let one expire first." });
    const later = new Date(Date.now() + 3 * 3600_000);
    const expired = w.store.transaction((d) => w.shop.sweep(d, later));
    expect(expired.map((o) => o.status)).toEqual(["expired"]);
    expect(w.shop.available("hoodie")).toBe(3);
    await w.close();
  });

  it("refuses a note with a link and keeps the checkout waiting", async () => {
    const w = await world();
    w.shop.add(BUYER, "hoodie");
    w.shop.startCheckout(BUYER);
    expect((await w.shop.placeOrder(BUYER, "@a", "see https://evil.com")).ok).toBe(false);
    expect(w.shop.chat(BUYER).pending).not.toBeNull();
    expect((await w.shop.placeOrder(BUYER, "@a", "DIGITAL")).ok).toBe(true);
    await w.close();
  });
});

describe("checkout: ONE fiat pay link per order", () => {
  it("sends the documented fields with orderId tg-<id> as the Idempotency-Key", async () => {
    const w = await world();
    const spy = vi.spyOn(w.mockSend21!, "createPaymentRequest");
    const o = (await checkout(w, { hoodie: 1, "sticker-pack": 2 }))!;
    expect(o.orderId).toMatch(/^tg-[a-z0-9]{10}$/);
    expect(spy).toHaveBeenCalledTimes(1);
    const [body, key] = spy.mock.calls[0]!;
    expect(key).toBe(o.orderId);
    expect(body).toEqual({
      fiatCurrency: "EUR",
      fiatAmount: 53,
      orderId: o.orderId,
      memo: `🛍️ Order #${o.number} · Pixel Merch`,
      options: o.options,
      expiryHours: 2,
      declineNote: "The order is cancelled and the items go back on the shelf.",
      reuseOpenForOrder: true,
      shortfallPolicy: { absorbUpToPercent: 1, absorbedBy: "receiver" },
    });
    expect(o.payUrl).toMatch(/\/mock\/pay\//);
    expect(o.paymentRequestId).toBeTruthy();
    await w.close();
  });

  it("a repeated note does not create a second order or link", async () => {
    const w = await world();
    await checkout(w, { hoodie: 1 });
    await w.phone.send(BUYER, "Flat 2, 1 Example Street, 12345 Town");
    expect(w.shop.orders()).toHaveLength(1);
    expect(w.mockSend21!.requests.size).toBe(1);
    expect(w.text(w.lastBot())).toBe("👋 /start opens the shop.");
    await w.close();
  });

  it("retrying a stored order without a link reuses the same Idempotency-Key", async () => {
    const w = await world();
    const o = (await checkout(w, { hoodie: 1 }))!;
    const spy = vi.spyOn(w.mockSend21!, "createPaymentRequest");
    w.store.transaction((d) => {
      d.orders[o.id] = { ...o, payUrl: null, paymentRequestId: null };
    });
    await w.resume();
    expect(spy.mock.calls[0]![1]).toBe(o.orderId);
    expect(w.store.getOrder(o.id)?.payUrl).toBeTruthy();
    await w.close();
  });

  it("send21 refuses: stock goes back and the buyer gets a plain message", async () => {
    const w = await world();
    vi.spyOn(w.mockSend21!, "createPaymentRequest").mockRejectedValue(new Send21Error("bad option", 400));
    const o = (await checkout(w, { hoodie: 3 }))!;
    expect(o.status).toBe("failed");
    expect(w.shop.available("hoodie")).toBe(3);
    expect(w.text(w.lastBot())).toMatch(/^😕 .*Your items are back in the shop\.$/);
    await w.close();
  });
});
