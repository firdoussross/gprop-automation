#!/usr/bin/env python3
"""
One-time capture of the GProp WEB app's authenticated pages, so we can build the
bot against the website instead of the mobile API.

Your password is read from a prompt and never printed or saved. It logs in,
handles the property/role step, then saves the add-visitor form, the visitor
listing, and a visitor pass page to ./gprop_web_capture/ for you to upload.

Usage:
    python3 web_capture.py                # prompts for email + password
    python3 web_capture.py you@email.com  # prompts for password only

Needs only Python 3 stdlib (no pip installs).
"""
import sys, os, re, json, getpass, urllib.request, urllib.parse, http.cookiejar

BASE = "https://www.gpropsystems.com"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
OUT = os.path.join(os.getcwd(), "gprop_web_capture")
os.makedirs(OUT, exist_ok=True)

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with opener.open(req, timeout=30) as r:
        return r.geturl(), r.read().decode("utf-8", "replace")

def post(url, data, referer=BASE + "/login"):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers={
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": referer,
        "Origin": BASE,
    })
    with opener.open(req, timeout=30) as r:
        return r.geturl(), r.read().decode("utf-8", "replace")

def csrf_from(html):
    m = re.search(r"csrf_token\s*=\s*'([^']+)'", html)
    return m.group(1) if m else None

def save(name, text):
    p = os.path.join(OUT, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"  saved {name}  ({len(text)} bytes)")

email = sys.argv[1] if len(sys.argv) > 1 else input("GProp login email: ").strip()
password = getpass.getpass("GProp password (hidden): ")

print("\n[1] GET /login ...")
_, login_html = get(BASE + "/login")
token = csrf_from(login_html)
print("  csrf_token:", token)

print("[2] POST login_data_submit ...")
_, res = post(BASE + "/login/login_data_submit",
              {"is_ajax": 1, "_co6sO0rpsfat": token, "email": email,
               "password": password, "remember": 1})
try:
    j = json.loads(res)
except Exception:
    print("  (non-JSON response, first 500 chars):\n", res[:500]); sys.exit(1)
# print structure, not secrets
print("  status:", j.get("status"), "| showOptions:", j.get("showOptions"),
      "| keys:", list(j.keys()))

# Refresh token (CodeIgniter may rotate it) and handle property/role step.
token2 = csrf_from(login_html) or token
if j.get("showOptions"):
    props = j.get("propertyOptions") or {}
    # propertyOptions is { propertyId: { roleId: {fldPName, fldRoleId, ...}, ... }, ... }
    prop_id = next(iter(props.keys()), None)
    role_id = None
    if prop_id is not None:
        roles = props[prop_id]
        if isinstance(roles, dict):
            first = next(iter(roles.values()), {})
            role_id = first.get("fldRoleId") or next(iter(roles.keys()), None)
    print(f"  choosing propertyId={prop_id} roleId={role_id}")
    _, res2 = post(BASE + "/login/login_data_submit",
                   {"is_ajax": 1, "_co6sO0rpsfat": token2, "propertyId": prop_id,
                    "roleId": role_id, "email": email, "password": password})
    try:
        j2 = json.loads(res2)
        print("  step2 status:", j2.get("status"), "| keys:", list(j2.keys()),
              "| redirectUrl:", j2.get("redirectUrl"))
    except Exception:
        print("  step2 (non-JSON):", res2[:300])

print("\n[3] Fetching authenticated pages ...")
for name, path in [
    ("add_new_visitor_page.html", "/visitor/add_new_visitor_page"),
    ("visitor_listing.html", "/visitor"),
    ("visitor_view_details.html", "/visitor/view_details/12599538"),
]:
    final, html = get(BASE + path)
    if "/login" in final:
        print(f"  {path} -> REDIRECTED TO LOGIN (not authenticated)")
    else:
        save(name, html)

# Try to discover the visitor-pass page link from the view_details HTML.
vp = os.path.join(OUT, "visitor_view_details.html")
if os.path.exists(vp):
    html = open(vp, encoding="utf-8").read()
    cands = set(re.findall(r'(https?://www\.gpropsystems\.com/visitor/[a-zA-Z0-9_/]*pass[a-zA-Z0-9_/]*)', html))
    cands |= set(re.findall(r'["\'](/visitor/[a-zA-Z0-9_/]*pass[a-zA-Z0-9_/]*)["\']', html))
    cands |= set(re.findall(r'(visitor_pass[a-zA-Z0-9_/]*)', html))
    print("\n[4] Visitor-pass link candidates:", cands or "(none found in HTML)")
    for i, c in enumerate(sorted(cands)):
        url = c if c.startswith("http") else BASE + (c if c.startswith("/") else "/visitor/" + c)
        try:
            final, phtml = get(url)
            if "/login" not in final:
                save(f"visitor_pass_{i}.html", phtml)
                print(f"    fetched {url}")
        except Exception as e:
            print(f"    {url} -> {e}")

print(f"\nDone. Upload the .html files in:\n  {OUT}\n"
      "(Do NOT upload any cookies file — these HTML pages are fine.)")
