// Frida: capture GProp's login/visitor request in NATIVE code, below the Java
// layer. The app's API doesn't touch android.net.http (Java hooks saw nothing),
// so the request is built/encrypted in native libraries (Cronet / BoringSSL).
//
//   frida -U Gadget -l capture_native.js
//
// This script does three things:
//   1. ENUMERATES loaded native modules + the crypto/http export symbols in
//      them, so we see the real library + function names to target.
//   2. Opportunistically HOOKS the usual plaintext choke points if their
//      symbols resolve:
//        - SSL_write / SSL_read            (HTTP/1.1 + HTTP/2 over TLS)
//        - EVP_AEAD_CTX_seal / _open       (HTTP/3 / QUIC payloads)
//        - Cronet_* C API (url/method/headers)
//   3. Prints any captured buffer that looks like our host or a login/visitor
//      request, in readable text.
//
// The request BODY (email=...&password=... or {"email":...}) shows up in these
// buffers even for HTTP/2 or HTTP/3, because only the HEADERS are compressed —
// the POST body in a DATA frame is plaintext.

function toText(ptr, len) {
  try {
    var bytes = new Uint8Array(Memory.readByteArray(ptr, len));
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  } catch (e) { return "<read err " + e + ">"; }
}

// Print a plaintext buffer only if it's relevant (our host, or a login/visitor
// request, or a small form/JSON body) — avoids drowning in TLS keepalive noise.
function maybePrint(tag, text) {
  if (!text || text.length === 0) return;
  var t = text;
  var hit =
    t.indexOf("gpropsystems") >= 0 ||
    t.indexOf("getLoginDetails") >= 0 ||
    t.indexOf("/login/") >= 0 ||
    t.indexOf("/visitor/") >= 0 ||
    t.indexOf("addNewVisitor") >= 0 ||
    (t.indexOf("password") >= 0 && t.length < 4000) ||
    (/\bPOST \//.test(t) && t.indexOf("google") < 0 && t.indexOf("crashlytics") < 0 && t.indexOf("firebase") < 0);
  if (!hit) return;
  console.log("\n[NATIVE] " + tag + " (" + text.length + " bytes) >>>\n" + text + "\n<<<");
}

function hookIfPresent(name, modName, onFound) {
  var addr = null;
  try { addr = Module.findExportByName(modName, name); } catch (e) {}
  if (addr) { try { onFound(addr); return true; } catch (e) {} }
  return false;
}

// ---- 1. Enumerate modules + interesting exports --------------------------
console.log("\n[NATIVE] ===== loaded modules of interest =====");
var mods = Process.enumerateModules();
var interesting = [];
mods.forEach(function (m) {
  if (/cronet|httpengine|flutter|ssl|boring|quic|crypto|chromium|gprop|netutil|conscrypt/i.test(m.name)) {
    interesting.push(m);
    console.log("  " + m.name + "  base=" + m.base + " size=" + m.size + "  " + m.path);
  }
});

console.log("\n[NATIVE] ===== crypto/http exports found =====");
var exportIndex = {}; // name -> [modName]
interesting.forEach(function (m) {
  var exps;
  try { exps = Module.enumerateExports(m.name); } catch (e) { return; }
  exps.forEach(function (e) {
    if (/^Cronet_|^SSL_write$|^SSL_read$|^EVP_AEAD_CTX_(seal|open)$|quic|^SSL_do_handshake$/i.test(e.name)) {
      if (!exportIndex[e.name]) exportIndex[e.name] = [];
      exportIndex[e.name].push(m.name);
    }
  });
});
var names = Object.keys(exportIndex).sort();
if (!names.length) {
  console.log("  (none exported — BoringSSL/Cronet symbols are stripped; friTap-style pattern scan needed)");
} else {
  names.forEach(function (n) { console.log("  " + n + "   [" + exportIndex[n].join(", ") + "]"); });
}

// ---- 2. Hook plaintext choke points where symbols resolve ----------------
var hooked = [];

// SSL_write(ssl, buf, num) -> plaintext we send (HTTP/1.1 + HTTP/2 requests).
Object.keys(exportIndex).forEach(function (n) { /* no-op, keep order */ });
["SSL_write"].forEach(function (fn) {
  (exportIndex[fn] || []).forEach(function (mod) {
    hookIfPresent(fn, mod, function (addr) {
      Interceptor.attach(addr, {
        onEnter: function (args) {
          try { maybePrint("SSL_write@" + mod, toText(args[1], args[2].toInt32())); } catch (e) {}
        }
      });
      hooked.push(fn + "@" + mod);
    });
  });
});

// SSL_read(ssl, buf, num) -> plaintext responses (shows the login RESPONSE too).
["SSL_read"].forEach(function (fn) {
  (exportIndex[fn] || []).forEach(function (mod) {
    hookIfPresent(fn, mod, function (addr) {
      Interceptor.attach(addr, {
        onEnter: function (args) { this.buf = args[1]; },
        onLeave: function (ret) {
          try {
            var n = ret.toInt32();
            if (n > 0) maybePrint("SSL_read@" + mod, toText(this.buf, n));
          } catch (e) {}
        }
      });
      hooked.push(fn + "@" + mod);
    });
  });
});

// EVP_AEAD_CTX_seal(ctx,out,out_len,max,nonce,nonce_len, IN, IN_len, ad,ad_len)
// -> plaintext QUIC/HTTP-3 payloads (in=args[6], in_len=args[7]).
["EVP_AEAD_CTX_seal"].forEach(function (fn) {
  (exportIndex[fn] || []).forEach(function (mod) {
    hookIfPresent(fn, mod, function (addr) {
      Interceptor.attach(addr, {
        onEnter: function (args) {
          try { maybePrint("AEAD_seal@" + mod, toText(args[6], args[7].toInt32())); } catch (e) {}
        }
      });
      hooked.push(fn + "@" + mod);
    });
  });
});

// Cronet C API: URL + method + headers, if the native Cronet ABI is exported.
[["Cronet_UrlRequest_InitWithParams", 2],   // arg[2] = url (C string)
 ["Cronet_UrlRequestParams_http_method_set", 1],
 ["Cronet_HttpHeader_name_set", 1],
 ["Cronet_HttpHeader_value_set", 1]
].forEach(function (pair) {
  var fn = pair[0], argIdx = pair[1];
  (exportIndex[fn] || []).forEach(function (mod) {
    hookIfPresent(fn, mod, function (addr) {
      Interceptor.attach(addr, {
        onEnter: function (args) {
          try {
            var s = args[argIdx].readUtf8String();
            if (s && (fn.indexOf("method") >= 0 || fn.indexOf("Header") >= 0 || String(s).indexOf("gpropsystems") >= 0)) {
              console.log("\n[NATIVE] " + fn + "  " + s);
            }
          } catch (e) {}
        }
      });
      hooked.push(fn + "@" + mod);
    });
  });
});

console.log("\n[NATIVE] hooks installed: " + (hooked.length ? hooked.join(", ") : "NONE (symbols stripped — send me the module/export lists above)"));
console.log("[NATIVE] Now log out and log in. Watch for [NATIVE] ... BODY blocks.\n");
