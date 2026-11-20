# GProp Visitor Bot — Cloudflare Worker

Telegram bot that creates GProp visitor/delivery passes for the family group and
posts the QR back. Runs on Cloudflare Workers (free plan is plenty) on
`potatoportal.dev`.

## How it works

The bot drives the GProp **website** (not the mobile API). A family member types
`/pass` in the group, then:

1. Picks **Social visitor** or **Delivery**.
2. Social → **visitor name** + **vehicle reg**. Delivery → **company**
   (Grab/Lalamove/etc.) + **vehicle reg**.
3. Confirms the **visit date** (defaults to today).
4. The bot logs into GProp with Ross's credentials, creates the visitor (unit is
   always **RB-034B**), reads back the pass QR number, and posts a generated
   **visitor-pass PNG** to the group.

The pass PNG is built entirely in the Worker (`src/pass.js`): the QR comes from
`qrcode.js` (same library GProp uses) and is composited with an 8×8 bitmap font
into a card, then encoded as a PNG by hand via `CompressionStream` — no wasm, no
external services, no browser. The QR encodes the same `fldVisitorQr` number the
GProp app embeds, so it scans identically.

Only the configured group (`ALLOWED_CHAT_ID`) is served; everything else is
ignored (keep Telegram group privacy mode on so the bot only sees `/commands`
and replies to its own prompts).

### Files

- `src/index.js` — Telegram webhook + conversation flow.
- `src/gprop.js` — GProp web client (login, create, listing, cancel).
- `src/pass.js` — self-contained visitor-pass PNG renderer.
- `src/qrcode.js`, `src/font8x8.js` — vendored QR encoder + bitmap font.
- `src/telegram.js` — Telegram Bot API helpers (incl. PNG upload).

See [`../docs/WEB_API.md`](../docs/WEB_API.md) for the reverse-engineered GProp
web endpoints. (`../docs/API.md` documents the abandoned mobile-API attempt.)

## One-time setup

### 0. Prereqs
- `potatoportal.dev` added as a zone on your Cloudflare account.
- Node + `npm install` in this `bot/` folder (installs Wrangler).
- `npx wrangler login`.

### 1. Create the Telegram bot
- Talk to **@BotFather** → `/newbot` → get the **bot token**.
- `/setprivacy` → **Enable** (default; the bot only sees commands + replies).

### 2. Create the KV namespace
```
npx wrangler kv namespace create STATE
```
Paste the returned `id` into `wrangler.toml` (`kv_namespaces` → `id`).

### 3. Set secrets (never committed)
```
npx wrangler secret put TELEGRAM_BOT_TOKEN        # from BotFather
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # any random string you pick
npx wrangler secret put GPROP_LOGIN_ID            # your GProp email
npx wrangler secret put GPROP_PASSWORD            # your GProp password
npx wrangler secret put ALLOWED_CHAT_ID           # see step 5
```
(Optional) `ALLOWED_USER_IDS` if you later want to restrict to specific people.

### 4. Deploy
```
npx wrangler deploy
```
This publishes to `https://gprop-bot.potatoportal.dev`.

### 5. Get the group chat id
- Add the bot to your family group.
- In the group, send `/chatid` → the bot replies with the id (a negative
  number). Put it in the `ALLOWED_CHAT_ID` secret (step 3) and redeploy.

### 6. Register the webhook
```
TELEGRAM_BOT_TOKEN=<token> TELEGRAM_WEBHOOK_SECRET=<secret> \
WORKER_HOST=gprop-bot.potatoportal.dev node scripts/set-webhook.mjs
```

### 7. Try it
In the group: `/pass` → follow the buttons.

## Confirming the API fields

The exact GProp request field names are reconstructed from the app and may need a
small tweak on first run. Leave `DEBUG_API = "1"` in `wrangler.toml` to start —
the bot echoes each raw GProp response into the chat, so if login or create-pass
comes back wrong we can see the real field names and fix `src/gprop.js` in one
place. Set `DEBUG_API = "0"` once everything works.

Tail logs while testing: `npx wrangler tail`.

## Free-plan notes
- Workers free: 100k requests/day — far above family use.
- KV free: 1k writes/day — a pass uses a handful of writes. Fine.
- No always-on server; Telegram pushes updates to the webhook.

## Security
- Credentials live only in Wrangler **secrets**, never in git.
- The bot answers only inside your group.
- It makes one GProp call per step — no polling, no hammering.
