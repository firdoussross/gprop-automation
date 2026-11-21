// GProp Visitor Pass — Telegram bot + mini-app on Cloudflare Workers.
//
// A family member taps "Create visitor pass" in the group, which opens a PRIVATE
// Telegram mini-app form (/app). They pick the type (Social visitor / Grab /
// Lalamove / Foodpanda / Other delivery), fill name/company + vehicle, confirm
// the visit date, and submit. The form POSTs to /app/submit with Telegram
// initData; the Worker verifies the signature + group membership, logs in to
// GProp, creates the visitor (unit RB-034B, single-day per GProp's rule), and
// posts the generated visitor-pass PNG to the family group.

import { tg } from "./telegram.js";
import * as gprop from "./gprop.js";
import { renderPassPNG } from "./pass.js";
import { WEBAPP_HTML } from "./webapp.js";
import { checkAnnouncements, postLatest } from "./announcements.js";

const APP_PATH = "/app";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Mini-app form
    if (url.pathname === APP_PATH && request.method === "GET") {
      return new Response(WEBAPP_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    // Mini-app submit
    if (url.pathname === "/app/submit" && request.method === "POST") {
      return onAppSubmit(request, env);
    }
    // Telegram webhook
    if (request.method === "POST" && url.pathname === `/tg/${env.TELEGRAM_WEBHOOK_SECRET}`) {
      let update;
      try { update = await request.json(); } catch { return new Response("bad json", { status: 400 }); }
      try { await handleUpdate(update, env); }
      catch (e) { console.log("handleUpdate error:", e?.stack || e); }
      return new Response("ok", { status: 200 });
    }
    if (request.method === "GET") return new Response("gprop-visitor-bot: ok", { status: 200 });
    return new Response("not found", { status: 404 });
  },

  // Cron Trigger: forward new GProp management announcements to the topic.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkAnnouncements(env, tg(env))
      .then((r) => console.log("announcements:", JSON.stringify(r)))
      .catch((e) => console.log("announcements error:", e?.stack || e)));
  },
};

// ---------- Telegram webhook ----------
let BOT_USERNAME = null;
const APP_URL = "https://gprop-bot.potatoportal.dev/app";
// Short name of the BotFather direct-link Mini App (/newapp). The group button
// opens it in one tap; falls back to the deep link if not yet registered.
const APP_SHORTNAME = "pass";

async function botUsername(bot) {
  if (BOT_USERNAME) return BOT_USERNAME;
  try { const me = await bot.getMe(); BOT_USERNAME = me?.result?.username || null; } catch { /* ignore */ }
  return BOT_USERNAME;
}

async function handleUpdate(update, env) {
  const bot = tg(env);
  const msg = update.message;
  if (!msg) return;
  const chat = msg.chat;
  let text = (msg.text || "").trim();
  // "@cimponi_bot pass" -> "/pass" (mention-style commands).
  const mm = /^@(\w+)\s+\/?([a-z]+)\b/i.exec(text);
  if (mm) {
    const uname = await botUsername(bot);
    if (uname && mm[1].toLowerCase() === uname.toLowerCase()) text = `/${mm[2].toLowerCase()}`;
  }
  const cmd = text.replace(/@\w+/, "");
  const isPrivate = chat.type === "private";
  if (text.startsWith("/")) console.log(`cmd chat=${chat.id} thread=${msg.message_thread_id || ""} ${text.split(/\s/)[0]}`);
  try { await ensureCommands(env, bot); } catch (e) { console.log("setMyCommands error:", e?.stack || e); }

  if (/^\/chatid\b/.test(cmd)) {
    const topic = msg.is_topic_message && msg.message_thread_id ? `\nTopic id: <code>${msg.message_thread_id}</code>` : "";
    return bot.sendMessage(chat.id, `This chat id is <code>${chat.id}</code>${topic}`,
      msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {});
  }

  // Private chat: show the mini-app form button — but only to family-group
  // members, so random people who find the bot can't invoke it.
  if (isPrivate) {
    if (/^\/(start|pass|visitor)\b/.test(cmd)) {
      const dest = passDest(env, (cmd.split(/\s+/)[1] || "").trim());
      if (!(await isMemberOf(bot, dest.chatId, msg.from.id))) {
        return bot.sendMessage(chat.id, "Sorry — this bot is only for the designated resident group. You don't have access.");
      }
      const url = dest.key ? `${APP_URL}?dest=${dest.key}` : APP_URL;
      return bot.sendMessage(chat.id,
        "🎟️ <b>GProp Visitor Pass</b>\nTap below to open the form. The finished pass posts to your family group.",
        { reply_markup: { inline_keyboard: [[{ text: "🎟️ Open pass form", web_app: { url } }]] } });
    }
    return;
  }

  // Announcements group: /latestnotice re-posts the newest notice (for testing).
  if (env.ANNOUNCE_CHAT_ID && String(chat.id) === String(env.ANNOUNCE_CHAT_ID)) {
    const inThread = msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {};
    if (/^\/(pass|visitor)\b/.test(cmd)) return passButtonMessage(bot, chat.id, await botUsername(bot), "t", inThread);
    if (/^\/help\b/.test(cmd)) return bot.sendMessage(chat.id, helpText(true), inThread);
    if (/^\/latestnotice\b/.test(cmd)) return latestNotice(env, bot, chat.id, msg.message_thread_id);
    return;
  }

  // Group chat: only the designated family group is served; others are ignored.
  if (!isAllowedChat(chat, env)) return;
  if (/^\/(pass|visitor)\b/.test(cmd)) return passButtonMessage(bot, chat.id, await botUsername(bot), "");
  if (/^\/help\b/.test(cmd)) return bot.sendMessage(chat.id, helpText(false));
  if (/^\/latestnotice\b/.test(cmd)) return latestNotice(env, bot, chat.id, msg.message_thread_id);
}

// Where a finished pass is posted. "t" = the announcements topic group.
function passDest(env, key) {
  if (key === "t" && env.ANNOUNCE_CHAT_ID) {
    return { key: "t", chatId: env.ANNOUNCE_CHAT_ID, threadId: env.ANNOUNCE_THREAD_ID ? Number(env.ANNOUNCE_THREAD_ID) : undefined };
  }
  return { key: "", chatId: env.ALLOWED_CHAT_ID, threadId: undefined };
}

async function isMemberOf(bot, chatId, userId) {
  try {
    const m = await bot.getChatMember(chatId, userId);
    return ["creator", "administrator", "member", "restricted"].includes(m?.result?.status);
  } catch (e) { console.log("getChatMember error:", e?.stack || e); return false; }
}

function passButtonMessage(bot, chatId, uname, destKey, extra = {}) {
  const q = destKey ? `?startapp=${destKey}` : "";
  const launch = uname ? `https://t.me/${uname}/${APP_SHORTNAME}${q}` : (destKey ? `${APP_URL}?dest=${destKey}` : APP_URL);
  return bot.sendMessage(chatId,
    "🎟️ <b>GProp Visitor Pass</b>\nTap to create a pass — opens a private form; the finished pass posts back here.",
    { reply_markup: { inline_keyboard: [[{ text: "➕ Create visitor pass", url: launch }]] }, ...extra });
}

async function latestNotice(env, bot, chatId, threadId) {
  try {
    const row = await postLatest(env, bot, { chatId, threadId });
    if (!row) await bot.sendMessage(chatId, "No announcements found.", threadId ? { message_thread_id: threadId } : {});
  } catch (e) { console.log("latestnotice error:", e?.stack || e); }
}

function helpText(isAnnounceGroup) {
  return "🤖 <b>What I can do</b>\n\n" +
    "/pass — create a GProp visitor pass (opens a private form; the pass posts back here)\n" +
    "   • <b>Social visitor</b> — name + vehicle\n" +
    "   • <b>Grab / Lalamove / Foodpanda</b> — just vehicle\n" +
    "   • <b>Other delivery</b> — company + vehicle\n" +
    "   Unit is always RB-034B; passes are valid for the chosen day.\n" +
    "/latestnotice — post the newest GProp management announcement\n" +
    (isAnnounceGroup ? "📢 New GProp announcements are posted to the announcements topic automatically (checked every 30 min).\n" : "") +
    "/help — this message\n\n" +
    "Only members of this group can create passes.";
}

// Register the "/" command menu once (re-run by bumping the version).
const COMMANDS_VERSION = "v3";
async function ensureCommands(env, bot) {
  if ((await env.STATE.get("cmds")) === COMMANDS_VERSION) return;
  const commands = [
    { command: "pass", description: "Create a GProp visitor pass" },
    { command: "latestnotice", description: "Post the newest GProp announcement" },
    { command: "help", description: "What this bot can do" },
  ];
  await bot.call("setMyCommands", { commands, scope: { type: "all_group_chats" } });
  if (env.ANNOUNCE_CHAT_ID) {
    await bot.call("setMyCommands", { commands, scope: { type: "chat", chat_id: Number(env.ANNOUNCE_CHAT_ID) } });
  }
  await env.STATE.put("cmds", COMMANDS_VERSION);
}

function isAllowedChat(chat, env) {
  return String(chat?.id) === String(env.ALLOWED_CHAT_ID);
}

// ---------- mini-app submit ----------
async function onAppSubmit(request, env) {
  const bot = tg(env);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad request" }); }

  // Verify the Telegram Web App signature.
  const user = await verifyInitData(body.initData || "", env.TELEGRAM_BOT_TOKEN);
  if (!user) return json({ ok: false, error: "Couldn't verify Telegram sign-in. Open the form from the group button." });

  // Destination: the signed start_param (direct-link launch) or the form's
  // dest field. Either way the user must be a member of that group.
  const dest = passDest(env, user._startParam || String(body.dest || ""));
  if (!(await isMemberOf(bot, dest.chatId, user.id))) {
    return json({ ok: false, error: "You need to be in the family group to create a pass." });
  }

  // Map the chosen kind to GProp category/type + the name shown on the pass.
  const kind = String(body.kind || "");
  const vehicle = String(body.vehicle || "").trim().toUpperCase();
  const date = String(body.date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, error: "Invalid date." });

  let categoryId, typeId, passName, categoryLabel;
  if (kind === "social") {
    const name = String(body.name || "").trim();
    if (!name) return json({ ok: false, error: "Visitor name is required." });
    categoryId = gprop.CAT_SOCIAL; typeId = gprop.TYPE_SOCIAL_VEHICLE; passName = name; categoryLabel = "Social Visitor";
  } else {
    // delivery: presets (grab/lalamove/foodpanda) or "other" (company typed)
    const PRESET = { grab: "Grab", lalamove: "Lalamove", foodpanda: "Foodpanda" };
    let company;
    if (PRESET[kind]) company = PRESET[kind];
    else if (kind === "other") { company = String(body.name || "").trim(); if (!company) return json({ ok: false, error: "Delivery company is required." }); }
    else return json({ ok: false, error: "Unknown pass type." });
    categoryId = gprop.CAT_DELIVERY; typeId = gprop.deliveryTypeFor(company); passName = company; categoryLabel = "Delivery Services";
  }

  // Log in + create (single-day: end = start).
  let auth;
  try { auth = await gprop.login(env); }
  catch (e) { console.log("login error:", e?.stack || e); return json({ ok: false, error: "Couldn't log in to GProp. Try again shortly." }); }

  const res = await gprop.createVisitor(auth, { categoryId, typeId, name: passName, vehicle, startDate: date, endDate: date });
  if (!res.ok) return json({ ok: false, error: `GProp rejected the pass${res.msg ? ` (“${res.msg}”)` : ""}.` });

  let row = null;
  try { row = await gprop.getVisitorById(auth, res.insertID); } catch (e) { console.log("listing error:", e?.stack || e); }
  const qr = row?.fldVisitorQr || "";

  const passData = {
    property: gprop.PROPERTY_NAME,
    unit: row?.fldUnitNumber || "RB-034B",
    name: passName,
    date: row?.fldStartDate || date,
    validFrom: row?.fldStartDate || date,
    validTo: row?.fldEndDate || date,
    vehicle: vehicle || "-",
    qr,
  };

  const who = user.first_name ? ` (by ${escapeHtml(user.first_name)})` : "";
  const caption =
    `🎟️ <b>Visitor pass</b>${who}\n` +
    `${kind === "social" ? "Name" : "Company"}: ${escapeHtml(passName)}\n` +
    (vehicle ? `Vehicle: ${escapeHtml(vehicle)}\n` : "") +
    `Date: ${escapeHtml(passData.date)} · Unit: ${escapeHtml(passData.unit)}` +
    (qr ? `\nPass no: <code>${escapeHtml(qr)}</code>` : "");

  // Post the pass to the family group.
  try {
    if (qr) {
      const png = await renderPassPNG(passData);
      await bot.sendPhotoBytes(dest.chatId, png, `pass-${qr}.png`, { caption, parse_mode: "HTML", ...(dest.threadId ? { message_thread_id: String(dest.threadId) } : {}) });
    } else {
      await bot.sendMessage(dest.chatId, caption + "\n(⚠️ created, but no QR found — check the GProp app.)", dest.threadId ? { message_thread_id: dest.threadId } : {});
    }
  } catch (e) {
    console.log("deliver error:", e?.stack || e);
    return json({ ok: true, qr, warn: "created but couldn't post to group" });
  }
  return json({ ok: true, qr });
}

// ---------- Telegram Web App initData verification ----------
async function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const pairs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort();
  const dcs = pairs.join("\n");
  const enc = new TextEncoder();
  // secret_key = HMAC_SHA256(key="WebAppData", data=bot_token)
  const kWeb = await crypto.subtle.importKey("raw", enc.encode("WebAppData"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const secret = await crypto.subtle.sign("HMAC", kWeb, enc.encode(botToken));
  const kSecret = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", kSecret, enc.encode(dcs));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex !== hash) return null;
  // freshness (24h)
  const authDate = Number(params.get("auth_date") || 0);
  if (authDate && Date.now() / 1000 - authDate > 86400) return null;
  try { const u = JSON.parse(params.get("user") || "{}"); u._startParam = params.get("start_param") || ""; return u; } catch { return null; }
}

// ---------- helpers ----------
function json(obj) { return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } }); }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
