import { Bot, GrammyError, InlineKeyboard, InputFile, type Api, type Context } from "grammy";
import QRCode from "qrcode";
import { lineTotal, money } from "./catalog.js";
import { coinFor } from "./currencies.js";
import { friendlyError } from "./send21.js";
import type { Outcome, Shop } from "./shop.js";
import type { Order, OrderItem } from "./types.js";

// The Telegram side. Every handler reads and writes through Shop, so prices,
// stock and orders never come from the chat. Messages use parse_mode HTML;
// every dynamic string goes through esc().

export const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const HTML = { parse_mode: "HTML" as const };

export interface BotDeps {
  shop: Shop;
  adminChatId: number | null;
  log?: (line: string) => void;
}

const who = (ctx: Context) => (ctx.from?.username ? `@${ctx.from.username}` : ctx.from?.first_name || "buyer");
const coinsLine = (shop: Shop) => [...new Set(shop.cfg.options.map((o) => coinFor(o.currency, o.network, o.method)?.label ?? `${o.currency} · ${o.network}`))].join(", ");

export function catalogText(shop: Shop, chatId: number): string {
  const { catalog } = shop;
  const lines = catalog.products.map((p) => {
    const left = shop.available(p.sku);
    const stock = p.digital ? "digital" : left === 0 ? "<i>sold out</i>" : `${left} left`;
    return `${p.emoji} <b>${esc(p.name)}</b> · ${esc(money(p.price, catalog.currency))} · ${stock}`;
  });
  const items = shop.cartItems(chatId);
  const n = items.reduce((s, i) => s + i.qty, 0);
  return [`🛍️ <b>${esc(catalog.shop)}</b>`, "", ...lines, "", n ? `🛒 ${n} in your cart · ${esc(money(shop.total(items), catalog.currency))}` : "Tap ➕ to add. Pay with crypto, no account needed."].join("\n");
}

export function catalogKeyboard(shop: Shop, chatId: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const cart = shop.chat(chatId).cart;
  for (const p of shop.catalog.products) {
    const qty = cart[p.sku] ?? 0;
    kb.text("➖", `rm:${p.sku}`).text(`${p.emoji} ${p.name}${qty ? ` · ${qty}` : ""}`, `info:${p.sku}`).text("➕", `add:${p.sku}`).row();
  }
  return kb.text("🛒 cart", "cart").text("✅ checkout", "checkout");
}

const itemLines = (items: OrderItem[], currency: string) => items.map((i) => `${i.qty}× ${i.emoji} ${esc(i.name)} · ${esc(money(lineTotal(i.price, i.qty, currency), currency))}`);

export function cartText(shop: Shop, chatId: number): string {
  const items = shop.cartItems(chatId);
  if (!items.length) return "🛒 Your cart is empty. Tap ➕ in the shop.";
  return ["🛒 <b>Your cart</b>", "", ...itemLines(items, shop.catalog.currency), "", `<b>Total ${esc(money(shop.total(items), shop.catalog.currency))}</b>`].join("\n");
}

export function orderCaption(shop: Shop, order: Order): string {
  return [
    `🧾 <b>Order #${order.number}</b>`,
    ...itemLines(order.items, order.currency),
    `<b>Total ${esc(money(order.total, order.currency))}</b>`,
    `📦 ${order.note === "digital" ? "digital" : `ship to: ${esc(order.note)}`}`,
    "",
    `Pay with ${esc(coinsLine(shop))}. Your items are held for ${shop.cfg.expiryHours} h.`,
  ].join("\n");
}

/** What the buyer and the seller hear after a webhook changed an order. */
export function notices(order: Order, outcome: Outcome, shop: Shop): { buyer?: string; admin?: string } {
  const n = `order #${order.number}`;
  const total = esc(money(order.total, order.currency));
  switch (outcome) {
    case "paid": {
      const coin = order.paid ? coinFor(order.paid.currency, order.paid.network)?.label ?? `${order.paid.currency} on ${order.paid.network}` : "";
      return {
        buyer: `🎉 <b>Paid, ${n}!</b>\nThanks 💛 ${order.note === "digital" ? "Your download is on its way here." : "We'll pack it and ship it soon."}`,
        admin: [
          `💰 <b>New ${n}</b> · ${total} in ${esc(coin)}`,
          ...itemLines(order.items, order.currency),
          `📦 ${order.note === "digital" ? "digital" : `ship to: ${esc(order.note)}`}`,
          `👤 ${esc(order.buyer)}`,
          ...(order.paid?.differentAmount ? ["⚠️ a different amount was accepted on send21"] : []),
          ...(order.paid?.late ? ["⚠️ paid after its stock was released: check stock before you ship"] : []),
        ].join("\n"),
      };
    }
    case "seen":
      return { buyer: `👀 Payment on its way for ${n}. We'll ping you when it's confirmed.` };
    case "review":
      return { buyer: `⚠️ A different amount arrived for ${n}. The shop is checking it.`, admin: `⚠️ ${n} (${total}): a different amount arrived. Accept or decline it on send21.` };
    case "accepted":
      return { buyer: `👍 The shop accepted the amount for ${n}. Waiting for confirmation.` };
    case "declined":
      return { buyer: `↩️ ${n} was cancelled and the items are back on the shelf.` };
    case "unresolved":
      return { buyer: `⚠️ The pay link for ${n} expired with a different amount. The shop will contact you.`, admin: `⚠️ ${n}: expired undecided, a different amount arrived. Sort it out on send21.` };
    case "expired":
      return { buyer: `⌛ ${n} expired and the items are back on the shelf. /start to order again.` };
    case "flagged":
      return {
        buyer: `⚠️ ${n} needs a quick manual check by the shop.`,
        admin: `🚩 ${n}: confirmed on send21 but it does not match the order, so it is NOT marked paid.\n${(order.problems ?? []).map((p) => `• ${esc(p)}`).join("\n")}`,
      };
    default:
      void shop;
      return {};
  }
}

/** Fire and forget: a Telegram hiccup never undoes a stored payment. */
export function notify(api: Api, deps: BotDeps, order: Order, outcome: Outcome): Promise<void> {
  const { buyer, admin } = notices(order, outcome, deps.shop);
  const log = deps.log ?? console.log;
  const send = (chat: number, text: string) => api.sendMessage(chat, text, HTML).then(() => undefined, (err: Error) => log(`notify ${chat} failed: ${err.message}`));
  return Promise.all([buyer ? send(order.chatId, buyer) : null, admin && deps.adminChatId !== null ? send(deps.adminChatId, admin) : null]).then(() => undefined);
}

/** The 💳 Pay button and a QR of the same link, in one photo message. */
export async function sendPayMessage(api: Api, shop: Shop, order: Order): Promise<void> {
  const qr = await QRCode.toBuffer(order.payUrl!, { margin: 2, width: 480, color: { dark: "#1B1C20", light: "#FFFFFF" } });
  await api.sendPhoto(order.chatId, new InputFile(qr, `order-${order.number}.png`), {
    caption: orderCaption(shop, order),
    ...HTML,
    reply_markup: new InlineKeyboard().url(`💳 Pay ${money(order.total, order.currency)}`, order.payUrl!),
  });
}

/** Editing a message to the same text is an error on Telegram: ignore just that. */
const notModified = (err: unknown) => {
  if (err instanceof GrammyError && /not modified/i.test(err.description)) return;
  throw err;
};

export function createBot(bot: Bot, deps: BotDeps): Bot {
  const { shop, adminChatId } = deps;
  const log = deps.log ?? console.log;
  const chatOf = (ctx: Context) => ctx.chat?.id ?? 0;
  const isAdmin = (ctx: Context) => adminChatId !== null && chatOf(ctx) === adminChatId;

  // Private chats only: a shop in a group would mix carts and addresses.
  bot.use(async (ctx, next) => {
    if (ctx.chat && ctx.chat.type !== "private") return;
    await next();
  });

  const showCatalog = async (ctx: Context) => {
    const chatId = chatOf(ctx);
    const m = await ctx.reply(catalogText(shop, chatId), { ...HTML, reply_markup: catalogKeyboard(shop, chatId) });
    shop.setCatalogMessage(chatId, m.message_id);
  };
  const refreshCatalog = async (ctx: Context) => {
    const chatId = chatOf(ctx);
    await ctx.editMessageText(catalogText(shop, chatId), { ...HTML, reply_markup: catalogKeyboard(shop, chatId) }).catch(notModified);
  };
  const askNote = async (ctx: Context) => {
    const r = shop.startCheckout(chatOf(ctx));
    if (!r.ok) return void (await ctx.reply(r.error));
    const allDigital = r.items.every((i) => shop.product(i.sku)?.digital);
    await ctx.reply(
      [`✅ <b>Checkout · ${esc(money(r.total, shop.catalog.currency))}</b>`, "", allDigital ? "All digital: tap 📦 digital." : "📦 Where should we ship it? Reply with a name and address.", "<i>Plain text, no links.</i>"].join("\n"),
      { ...HTML, reply_markup: allDigital ? new InlineKeyboard().text("📦 digital", "digital").text("✖️ cancel", "cancel") : new InlineKeyboard().text("✖️ cancel", "cancel") },
    );
  };

  const place = async (ctx: Context, note: string) => {
    const chatId = chatOf(ctx);
    let r;
    try {
      r = await shop.placeOrder(chatId, who(ctx), note);
    } catch (err) {
      log(`pay link failed: ${(err as Error).message}`);
      return void (await ctx.reply(`😕 ${friendlyError(err)} Your items are back in the shop.`));
    }
    if (!r.ok) return void (await ctx.reply(r.error));
    await sendPayMessage(ctx.api, shop, r.order);
  };

  bot.command("start", showCatalog);
  bot.command("shop", showCatalog);
  bot.command("cart", (ctx) => ctx.reply(cartText(shop, chatOf(ctx)), HTML));
  bot.command("whoami", (ctx) => ctx.reply(`🪪 your chat id: <code>${chatOf(ctx)}</code>\nPut it in ADMIN_CHAT_ID to get order alerts.`, HTML));
  bot.command("orders", async (ctx) => {
    if (!isAdmin(ctx)) return void (await ctx.reply("🔒 for the shop owner only"));
    const list = shop.orders().sort((a, b) => b.number - a.number).slice(0, 10);
    const icon: Record<string, string> = { open: "💳", seen: "👀", review: "⚠️", accepted: "👍", paid: "✅", declined: "↩️", unresolved: "⚠️", expired: "⌛", flagged: "🚩", failed: "❌" };
    await ctx.reply(list.length ? ["📋 <b>Last orders</b>", ...list.map((o) => `${icon[o.status] ?? "•"} #${o.number} · ${esc(money(o.total, o.currency))} · ${o.status} · ${esc(o.buyer)}`)].join("\n") : "📋 no orders yet", HTML);
  });

  bot.callbackQuery(/^(add|rm):([a-z0-9-]{1,24})$/, async (ctx) => {
    const [, op, sku] = ctx.match as RegExpMatchArray;
    const p = shop.product(sku!);
    const r = op === "add" ? shop.add(chatOf(ctx), sku!) : shop.remove(chatOf(ctx), sku!);
    await ctx.answerCallbackQuery(r.ok ? `${op === "add" ? "➕" : "➖"} ${p?.emoji ?? ""} ${p?.name ?? ""} · ${r.qty} in cart` : r.error);
    if (r.ok) await refreshCatalog(ctx);
  });
  bot.callbackQuery(/^info:([a-z0-9-]{1,24})$/, async (ctx) => {
    const p = shop.product(ctx.match![1]!);
    if (!p) return void (await ctx.answerCallbackQuery("🤷"));
    await ctx.answerCallbackQuery();
    const caption = `${p.emoji} <b>${esc(p.name)}</b> · ${esc(money(p.price, shop.catalog.currency))}${p.digital ? " · digital" : ` · ${shop.available(p.sku)} left`}`;
    if (p.photo) await ctx.replyWithPhoto(p.photo, { caption, ...HTML, reply_markup: new InlineKeyboard().text("➕ add", `add:${p.sku}`) });
    else await ctx.reply(caption, HTML);
  });
  bot.callbackQuery("cart", async (ctx) => {
    await ctx.answerCallbackQuery();
    const has = shop.cartItems(chatOf(ctx)).length > 0;
    await ctx.reply(cartText(shop, chatOf(ctx)), { ...HTML, ...(has ? { reply_markup: new InlineKeyboard().text("✅ checkout", "checkout") } : {}) });
  });
  bot.callbackQuery("checkout", async (ctx) => {
    await ctx.answerCallbackQuery();
    await askNote(ctx);
  });
  bot.callbackQuery("digital", async (ctx) => {
    await ctx.answerCallbackQuery();
    await place(ctx, "digital");
  });
  bot.callbackQuery("cancel", async (ctx) => {
    await ctx.answerCallbackQuery("✖️ checkout cancelled, your cart is still there");
    shop.store.transaction((d) => {
      const c = d.chats[String(chatOf(ctx))];
      if (c) c.pending = null;
    });
  });
  bot.on("callback_query:data", (ctx) => ctx.answerCallbackQuery("🤷 that button is old, /start again"));

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return void (await ctx.reply("🤷 try /start, /cart or /whoami"));
    if (shop.chat(chatOf(ctx)).pending) return place(ctx, ctx.message.text);
    await ctx.reply("👋 /start opens the shop.");
  });

  bot.catch((err) => log(`bot error on update ${err.ctx.update.update_id}: ${(err.error as Error)?.message ?? err.error}`));
  return bot;
}

export const COMMANDS = [
  { command: "start", description: "🛍️ open the shop" },
  { command: "cart", description: "🛒 your cart" },
  { command: "whoami", description: "🪪 your chat id" },
];
