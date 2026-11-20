// GProp Visitor Pass — Telegram bot on Cloudflare Workers.
//
// Family members in one Telegram group create visitor/delivery passes; the bot
// talks to the GProp backend with Ross's credentials and posts the QR back.
//
// Flow:  /pass → pick type → pick unit → name → vehicle reg → date → QR.
// Allowlist: only the configured group chat (ALLOWED_CHAT_ID) is served.

import { tg, keyboard } from "./telegram.js";
import * as gprop from "./gprop.js";

const STEP = { TYPE: "type", UNIT: "unit", NAME: "name", VEHICLE: "vehicle", DATE: "date" };
const STATE_TTL = 1800;      // conversation state lives 30 min
const AUTH_TTL = 3000;       // cached GProp token ~50 min (tune once expiry known)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET") {
      return new Response("gprop-visitor-bot: ok", { status: 200 });
    }
    // Webhook path carries the secret: /tg/<TELEGRAM_WEBHOOK_SECRET>
    if (request.method === "POST" && url.pathname === `/tg/${env.TELEGRAM_WEBHOOK_SECRET}`) {
      let update;
      try { update = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
      // Ack Telegram immediately; process without blocking the response.
      try { await handleUpdate(update, env); }
      catch (e) { console.log("handleUpdate error:", e?.stack || e); }
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
};

// ---------- update router ----------
async function handleUpdate(update, env) {
  const bot = tg(env);
  if (update.callback_query) return onCallback(update.callback_query, env, bot);
  if (update.message) return onMessage(update.message, env, bot);
}

function isAllowedChat(chat, env) {
  return String(chat?.id) === String(env.ALLOWED_CHAT_ID);
}

async function onMessage(msg, env, bot) {
  const chat = msg.chat;
  const text = (msg.text || "").trim();

  // Setup helper: works anywhere so Ross can discover the group's chat id.
  if (/^\/chatid\b/.test(text)) {
    return bot.sendMessage(chat.id, `This chat id is <code>${chat.id}</code>`);
  }

  if (!isAllowedChat(chat, env)) return; // silently ignore other chats

  // Command to start a pass (strip any @botname suffix).
  if (/^\/(pass|start|visitor)\b/.test(text.replace(/@\w+/, ""))) {
    return startPass(msg, env, bot);
  }
  if (/^\/cancel\b/.test(text)) {
    await clearState(env, chat.id, msg.from.id);
    return bot.sendMessage(chat.id, "Cancelled.");
  }

  // A reply that answers one of our force_reply prompts (name / vehicle).
  if (msg.reply_to_message && text) {
    const st = await getState(env, chat.id, msg.from.id);
    if (st && (st.step === STEP.NAME || st.step === STEP.VEHICLE)) {
      return onTextStep(msg, st, env, bot);
    }
  }
}

// ---------- flow ----------
async function startPass(msg, env, bot) {
  const chatId = msg.chat.id;
  const auth = await ensureAuth(env, bot, chatId);
  if (!auth) return;

  const r = await gprop.getVisitorTypes(env, auth);
  await maybeDebug(env, bot, chatId, "get_visitor_type", r);
  const types = extractList(r).map((t) => ({
    text: t.name || t.visitor_type || t.type_name || String(t.id),
    id: t.id ?? t.visitor_type_id ?? t.type_id,
  })).filter((t) => t.id != null);

  if (!types.length) {
    return bot.sendMessage(chatId, "Couldn't load visitor types from GProp. (Check the debug output above.)");
  }

  await setState(env, chatId, msg.from.id, { step: STEP.TYPE, data: {} });
  return bot.sendMessage(chatId, "🎟️ <b>New visitor pass</b>\nChoose the visitor type:",
    keyboard(types.map((t) => [{ text: t.text, data: `type:${t.id}` }])));
}

async function onCallback(cq, env, bot) {
  const chatId = cq.message.chat.id;
  if (!isAllowedChat(cq.message.chat, env)) return bot.answerCallbackQuery(cq.id);
  const st = await getState(env, chatId, cq.from.id);
  if (!st) { await bot.answerCallbackQuery(cq.id, { text: "Session expired, send /pass again." }); return; }

  const [kind, value] = (cq.data || "").split(":");
  await bot.answerCallbackQuery(cq.id);

  if (kind === "type") {
    st.data.typeId = value;
    // Next: unit. Auto-pick if the account has only one.
    const auth = await ensureAuth(env, bot, chatId);
    if (!auth) return;
    const r = await gprop.getUnitListing(env, auth);
    await maybeDebug(env, bot, chatId, "getUnitListing", r);
    const units = extractList(r).map((u) => ({
      text: u.unit_no || u.unit_number || u.name || String(u.id),
      id: u.id ?? u.unit_id,
    })).filter((u) => u.id != null);

    if (units.length === 1) {
      st.data.unitId = units[0].id;
      st.step = STEP.NAME;
      await setState(env, chatId, cq.from.id, st);
      return promptName(chatId, bot);
    }
    st.step = STEP.UNIT;
    await setState(env, chatId, cq.from.id, st);
    return bot.sendMessage(chatId, "Choose the unit:",
      keyboard(units.map((u) => [{ text: u.text, data: `unit:${u.id}` }])));
  }

  if (kind === "unit") {
    st.data.unitId = value;
    st.step = STEP.NAME;
    await setState(env, chatId, cq.from.id, st);
    return promptName(chatId, bot);
  }

  if (kind === "date") {
    st.data.visitDate = value;
    await setState(env, chatId, cq.from.id, st);
    return submitPass(chatId, cq.from.id, st, env, bot);
  }
}

function promptName(chatId, bot) {
  return bot.sendMessage(chatId, "👤 Reply with the <b>visitor's name</b>:",
    { reply_markup: { force_reply: true, selective: true } });
}

async function onTextStep(msg, st, env, bot) {
  const chatId = msg.chat.id;
  const val = msg.text.trim();

  if (st.step === STEP.NAME) {
    st.data.name = val;
    st.step = STEP.VEHICLE;
    await setState(env, chatId, msg.from.id, st);
    return bot.sendMessage(chatId, "🚗 Reply with the <b>vehicle registration number</b> (or type <code>-</code> if none):",
      { reply_markup: { force_reply: true, selective: true } });
  }

  if (st.step === STEP.VEHICLE) {
    st.data.carPlate = val === "-" ? "" : val;
    st.step = STEP.DATE;
    await setState(env, chatId, msg.from.id, st);
    // Offer a few quick dates (today + next 3 days). Refine against valid-range API.
    const dates = quickDates(4);
    return bot.sendMessage(chatId, "📅 Choose the <b>visit date</b>:",
      keyboard(dates.map((d) => [{ text: d.label, data: `date:${d.value}` }])));
  }
}

async function submitPass(chatId, userId, st, env, bot) {
  const auth = await ensureAuth(env, bot, chatId);
  if (!auth) return;
  const d = st.data;
  await bot.sendMessage(chatId, "⏳ Creating the pass…");

  const r = await gprop.addVisitor(env, auth, {
    name: d.name, typeId: d.typeId, carPlate: d.carPlate,
    visitDate: d.visitDate, unitId: d.unitId,
  });
  await maybeDebug(env, bot, chatId, "addNewVisitor", r);
  await clearState(env, chatId, userId);

  if (!r.ok) {
    return bot.sendMessage(chatId, `❌ GProp rejected the request (HTTP ${r.status}). See debug above; I'll adjust the fields.`);
  }

  // Find the new visitor id, then fetch the pass/QR.
  const dd = r.json?.data ?? r.json ?? {};
  const visitorId = dd.visitor_id || dd.id || dd.visitorId;
  let detail = null;
  if (visitorId) {
    detail = await gprop.getVisitorDetails(env, auth, visitorId);
    await maybeDebug(env, bot, chatId, "getVisitorDetails", detail);
  }
  return deliverPass(chatId, d, detail, bot, env);
}

async function deliverPass(chatId, d, detail, bot, env) {
  const dd = detail?.json?.data ?? detail?.json ?? {};
  const qrImage = dd.qr_image || dd.qrImage || dd.qr_url;
  const qrText = dd.qr_code || dd.qr_text || dd.qrcode || dd.pass_code;

  const caption =
    `✅ <b>Visitor pass created</b>\n` +
    `Name: ${escapeHtml(d.name)}\n` +
    (d.carPlate ? `Vehicle: ${escapeHtml(d.carPlate)}\n` : "") +
    (d.visitDate ? `Date: ${escapeHtml(d.visitDate)}\n` : "");

  if (qrImage && /^https?:\/\//.test(qrImage)) {
    return bot.sendPhoto(chatId, qrImage, { caption, parse_mode: "HTML" });
  }
  if (qrText) {
    return bot.sendMessage(chatId, caption + `\nPass code: <code>${escapeHtml(qrText)}</code>`);
  }
  return bot.sendMessage(chatId, caption + `\n(Pass created, but I couldn't find the QR in the response — see debug.)`);
}

// ---------- auth cache ----------
async function ensureAuth(env, bot, chatId) {
  try {
    const cached = await env.STATE.get("gprop_auth", "json");
    if (cached?.token) return cached;
    const { token, userId, raw } = await gprop.login(env);
    if (!token) {
      await maybeDebug(env, bot, chatId, "login", raw);
      await bot.sendMessage(chatId, "❌ Couldn't log in to GProp (no token in response). See debug — likely a field-name tweak.");
      return null;
    }
    const auth = { token, userId };
    await env.STATE.put("gprop_auth", JSON.stringify(auth), { expirationTtl: AUTH_TTL });
    return auth;
  } catch (e) {
    console.log("auth error:", e?.stack || e);
    await bot.sendMessage(chatId, "❌ GProp login failed (network/error). Try again in a moment.");
    return null;
  }
}

// ---------- helpers ----------
function extractList(r) {
  const j = r?.json;
  if (!j) return [];
  if (Array.isArray(j)) return j;
  if (Array.isArray(j.data)) return j.data;
  if (Array.isArray(j.result)) return j.result;
  if (Array.isArray(j.data?.list)) return j.data.list;
  return [];
}

function quickDates(n) {
  const out = [];
  const today = new Date();
  for (let i = 0; i < n; i++) {
    const dt = new Date(today.getTime() + i * 86400000);
    const value = dt.toISOString().slice(0, 10); // YYYY-MM-DD; adjust to API format
    const label = i === 0 ? `Today (${value})` : i === 1 ? `Tomorrow (${value})` : value;
    out.push({ label, value });
  }
  return out;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

async function maybeDebug(env, bot, chatId, label, r) {
  if (env.DEBUG_API !== "1") return;
  const body = r?.text ? r.text.slice(0, 900) : JSON.stringify(r?.json || r).slice(0, 900);
  await bot.sendMessage(chatId, `🐛 <b>${label}</b> (HTTP ${r?.status ?? "?"}):\n<pre>${escapeHtml(body)}</pre>`);
}

// ---------- conversation state (KV) ----------
const stKey = (chatId, userId) => `conv:${chatId}:${userId}`;
async function getState(env, chatId, userId) {
  return env.STATE.get(stKey(chatId, userId), "json");
}
async function setState(env, chatId, userId, st) {
  return env.STATE.put(stKey(chatId, userId), JSON.stringify(st), { expirationTtl: STATE_TTL });
}
async function clearState(env, chatId, userId) {
  return env.STATE.delete(stKey(chatId, userId));
}
