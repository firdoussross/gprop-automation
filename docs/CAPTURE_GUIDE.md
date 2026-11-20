# Phase 1 — Capturing GProp's API traffic

Goal: see exactly what the GProp app sends when you **log in** and when you
**create a visitor/delivery pass and get the QR**, so we can reproduce just those
two calls from the bot. You do this on your Android phone; I can't reach the
device, so this guide is for you to run. Send me the results and I'll document
the API and build the bot.

The thing that usually gets in the way is **TLS/certificate pinning** — many
apps reject a proxy's certificate. We'll try the easy path first and only deal
with pinning if we hit it.

---

## Option A — HTTP Toolkit (easiest, try this first)

[HTTP Toolkit](https://httptoolkit.com) is free and has a one-tap Android setup.

1. **On your PC:** install HTTP Toolkit (Windows/Mac/Linux) and open it.
2. Connect the phone and PC to the **same Wi-Fi**.
3. In HTTP Toolkit choose **Android device via ADB** (needs USB debugging on —
   you already have developer mode) or **Android device via QR code**.
   - For ADB: enable *USB debugging* in Developer options, plug in USB, accept
     the prompt on the phone.
4. It installs a helper app + its CA certificate and starts intercepting.
5. On the phone, **open GProp and log in**, then **create a test visitor pass**
   (use a real but low-stakes case, e.g. a visitor named "TEST").
6. Back in HTTP Toolkit you'll see the requests. **Export** the relevant ones
   (the login request and the visitor-pass requests) — right-click → *Copy as
   cURL*, or use **Export → HAR**.
7. Send me:
   - the login request/response,
   - the create-visitor-pass request/response,
   - any request that returns the QR (image or a code/string).

If GProp works and you see its traffic → **you're done, skip to "What to send".**

If GProp's requests **don't appear** or show a TLS/connection error while other
apps work → GProp is **certificate-pinned**. Go to Option B.

---

## Option B — mitmproxy + bypassing certificate pinning

Needed only if Option A gets blocked by pinning. This needs either a **rooted
phone** or **patching the APK**. Pick whichever matches your device.

### B1. Set up mitmproxy

1. On PC: `pip install mitmproxy` then run `mitmweb` (web UI) or `mitmproxy`.
2. On phone Wi-Fi settings → set a **manual proxy** to your PC's LAN IP, port
   `8080`.
3. On phone browser visit `http://mitm.it`, download and install the
   **mitmproxy CA certificate** (install as a *CA certificate* in
   Settings → Security → Encryption & credentials).
4. Test with a browser — you should see traffic in mitmproxy.

Apps that aren't pinned will now work. If GProp still fails → it's pinned, do B2.

### B2. Defeat pinning (choose one)

**If your phone is rooted** — easiest:
- Install **Magisk**, then the **Frida** or **LSPosed + TrustMeAlready** module,
  or run a Frida pinning-bypass script against the GProp process.

**If not rooted** — patch the APK:
- Pull the GProp APK, use **apk-mitm** (`npx apk-mitm gprop.apk`) which
  automatically rewrites the network-security config to trust user CAs and
  strips common pinning, then install the patched APK.
- Re-run the capture from B1.

> Note: patching/repackaging is only for your own device to inspect your own
> account's traffic. Don't distribute the patched APK.

### B3. APK inspection (parallel / fallback)

Even without live capture we can learn a lot from the APK itself:
- Get the APK (e.g. from the phone via `adb shell pm path com.<gprop package>`
  then `adb pull`), then decompile with **jadx** (`jadx-gui gprop.apk`).
- Search the decompiled source for: the **base URL / host**, endpoint paths
  (`/api/...`, `visitor`, `pass`, `qr`), header names, and how the auth
  token is stored/sent.
- Send me the package name and any API hostnames/paths you find.

---

## What to send me

Whatever you capture, I need enough to reproduce the two actions. Ideally:

1. **Base URL / host** of the GProp backend.
2. **Login call:** method, path, request body (you can redact your actual
   password — I mainly need the field *names* and the shape), and what the
   response returns (token? cookie? how long it lasts).
3. **Create-visitor-pass call(s):** method, path, headers (esp. the auth
   header), request body fields (visitor name, phone, unit, visit date, type =
   visitor vs delivery, etc.), and the response.
4. **QR retrieval:** is the QR returned as an image URL, a base64 image, or a
   raw code/string that the app renders into a QR locally?

**Redact before sending:** your password, any OTP, and the actual bearer/session
token value (I need the header *name* and format, not your live token).

The cleanest format is **HTTP Toolkit "Copy as cURL"** for each request, or a
**HAR export** — paste it straight into this thread and I'll take it from there.

---

## Safety / etiquette

- Only your own account, only the visitor-pass feature.
- We'll build the bot to make **one** backend call per pass, no retries-in-a-loop,
  no scraping. The aim is to behave like a single polite user.
- If GProp later changes their API, we re-capture — nothing here fights the app.

---

## Option C — Flutter apps (GProp is Flutter)

GProp ships `libflutter.so` + `libapp.so`, so it's a **Flutter** app. Flutter
ignores the Android system proxy and pins certs inside its own engine
(BoringSSL), which is why apk-mitm and a normal proxy see no traffic and the
login just hangs. Use **reFlutter**, which patches `libflutter.so` to disable
pinning and route traffic to a proxy you choose.

Because GProp is a split APK, merge the splits into one universal APK first.

1. **Merge splits** (APKEditor):
   ```
   java -jar APKEditor.jar m -i gprop-apk -o gprop-merged.apk
   ```
2. **Find your PC's LAN IP** (same Wi-Fi as phone): `ipconfig getifaddr en0`
   (mac) or `ip addr` (linux).
3. **Patch with reFlutter:**
   ```
   pip install reflutter
   reflutter gprop-merged.apk
   ```
   Choose option **1** (traffic monitoring), enter your LAN IP, default port
   `8083`. Outputs `release.RE.apk`.
4. **Sign** (uber-apk-signer): `java -jar uber-apk-signer.jar -a release.RE.apk`
5. **Install:**
   ```
   adb uninstall com.gprop.users
   adb install release.RE-aligned-debugSigned.apk
   ```
6. **Listen** on the IP:port you gave — run mitmproxy there:
   `mitmweb --listen-port 8083` (or Burp on 8083). The patched app sends its
   decrypted API traffic through it. Open GProp, log in, create a test pass, view
   the QR — the requests appear in mitmproxy.
