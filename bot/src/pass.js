// Visitor-pass PNG renderer — mirrors the GProp app's Visitor Pass.
// Self-contained for Cloudflare Workers: real Poppins text (opentype.js + a
// subset font, anti-aliased), the actual GProp logo, a QR of fldVisitorQr, all
// composited into an RGB buffer and hand-encoded as a PNG via CompressionStream.
// No wasm, no browser, no external services.

import qrcode from "./qrcode.js";
import opentype from "./opentype.js";
import { POPPINS_REGULAR_B64, POPPINS_BOLD_B64 } from "./fonts.js";
import { LOGO_W, LOGO_H, LOGO_RGBA_B64 } from "./logo.js";

// ---- palette (sampled from the app) ----------------------------------------
const ORANGE = [243, 179, 67];   // header + logo  #F3B343
const INK = [29, 27, 32];        // near-black text
const GREY = [96, 99, 105];      // body / secondary text
const VALUE = [74, 78, 84];      // label values
const LINE = [230, 230, 234];    // dividers
const PAGE = [243, 244, 246];    // page background
const CARDBORDER = [230, 231, 234];

// ---- base64 -> Uint8Array --------------------------------------------------
function b64(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}

// ---- fonts (parsed once) ---------------------------------------------------
let FONTS = null;
function fonts() {
  if (!FONTS) {
    FONTS = {
      regular: opentype.parse(b64(POPPINS_REGULAR_B64).buffer),
      bold: opentype.parse(b64(POPPINS_BOLD_B64).buffer),
    };
  }
  return FONTS;
}

// ---- logo (decoded once) ---------------------------------------------------
let LOGO = null;
function logo() {
  if (!LOGO) LOGO = { w: LOGO_W, h: LOGO_H, rgba: b64(LOGO_RGBA_B64) };
  return LOGO;
}

// ---- canvas ----------------------------------------------------------------
function canvas(w, h, bg) {
  const buf = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { buf[i * 3] = bg[0]; buf[i * 3 + 1] = bg[1]; buf[i * 3 + 2] = bg[2]; }
  return { w, h, buf };
}
function blend(c, x, y, rgb, a) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return;
  const i = (y * c.w + x) * 3;
  if (a >= 1) { c.buf[i] = rgb[0]; c.buf[i + 1] = rgb[1]; c.buf[i + 2] = rgb[2]; return; }
  c.buf[i] = rgb[0] * a + c.buf[i] * (1 - a);
  c.buf[i + 1] = rgb[1] * a + c.buf[i + 1] * (1 - a);
  c.buf[i + 2] = rgb[2] * a + c.buf[i + 2] * (1 - a);
}
function fillRect(c, x, y, w, h, rgb) {
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(c.w, Math.round(x + w)), y1 = Math.min(c.h, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) blend(c, xx, yy, rgb, 1);
}
// rounded rectangle (anti-aliased corners)
function roundRect(c, x, y, w, h, r, rgb) {
  const x1 = x + w, y1 = y + h;
  const X0 = Math.max(0, Math.floor(x)), Y0 = Math.max(0, Math.floor(y));
  const X1 = Math.min(c.w, Math.ceil(x1)), Y1 = Math.min(c.h, Math.ceil(y1));
  for (let py = Y0; py < Y1; py++) {
    for (let px = X0; px < X1; px++) {
      // supersample 2x2 for edge AA
      let cov = 0;
      for (let sy = 0; sy < 2; sy++) for (let sx = 0; sx < 2; sx++) {
        const fx = px + 0.25 + sx * 0.5, fy = py + 0.25 + sy * 0.5;
        if (fx < x || fx > x1 || fy < y || fy > y1) continue;
        let inside = true;
        // corner checks
        const cxs = [[x + r, y + r], [x1 - r, y + r], [x + r, y1 - r], [x1 - r, y1 - r]];
        const cond = [fx < x + r && fy < y + r, fx > x1 - r && fy < y + r, fx < x + r && fy > y1 - r, fx > x1 - r && fy > y1 - r];
        for (let k = 0; k < 4; k++) if (cond[k]) { const dx = fx - cxs[k][0], dy = fy - cxs[k][1]; if (dx * dx + dy * dy > r * r) inside = false; }
        if (inside) cov++;
      }
      if (cov) blend(c, px, py, rgb, cov / 4);
    }
  }
}

// ---- bezier flattening -----------------------------------------------------
function flattenQ(pts, x0, y0, cx, cy, x1, y1) {
  const N = 10;
  for (let i = 1; i <= N; i++) { const t = i / N, u = 1 - t; const x = u * u * x0 + 2 * u * t * cx + t * t * x1; const y = u * u * y0 + 2 * u * t * cy + t * t * y1; pts.push([x, y]); }
}
function flattenC(pts, x0, y0, c1x, c1y, c2x, c2y, x1, y1) {
  const N = 12;
  for (let i = 1; i <= N; i++) { const t = i / N, u = 1 - t; const x = u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x1; const y = u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y1; pts.push([x, y]); }
}
function commandsToContours(cmds) {
  const contours = []; let cur = null, sx = 0, sy = 0, px = 0, py = 0;
  for (const cmd of cmds) {
    if (cmd.type === "M") { if (cur && cur.length) contours.push(cur); cur = [[cmd.x, cmd.y]]; sx = px = cmd.x; sy = py = cmd.y; }
    else if (cmd.type === "L") { cur.push([cmd.x, cmd.y]); px = cmd.x; py = cmd.y; }
    else if (cmd.type === "Q") { flattenQ(cur, px, py, cmd.x1, cmd.y1, cmd.x, cmd.y); px = cmd.x; py = cmd.y; }
    else if (cmd.type === "C") { flattenC(cur, px, py, cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); px = cmd.x; py = cmd.y; }
    else if (cmd.type === "Z") { if (cur) { cur.push([sx, sy]); contours.push(cur); cur = null; } }
  }
  if (cur && cur.length) contours.push(cur);
  return contours;
}

// ---- text (anti-aliased non-zero scanline fill of a whole run) -------------
const S = 4; // supersampling factor for text AA
function measure(font, text, size) { return font.getAdvanceWidth(text, size); }
function drawText(c, font, text, x, baseY, size, color, align = "left") {
  if (!text) return;
  let ox = x;
  if (align === "center") ox = x - measure(font, text, size) / 2;
  else if (align === "right") ox = x - measure(font, text, size);
  const path = font.getPath(text, ox, baseY, size);
  const contours = commandsToContours(path.commands);
  if (!contours.length) return;
  // bbox
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ct of contours) for (const [px, py] of ct) { if (px < minX) minX = px; if (px > maxX) maxX = px; if (py < minY) minY = py; if (py > maxY) maxY = py; }
  const gx0 = Math.max(0, Math.floor(minX)), gy0 = Math.max(0, Math.floor(minY));
  const gx1 = Math.min(c.w, Math.ceil(maxX)), gy1 = Math.min(c.h, Math.ceil(maxY));
  const gw = gx1 - gx0, gh = gy1 - gy0;
  if (gw <= 0 || gh <= 0) return;
  const SW = gw * S, SH = gh * S;
  const cov = new Uint8Array(SW * SH);
  // edges in subpixel space relative to (gx0,gy0)
  const edges = [];
  for (const ct of contours) {
    for (let i = 0; i + 1 < ct.length; i++) {
      let ax = (ct[i][0] - gx0) * S, ay = (ct[i][1] - gy0) * S;
      let bx = (ct[i + 1][0] - gx0) * S, by = (ct[i + 1][1] - gy0) * S;
      if (ay === by) continue;
      edges.push([ax, ay, bx, by]);
    }
  }
  const xs = [];
  for (let sy = 0; sy < SH; sy++) {
    const yc = sy + 0.5;
    xs.length = 0;
    for (const e of edges) {
      const ay = e[1], by = e[3];
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
        const t = (yc - ay) / (by - ay);
        xs.push([e[0] + t * (e[2] - e[0]), by > ay ? 1 : -1]);
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a[0] - b[0]);
    let wind = 0;
    for (let k = 0; k + 1 < xs.length; k++) {
      wind += xs[k][1];
      if (wind !== 0) {
        let xa = Math.max(0, Math.round(xs[k][0])), xb = Math.min(SW, Math.round(xs[k + 1][0]));
        for (let sx = xa; sx < xb; sx++) cov[sy * SW + sx] = 1;
      }
    }
  }
  // downsample + composite
  const inv = 1 / (S * S);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      let s = 0;
      const by = j * S, bx = i * S;
      for (let dy = 0; dy < S; dy++) { const row = (by + dy) * SW + bx; for (let dx = 0; dx < S; dx++) s += cov[row + dx]; }
      if (s) blend(c, gx0 + i, gy0 + j, color, s * inv);
    }
  }
}
// word-wrap a string to maxWidth, returning lines
function wrap(font, text, size, maxWidth) {
  const words = text.split(" "); const lines = []; let cur = "";
  for (const w of words) {
    const t = cur ? cur + " " + w : w;
    if (measure(font, t, size) > maxWidth && cur) { lines.push(cur); cur = w; }
    else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---- QR (crisp) ------------------------------------------------------------
function drawQR(c, text, cx, top, targetPx) {
  const qr = qrcode(0, "M"); qr.addData(String(text)); qr.make();
  const n = qr.getModuleCount(), quiet = 2, total = n + quiet * 2;
  const mod = Math.max(4, Math.floor(targetPx / total));
  const size = total * mod, x0 = Math.round(cx - size / 2);
  fillRect(c, x0, top, size, size, [255, 255, 255]);
  for (let r = 0; r < n; r++) for (let col = 0; col < n; col++)
    if (qr.isDark(r, col)) fillRect(c, x0 + (col + quiet) * mod, top + (r + quiet) * mod, mod, mod, INK);
  return { size, bottom: top + size };
}

// ---- logo (scaled, recolored to orange, alpha-composited) ------------------
function drawLogo(c, cx, top, targetH) {
  const L = logo();
  const scale = targetH / L.h;
  const dw = Math.round(L.w * scale), dh = Math.round(L.h * scale);
  const x0 = Math.round(cx - dw / 2);
  for (let j = 0; j < dh; j++) {
    for (let i = 0; i < dw; i++) {
      const sxp = Math.min(L.w - 1, Math.floor(i / scale)), syp = Math.min(L.h - 1, Math.floor(j / scale));
      const si = (syp * L.w + sxp) * 4;
      const a = L.rgba[si + 3] / 255;
      if (a <= 0) continue;
      // original logo is dark on transparent -> paint it orange
      blend(c, x0 + i, top + j, ORANGE, a);
    }
  }
  return top + dh;
}

// ---- PNG encoding (RGB) ----------------------------------------------------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function u32(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
function chunk(type, data) {
  const tb = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)));
  const body = new Uint8Array(tb.length + data.length); body.set(tb, 0); body.set(data, tb.length);
  const out = new Uint8Array(4 + body.length + 4); out.set(u32(data.length), 0); out.set(body, 4); out.set(u32(crc32(body)), 4 + body.length); return out;
}
async function deflate(bytes) {
  const cs = new CompressionStream("deflate"); const w = cs.writable.getWriter(); w.write(bytes); w.close();
  const chunks = []; const rd = cs.readable.getReader();
  for (; ;) { const { done, value } = await rd.read(); if (done) break; chunks.push(value); }
  let len = 0; for (const ch of chunks) len += ch.length; const out = new Uint8Array(len); let o = 0; for (const ch of chunks) { out.set(ch, o); o += ch.length; } return out;
}
async function encodePNG(c) {
  const { w, h, buf } = c;
  const raw = new Uint8Array(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; raw.set(buf.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1); }
  const idat = await deflate(raw);
  const ihdr = new Uint8Array(13); ihdr.set(u32(w), 0); ihdr.set(u32(h), 4); ihdr[8] = 8; ihdr[9] = 2;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  let len = 0; for (const p of parts) len += p.length; const out = new Uint8Array(len); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

// ---- the pass --------------------------------------------------------------
// data: { property, unit, name, vehicle, date, validFrom, validTo, qr }
export async function renderPassPNG(data) {
  const { regular, bold } = fonts();
  const W = 760;
  const PAD = 40;            // card inner padding
  const CARDX = 28, CARDW = W - 56;
  const innerX = CARDX + PAD, innerW = CARDW - PAD * 2;
  const centerX = CARDX + CARDW / 2;

  // --- measure total height by walking the layout once ---
  // header
  const headerH = 96;
  let y = headerH + 26;      // card top
  const cardTop = y;
  let cy = cardTop + 34;     // cursor inside card (top padding)
  cy += 34;                  // "Simfoni Perdana" heading baseline area
  cy += 26;                  // divider gap
  // body lines
  const bodyLines = wrap(regular, "Please scan the QR code below to the scanner to enter the property.", 25, innerW);
  cy += 10 + bodyLines.length * 36 + 14;
  const qrTop = cy;
  const qrTargetTop = cy;    // placeholder
  // QR size
  const qrSize = 324;
  cy += qrSize + 26;         // unit line
  cy += 34;                  // unit baseline
  cy += 26;                  // divider
  const rows = [
    ["Name", data.name],
    ["Vehicle No", data.vehicle || "-"],
    ["Date", data.date || data.validFrom],
    ["Validity", `${data.validFrom || data.date} - ${data.validTo || data.validFrom}`],
  ];
  cy += 8 + rows.length * 62;   // each row: label + value
  cy += 20;                     // divider gap
  cy += 70;                     // logo
  cy += 20;                     // bottom padding
  const cardBottom = cy;
  const H = cardBottom + 28;

  // --- draw ---
  const c = canvas(W, H, PAGE);
  // header band
  fillRect(c, 0, 0, W, headerH, ORANGE);
  drawText(c, bold, "Visitor Pass", 40, 62, 34, INK, "left");
  // card (soft shadow + white rounded rect + border)
  roundRect(c, CARDX + 2, cardTop + 6, CARDW, cardBottom - cardTop, 26, [225, 227, 231]); // shadow
  roundRect(c, CARDX, cardTop, CARDW, cardBottom - cardTop, 26, [255, 255, 255]);

  let p = cardTop + 34;
  // heading
  drawText(c, bold, data.property || "Simfoni Perdana", innerX, p + 30, 31, INK, "left");
  p += 34 + 26;
  fillRect(c, innerX, p - 14, innerW, 1.4, LINE);
  // body
  p += 10;
  for (const line of bodyLines) { drawText(c, regular, line, centerX, p + 26, 25, GREY, "center"); p += 36; }
  p += 14;
  // QR
  const qr = drawQR(c, data.qr, centerX, p, qrSize);
  p = qr.bottom + 26;
  // unit
  drawText(c, bold, data.unit || "RB-034B", centerX, p + 28, 27, INK, "center");
  p += 34 + 26;
  fillRect(c, innerX, p - 14, innerW, 1.4, LINE);
  // rows
  p += 8;
  for (const [label, value] of rows) {
    drawText(c, bold, label, innerX, p + 22, 22, INK, "left");
    drawText(c, regular, clip(regular, String(value), 22, innerW), innerX, p + 50, 22, VALUE, "left");
    p += 62;
  }
  p += 6;
  fillRect(c, innerX, p, innerW, 1.4, LINE);
  p += 24;
  // logo
  drawLogo(c, centerX, p, 54);

  return encodePNG(c);
}

// clip a value to fit maxWidth at the given size (keeps it on one line)
function clip(font, s, size, maxWidth) {
  if (measure(font, s, size) <= maxWidth) return s;
  let out = s;
  while (out.length > 1 && measure(font, out + "…", size) > maxWidth) out = out.slice(0, -1);
  return out + "…";
}
