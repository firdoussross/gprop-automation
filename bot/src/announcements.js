// GProp management announcements -> a Telegram forum topic.
//
// A Cloudflare Cron Trigger calls checkAnnouncements(). It logs in to GProp,
// reads the announcement listing, and posts every Published announcement whose
// id hasn't been seen before into ANNOUNCE_CHAT_ID (and ANNOUNCE_THREAD_ID, the
// topic). Seen ids live in KV, so each notice is posted once.
//
//   listing: GET /announcement/announcement_listing -> {aaData:[{fldAnnouncementId,
//            fldTitle, fldPublishedDate "dd/mm/yyyy", fldDescription (HTML),
//            fldStatus (badge HTML), fldName}]}, newest first, all rows.
//   details: GET /announcement_details/<id> -> HTML with attachment links
//            /upload/documents/announcement/... (publicly downloadable).

import * as gprop from "./gprop.js";

const SEEN_KEY = "ann:seen";
const MAX_SEEN = 500;
const BASE = "https://www.gpropsystems.com";

export async function checkAnnouncements(env, bot, { dryRun = false } = {}) {
  if (!env.ANNOUNCE_CHAT_ID) return { skipped: "ANNOUNCE_CHAT_ID not set" };
  const auth = await gprop.login(env);
  const rows = (await gprop.listAnnouncements(auth)).filter(isPublished);

  const raw = await env.STATE.get(SEEN_KEY);
  // First run: remember everything already published, post nothing (no flood).
  if (raw == null) {
    await env.STATE.put(SEEN_KEY, JSON.stringify(rows.map((r) => String(r.fldAnnouncementId))));
    return { seeded: rows.length };
  }
  const seen = new Set(JSON.parse(raw));
  const fresh = rows.filter((r) => !seen.has(String(r.fldAnnouncementId))).reverse(); // oldest first
  let posted = 0;
  for (const row of fresh) {
    if (!dryRun) await postAnnouncement(bot, auth, row, { chatId: env.ANNOUNCE_CHAT_ID, threadId: env.ANNOUNCE_THREAD_ID });
    seen.add(String(row.fldAnnouncementId));
    posted++;
  }
  if (posted) await env.STATE.put(SEEN_KEY, JSON.stringify([...seen].slice(-MAX_SEEN)));
  return { posted };
}

// Post the newest announcement on demand (/latestnotice) into the asking chat.
export async function postLatest(env, bot, dest) {
  const auth = await gprop.login(env);
  const row = (await gprop.listAnnouncements(auth)).filter(isPublished)[0];
  if (row) await postAnnouncement(bot, auth, row, dest);
  return row;
}

async function postAnnouncement(bot, auth, row, dest) {
  const chatId = dest.chatId;
  const target = dest.threadId ? { message_thread_id: Number(dest.threadId) } : {};
  const id = row.fldAnnouncementId;
  const link = `${BASE}/announcement_details/${id}`;
  const head = `📢 <b>${esc(clean(row.fldTitle))}</b>\n🗓 ${esc(row.fldPublishedDate || "")}\n\n`;
  const tail = `\n\n<a href="${link}">Open in GProp</a>`;
  let body = htmlToTelegram(row.fldDescription || "");
  const room = 4096 - head.length - tail.length - 10;
  if (body.length > room) body = truncateSafe(body, room) + "…";
  await bot.sendMessage(chatId, head + body + tail, { ...target, disable_web_page_preview: true });

  // Attachments (PDF / images) from the details page.
  let docs = [];
  try { docs = await gprop.announcementAttachments(auth, id); } catch (e) { console.log("attachments error:", e?.stack || e); }
  for (const d of docs.slice(0, 3)) {
    const r = await bot.call("sendDocument", { chat_id: chatId, document: d.url, caption: d.name.slice(0, 1000), ...target });
    if (!r?.ok) {
      console.log("sendDocument failed:", JSON.stringify(r));
      await bot.sendMessage(chatId, `📎 <a href="${d.url}">${esc(d.name)}</a>`, target);
    }
  }
}

function isPublished(r) { return /published/i.test(String(r.fldStatus || "")); }
function clean(s) { return String(s || "").replace(/\s+/g, " ").trim(); }
function esc(s) { return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function decode(s) {
  return s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
}

// GProp's summernote HTML -> the small HTML subset Telegram accepts.
export function htmlToTelegram(html) {
  const out = [];
  const stack = [];
  const MAP = { b: "b", strong: "b", i: "i", em: "i", u: "u" };
  let olCount = [];
  const re = /<\s*(\/?)\s*([a-z0-9]+)[^>]*>|([^<]+)/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[3] != null) { out.push(esc(decode(m[3]))); continue; }
    const close = !!m[1], tag = m[2].toLowerCase();
    if (MAP[tag]) {
      const t = MAP[tag];
      if (!close) { out.push(`<${t}>`); stack.push(t); }
      else { const i = stack.lastIndexOf(t); if (i >= 0) { for (let k = stack.length - 1; k >= i; k--) out.push(`</${stack[k]}>`); stack.splice(i); } }
    } else if (tag === "br") out.push("\n");
    else if (tag === "p" || tag === "div") { if (close) out.push("\n"); }
    else if (tag === "ol" && !close) olCount.push(0);
    else if (tag === "ol" && close) { olCount.pop(); out.push("\n"); }
    else if (tag === "ul" && close) out.push("\n");
    else if (tag === "li" && !close) {
      if (olCount.length) { olCount[olCount.length - 1]++; out.push(`\n${olCount[olCount.length - 1]}. `); }
      else out.push("\n• ");
    }
  }
  for (let k = stack.length - 1; k >= 0; k--) out.push(`</${stack[k]}>`);
  return out.join("").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Cut without leaving an open tag or half an entity.
function truncateSafe(s, n) {
  let t = s.slice(0, n).replace(/<[^>]*$/, "").replace(/&[a-z#0-9]*$/i, "");
  return t.replace(/<\/?[biu]>/g, ""); // drop formatting rather than risk unbalanced tags
}
