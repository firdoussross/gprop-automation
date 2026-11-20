// Frida: capture GProp's exact login/visitor requests at the Cronet layer,
// BEFORE TLS/HTTP-3 encryption. Run against the objection-injected gadget:
//
//   frida -U Gadget -l capture_cronet.js
//
// Then in the app: log in, create a pass, show the QR. The exact URL, method,
// headers, and request BODY (field names + encoding) print to this terminal.
//
// Why the first version caught nothing: the cronet_http plugin doesn't call the
// abstract org.chromium.net.UrlRequest$Builder / UploadDataProviders we hooked.
// It uses the CONCRETE impl classes (org.chromium.net.impl.*), and it uploads
// the body through its OWN UploadDataProvider.read(sink, byteBuffer). So this
// version:
//   1) enumerates every loaded cronet/chromium class and prints the real names,
//   2) hooks addHeader / setHttpMethod / newUrlRequestBuilder on whatever class
//      actually declares them (abstract AND impl), and
//   3) dumps the body out of any UploadDataProvider.read(...) buffer.

function log(s) { console.log("\n[CRONET] " + s); }

// Read a java byte[] (or the filled part of a ByteBuffer) as a latin1 string so
// form bodies / JSON are human-readable in the terminal.
function bytesToStr(arr) {
  try {
    var s = "";
    for (var i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i] & 0xff);
    return s;
  } catch (e) { return "<bytes err " + e + ">"; }
}

Java.perform(function () {
  var Modifier = Java.use("java.lang.reflect.Modifier");

  // ---- 1. Discover the real cronet classes ---------------------------------
  var found = [];
  Java.enumerateLoadedClassesSync().forEach(function (name) {
    if (/cronet|chromium|UrlRequest|UploadData|HttpEngine/i.test(name)) {
      found.push(name);
    }
  });
  found.sort();
  log("cronet/chromium classes loaded (" + found.length + "):");
  found.forEach(function (n) { console.log("    " + n); });
  if (!found.length) {
    log("NONE loaded yet. Open the app and log in, then re-run — cronet loads lazily.");
  }

  var hookedMethods = 0;

  // Hook one method overload-safe: wrap every overload of clsName.method.
  function hookAll(clsName, method, onEnter, onLeaveReadThis) {
    try {
      var C = Java.use(clsName);
      if (!C[method]) return;
      C[method].overloads.forEach(function (ov) {
        try {
          ov.implementation = function () {
            try { onEnter.call(this, arguments, clsName, method); } catch (e) {}
            var ret = ov.apply(this, arguments);
            if (onLeaveReadThis) { try { onLeaveReadThis.call(this, arguments); } catch (e) {} }
            return ret;
          };
          hookedMethods++;
        } catch (e) {}
      });
    } catch (e) {}
  }

  // ---- 2. Hook URL / method / headers on every matching class --------------
  found.forEach(function (clsName) {
    // URL comes through the engine's newUrlRequestBuilder(url, cb, executor).
    hookAll(clsName, "newUrlRequestBuilder", function (args) {
      var url = args[0];
      if (url && String(url).indexOf("gpropsystems") >= 0) log("URL     " + url);
    });
    // Request method + headers come through the builder.
    hookAll(clsName, "setHttpMethod", function (args) {
      log("method  " + args[0]);
    });
    hookAll(clsName, "addHeader", function (args) {
      log("header  " + args[0] + ": " + args[1]);
    });
  });

  // ---- 3. Dump the request body --------------------------------------------
  // (a) The standard factory, if used.
  hookAll("org.chromium.net.UploadDataProviders", "create", function (args) {
    var a0 = args[0];
    if (a0 && a0.length !== undefined) log("BODY (create byte[]) >>>\n" + bytesToStr(a0) + "\n<<<");
  });

  // (b) The real path: a custom UploadDataProvider.read(sink, byteBuffer).
  // cronet_http fills `byteBuffer` with the body, then calls sink.onReadSucceeded.
  // We read the buffer AFTER the original runs (so it's populated), from its
  // start up to the new position.
  found.forEach(function (clsName) {
    if (!/UploadDataProvider/i.test(clsName)) return;
    try {
      var C = Java.use(clsName);
      if (!C.read) return;
      C.read.overloads.forEach(function (ov) {
        try {
          ov.implementation = function (sink, bb) {
            var before = -1;
            try { before = bb.position(); } catch (e) {}
            var ret = ov.call(this, sink, bb);
            try {
              var after = bb.position();
              var dup = bb.duplicate();
              dup.position(before < 0 ? 0 : before);
              dup.limit(after);
              var n = dup.remaining();
              if (n > 0) {
                var out = Java.array("byte", new Array(n));
                dup.get(out);
                log("BODY (" + clsName + ".read, " + n + "B) >>>\n" + bytesToStr(out) + "\n<<<");
              }
            } catch (e) { log("body read err " + e); }
            return ret;
          };
          hookedMethods++;
        } catch (e) {}
      });
    } catch (e) {}
  });

  log("hooks installed on methods: " + hookedMethods +
      (hookedMethods ? "" : "  (no cronet methods found yet — log in, then re-run)"));
});
