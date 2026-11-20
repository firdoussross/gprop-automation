// Visitor-pass PNG renderer — fully self-contained for Cloudflare Workers.
// No wasm, no external services, no fonts on disk: a QR matrix (qrcode.js) and
// an 8x8 bitmap font are composited into an RGB buffer, then encoded as a PNG
// by hand (IDAT compressed with the runtime's CompressionStream). Output fits
// well within the Workers free-plan size budget.

import qrcode from "./qrcode.js";
import { FONT8X8 } from "./font8x8.js";

// ---- tiny RGB canvas -------------------------------------------------------
function canvas(w, h, bg = [255, 255, 255]) {
  const buf = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    buf[i * 3] = bg[0]; buf[i * 3 + 1] = bg[1]; buf[i * 3 + 2] = bg[2];
  }
  return { w, h, buf };
}
function px(c, x, y, rgb) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 3;
  c.buf[i] = rgb[0]; c.buf[i + 1] = rgb[1]; c.buf[i + 2] = rgb[2];
}
function rect(c, x, y, w, h, rgb) {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) px(c, xx, yy, rgb);
}

// ---- 8x8 bitmap text -------------------------------------------------------
// Each glyph: 8 bytes (rows), bit0 = leftmost pixel. Drawn at integer scale.
function glyph(c, ch, x, y, scale, rgb) {
  const code = ch.charCodeAt(0);
  if (code > 127) return;
  const base = code * 8;
  for (let row = 0; row < 8; row++) {
    const bits = FONT8X8[base + row];
    for (let col = 0; col < 8; col++) {
      if ((bits >> col) & 1) rect(c, x + col * scale, y + row * scale, scale, scale, rgb);
    }
  }
}
function textWidth(text, scale) { return text.length * 8 * scale; }
function drawText(c, x, y, text, scale, rgb) {
  let cx = x;
  for (const ch of text) { glyph(c, ch, cx, y, scale, rgb); cx += 8 * scale; }
}
function drawTextCentered(c, cx, y, text, scale, rgb) {
  drawText(c, Math.round(cx - textWidth(text, scale) / 2), y, text, scale, rgb);
}

// ---- QR --------------------------------------------------------------------
function drawQR(c, text, cx, top, targetPx, dark = [17, 24, 39]) {
  const qr = qrcode(0, "M"); // auto version, medium EC
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const total = n + quiet * 2;
  const mod = Math.max(4, Math.floor(targetPx / total));
  const size = total * mod;
  const x0 = Math.round(cx - size / 2);
  // white backing already present; draw a crisp white pad + dark modules
  rect(c, x0, top, size, size, [255, 255, 255]);
  for (let r = 0; r < n; r++)
    for (let col = 0; col < n; col++)
      if (qr.isDark(r, col))
        rect(c, x0 + (col + quiet) * mod, top + (r + quiet) * mod, mod, mod, dark);
  return { size, bottom: top + size };
}

// ---- PNG encoding (RGB, filter 0) -----------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function u32(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
function chunk(type, data) {
  const typeBytes = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0); body.set(data, typeBytes.length);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(u32(data.length), 0);
  out.set(body, 4);
  out.set(u32(crc32(body)), 4 + body.length);
  return out;
}
async function deflate(bytes) {
  const cs = new CompressionStream("deflate"); // zlib-wrapped, as PNG requires
  const writer = cs.writable.getWriter();
  writer.write(bytes); writer.close();
  const chunks = [];
  const reader = cs.readable.getReader();
  for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
  let len = 0; for (const ch of chunks) len += ch.length;
  const out = new Uint8Array(len); let o = 0;
  for (const ch of chunks) { out.set(ch, o); o += ch.length; }
  return out;
}
async function encodePNG(c) {
  const { w, h, buf } = c;
  const raw = new Uint8Array(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    raw.set(buf.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  }
  const idat = await deflate(raw);
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(w), 0); ihdr.set(u32(h), 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // color type: RGB
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  let len = 0; for (const p of parts) len += p.length;
  const out = new Uint8Array(len); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---- the pass layout -------------------------------------------------------
// data: { property, unit, name, category, type, validFrom, validTo, vehicle, qr }
export async function renderPassPNG(data) {
  const W = 720, H = 1180;
  const NAVY = [15, 32, 61];
  const TEAL = [13, 148, 136];
  const INK = [17, 24, 39];
  const GREY = [107, 114, 128];
  const LINE = [226, 232, 240];
  const c = canvas(W, H, [247, 249, 252]);

  // outer card
  rect(c, 24, 24, W - 48, H - 48, [255, 255, 255]);
  // header band
  rect(c, 24, 24, W - 48, 132, NAVY);
  rect(c, 24, 150, W - 48, 6, TEAL);
  drawTextCentered(c, W / 2, 52, "VISITOR PASS", 5, [255, 255, 255]);
  drawTextCentered(c, W / 2, 104, (data.property || "").toUpperCase().slice(0, 34), 2, [189, 211, 230]);

  // QR
  const qrTop = 196;
  const qr = drawQR(c, String(data.qr || ""), W / 2, qrTop, 440, INK);
  drawTextCentered(c, W / 2, qr.bottom + 16, String(data.qr || ""), 3, INK);

  // info rows
  let y = qr.bottom + 72;
  const rows = [
    ["UNIT", data.unit],
    ["NAME", data.name],
    ["PASS", [data.category, data.type].filter(Boolean).join(" / ")],
    ["VALID", data.validFrom === data.validTo ? data.validFrom : `${data.validFrom} - ${data.validTo}`],
    ["VEHICLE", data.vehicle || "-"],
  ];
  const lx = 60, vx = 240;
  const avail = W - 60 - vx;
  for (const [label, value] of rows) {
    drawText(c, lx, y + 2, label, 2, TEAL);
    // auto-fit the value: scale 3 if it fits, otherwise scale 2, then clip.
    let str = String(value ?? "-");
    let scale = 3;
    if (textWidth(str, scale) > avail) scale = 2;
    const maxChars = Math.floor(avail / (8 * scale));
    drawText(c, vx, scale === 3 ? y : y + 4, clip(str, maxChars), scale, INK);
    rect(c, lx, y + 40, W - 120, 2, LINE);
    y += 64;
  }

  // footer
  drawTextCentered(c, W / 2, H - 70, "Powered by GProp - auto-generated pass", 2, GREY);

  return encodePNG(c);
}

function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + "~" : s; }
