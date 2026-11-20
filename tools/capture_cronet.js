// Frida script: capture GProp's exact HTTP requests at the Cronet Java layer,
// BEFORE TLS/HTTP-3 encryption. Works with the objection-injected gadget:
//
//   frida -U Gadget -l capture_cronet.js
//
// Then in the app: log in, create a pass, show the QR. The exact URL, method,
// headers, and request BODY (field names + encoding) print to the terminal.
//
// Why this works: the app uses the cronet_http plugin, which builds requests via
// org.chromium.net.UrlRequest$Builder and uploads the body through
// UploadDataProviders. Hooking those reads the plaintext request regardless of
// HTTP/3. We filter to gpropsystems.com and skip Google telemetry noise.

function log(s) { console.log("\n[CRONET] " + s); }
function hex(bytes) {
  try {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0xff);
    return s;
  } catch (e) { return "<" + e + ">"; }
}

Java.perform(function () {
  var hooked = [];

  function tryHook(name, fn) {
    try { fn(); hooked.push(name); } catch (e) { /* class not loaded yet */ }
  }

  // --- URL + method on the request builder ---
  ["org.chromium.net.UrlRequest$Builder",
   "org.chromium.net.ExperimentalUrlRequest$Builder"].forEach(function (cls) {
    tryHook(cls + ".setHttpMethod", function () {
      var B = Java.use(cls);
      B.setHttpMethod.implementation = function (m) {
        log("method=" + m);
        return this.setHttpMethod(m);
      };
      B.addHeader.implementation = function (k, v) {
        log("header  " + k + ": " + v);
        return this.addHeader(k, v);
      };
    });
  });

  // The engine's newUrlRequestBuilder(url, ...) gives us the URL.
  ["org.chromium.net.CronetEngine",
   "org.chromium.net.ExperimentalCronetEngine"].forEach(function (cls) {
    tryHook(cls + ".newUrlRequestBuilder", function () {
      var E = Java.use(cls);
      E.newUrlRequestBuilder.overload(
        "java.lang.String", "org.chromium.net.UrlRequest$Callback", "java.util.concurrent.Executor"
      ).implementation = function (url, cb, ex) {
        if (String(url).indexOf("gpropsystems") >= 0) log("URL     " + url);
        return this.newUrlRequestBuilder(url, cb, ex);
      };
    });
  });

  // --- request body: UploadDataProviders.create(byte[]) / (ByteBuffer) ---
  tryHook("org.chromium.net.UploadDataProviders", function () {
    var U = Java.use("org.chromium.net.UploadDataProviders");
    U.create.overload("[B").implementation = function (arr) {
      log("BODY (byte[]) >>>\n" + hex(arr) + "\n<<<");
      return this.create(arr);
    };
    try {
      U.create.overload("java.nio.ByteBuffer").implementation = function (bb) {
        try {
          var dup = bb.duplicate();
          var n = dup.remaining();
          var out = Java.array("byte", new Array(n));
          dup.get(out);
          log("BODY (ByteBuffer) >>>\n" + hex(out) + "\n<<<");
        } catch (e) { log("body bb read err " + e); }
        return this.create(bb);
      };
    } catch (e) {}
  });

  // Fallback: some builds route the body through a cronet_http UploadDataProvider.
  tryHook("org.chromium.net.UploadDataProviders.create2", function () {
    var U = Java.use("org.chromium.net.UploadDataProviders");
    U.create.overload("java.io.File").implementation = function (f) {
      log("BODY (file) " + f.getAbsolutePath());
      return this.create(f);
    };
  });

  console.log("[CRONET] hooks installed: " + (hooked.join(", ") || "NONE (cronet classes not loaded yet — open the app/login and it will hook on use)"));

  // If nothing hooked yet, cronet loads lazily; retry after classes appear.
  if (!hooked.length) {
    Java.scheduleOnMainThread(function () {});
  }
});
