/* OnSite offline core — doc-80 v1 (capture-first). window.OnsiteOffline.
 *
 * Implements the C3a contract for /app:
 *  - per-USER IndexedDB read-cache (kv snapshots) — field reads local, board reads truth (doc-80 §0)
 *  - the outbox (doc-80 §2): op = { opId, entity, op, payload, baseUpdatedAt, tenantId, buildingId,
 *    userId, clientTs, attempts, status queued|sending|rejected|held } — FIFO drain, direct supabase-js
 *    upsert(onConflict:'id') per op (idempotent: crash mid-drain + re-send = one row), exponential
 *    backoff, attempts capped then HELD visibly, RLS-rejected kept + surfaced, never retried blind
 *  - photo two-phase (doc-80 §4): separate blob queue → photos bucket at tenant/building/photoId.jpg
 *    (fixed idempotent path, upsert:true); stored as data-URLs (renderable offline under the strict CSP
 *    img-src data:); local GC only after confirmed upload + 1 h grace
 *  - persisted-identity (offline session rule): if a session exists in localStorage but can't refresh
 *    because we're OFFLINE, the app opens anyway — never force sign-out offline
 *  - drain triggers: app open, 'online', visibilitychange (NO Background Sync API — iOS reality)
 *
 * A queued write is a durable local success (the honesty levels are the APP's chips; this module only
 * ever reports true states). C1: queue failures REJECT loudly — the caller must never fake a ✓. */
(function () {
  "use strict";
  var DB_NAME = "onsite-app-offline", DB_VER = 1;
  var ATTEMPT_CAP = 8;              // then status 'held' — kept visibly, manual retry
  var BACKOFF_BASE_MS = 5000, BACKOFF_MAX_MS = 5 * 60 * 1000;
  var PHOTO_GC_GRACE_MS = 60 * 60 * 1000;   // local blob kept ≥1 h after confirmed upload
  var _db = null;

  function open() {
    return new Promise(function (res, rej) {
      if (_db) return res(_db);
      var rq = indexedDB.open(DB_NAME, DB_VER);
      rq.onupgradeneeded = function () {
        var d = rq.result;
        if (!d.objectStoreNames.contains("kv")) d.createObjectStore("kv");                    // key: userId + ":" + name
        if (!d.objectStoreNames.contains("outbox")) d.createObjectStore("outbox", { keyPath: "opId" });
        if (!d.objectStoreNames.contains("photoq")) d.createObjectStore("photoq", { keyPath: "path" });
      };
      rq.onsuccess = function () { _db = rq.result; _db.onversionchange = function () { try { _db.close(); } catch (e) {} _db = null; }; res(_db); };
      rq.onerror = function () { rej(rq.error || new Error("IndexedDB åpnet ikke")); };
      rq.onblocked = function () { rej(new Error("IndexedDB blokkert (annen fane)")); };
      setTimeout(function () { rej(new Error("IndexedDB tidsavbrudd")); }, 4000);
    });
  }
  function tx(store, mode, fn) {
    return open().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode), s = t.objectStore(store), out = fn(s);
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : undefined); };
        t.onerror = function () { rej(t.error || new Error("IndexedDB-feil")); };
        t.onabort = function () { rej(t.error || new Error("IndexedDB avbrutt (full lagring?)")); };
      });
    });
  }
  function getAll(store) { return tx(store, "readonly", function (s) { return s.getAll(); }); }

  /* ---------- persisted identity (offline session rule) ---------- */
  function persistedIdentity(sbRef) {
    try {
      var raw = localStorage.getItem("sb-" + sbRef + "-auth-token"); if (!raw) return null;
      var j = JSON.parse(raw); var u = (j && (j.user || (j.currentSession && j.currentSession.user))) || null;
      return u && u.id ? { id: u.id, email: u.email || "" } : null;
    } catch (e) { return null; }
  }

  /* ---------- per-user read-cache (kv snapshots) ---------- */
  function cachePut(userId, name, value) {
    return tx("kv", "readwrite", function (s) { s.put({ v: value, ts: Date.now() }, userId + ":" + name); });
  }
  function cacheGet(userId, name) {
    return tx("kv", "readonly", function (s) { return s.get(userId + ":" + name); }).then(function (r) { return r || null; });
  }

  /* ---------- outbox ---------- */
  function uuid() { return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : "op-" + Date.now() + "-" + Math.random().toString(36).slice(2); }
  function queueOp(op) {   // REJECTS on IDB failure — the caller surfaces it loudly (C1)
    op.opId = op.opId || uuid();
    op.status = "queued"; op.attempts = 0; op.nextAt = 0; op.clientTs = op.clientTs || new Date().toISOString();
    return tx("outbox", "readwrite", function (s) { s.put(op); }).then(function () { return op; });
  }
  function setOp(op) { return tx("outbox", "readwrite", function (s) { s.put(op); }); }
  function delOp(opId) { return tx("outbox", "readwrite", function (s) { s.delete(opId); }); }
  function listOps(userId) {
    return getAll("outbox").then(function (all) {
      return (all || []).filter(function (o) { return o.userId === userId; })
        .sort(function (a, b) { return (a.clientTs || "") < (b.clientTs || "") ? -1 : 1; });   // FIFO
    });
  }

  /* ---------- photo queue (two-phase) ---------- */
  function queuePhoto(p) {   // { path, userId, buildingId, dataUrl } — path IS the idempotency key
    p.status = "queued"; p.attempts = 0; p.nextAt = 0; p.queuedAt = Date.now();
    return tx("photoq", "readwrite", function (s) { s.put(p); }).then(function () { return p; });
  }
  function setPhoto(p) { return tx("photoq", "readwrite", function (s) { s.put(p); }); }
  function delPhoto(path) { return tx("photoq", "readwrite", function (s) { s.delete(path); }); }
  function listPhotos(userId) {
    return getAll("photoq").then(function (all) {
      return (all || []).filter(function (p) { return p.userId === userId; })
        .sort(function (a, b) { return (a.queuedAt || 0) - (b.queuedAt || 0); });
    });
  }
  function getPhoto(path) { return tx("photoq", "readonly", function (s) { return s.get(path); }).then(function (r) { return r || null; }); }
  function dataUrlToBlob(dataUrl) {
    var parts = dataUrl.split(","), bin = atob(parts[1]), mime = (parts[0].match(/data:([^;]+)/) || [])[1] || "image/jpeg";
    var arr = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  /* ---------- pending counts (the header chip) ---------- */
  function countPending(userId) {
    return Promise.all([listOps(userId), listPhotos(userId)]).then(function (r) {
      var ops = r[0].filter(function (o) { return o.status !== "rejected"; }).length;
      var rejected = r[0].filter(function (o) { return o.status === "rejected"; }).length
                   + r[1].filter(function (p) { return p.status === "rejected"; }).length;   // rejected PHOTOS count too — nothing unsynced may hide from the chip
      var photos = r[1].filter(function (p) { return p.status === "queued" || p.status === "sending" || p.status === "held"; }).length;
      return { ops: ops, photos: photos, rejected: rejected, total: ops + photos + rejected };
    });
  }

  /* ---------- drain (foreground; open/online/visibilitychange) ---------- */
  var _draining = false;
  function classifyError(err) {
    var m = ((err && err.message) || "") + " " + ((err && err.code) || "");
    if (/42501|row-level security|permission|403|401|JWT/i.test(m)) return "rejected";
    return "retry";
  }
  function backoff(attempts) { return Math.min(BACKOFF_BASE_MS * Math.pow(2, attempts), BACKOFF_MAX_MS); }
  function drain(sb, userId, onChange) {
    if (_draining || !navigator.onLine || !sb || !userId) return Promise.resolve(false);
    _draining = true;
    var changed = false, now = Date.now();
    function note() { changed = true; if (onChange) onChange(); }
    return listOps(userId).then(function (ops) {
      var run = ops.filter(function (o) {
        if (o.status === "rejected" || o.status === "held") return false;
        if (o.status === "sending" && now - (o.sendingAt || 0) < 60000) return false;   // in-flight elsewhere; stale 'sending' (crash) re-runs
        return (o.nextAt || 0) <= now;
      });
      var chain = Promise.resolve();
      run.forEach(function (o) {
        chain = chain.then(function () {
          o.status = "sending"; o.sendingAt = Date.now();
          return setOp(o).then(function () { if (onChange) onChange(); })
            .then(function () {
              if (o.entity === "completion_proof" && o.op === "insert") {
                return sb.from("completion_proof").upsert(o.payload, { onConflict: "id" });   // idempotent on the client uuid
              }
              return { error: { message: "ukjent op-type: " + o.entity + "/" + o.op } };
            })
            .then(function (r) {
              if (!r || !r.error) { return delOp(o.opId).then(note); }   // acked → the server row IS the record
              if (classifyError(r.error) === "rejected") { o.status = "rejected"; o.lastError = (r.error.message || "avvist"); return setOp(o).then(note); }
              o.attempts = (o.attempts || 0) + 1; o.lastError = (r.error.message || "nettverksfeil");
              o.status = o.attempts >= ATTEMPT_CAP ? "held" : "queued";
              o.nextAt = Date.now() + backoff(o.attempts);
              return setOp(o).then(note);
            });
        });
      });
      return chain;
    }).then(function () { return drainPhotos(sb, userId, onChange); })
      .then(function () { _draining = false; return changed; })
      .catch(function () { _draining = false; return changed; });
  }
  function drainPhotos(sb, userId, onChange) {
    var now = Date.now();
    return listPhotos(userId).then(function (ps) {
      var chain = Promise.resolve();
      ps.forEach(function (p) {
        chain = chain.then(function () {
          if (p.status === "uploaded") {   // GC after grace
            if (now - (p.uploadedAt || 0) > PHOTO_GC_GRACE_MS) return delPhoto(p.path);
            return null;
          }
          if (p.status === "rejected" || p.status === "held") return null;
          if ((p.nextAt || 0) > now) return null;
          p.status = "sending"; p.sendingAt = Date.now();
          return setPhoto(p)
            .then(function () { return sb.storage.from("photos").upload(p.path, dataUrlToBlob(p.dataUrl), { contentType: "image/jpeg", upsert: true }); })
            .then(function (r) {
              if (!r || !r.error || /already exists|duplicate/i.test((r.error && r.error.message) || "")) {
                p.status = "uploaded"; p.uploadedAt = Date.now();   // keep the local blob through the grace window
              } else if (classifyError(r.error) === "rejected") { p.status = "rejected"; p.lastError = r.error.message || "avvist"; }
              else { p.attempts = (p.attempts || 0) + 1; p.lastError = r.error.message || "nettverksfeil"; p.status = p.attempts >= ATTEMPT_CAP ? "held" : "queued"; p.nextAt = Date.now() + backoff(p.attempts); }
              return setPhoto(p).then(function () { if (onChange) onChange(); });
            });
        });
      });
      return chain;
    });
  }
  function retryHeld(userId) {   // manual "prøv igjen" from the outbox list — resets held → queued
    return Promise.all([listOps(userId), listPhotos(userId)]).then(function (r) {
      var chain = Promise.resolve();
      r[0].forEach(function (o) { if (o.status === "held") { o.status = "queued"; o.attempts = 0; o.nextAt = 0; chain = chain.then(function () { return setOp(o); }); } });
      r[1].forEach(function (p) { if (p.status === "held") { p.status = "queued"; p.attempts = 0; p.nextAt = 0; chain = chain.then(function () { return setPhoto(p); }); } });
      return chain;
    });
  }
  function discardAll(userId) {   // explicit, double-confirmed by the APP (sign-out guard "Forkast")
    return Promise.all([listOps(userId), listPhotos(userId)]).then(function (r) {
      var chain = Promise.resolve();
      r[0].forEach(function (o) { chain = chain.then(function () { return delOp(o.opId); }); });
      r[1].forEach(function (p) { chain = chain.then(function () { return delPhoto(p.path); }); });
      return chain;
    });
  }

  /* ---------- service worker registration + the quiet "ny versjon" hint ---------- */
  function registerSW(onUpdateReady) {
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("sw.js").then(function (reg) {
      function watch(w) { if (!w) return; w.addEventListener("statechange", function () {
        if (w.state === "installed" && navigator.serviceWorker.controller) onUpdateReady && onUpdateReady(reg); }); }
      watch(reg.installing);
      reg.addEventListener("updatefound", function () { watch(reg.installing); });
      if (reg.waiting && navigator.serviceWorker.controller) onUpdateReady && onUpdateReady(reg);
    }).catch(function () { /* SW is progressive enhancement — the app still runs without it */ });
  }
  function applyUpdate(reg) {
    if (reg && reg.waiting) {
      navigator.serviceWorker.addEventListener("controllerchange", function () { location.reload(); });
      reg.waiting.postMessage({ type: "SKIP_WAITING" });
    }
  }

  window.OnsiteOffline = {
    persistedIdentity: persistedIdentity,
    cachePut: cachePut, cacheGet: cacheGet,
    uuid: uuid, queueOp: queueOp, listOps: listOps, delOp: delOp, setOp: setOp,
    queuePhoto: queuePhoto, listPhotos: listPhotos, getPhoto: getPhoto, delPhoto: delPhoto,
    countPending: countPending, drain: drain, retryHeld: retryHeld, discardAll: discardAll,
    registerSW: registerSW, applyUpdate: applyUpdate
  };
})();
