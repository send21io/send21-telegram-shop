import type { Bot, Transformer } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";

// Mock Telegram: no token, no network. The real bot code runs; every Bot API
// call it makes is answered here (bot.api.config.use), and the 📱 /phone page
// shows the chats. Two chats: a buyer and the seller (the admin chat).

export interface Span {
  t: string;
  b?: true;
  i?: true;
  code?: true;
}
export interface Button {
  text: string;
  data?: string;
  url?: string;
}
export interface PhoneMessage {
  id: number;
  from: "bot" | "me";
  spans: Span[];
  /** data: URL (a QR from InputFile) or an https product photo */
  photo?: string;
  buttons?: Button[][];
  at: number;
}
export interface PhoneChat {
  id: number;
  title: string;
  user: { id: number; first_name: string; username: string };
  messages: PhoneMessage[];
  toast?: { text: string; at: number };
}

export const BOT_INFO: UserFromGetMe = {
  id: 1_000_000,
  is_bot: true,
  first_name: "Merch Shop",
  username: "merch_shop_mock_bot",
  can_join_groups: false,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

/** Telegram HTML (b, i, code; entities escaped) -> plain spans. Any other tag is shown as text. */
export function parseHtml(html: string): Span[] {
  const out: Span[] = [];
  const st = { b: 0, i: 0, code: 0 };
  const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  for (const part of html.split(/(<\/?(?:b|i|code)>)/)) {
    const tag = /^<(\/?)(b|i|code)>$/.exec(part);
    if (tag) {
      st[tag[2] as keyof typeof st] += tag[1] ? -1 : 1;
      continue;
    }
    if (!part) continue;
    out.push({ t: unesc(part), ...(st.b > 0 ? { b: true as const } : {}), ...(st.i > 0 ? { i: true as const } : {}), ...(st.code > 0 ? { code: true as const } : {}) });
  }
  return out;
}

type Markup = { inline_keyboard?: { text: string; callback_data?: string; url?: string }[][] } | undefined;
const buttonsOf = (m: Markup): Button[][] | undefined =>
  m?.inline_keyboard?.map((row) => row.map((b) => ({ text: b.text, ...(b.callback_data ? { data: b.callback_data } : {}), ...(b.url ? { url: b.url } : {}) })));

export class Phone {
  readonly chats = new Map<number, PhoneChat>();
  private nextMessage = 1;
  private nextUpdate = 1;
  /** Every Bot API call, for tests. */
  readonly calls: { method: string; payload: Record<string, unknown> }[] = [];

  constructor(
    private readonly bot: Bot,
    chats: { id: number; title: string; first_name: string; username: string }[],
  ) {
    for (const c of chats) this.chats.set(c.id, { id: c.id, title: c.title, user: { id: c.id, first_name: c.first_name, username: c.username }, messages: [] });
    bot.api.config.use(this.transformer);
  }

  private chat(id: unknown): PhoneChat {
    const c = this.chats.get(Number(id));
    if (!c) throw new Error(`mock telegram: unknown chat ${String(id)}`);
    return c;
  }

  private transformer: Transformer = async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    this.calls.push({ method, payload: p });
    const ok = <T>(result: T) => ({ ok: true as const, result }) as never;
    const msgResult = (chatId: number, id: number) => ({ message_id: id, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: "private" }, from: BOT_INFO });
    const spans = (text: unknown, mode: unknown): Span[] => (mode === "HTML" ? parseHtml(String(text ?? "")) : [{ t: String(text ?? "") }]);
    switch (method) {
      case "sendMessage": {
        const c = this.chat(p.chat_id);
        const m: PhoneMessage = { id: this.nextMessage++, from: "bot", spans: spans(p.text, p.parse_mode), buttons: buttonsOf(p.reply_markup as Markup), at: Date.now() };
        c.messages.push(m);
        return ok({ ...msgResult(c.id, m.id), text: String(p.text) });
      }
      case "sendPhoto": {
        const c = this.chat(p.chat_id);
        const photo = p.photo as unknown;
        let src: string | undefined;
        if (typeof photo === "string") src = /^https:\/\//.test(photo) ? photo : undefined;
        else {
          // grammY's InputFile keeps the bytes in a private field; fine for a mock.
          const data = (photo as { fileData?: unknown }).fileData;
          if (data instanceof Uint8Array) src = `data:image/png;base64,${Buffer.from(data).toString("base64")}`;
        }
        const m: PhoneMessage = { id: this.nextMessage++, from: "bot", spans: spans(p.caption, p.parse_mode), ...(src ? { photo: src } : {}), buttons: buttonsOf(p.reply_markup as Markup), at: Date.now() };
        c.messages.push(m);
        return ok({ ...msgResult(c.id, m.id), photo: [{ file_id: `mock-${m.id}`, file_unique_id: `mock-${m.id}`, width: 480, height: 480 }] });
      }
      case "editMessageText":
      case "editMessageReplyMarkup": {
        const c = this.chat(p.chat_id);
        const m = c.messages.find((x) => x.id === Number(p.message_id));
        if (!m) return { ok: false, error_code: 400, description: "Bad Request: message to edit not found" } as never;
        if (method === "editMessageText") m.spans = spans(p.text, p.parse_mode);
        m.buttons = buttonsOf(p.reply_markup as Markup);
        return ok({ ...msgResult(c.id, m.id), text: m.spans.map((s) => s.t).join("") });
      }
      case "deleteMessage": {
        const c = this.chat(p.chat_id);
        c.messages = c.messages.filter((x) => x.id !== Number(p.message_id));
        return ok(true);
      }
      case "answerCallbackQuery": {
        const chatId = Number(String(p.callback_query_id).split(":")[0]);
        const c = this.chats.get(chatId);
        if (c && p.text) c.toast = { text: String(p.text), at: Date.now() };
        return ok(true);
      }
      case "setMyCommands":
      case "deleteWebhook":
      case "setWebhook":
        return ok(true);
      case "getMe":
        return ok(BOT_INFO);
      default:
        return { ok: false, error_code: 400, description: `mock telegram: ${method} is not simulated` } as never;
    }
  };

  /** The person types a message in the chat. */
  async send(chatId: number, text: string): Promise<void> {
    const c = this.chat(chatId);
    const m: PhoneMessage = { id: this.nextMessage++, from: "me", spans: [{ t: text }], at: Date.now() };
    c.messages.push(m);
    const cmd = /^\/[a-z_]+/i.exec(text);
    const update = {
      update_id: this.nextUpdate++,
      message: {
        message_id: m.id,
        date: Math.floor(m.at / 1000),
        chat: { id: c.id, type: "private", first_name: c.user.first_name, username: c.user.username },
        from: { ...c.user, is_bot: false },
        text,
        ...(cmd ? { entities: [{ type: "bot_command", offset: 0, length: cmd[0].length }] } : {}),
      },
    } as unknown as Update;
    await this.bot.handleUpdate(update);
  }

  /** The person taps an inline button of a bot message. */
  async tap(chatId: number, messageId: number, data: string): Promise<boolean> {
    const c = this.chat(chatId);
    const m = c.messages.find((x) => x.id === messageId && x.from === "bot");
    if (!m?.buttons?.flat().some((b) => b.data === data)) return false; // only buttons that are really there
    const update = {
      update_id: this.nextUpdate++,
      callback_query: {
        id: `${c.id}:${this.nextUpdate}`,
        from: { ...c.user, is_bot: false },
        chat_instance: String(c.id),
        data,
        message: { message_id: m.id, date: Math.floor(m.at / 1000), chat: { id: c.id, type: "private" }, from: BOT_INFO, text: m.spans.map((s) => s.t).join("") },
      },
    } as unknown as Update;
    await this.bot.handleUpdate(update);
    return true;
  }

  state(since = 0) {
    return [...this.chats.values()].map((c) => ({ ...c, messages: c.messages.slice(-60), toast: c.toast && c.toast.at > since ? c.toast : undefined }));
  }
}
