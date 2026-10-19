// The 📱 mock Telegram page. Renders /phone/api/state with textContent only:
// the bot's HTML was already parsed server-side into plain spans.
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let chatId = Number(params.get("chat")) || 1001;
  let chats = [];
  let last = "";
  let since = Date.now();

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(refresh);
  const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function openUrl(url) {
    const u = new URL(url, location.href);
    if (u.origin === location.origin) location.href = u.href; // mock pay page
    else if (u.protocol === "https:") window.open(u.href, "_blank", "noopener");
  }

  function render() {
    const chat = chats.find((c) => c.id === chatId) ?? chats[0];
    if (!chat) return;
    chatId = chat.id;
    $("title").textContent = chat.title;
    $("avatar").textContent = chat.id === 1001 ? "🛍️" : "🔔";
    $("sub").textContent = chat.id === 1001 ? "bot · buyer chat" : "bot · your seller chat";
    const tabs = $("tabs");
    tabs.replaceChildren(
      ...chats.map((c) => {
        const b = el("button", c.id === chatId ? "on" : "", c.id === 1001 ? "🛍️" : "🔔");
        b.title = c.title;
        b.onclick = () => {
          chatId = c.id;
          last = "";
          render();
        };
        return b;
      }),
    );
    const key = JSON.stringify(chat.messages) + chatId;
    if (key !== last) {
      last = key;
      const log = $("log");
      if (!chat.messages.length) log.replaceChildren(el("p", "hint", chat.id === 1001 ? "Type /start to open the shop 👇" : "Order alerts for the seller land here."));
      else
        log.replaceChildren(
          ...chat.messages.map((m) => {
            const wrap = el("div", `msg ${m.from}`);
            const bubble = el("div", "bubble");
            if (m.photo) {
              const img = el("img", "photo");
              img.src = m.photo;
              img.alt = "QR code";
              bubble.append(img);
            }
            const text = el("div", "text");
            for (const s of m.spans) {
              const span = el(s.code ? "code" : "span", "", s.t);
              if (s.b) span.classList.add("b");
              if (s.i) span.classList.add("i");
              text.append(span);
            }
            bubble.append(text, el("time", "", time(m.at)));
            wrap.append(bubble);
            if (m.buttons?.length) {
              const kb = el("div", "kb");
              for (const row of m.buttons) {
                const r = el("div", "kbrow");
                for (const btn of row) {
                  const b = el("button", btn.url ? "url" : "", btn.text);
                  b.onclick = () => (btn.url ? openUrl(btn.url) : post("/phone/api/tap", { chat: chatId, message: m.id, data: btn.data }));
                  r.append(b);
                }
                kb.append(r);
              }
              wrap.append(kb);
            }
            return wrap;
          }),
        );
      log.scrollTop = log.scrollHeight;
    }
    const toast = chat.toast;
    if (toast) {
      $("toast").textContent = toast.text;
      $("toast").hidden = false;
      clearTimeout(render.t);
      render.t = setTimeout(() => ($("toast").hidden = true), 2200);
    }
  }

  async function refresh() {
    try {
      const r = await fetch(`/phone/api/state?since=${since}`, { cache: "no-store" });
      since = Date.now() - 50;
      chats = (await r.json()).chats;
      render();
    } catch {
      /* server restarting */
    }
  }

  $("compose").onsubmit = (e) => {
    e.preventDefault();
    const text = $("text").value.trim();
    if (!text) return;
    $("text").value = "";
    post("/phone/api/send", { chat: chatId, text });
  };
  since = Date.now() - 3000; // show a toast from the last few seconds only
  refresh();
  setInterval(refresh, 800);
})();
