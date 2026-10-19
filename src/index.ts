import { loadConfig } from "./config.js";
import { buildShop } from "./app.js";

const cfg = loadConfig();
const { app, bot, phone, mockSend21, sweep, resume, commands } = buildShop(cfg);

// Mock Telegram means a local phone page anyone on the network could type into: localhost only.
const host = phone ? "127.0.0.1" : "0.0.0.0";
app.listen(cfg.port, host, async () => {
  console.log(`🪝 send21 webhooks: ${cfg.publicUrl}/webhooks/send21`);
  if (mockSend21) console.log("🧪 MOCK send21: no send21 calls, pay links open a local simulator.");
  setInterval(sweep, 60_000).unref();
  sweep();
  if (phone) {
    console.log(`🧪 MOCK Telegram: open 📱 ${cfg.publicUrl}/phone and type /start`);
    await resume();
    return;
  }
  await bot.api.setMyCommands(commands);
  if (cfg.telegramWebhookUrl) {
    await bot.api.setWebhook(`${cfg.telegramWebhookUrl}/telegram`, { secret_token: cfg.telegramWebhookSecret!, allowed_updates: ["message", "callback_query"] });
    console.log(`🤖 Telegram webhook: ${cfg.telegramWebhookUrl}/telegram`);
  } else {
    await bot.api.deleteWebhook();
    console.log("🤖 Telegram long polling. Say /start to your bot.");
    void bot.start({ allowed_updates: ["message", "callback_query"] });
  }
  await resume();
});

for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void (bot.isRunning() ? bot.stop() : Promise.resolve()).finally(() => process.exit(0)));
