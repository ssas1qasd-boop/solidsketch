// Injected by MainActivity into solidsketch.html (idempotent).
// Android WebView cannot save blob:/data: downloads by itself, so this helper
// intercepts <a download> clicks (including a.click() on detached anchors, which is
// how the page exports STL/OBJ/DXF zips), reads the Blob in the page and streams it
// as base64 chunks to the Java bridge window.SolidSketchAndroid, which writes the file
// to Downloads (MediaStore on API 29+, app-specific Downloads dir on API 24-28).
(function () {
  'use strict';
  if (window.__solidsketchAndroidBridge) return;
  var bridge = window.SolidSketchAndroid;
  if (!bridge) return;
  window.__solidsketchAndroidBridge = true;

  var blobs = Object.create(null);   // blob: URL -> Blob, recorded at URL.createObjectURL time
  var names = Object.create(null);   // blob: URL -> download name, for the DownloadListener fallback
  var CHUNK = 768 * 1024;            // bytes per chunk (multiple of 3 -> independent base64 chunks)

  var origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    var url = origCreate.apply(URL, arguments);
    try { if (obj instanceof Blob) blobs[url] = obj; } catch (e) { /* MediaSource etc. */ }
    return url;
  };
  var origRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = function (url) {
    // keep the Blob until it has been saved; the page may revoke right after click()
    setTimeout(function () { delete blobs[url]; delete names[url]; }, 60000);
    return origRevoke.apply(URL, arguments);
  };

  function b64(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function getBlob(url) {
    if (blobs[url]) return Promise.resolve(blobs[url]);
    return fetch(url).then(function (r) { return r.blob(); });
  }

  function readBuf(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(fr.error); };
      fr.readAsArrayBuffer(blob);
    });
  }

  // The Java bridge resolves methods by name AND argument count (a call with the wrong
  // number of arguments throws "Method not found"), so every call below must match
  // DownloadBridge.java exactly: begin(name, mime) -> token|null, append(token, base64) ->
  // boolean, finish(token), failed(name, message). build.sh checks this (tools/check_bridge.py).
  // begin/append report their own errors with a toast and return null/false; then we stop
  // without calling failed(), so the user sees one error toast, not two.
  function javaReported(msg) { var e = new Error(msg); e.javaReported = true; return e; }

  function save(url, name, mime) {
    name = name || names[url] || 'download';
    getBlob(url).then(function (blob) {
      return readBuf(blob).then(function (buf) {
        var bytes = new Uint8Array(buf);
        var type = mime || blob.type || 'application/octet-stream';
        var token = bridge.begin(name, type);
        if (!token) throw javaReported('could not create the file');
        for (var off = 0; off < bytes.length; off += CHUNK) {
          if (!bridge.append(token, b64(bytes.subarray(off, Math.min(bytes.length, off + CHUNK))))) throw javaReported('write failed');
        }
        bridge.finish(token);
      });
    }).catch(function (e) {
      if (e && e.javaReported) return;   // DownloadBridge already showed the error toast
      try { bridge.failed(name, String(e && e.message || e)); } catch (e2) { /* bridge gone (page unloading) */ }
    });
  }

  // Called from Java's DownloadListener when a blob:/data: download slipped through
  // (name = URLUtil.guessFileName() from Java, used when the click hook did not see the anchor).
  window.__solidsketchSave = function (url, mime, name) { save(url, names[url] || name, mime); };

  function intercept(a) {
    if (!a || !a.hasAttribute || !a.hasAttribute('download')) return false;
    var href = a.href || '';
    if (href.indexOf('blob:') !== 0 && href.indexOf('data:') !== 0) return false;
    var name = a.getAttribute('download') || '';
    if (!name) { try { name = decodeURIComponent((href.split('/').pop() || '').split(/[?#]/)[0]); } catch (e) { name = ''; } }
    names[href] = name;
    save(href, name, a.type || '');
    return true;
  }

  // a.click() on an anchor that is not in the document never reaches document listeners
  var origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (intercept(this)) return;
    return origClick.apply(this, arguments);
  };
  // real taps on <a download href="blob:..."> in the document
  document.addEventListener('click', function (e) {
    var t = e.target;
    var a = t && t.closest ? t.closest('a[download]') : null;
    if (a && intercept(a)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
})();
