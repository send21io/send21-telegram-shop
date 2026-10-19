import { describe, expect, it } from "vitest";
import { parseHtml } from "../src/mock/telegram.js";
import { ADMIN, BUYER, checkout, world } from "./helpers.js";

describe("the bot (real grammY handlers, mock Telegram)", () => {
  it("/start shows the catalog with ➕ ➖ 🛒 ✅", async () => {
    const w = await world();
    await w.phone.send(BUYER, "/start");
    const m = w.lastBot();
    expect(w.text(m)).toContain("🧥 Hoodie · €45.00 · 3 left");
    expect(w.text(m)).toContain("📱 Wallpaper pack · €3.00 · digital");
    expect(m.buttons?.[0]?.map((b) => b.text)).toEqual(["➖", "🌈 Sticker pack", "➕"]);
    expect(m.buttons?.at(-1)?.map((b) => b.data)).toEqual(["cart", "checkout"]);
    expect(w.phone.calls.find((c) => c.method === "sendMessage")?.payload.parse_mode).toBe("HTML");
    await w.close();
  });

  it("➕ edits the catalog in place and shows a toast", async () => {
    const w = await world();
    await w.phone.send(BUYER, "/start");
    const cat = w.lastBot();
    await w.phone.tap(BUYER, cat.id, "add:hoodie");
    await w.phone.tap(BUYER, cat.id, "add:hoodie");
    expect(w.phone.chats.get(BUYER)!.toast?.text).toBe("➕ 🧥 Hoodie · 2 in cart");
    expect(w.text(cat)).toContain("🛒 2 in your cart · €90.00");
    expect(cat.buttons?.[2]?.[1]?.text).toBe("🧥 Hoodie · 2");
    await w.phone.tap(BUYER, cat.id, "cart");
    expect(w.text(w.lastBot())).toBe("🛒 Your cart\n\n2× 🧥 Hoodie · €90.00\n\nTotal €90.00");
    await w.close();
  });

  it("✅ checkout asks for a note, then sends ONE 💳 Pay button with a QR", async () => {
    const w = await world();
    const o = (await checkout(w, { hoodie: 1 }))!;
    const m = w.lastBot();
    expect(m.photo).toMatch(/^data:image\/png;base64,iVBOR/);
    expect(m.buttons).toEqual([[{ text: "💳 Pay €45.00", url: o.payUrl }]]);
    expect(w.text(m)).toContain(`🧾 Order #${o.number}`);
    expect(w.text(m)).toContain("Your items are held for 2 h.");
    expect(w.phone.calls.filter((c) => c.method === "sendPhoto")).toHaveLength(1);
    await w.close();
  });

  it("📦 digital needs no address", async () => {
    const w = await world();
    await w.phone.send(BUYER, "/start");
    const cat = w.lastBot();
    await w.phone.tap(BUYER, cat.id, "add:wallpapers");
    await w.phone.tap(BUYER, cat.id, "checkout");
    expect(w.text(w.lastBot())).toContain("All digital: tap 📦 digital.");
    await w.phone.tap(BUYER, w.lastBot().id, "digital");
    expect(w.shop.orders()[0]?.note).toBe("digital");
    await w.close();
  });

  it("✖️ cancel keeps the cart and a later message is not taken as a note", async () => {
    const w = await world();
    await w.phone.send(BUYER, "/start");
    const cat = w.lastBot();
    await w.phone.tap(BUYER, cat.id, "add:hoodie");
    await w.phone.tap(BUYER, cat.id, "checkout");
    await w.phone.tap(BUYER, w.lastBot().id, "cancel");
    await w.phone.send(BUYER, "hello");
    expect(w.shop.orders()).toHaveLength(0);
    expect(w.shop.cartItems(BUYER)).toHaveLength(1);
    await w.close();
  });

  it("only buttons that are really on a message can be tapped", async () => {
    const w = await world();
    await w.phone.send(BUYER, "/start");
    expect(await w.phone.tap(BUYER, w.lastBot().id, "add:../../x")).toBe(false);
    await w.phone.send(BUYER, "/start");
    await w.phone.tap(BUYER, w.lastBot().id, "add:hoodie");
    expect(w.phone.chats.get(BUYER)!.toast?.text).toContain("Hoodie");
    await w.close();
  });

  it("/orders is for the admin chat only", async () => {
    const w = await world();
    await checkout(w, { hoodie: 1 });
    await w.phone.send(BUYER, "/orders");
    expect(w.text(w.lastBot())).toBe("🔒 for the shop owner only");
    await w.phone.send(ADMIN, "/orders");
    expect(w.text(w.lastBot(ADMIN))).toMatch(/^📋 Last orders\n💳 #1 · €45\.00 · open · @buyer_demo$/);
    await w.close();
  });

  it("escapes everything that goes into HTML", async () => {
    const w = await world();
    await checkout(w, { hoodie: 1 }, "Shop & Co, \"Flat\" 2");
    const sent = w.phone.calls.find((c) => c.method === "sendPhoto")!.payload.caption as string;
    expect(sent).toContain("ship to: Shop &amp; Co, &quot;Flat&quot; 2");
    expect(w.text(w.lastBot())).toContain('ship to: Shop & Co, "Flat" 2');
    await w.close();
  });
});

describe("mock pay page → signed webhook → 🎉 in the chat", () => {
  it("runs the whole loop over HTTP", async () => {
    const w = await world();
    const o = (await checkout(w, { "sticker-pack": 2 }))!;
    const path = new URL(o.payUrl!).pathname;
    const page = await (await fetch(`${w.url}${path}`)).text();
    expect(page).toContain("€8.00");
    expect(page).toContain("🧪 mock send21");
    const r = await fetch(`${w.url}${path}/paid`, { method: "POST", body: new URLSearchParams({ coin: "1" }) });
    expect(await r.text()).toContain("📨 sent <code>draft.confirmed</code>");
    await w.settle();
    expect(w.store.getOrder(o.id)?.status).toBe("paid");
    expect(w.text(w.lastBot())).toMatch(/^🎉 Paid, order #1!/);
    expect(w.text(w.lastBot(ADMIN))).toMatch(/^💰 New order #1 · €8\.00 in USDC · Solana/);
    await w.close();
  });

  it("⚠️ 5% short goes to review and the seller is asked to decide", async () => {
    const w = await world();
    const o = (await checkout(w, { hoodie: 1 }))!;
    await fetch(`${w.url}${new URL(o.payUrl!).pathname}/short`, { method: "POST", body: new URLSearchParams({ coin: "0" }) });
    await w.settle();
    expect(w.store.getOrder(o.id)?.status).toBe("review");
    expect(w.text(w.lastBot(ADMIN))).toContain("Accept or decline it on send21.");
    await w.close();
  });

  it("👍 accept the short pay sends mismatch_accepted → confirmed and marks it paid", async () => {
    const w = await world();
    const o = (await checkout(w, { hoodie: 1 }))!;
    const path = new URL(o.payUrl!).pathname;
    await fetch(`${w.url}${path}/short`, { method: "POST", body: new URLSearchParams({ coin: "0" }) });
    const r = await fetch(`${w.url}${path}/accept`, { method: "POST", body: new URLSearchParams({ coin: "0" }) });
    expect(await r.text()).toContain("draft.mismatch_accepted → draft.confirmed");
    await w.settle();
    expect(w.store.getOrder(o.id)?.status).toBe("paid");
    expect(w.text(w.lastBot(ADMIN))).toContain("⚠️ a different amount was accepted on send21");
    await w.close();
  });

  it("↩️ decline the short pay cancels the order", async () => {
    const w = await world();
    const o = (await checkout(w, { hoodie: 1 }))!;
    const path = new URL(o.payUrl!).pathname;
    await fetch(`${w.url}${path}/short`, { method: "POST", body: new URLSearchParams({ coin: "0" }) });
    await fetch(`${w.url}${path}/decline`, { method: "POST", body: new URLSearchParams({ coin: "0" }) });
    await w.settle();
    expect(w.store.getOrder(o.id)?.status).toBe("declined");
    expect(w.text(w.lastBot())).toMatch(/^↩️ order #1 was cancelled/);
    await w.close();
  });

  it("an unknown action is a 404 and does NOT expire the order (it used to)", async () => {
    const w = await world();
    const o = (await checkout(w, { hoodie: 1 }))!;
    const r = await fetch(`${w.url}${new URL(o.payUrl!).pathname}/oops`, { method: "POST", body: new URLSearchParams({ coin: "0" }) });
    expect(r.status).toBe(404);
    await w.settle();
    expect(w.store.getOrder(o.id)?.status).toBe("open");
    await w.close();
  });

  it("the mock chat is named after the shop", async () => {
    const w = await world();
    const state = (await (await fetch(`${w.url}/phone/api/state`)).json()) as { chats: { id: number; title: string }[] };
    expect(state.chats.find((c) => c.id === 1001)?.title).toBe("Pixel Merch");
    await w.close();
  });
});

describe("📱 phone page", () => {
  it("serves the page with a strict CSP and validates the API", async () => {
    const w = await world();
    const r = await fetch(`${w.url}/phone`);
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(await r.text()).toContain("phone.js");
    const post = (p: string, body: unknown) => fetch(`${w.url}/phone/api/${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await post("send", { chat: 9, text: "hi" })).status).toBe(400);
    expect((await post("send", { chat: BUYER, text: "x".repeat(501) })).status).toBe(400);
    expect((await post("send", { chat: BUYER, text: "/start" })).status).toBe(200);
    const state = await (await fetch(`${w.url}/phone/api/state`)).json();
    expect(state.chats[0].messages.at(-1).spans[0]).toEqual({ t: "🛍️ ", });
    expect((await post("tap", { chat: BUYER, message: 999, data: "cart" })).status).toBe(404);
    expect(await (await fetch(`${w.url}/healthz`)).json()).toEqual({ ok: true, send21: "mock", telegram: "mock" });
    await w.close();
  });

  it("parses only b, i and code; other tags stay text", () => {
    expect(parseHtml("<b>Hi</b> &lt;i&gt; <i>x</i><script>")).toEqual([{ t: "Hi", b: true }, { t: " <i> " }, { t: "x", i: true }, { t: "<script>" }]);
  });
});
