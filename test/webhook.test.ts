import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { checkPaymentAgainstOrder } from "../src/shop.js";
import { Store } from "../src/store.js";
import { ADMIN, BUYER, checkout, confirmedFor, deliver, world } from "./helpers.js";

type W = Awaited<ReturnType<typeof world>>;
const ordered = async (w: W) => (await checkout(w, { hoodie: 1, "sticker-pack": 2 }))!;
const ev = (event: string, o: { orderId: string; paymentRequestId: string | null; total: number; currency: string }, data: Record<string, unknown> = {}) => ({
  event,
  data: { ...confirmedFor(o).data, status: "Seen", ...data },
});

describe("send21 webhook: verify, dedupe, then apply", () => {
  it("401 for a bad or stale signature, 400 for bad JSON, nothing stored", async () => {
    const w = await world();
    const o = await ordered(w);
    expect((await deliver(w.url, confirmedFor(o), { secret: "wrong" })).status).toBe(401);
    expect((await deliver(w.url, confirmedFor(o), { t: Math.floor(Date.now() / 1000) - 301 })).status).toBe(401);
    expect((await deliver(w.url, null, { raw: "{nope" })).status).toBe(400);
    expect(w.store.getOrder(o.id)?.status).toBe("open");
    expect(w.store.read((d) => Object.keys(d.deliveries))).toHaveLength(0);
    await w.close();
  });

  it("✅ paid: messages the buyer and the seller once", async () => {
    const w = await world();
    const o = await ordered(w);
    const r = await deliver(w.url, confirmedFor(o));
    expect(await r.json()).toEqual({ ok: true, outcome: "paid" });
    await w.settle();
    expect(w.text(w.lastBot())).toBe(`🎉 Paid, order #${o.number}!\nThanks 💛 We'll pack it and ship it soon.`);
    const admin = w.text(w.lastBot(ADMIN));
    expect(admin).toContain(`💰 New order #${o.number} · €53.00 in USDC · Solana`);
    expect(admin).toContain("📦 ship to: Flat 2, 1 Example Street, 12345 Town");
    expect(admin).toContain("👤 @buyer_demo");
    const sent = w.phone.calls.filter((c) => c.method === "sendMessage").length;
    // The same delivery again, and the same body under a new delivery id: both duplicates.
    const id = crypto.randomUUID();
    const body = JSON.stringify(confirmedFor(o));
    expect(await (await deliver(w.url, null, { raw: body, deliveryId: id })).json()).toEqual({ ok: true, outcome: "already_paid" });
    expect(await (await deliver(w.url, null, { raw: body, deliveryId: id })).json()).toEqual({ ok: true, duplicate: true });
    expect(await (await deliver(w.url, null, { raw: body })).json()).toEqual({ ok: true, duplicate: true });
    await w.settle();
    expect(w.phone.calls.filter((c) => c.method === "sendMessage").length).toBe(sent);
    await w.close();
  });

  it("remembers deliveries across a restart (file store)", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tgshop-")), "shop.json");
    const a = await world({ DATA_FILE: file });
    const o = await ordered(a);
    const raw = JSON.stringify(confirmedFor(o));
    const id = crypto.randomUUID();
    expect((await deliver(a.url, null, { raw, deliveryId: id })).status).toBe(200);
    await a.close();
    const b = await world({ DATA_FILE: file });
    expect(b.store.getOrder(o.id)?.status).toBe("paid");
    expect(await (await deliver(b.url, null, { raw, deliveryId: id })).json()).toEqual({ ok: true, duplicate: true });
    await b.close();
  });

  it("500 when the store cannot write: nothing is half-applied, the retry works", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "tgshop-")), "shop.json");
    const w = await world({ DATA_FILE: file });
    const o = await ordered(w);
    const raw = JSON.stringify(confirmedFor(o));
    const id = crypto.randomUUID();
    const spy = vi.spyOn(w.store as unknown as { persist: () => void }, "persist").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    expect((await deliver(w.url, null, { raw, deliveryId: id })).status).toBe(500);
    expect(w.store.getOrder(o.id)?.status).toBe("open");
    expect(w.store.read((d) => d.deliveries[id])).toBeUndefined();
    spy.mockRestore();
    expect(await (await deliver(w.url, null, { raw, deliveryId: id })).json()).toEqual({ ok: true, outcome: "paid" });
    await w.close();
  });

  it("ignores other integrations' orderIds and test events", async () => {
    const w = await world();
    const o = await ordered(w);
    expect(await (await deliver(w.url, confirmedFor(o, { orderId: "coffee-abc" }))).json()).toEqual({ ok: true, outcome: "unknown_order" });
    expect(await (await deliver(w.url, confirmedFor(o, { orderId: "tg-zzzzzzzzzz" }))).json()).toEqual({ ok: true, outcome: "unknown_order" });
    expect(await (await deliver(w.url, { event: "test", data: {} })).json()).toEqual({ ok: true, outcome: "test" });
    expect(await (await deliver(w.url, ev("draft.created", o))).json()).toEqual({ ok: true, outcome: "ignored" });
    await w.close();
  });
});

describe("the order must match before it is paid", () => {
  it.each([
    [{ fiatAmount: 52.99 }, /amount/],
    [{ fiatCurrency: "USD" }, /fiat/],
    [{ sentCurrency: "USDT", network: "Solana" }, /not offered/],
    [{ sentCurrency: "USDC", network: "Base" }, /not offered/],
    [{ status: "Seen" }, /status/],
    [{ txId: "" }, /txId/],
    [{ amountSats: 0 }, /amountSats/],
    [{ paymentRequestId: "pr-other" }, /pay link/],
  ])("%j → 🚩 flagged, stock held, never paid", async (over, why) => {
    const w = await world();
    const o = await ordered(w);
    expect(checkPaymentAgainstOrder(confirmedFor(o, over).data, o).join()).toMatch(why);
    const r = await (await deliver(w.url, confirmedFor(o, over))).json();
    // A paymentRequestId that is not this order's is not this order at all.
    expect(r.outcome).toBe("paymentRequestId" in over ? "unknown_order" : "flagged");
    if (r.outcome === "flagged") {
      await w.settle();
      expect(w.text(w.lastBot(ADMIN))).toMatch(/^🚩 order #\d+: confirmed on send21 but it does not match/);
      expect(w.shop.available("hoodie")).toBe(2);
    }
    await w.close();
  });

  it("matches coin names case-insensitively (payload USDC vs option Usdc) and Lightning as BTC on Mainnet", async () => {
    const w = await world();
    const o = await ordered(w);
    expect(checkPaymentAgainstOrder(confirmedFor(o).data, o)).toEqual([]);
    expect(checkPaymentAgainstOrder(confirmedFor(o, { sentCurrency: "BTC", network: "Mainnet", amountSats: 88_000 }).data, o)).toEqual([]);
    await w.close();
  });
});

describe("state machine", () => {
  const run = async (events: [string, Record<string, unknown>?][]) => {
    const w = await world();
    const o = await ordered(w);
    const outcomes: string[] = [];
    for (const [e, data] of events) outcomes.push((await (await deliver(w.url, e === "draft.confirmed" ? confirmedFor(o, data) : ev(e, o, data))).json()).outcome);
    await w.settle();
    return { w, o, outcomes, status: w.store.getOrder(o.id)!.status };
  };

  it("👀 seen → ✅ paid", async () => {
    const { w, outcomes, status } = await run([["draft.seen"], ["draft.confirmed"]]);
    expect(outcomes).toEqual(["seen", "paid"]);
    expect(status).toBe("paid");
    expect(w.phone.chats.get(BUYER)!.messages.some((m) => w.text(m).startsWith("👀 Payment on its way"))).toBe(true);
    await w.close();
  });

  it("⚠️ different amount → 👍 accepted → ✅ paid (marked as a different amount)", async () => {
    const { w, o, outcomes } = await run([["draft.amount_mismatch", { receivedAmountSats: 50_000_000 }], ["draft.mismatch_accepted"], ["draft.confirmed", { receivedAmountSats: 50_000_000 }]]);
    expect(outcomes).toEqual(["review", "accepted", "paid"]);
    expect(w.store.getOrder(o.id)?.paid?.differentAmount).toBe(true);
    expect(w.text(w.lastBot(ADMIN))).toContain("⚠️ a different amount was accepted on send21");
    await w.close();
  });

  it("⚠️ different amount → ↩️ declined: stock back on the shelf", async () => {
    const { w, outcomes, status } = await run([["draft.amount_mismatch"], ["draft.mismatch_rejected"]]);
    expect(outcomes).toEqual(["review", "declined"]);
    expect(status).toBe("declined");
    expect(w.shop.available("hoodie")).toBe(3);
    expect(w.text(w.lastBot())).toMatch(/cancelled and the items are back on the shelf/);
    await w.close();
  });

  it("expired undecided with money in: ⚠️ unresolved, stock held", async () => {
    const { w, outcomes } = await run([["draft.amount_mismatch"], ["draft.expired", { reviewState: "unresolved" }]]);
    expect(outcomes).toEqual(["review", "unresolved"]);
    expect(w.shop.available("hoodie")).toBe(2);
    await w.close();
  });

  it("⌛ expired: stock back; a late payment still counts, and the seller is told to check stock", async () => {
    const { w, outcomes } = await run([["payment_request.expired"], ["draft.confirmed"]]);
    expect(outcomes).toEqual(["expired", "paid"]);
    expect(w.text(w.lastBot(ADMIN))).toContain("⚠️ paid after its stock was released");
    await w.close();
  });

  it("a paid order never goes back", async () => {
    const { outcomes, status, w } = await run([["draft.confirmed"], ["draft.mismatch_rejected"], ["draft.expired"], ["payment_request.expired"]]);
    expect(outcomes).toEqual(["paid", "unchanged", "unchanged", "unchanged"]);
    expect(status).toBe("paid");
    await w.close();
  });
});

describe("Store.remember", () => {
  it("drops entries older than 30 days", () => {
    const d = { version: 1 as const, seq: 0, orders: {}, chats: {}, deliveries: { old: 0 }, events: { oldk: 0 } };
    expect(Store.remember(d, "new", "k", 31 * 24 * 3600_000)).toBe(true);
    expect(Object.keys(d.deliveries)).toEqual(["new"]);
    expect(Store.remember(d, "other", "k", 31 * 24 * 3600_000)).toBe(false);
  });
});
