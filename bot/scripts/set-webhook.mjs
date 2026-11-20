// Registers (or deletes) the Telegram webhook for the bot.
//
// Usage:
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... WORKER_HOST=gprop-bot.potatoportal.dev \
//     node scripts/set-webhook.mjs            # set
//   ... node scripts/set-webhook.mjs delete   # remove
//
// Keeps the bot's group privacy mode in mind: we only need message + callback updates.

const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const host = process.env.WORKER_HOST || "gprop-bot.potatoportal.dev";
if (!token) { console.error("TELEGRAM_BOT_TOKEN required"); process.exit(1); }

const api = (m, q = "") => `https://api.telegram.org/bot${token}/${m}${q}`;

if (process.argv[2] === "delete") {
  const r = await fetch(api("deleteWebhook", "?drop_pending_updates=true"));
  console.log(await r.json());
  process.exit(0);
}

if (!secret) { console.error("TELEGRAM_WEBHOOK_SECRET required to set"); process.exit(1); }
const url = `https://${host}/tg/${secret}`;
const r = await fetch(api("setWebhook"), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: true,
  }),
});
console.log("setWebhook ->", await r.json());
console.log("webhook url:", url);
