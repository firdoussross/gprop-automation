// GProp WEBSITE client for Cloudflare Workers.
//
// The bot drives the GProp web app (CodeIgniter) with Ross's credentials:
// log in, create a visitor, then read the newest listing row to get the QR.
// Credentials come only from Wrangler secrets (env), never hard-coded.
//
// Proven request shapes (see docs/WEB_API.md):
//   login:  POST /login/login_data_submit  {is_ajax,_co6sO0rpsfat,email,password,remember}
//   create: POST /visitor/add_new_visitor   urlencoded
//             is_ajax=1 & formData=<JSON [{name,value}]> & visitorImages=[] & _co6sO0rpsfat=<csrf>
//           CSRF regen is disabled -> the login cookie _cmhsYhr8mfXz is the CSRF.
//           fldEndDate is REQUIRED (empty => "Add Failed"); set = fldStartDate.
//   listing: GET /visitor/visitor_listing -> {aaData:[row,...]} newest first.

const BASE = "https://www.gpropsystems.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Unit is always RB-034B for this account.
export const UNIT_ID = "1-186228";
export const PROPERTY_NAME = "Simfoni Perdana";

// Visitor categories/types we use (confirmed from the live form).
export const CAT_SOCIAL = "1";
export const TYPE_SOCIAL_VEHICLE = "56406"; // Social Visitor -> Vehicle
export const CAT_DELIVERY = "5";
export const DELIVERY_TYPES = {
  lalamove: "56777",
  shopee: "56778",
  jnt: "56779",       // J&T Express
  "j&t": "56779",
  others: "56780",
};
// Map a free-typed company to a delivery type id (defaults to "Others").
export function deliveryTypeFor(company) {
  const k = String(company || "").toLowerCase().replace(/[^a-z&]/g, "");
  if (k.includes("lalamove")) return DELIVERY_TYPES.lalamove;
  if (k.includes("shopee")) return DELIVERY_TYPES.shopee;
  if (k.includes("jnt") || k.includes("j&t")) return DELIVERY_TYPES.jnt;
  return DELIVERY_TYPES.others; // Grab, Foodpanda, etc. -> Others, name carries the brand
}

// ---- cookie jar ------------------------------------------------------------
function mkJar() {
  const jar = {};
  return {
    absorb(res) {
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const line of sc) {
        const m = /^([^=]+)=([^;]*)/.exec(line);
        if (!m) continue;
        const name = m[1].trim(), val = m[2];
        if (val === "deleted" || val === "") delete jar[name];
        else jar[name] = val;
      }
    },
    header() { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "); },
    get(k) { return jar[k]; },
  };
}

function csrfFrom(html) {
  const m = /csrf_token\s*=\s*'([^']+)'/.exec(html);
  return m ? m[1] : null;
}

async function httpGet(jar, path, referer) {
  const res = await fetch(BASE + path, {
    headers: {
      "User-Agent": UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Cookie": jar.header(),
      ...(referer ? { Referer: referer } : {}),
    },
    redirect: "manual",
  });
  jar.absorb(res);
  return { status: res.status, body: await res.text(), location: res.headers.get("location") };
}

async function httpPost(jar, path, bodyParams, referer) {
  const res = await fetch(BASE + path, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "Origin": BASE,
      "Referer": referer || BASE + "/login",
      "Cookie": jar.header(),
    },
    body: new URLSearchParams(bodyParams).toString(),
    redirect: "manual",
  });
  jar.absorb(res);
  return { status: res.status, body: await res.text() };
}

function parseJSON(body) {
  try { return JSON.parse(String(body).replace(/^﻿/, "")); } catch { return null; }
}

// ---- login -----------------------------------------------------------------
// Returns { jar, csrf } on success, or throws on auth failure.
export async function login(env) {
  const jar = mkJar();
  const loginPage = await httpGet(jar, "/login");
  const token = csrfFrom(loginPage.body);
  const loginField = env.GPROP_LOGIN_FIELD === "contact" ? "contact" : "email";

  const r = await httpPost(jar, "/login/login_data_submit", {
    is_ajax: 1,
    _co6sO0rpsfat: token,
    [loginField]: env.GPROP_LOGIN_ID,
    password: env.GPROP_PASSWORD,
    remember: 1,
  });
  const j = parseJSON(r.body);

  // Multi-property accounts return showOptions; Ross's is single-property and
  // auto-logs-in. Handle both.
  if (j && j.showOptions && j.propertyOptions) {
    const propId = Object.keys(j.propertyOptions)[0];
    const roles = j.propertyOptions[propId] || {};
    const first = Object.values(roles)[0] || {};
    const roleId = first.fldRoleId || Object.keys(roles)[0];
    await httpPost(jar, "/login/login_data_submit", {
      is_ajax: 1,
      _co6sO0rpsfat: jar.get("_cmhsYhr8mfXz") || token,
      propertyId: propId, roleId,
      [loginField]: env.GPROP_LOGIN_ID, password: env.GPROP_PASSWORD,
    });
  }

  const csrf = jar.get("_cmhsYhr8mfXz");
  if (!csrf || !jar.get("ci_session")) {
    throw new Error("login failed: no session cookie (check GPROP_LOGIN_ID / GPROP_PASSWORD)");
  }
  return { jar, csrf };
}

// ---- create visitor --------------------------------------------------------
// opts: { categoryId, typeId, name, vehicle, startDate, endDate, remarks }
// Returns { ok, insertID, msg, raw }.
export async function createVisitor(auth, opts) {
  const { jar, csrf } = auth;
  const startDate = opts.startDate;
  const endDate = opts.endDate || startDate; // REQUIRED; single-day default
  const fields = [
    { name: "fldUnitId", value: UNIT_ID },
    { name: "fldVisitorCategoryId", value: String(opts.categoryId) },
    { name: "fldVisitorTypeId", value: String(opts.typeId) },
    { name: "fldStartDate", value: startDate },
    { name: "fldEndDate", value: endDate },
    { name: "fldVehicleNo", value: opts.vehicle || "" },
    { name: "fldVisitorName", value: opts.name || "" },
    { name: "fldRemarks", value: opts.remarks || "" },
    { name: "_co6sO0rpsfat", value: csrf },
  ];
  const r = await httpPost(jar, "/visitor/add_new_visitor", {
    is_ajax: "1",
    formData: JSON.stringify(fields),
    visitorImages: "[]",
    _co6sO0rpsfat: csrf,
  }, BASE + "/visitor/add_new_visitor_page");
  const j = parseJSON(r.body) || {};
  return {
    ok: j.status === true && !!j.insertID,
    insertID: j.insertID || null,
    msg: j.msg || null,
    status: r.status,
    raw: r.body.slice(0, 500),
  };
}

// ---- newest listing row (carries the QR + pass data) -----------------------
export async function getLatestVisitor(auth) {
  const { jar } = auth;
  const r = await httpGet(jar, "/visitor/visitor_listing", BASE + "/visitor");
  const j = parseJSON(r.body);
  const rows = j && Array.isArray(j.aaData) ? j.aaData : [];
  return rows[0] || null;
}

// Find a specific visitor row by insertID (fldVisitorId), falling back to newest.
export async function getVisitorById(auth, insertID) {
  const { jar } = auth;
  const r = await httpGet(jar, "/visitor/visitor_listing", BASE + "/visitor");
  const j = parseJSON(r.body);
  const rows = j && Array.isArray(j.aaData) ? j.aaData : [];
  if (insertID != null) {
    const hit = rows.find((row) => String(row.fldVisitorId) === String(insertID));
    if (hit) return hit;
  }
  return rows[0] || null;
}

// ---- cancel (for cleanup / future use) -------------------------------------
export async function cancelVisitor(auth, visitorId) {
  const { jar, csrf } = auth;
  const r = await httpPost(jar, "/visitor/cancel_visitor", {
    is_ajax: "1", targetId: visitorId, _co6sO0rpsfat: csrf,
  }, BASE + "/visitor");
  return { status: r.status, raw: r.body.slice(0, 300), json: parseJSON(r.body) };
}

// ---- announcements ---------------------------------------------------------
export async function listAnnouncements(auth) {
  const r = await httpGet(auth.jar, "/announcement/announcement_listing", BASE + "/announcement");
  const j = parseJSON(r.body);
  return j && Array.isArray(j.aaData) ? j.aaData : [];
}

// Attachment links on an announcement's details page: [{url, name}].
export async function announcementAttachments(auth, id) {
  const r = await httpGet(auth.jar, `/announcement_details/${encodeURIComponent(id)}`, BASE + "/announcement");
  const out = [];
  const re = /href="(https:\/\/www\.gpropsystems\.com\/upload\/documents\/announcement\/[^"]+)"[^>]*>(?:\s*<i[^>]*><\/i>)?\s*([^<]*)</g;
  let m;
  while ((m = re.exec(r.body))) out.push({ url: m[1], name: m[2].trim() || m[1].split("/").pop() });
  return out;
}
