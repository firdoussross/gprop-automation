// GProp API client for Cloudflare Workers.
//
// The exact request field names below were reconstructed from the app's compiled
// Dart (see ../docs/API.md). They are centralized here so that, the first time we
// run against Ross's real account, any mismatch is a one-line fix. DEBUG_API=1
// surfaces the raw responses so we can confirm them.

const BASE = "https://www.gpropsystems.com/api";

// ---- field names to confirm against the live API ----
const FIELDS = {
  login: {
    // which key carries the login id is chosen at call time (email vs contact)
    password: "password",
    fcmToken: "fcm_token",
    deviceId: "device_id",
    platform: "platform",
  },
  addVisitor: {
    name: "visitor_name",
    type: "visitor_type",     // id from get_visitor_type_API
    contact: "contact",
    carPlate: "car_plate",
    visitDate: "visit_date",
    unitId: "unit_id",
    remark: "remark",
  },
};

function authHeaders(env, token, userId) {
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Platform: env.GPROP_PLATFORM || "android",
    Version: env.GPROP_APP_VERSION || "1.0.0",
    "app-version": env.GPROP_APP_VERSION || "1.0.0",
    "device-os": env.GPROP_DEVICE_OS || "android",
  };
  if (token) h["Authorization"] = `Bearer ${token}`;
  if (userId) h["User-Id"] = String(userId);
  return h;
}

async function post(env, path, body, { token, userId } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: authHeaders(env, token, userId),
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* keep text */ }
  return { ok: res.ok, status: res.status, json, text };
}

// ---- auth ----
// Logs in and returns { token, userId, raw }. Cached by the caller in KV.
export async function login(env) {
  const idField = env.GPROP_LOGIN_FIELD === "contact" ? "contact" : "email";
  const body = {
    [idField]: env.GPROP_LOGIN_ID,
    [FIELDS.login.password]: env.GPROP_PASSWORD,
    [FIELDS.login.platform]: env.GPROP_PLATFORM || "android",
  };
  const r = await post(env, "/login/getLoginDetails_API", body);
  // Token/userId location is confirmed on first real login; try common shapes.
  const d = r.json?.data ?? r.json ?? {};
  const token =
    d.token || d.access_token || d.auth_token || d.api_token ||
    r.json?.token || null;
  const userId =
    d.user_id || d.userId || d.id || r.json?.user_id || null;
  return { token, userId, raw: r };
}

// ---- visitor flow ----
export async function getVisitorTypes(env, auth) {
  return post(env, "/visitor/get_visitor_type_API", {}, auth);
}

export async function getValidDateRange(env, auth) {
  return post(env, "/visitor/vms_get_valid_date_range_api", {}, auth);
}

// Units registered to the account (the "unit number" dropdown when adding a pass).
export async function getUnitListing(env, auth) {
  return post(env, "/unit/getUnitListing_API", {}, auth);
}

export async function addVisitor(env, auth, { name, typeId, contact, carPlate, visitDate, unitId, remark }) {
  const body = {
    [FIELDS.addVisitor.name]: name,
    [FIELDS.addVisitor.type]: typeId,
  };
  if (contact) body[FIELDS.addVisitor.contact] = contact;
  if (carPlate) body[FIELDS.addVisitor.carPlate] = carPlate;
  if (visitDate) body[FIELDS.addVisitor.visitDate] = visitDate;
  if (unitId) body[FIELDS.addVisitor.unitId] = unitId;
  if (remark) body[FIELDS.addVisitor.remark] = remark;
  return post(env, "/visitor/addNewVisitor_API", body, auth);
}

export async function getVisitorDetails(env, auth, visitorId) {
  return post(env, "/visitor/getVisitorDetails_API", { visitor_id: visitorId }, auth);
}

export async function getSharePassText(env, auth, visitorId) {
  return post(env, "/visitor/get_share_pass_text_API", { visitor_id: visitorId }, auth);
}

export { FIELDS, BASE };
