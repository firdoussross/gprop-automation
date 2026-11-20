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
};

// ---------- Telegram webhook ----------
let BOT_USERNAME = null;
const APP_URL = "https://gprop-bot.potatoportal.dev/app";

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
  const text = (msg.text || "").trim();
  const cmd = text.replace(/@\w+/, "");
  const isPrivate = chat.type === "private";

  if (/^\/chatid\b/.test(text)) {
    return bot.sendMessage(chat.id, `This chat id is <code>${chat.id}</code>`);
  }

  // Private chat: launch the mini-app form directly (web_app inline buttons are
  // only allowed in private chats). Open to anyone; membership is re-checked on
  // submit, so non-members can't actually create a pass.
  if (isPrivate) {
    if (/^\/(start|pass|visitor)\b/.test(cmd)) {
      return bot.sendMessage(chat.id,
        "🎟️ <b>GProp Visitor Pass</b>\nTap below to open the form. The finished pass posts to your family group.",
        { reply_markup: { inline_keyboard: [[{ text: "🎟️ Open pass form", web_app: { url: APP_URL } }]] } });
    }
    return;
  }

  // Group chat: only the family group is served.
  if (!isAllowedChat(chat, env)) return;
  if (/^\/(pass|visitor)\b/.test(cmd)) {
    const uname = await botUsername(bot);
    // web_app buttons can't be used in groups, so link to the bot's private
    // chat (deep link) where the form button is shown.
    const deepLink = uname ? `https://t.me/${uname}?start=pass` : APP_URL;
    return bot.sendMessage(chat.id,
      "🎟️ <b>GProp Visitor Pass</b>\nTap to create a pass — it opens a private form, and the finished pass posts back here.",
      { reply_markup: { inline_keyboard: [[{ text: "➕ Create visitor pass", url: deepLink }]] } });
  }
  if (/^\/help\b/.test(cmd)) {
    return bot.sendMessage(chat.id,
      "🎟️ <b>GProp Visitor Pass</b>\nSend /pass, then tap <b>Create visitor pass</b> — it opens a private form in your chat with me.\n" +
      "• <b>Social visitor</b> — name + vehicle\n• <b>Grab / Lalamove / Foodpanda</b> — just vehicle\n" +
      "• <b>Other delivery</b> — company + vehicle\nUnit is always RB-034B. Passes are valid for the day.");
  }
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

  // Only family-group members may create passes.
  try {
    const m = await bot.getChatMember(env.ALLOWED_CHAT_ID, user.id);
    const status = m?.result?.status;
    if (!["creator", "administrator", "member", "restricted"].includes(status)) {
      return json({ ok: false, error: "You need to be in the family group to create a pass." });
    }
  } catch (e) {
    console.log("getChatMember error:", e?.stack || e);
    return json({ ok: false, error: "Couldn't verify your group membership. Try again." });
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
      await bot.sendPhotoBytes(env.ALLOWED_CHAT_ID, png, `pass-${qr}.png`, { caption, parse_mode: "HTML" });
    } else {
      await bot.sendMessage(env.ALLOWED_CHAT_ID, caption + "\n(⚠️ created, but no QR found — check the GProp app.)");
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
  try { return JSON.parse(params.get("user") || "{}"); } catch { return null; }
}

// ---------- helpers ----------
function json(obj) { return new Response(JSON.stringify(obj), { headers: { "Content-Type": "application/json" } }); }
function escapeHtml(s) { return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
