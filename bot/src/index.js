// GProp Visitor Pass — Telegram bot on Cloudflare Workers (WEB-app driven).
//
// Family members in one Telegram group create visitor/delivery passes; the bot
// logs in to the GProp website with Ross's credentials, creates the visitor,
// and posts back a generated visitor-pass PNG (with the scannable QR).
//
// Flow:  /pass -> Social or Delivery
//   Social   -> visitor name  + vehicle reg
//   Delivery -> company name   + vehicle reg
//   -> visit date (default today, confirm) -> pass PNG.
// Unit is always RB-034B. Only the configured group chat is served.

import { tg, keyboard } from "./telegram.js";
import * as gprop from "./gprop.js";
import { renderPassPNG } from "./pass.js";

const STEP = { NAME: "name", VEHICLE: "vehicle", CUSTOMEND: "customend" };
const STATE_TTL = 1800; // conversation state lives 30 min
const TZ_OFFSET_MIN = 8 * 60; // Malaysia UTC+8 for "today"

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "GET") return new Response("gprop-visitor-bot: ok", { status: 200 });
    if (request.method === "POST" && url.pathname === `/tg/${env.TELEGRAM_WEBHOOK_SECRET}`) {
      let update;
      try { update = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
      try { await handleUpdate(update, env); }
      catch (e) { console.log("handleUpdate error:", e?.stack || e); }
      return new Response("ok", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  },
};

// ---------- router ----------
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

  if (/^\/chatid\b/.test(text)) {
    return bot.sendMessage(chat.id, `This chat id is <code>${chat.id}</code>`);
  }
  if (!isAllowedChat(chat, env)) return; // silently ignore other chats

  const cmd = text.replace(/@\w+/, "");
  if (/^\/(pass|start|visitor)\b/.test(cmd)) return startPass(msg, env, bot);
  if (/^\/cancel\b/.test(cmd)) {
    await clearState(env, chat.id, msg.from.id);
    return bot.sendMessage(chat.id, "Cancelled. Send /pass to start again.");
  }
  if (/^\/help\b/.test(cmd)) {
    return bot.sendMessage(chat.id,
      "🎟️ <b>GProp Visitor Pass</b>\nSend /pass to create a pass.\n" +
      "• <b>Social visitor</b> — asks name + vehicle reg\n" +
      "• <b>Delivery</b> — asks company (Grab/Lalamove/etc) + vehicle reg\n" +
      "Unit is always RB-034B. /cancel to stop.");
  }

  // Reply to a force_reply prompt (name / company / vehicle / custom end date).
  if (msg.reply_to_message && text) {
    const st = await getState(env, chat.id, msg.from.id);
    if (st && (st.step === STEP.NAME || st.step === STEP.VEHICLE || st.step === STEP.CUSTOMEND)) {
      return onTextStep(msg, st, env, bot);
    }
  }
}

// ---------- flow ----------
async function startPass(msg, env, bot) {
  const chatId = msg.chat.id;
  await setState(env, chatId, msg.from.id, { step: "category", data: {} });
  return bot.sendMessage(chatId,
    "🎟️ <b>New visitor pass</b>\nWhat kind of pass?",
    keyboard([
      [{ text: "👤 Social visitor", data: "cat:social" }],
      [{ text: "📦 Delivery (Grab/Lalamove/…)", data: "cat:delivery" }],
    ]));
}

async function onCallback(cq, env, bot) {
  const chatId = cq.message.chat.id;
  if (!isAllowedChat(cq.message.chat, env)) return bot.answerCallbackQuery(cq.id);
  const st = await getState(env, chatId, cq.from.id);
  if (!st) { await bot.answerCallbackQuery(cq.id, { text: "Session expired — send /pass again." }); return; }

  const [kind, value] = (cq.data || "").split(":");
  await bot.answerCallbackQuery(cq.id);

  if (kind === "cat") {
    st.data.kind = value; // "social" | "delivery"
    st.step = STEP.NAME;
    await setState(env, chatId, cq.from.id, st);
    const prompt = value === "delivery"
      ? "📦 Reply with the <b>delivery company</b> (e.g. Grab, Lalamove, Shopee, J&amp;T):"
      : "👤 Reply with the <b>visitor's name</b>:";
    return bot.sendMessage(chatId, prompt, { reply_markup: { force_reply: true, selective: true } });
  }

  if (kind === "sdate") {
    st.data.startDate = value;
    await setState(env, chatId, cq.from.id, st);
    return promptEndDate(chatId, value, bot);
  }

  if (kind === "edate") {
    if (value === "custom") {
      st.step = STEP.CUSTOMEND;
      await setState(env, chatId, cq.from.id, st);
      return bot.sendMessage(chatId,
        "📅 Reply with the <b>end date</b> as <code>YYYY-MM-DD</code> (e.g. <code>2026-12-05</code>):",
        { reply_markup: { force_reply: true, selective: true } });
    }
    st.data.endDate = value;
    await setState(env, chatId, cq.from.id, st);
    return submitPass(chatId, cq.from.id, st, env, bot);
  }
}

async function onTextStep(msg, st, env, bot) {
  const chatId = msg.chat.id;
  const val = msg.text.trim();

  if (st.step === STEP.NAME) {
    st.data.name = val;
    st.step = STEP.VEHICLE;
    await setState(env, chatId, msg.from.id, st);
    return bot.sendMessage(chatId,
      "🚗 Reply with the <b>vehicle registration number</b> (or <code>-</code> if none):",
      { reply_markup: { force_reply: true, selective: true } });
  }

  if (st.step === STEP.VEHICLE) {
    st.data.vehicle = val === "-" ? "" : val.toUpperCase();
    await setState(env, chatId, msg.from.id, st);
    const dates = quickDates(4);
    return bot.sendMessage(chatId,
      "📅 <b>Visit date?</b> (defaults to today — tap to confirm)",
      keyboard(dates.map((d) => [{ text: d.label, data: `sdate:${d.value}` }])));
  }

  if (st.step === STEP.CUSTOMEND) {
    const end = val.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(end) || isNaN(Date.parse(end))) {
      return bot.sendMessage(chatId, "That doesn't look like a date. Reply as <code>YYYY-MM-DD</code>, e.g. <code>2026-12-05</code>.",
        { reply_markup: { force_reply: true, selective: true } });
    }
    if (end < st.data.startDate) {
      return bot.sendMessage(chatId, `End date can't be before the start date (${escapeHtml(st.data.startDate)}). Reply with a later date.`,
        { reply_markup: { force_reply: true, selective: true } });
    }
    st.data.endDate = end;
    await setState(env, chatId, msg.from.id, st);
    return submitPass(chatId, msg.from.id, st, env, bot);
  }
}

// Ask for the validity end date: default same day, plus 3-day / 7-day / custom.
function promptEndDate(chatId, startDate, bot) {
  const d3 = addDays(startDate, 2);  // 3 calendar days inclusive
  const d7 = addDays(startDate, 6);  // 7 calendar days inclusive
  return bot.sendMessage(chatId,
    "🗓️ <b>Valid until?</b> (defaults to same day)",
    keyboard([
      [{ text: `✅ Same day (${startDate})`, data: `edate:${startDate}` }],
      [{ text: `3 days (→ ${d3})`, data: `edate:${d3}` }],
      [{ text: `7 days (→ ${d7})`, data: `edate:${d7}` }],
      [{ text: "✏️ Custom date", data: "edate:custom" }],
    ]));
}

async function submitPass(chatId, userId, st, env, bot) {
  const d = st.data;
  await clearState(env, chatId, userId);
  await bot.sendMessage(chatId, "⏳ Creating the pass…");

  let auth;
  try { auth = await gprop.login(env); }
  catch (e) {
    console.log("login error:", e?.stack || e);
    return bot.sendMessage(chatId, "❌ Couldn't log in to GProp. Please try again shortly.");
  }

  const isDelivery = d.kind === "delivery";
  const categoryId = isDelivery ? gprop.CAT_DELIVERY : gprop.CAT_SOCIAL;
  const typeId = isDelivery ? gprop.deliveryTypeFor(d.name) : gprop.TYPE_SOCIAL_VEHICLE;
  const categoryLabel = isDelivery ? "Delivery Services" : "Social Visitor";

  const startDate = d.startDate;
  const endDate = d.endDate || d.startDate;
  const res = await gprop.createVisitor(auth, {
    categoryId, typeId, name: d.name, vehicle: d.vehicle,
    startDate, endDate,
  });
  if (!res.ok) {
    return bot.sendMessage(chatId, `❌ GProp did not accept the pass${res.msg ? ` (“${escapeHtml(res.msg)}”)` : ""}. Please try again.`);
  }

  // Pull the created row for the QR + confirmed pass data.
  let row = null;
  try { row = await gprop.getVisitorById(auth, res.insertID); }
  catch (e) { console.log("listing error:", e?.stack || e); }

  const qr = row?.fldVisitorQr || "";
  const typeName = row?.fldVisitorType || (isDelivery ? "Delivery" : "Vehicle");
  const passData = {
    property: gprop.PROPERTY_NAME,
    unit: row?.fldUnitNumber || "RB-034B",
    name: d.name,
    category: categoryLabel,
    type: typeName,
    validFrom: row?.fldStartDate || startDate,
    validTo: row?.fldEndDate || endDate,
    vehicle: d.vehicle || "-",
    date: row?.fldStartDate || startDate,
    qr,
  };
  const validity = passData.validFrom === passData.validTo
    ? passData.validFrom
    : `${passData.validFrom} → ${passData.validTo}`;

  const caption =
    `✅ <b>Visitor pass ready</b>\n` +
    `${isDelivery ? "Company" : "Name"}: ${escapeHtml(d.name)}\n` +
    (d.vehicle ? `Vehicle: ${escapeHtml(d.vehicle)}\n` : "") +
    `Valid: ${escapeHtml(validity)}\n` +
    `Unit: ${escapeHtml(passData.unit)}` +
    (qr ? `\nPass no: <code>${escapeHtml(qr)}</code>` : "");

  if (!qr) {
    // Created but QR not found — still confirm so the family isn't left hanging.
    return bot.sendMessage(chatId, caption + "\n(⚠️ Pass created, but I couldn't read the QR number — check the GProp app.)");
  }

  try {
    const png = await renderPassPNG(passData);
    return bot.sendPhotoBytes(chatId, png, `pass-${qr}.png`, { caption, parse_mode: "HTML" });
  } catch (e) {
    console.log("render error:", e?.stack || e);
    return bot.sendMessage(chatId, caption + "\n(Pass created; image render failed — the pass number above still works.)");
  }
}

// ---------- helpers ----------
function quickDates(n) {
  const out = [];
  const now = Date.now();
  for (let i = 0; i < n; i++) {
    const dt = new Date(now + (TZ_OFFSET_MIN * 60000) + i * 86400000);
    const value = dt.toISOString().slice(0, 10); // YYYY-MM-DD in UTC+8
    const label = i === 0 ? `✅ Today (${value})` : i === 1 ? `Tomorrow (${value})` : value;
    out.push({ label, value });
  }
  return out;
}

function addDays(yyyymmdd, days) {
  const dt = new Date(yyyymmdd + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// ---------- conversation state (KV) ----------
const stKey = (chatId, userId) => `conv:${chatId}:${userId}`;
async function getState(env, chatId, userId) { return env.STATE.get(stKey(chatId, userId), "json"); }
async function setState(env, chatId, userId, st) { return env.STATE.put(stKey(chatId, userId), JSON.stringify(st), { expirationTtl: STATE_TTL }); }
async function clearState(env, chatId, userId) { return env.STATE.delete(stKey(chatId, userId)); }
