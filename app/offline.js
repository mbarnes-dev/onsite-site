/* OnSite offline core — doc-80 v1.5 (capture-first + class-B edits). window.OnsiteOffline.
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
  var DB_NAME = "onsite-app-offline", DB_VER = 2;   // v2 (doc-80 v1.5): + review store ("trenger gjennomsyn")
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
        if (!d.objectStoreNames.contains("review")) d.createObjectStore("review", { keyPath: "reviewId" });   // v1.5: LWW losers, device-local
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
    op.rev = 1;   // review-3: merges bump this; ack/fail verify it (a new key can't race an existing writer)
    return tx("outbox", "readwrite", function (s) { s.put(op); }).then(function () { return op; });
  }
  function setOp(op) { return tx("outbox", "readwrite", function (s) { s.put(op); }); }
  function delOp(opId) { return tx("outbox", "readwrite", function (s) { s.delete(opId); }); }
  function getOp(opId) { return tx("outbox", "readonly", function (s) { return s.get(opId); }).then(function (r) { return r || null; }); }
  /* review-3 F-M2/F-M3 — THE OUTBOX INVARIANT: every mutation is a read-check-write inside ONE atomic
   * IndexedDB transaction. No mutator may act on a snapshot older than the step it writes in. txRCW is
   * the single primitive: get(opId) → decide on the CURRENT record → put/delete in the same tx. IDB
   * serializes readwrite transactions on the store, in-process AND across tabs. Every op carries `rev`
   * (bumped by merges); the ack/fail write-backs verify status+rev so a record that changed since the
   * send can never be deleted or clobbered by a stale writer. */
  function txRCW(opId, decide) {   // decide(cur) → {put: op} | {del: true} | null (no-op); resolves the action
    return open().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction("outbox", "readwrite"), s = t.objectStore("outbox");
        var out = null, g = s.get(opId);
        g.onsuccess = function () {
          var cur = g.result || null;
          var act = decide(cur);
          if (act && act.put) s.put(act.put);
          else if (act && act.del && cur) s.delete(opId);
          out = act;
        };
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error || new Error("IndexedDB-feil")); };
        t.onabort = function () { rej(t.error || new Error("IndexedDB avbrutt (full lagring?)")); };
      });
    });
  }
  function claimOp(opId, now) {   // atomic queued→sending claim; also reclaims a stale `sending` (crash recovery)
    return txRCW(opId, function (cur) {
      if (!cur) return null;
      var claimable = cur.status === "queued" || (cur.status === "sending" && now - (cur.sendingAt || 0) >= 60000);
      if (!claimable || (cur.nextAt || 0) > now) return null;
      var c = {}; for (var k in cur) c[k] = cur[k];
      c.status = "sending"; c.sendingAt = now;
      return { put: c };
    }).then(function (act) { return act && act.put ? act.put : null; });
  }
  function ackDeleteOp(opId, sentRev) {   // delete ONLY what was actually sent; a mid-flight change survives
    return txRCW(opId, function (cur) {
      if (!cur) return null;                                          // already gone (user discarded)
      if (cur.status !== "sending" || (cur.rev || 1) !== sentRev) {   // changed since the send → it lives on
        var c = {}; for (var k in cur) c[k] = cur[k];
        c.status = "queued"; c.sendingAt = 0;                          // re-drains with its newer content
        return { put: c };
      }
      return { del: true };
    });
  }
  function failOp(opId, sentRev, mutate) {   // write-back re-verifies the record is still the one we sent
    return txRCW(opId, function (cur) {
      if (!cur || cur.status !== "sending" || (cur.rev || 1) !== sentRev) return null;
      var c = {}; for (var k in cur) c[k] = cur[k];
      mutate(c);
      return { put: c };
    });
  }
  function mergeInto(opId, op) {   // coalesce, atomically: only into a record that is STILL a queued update for the row
    return txRCW(opId, function (cur) {
      if (!cur || cur.status !== "queued" || cur.op !== "update" || cur.entity !== op.entity ||
          !cur.payload || cur.payload.id !== op.payload.id) return null;
      var c = {}; for (var k in cur) c[k] = cur[k];
      var p = {}; for (var pk in c.payload) p[pk] = c.payload[pk];
      if (op.payload.deleted_at) p = { id: p.id, deleted_at: op.payload.deleted_at };   // delete supersedes
      else { for (var nk in op.payload) if (nk !== "id") p[nk] = op.payload[nk]; }      // later value wins per field
      c.payload = p; c.title = op.title || c.title; c.rev = (c.rev || 1) + 1;
      return { put: c };
    }).then(function (act) { return act && act.put ? act.put : null; });
  }
  function rebaseFollower(opId, entity, rowId, newTs) {
    return txRCW(opId, function (cur) {
      if (!cur || cur.status !== "queued" || cur.op !== "update" || cur.entity !== entity ||
          !cur.payload || cur.payload.id !== rowId) return null;
      var c = {}; for (var k in cur) c[k] = cur[k];
      c.baseUpdatedAt = newTs;
      return { put: c };
    });
  }
  /* doc-80 §2 refined (self-conflict fix): ONE pending update op per row. A second edit of the same row
   * while the first is still QUEUED merges its changed fields into the existing op (later value wins per
   * field) and keeps the ORIGINAL baseUpdatedAt — both edits were made on top of that base locally, so it
   * stays the honest base. A soft-delete supersedes pending edits (fields are moot). Never merges into an
   * op in `sending` (queued behind instead; the drain re-bases it on the leader's ack), never across
   * rows/entities, never other users' ops — genuine REMOTE conflicts still fire exactly as v1.5 built. */
  var _acked = {};   // entity:id → updated_at from THIS device's own update acks (session-lived).
  // Third window of the same bug: an edit queued AFTER our own ack but BEFORE the delta pull refreshes
  // the local row still carries the pre-ack base. Upgrading to the acked ts is honest (the edit was made
  // on top of our own applied fields); a genuinely newer REMOTE edit still mismatches → real conflict.
  function ackedBase(op) {
    var ak = _acked[op.entity + ":" + op.payload.id];
    if (ak && (!op.baseUpdatedAt || op.baseUpdatedAt < ak)) op.baseUpdatedAt = ak;
    return op;
  }
  function queueUpdate(op) {
    if (op.op !== "update" || !op.payload || !op.payload.id) return queueOp(op);   // inserts etc. pass through
    return listOps(op.userId).then(function (ops) {
      var pend = ops.filter(function (o) {
        return o.op === "update" && o.entity === op.entity && o.status === "queued" &&
               o.payload && o.payload.id === op.payload.id;
      })[0];
      if (!pend) return queueOp(ackedBase(op));
      // the scan found a candidate on a snapshot — the MERGE itself re-verifies inside one atomic tx
      // (F-M2): if the drain claimed it meanwhile (status sending) the merge refuses and the edit
      // queues BEHIND instead; the drain's rev-verified ack can never delete a mid-flight merge.
      return mergeInto(pend.opId, op).then(function (merged) {
        return merged || queueOp(ackedBase(op));
      });
    });
  }
  function listOps(userId) {
    return getAll("outbox").then(function (all) {
      return (all || []).filter(function (o) { return o.userId === userId; })
        .sort(function (a, b) { return (a.clientTs || "") < (b.clientTs || "") ? -1 : 1; });   // FIFO
    });
  }

  /* ---------- photo queue (two-phase) ---------- */
  function queuePhoto(p) {   // { path, userId, buildingId, dataUrl } — path IS the idempotency key
    // field-findings #1: status "draft" = stored durably at ATTACH time but NOT uploadable yet — the
    // proof op promotes it at queue time. What the sheet shows is what is in IDB, never a DOM file input.
    p.status = p.status || "queued"; p.attempts = 0; p.nextAt = 0; p.queuedAt = Date.now();
    return tx("photoq", "readwrite", function (s) { s.put(p); }).then(function () { return p; });
  }
  function promotePhoto(path) {   // draft → queued (called when the op that references it is queued)
    return getPhoto(path).then(function (p) {
      if (!p) return null;
      p.status = "queued"; p.attempts = 0; p.nextAt = 0;
      return tx("photoq", "readwrite", function (s) { s.put(p); }).then(function () { return p; });
    });
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

  /* ---------- "trenger gjennomsyn" (doc-80 §1 class B: the LWW loser, kept device-local, never silent) ---------- */
  function queueReview(item) {
    item.reviewId = item.reviewId || uuid(); item.ts = item.ts || new Date().toISOString();
    return tx("review", "readwrite", function (s) { s.put(item); }).then(function () { return item; });
  }
  function listReview(userId) {
    return getAll("review").then(function (all) {
      return (all || []).filter(function (r) { return r.userId === userId; })
        .sort(function (a, b) { return (a.ts || "") < (b.ts || "") ? -1 : 1; });
    });
  }
  function delReview(reviewId) { return tx("review", "readwrite", function (s) { s.delete(reviewId); }); }

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
  var _tabId = uuid();
  function classifyError(err) {
    var m = ((err && err.message) || "") + " " + ((err && err.code) || "");
    if (/42501|row-level security|permission|403|401|JWT/i.test(m)) return "rejected";
    return "retry";
  }
  function backoff(attempts) { return Math.min(BACKOFF_BASE_MS * Math.pow(2, attempts), BACKOFF_MAX_MS); }
  /* F-M3: the drain is single-instance ACROSS TABS. Web Locks where available (our Safari/Chrome floor
   * has it); a localStorage heartbeat lease as the fallback. A tab that doesn't get the lock never sends —
   * it only enqueues; the claim transactions are the belt under this suspender. */
  function withDrainLock(fn) {
    if (navigator.locks && navigator.locks.request) {
      return navigator.locks.request("onsite-drain", { ifAvailable: true }, function (lock) {
        if (!lock) return false;
        return fn();
      });
    }
    var K = "onsite-drain-lease", now = Date.now();
    try {
      var cur = JSON.parse(localStorage.getItem(K) || "null");
      if (cur && cur.id !== _tabId && now - cur.ts < 10000) return Promise.resolve(false);
      localStorage.setItem(K, JSON.stringify({ id: _tabId, ts: now }));
    } catch (e) {}
    var hb = setInterval(function () { try { localStorage.setItem(K, JSON.stringify({ id: _tabId, ts: Date.now() })); } catch (e) {} }, 4000);
    function release() { clearInterval(hb); try { var c = JSON.parse(localStorage.getItem(K) || "null"); if (c && c.id === _tabId) localStorage.removeItem(K); } catch (e) {} }
    return Promise.resolve().then(fn).then(function (r) { release(); return r; }, function (e) { release(); throw e; });
  }
  function drain(sb, userId, onChange) {
    if (_draining || !navigator.onLine || !sb || !userId) return Promise.resolve(false);
    return withDrainLock(function () {
      _draining = true;
      var changed = false, now = Date.now();
      function note() { changed = true; if (onChange) onChange(); }
      return listOps(userId).then(function (ops) {
        var run = ops.filter(function (o) {
          if (o.status === "rejected" || o.status === "held") return false;
          if (o.status === "sending" && now - (o.sendingAt || 0) < 60000) return false;   // in-flight elsewhere; stale 'sending' (crash) re-runs
          return (o.nextAt || 0) <= now;
        });
        // a successful update returns the server's NEW updated_at (the .select() plumbing) — queued
        // follower ops for the same row are re-based onto it, each via its own atomic step.
        function rebaseFollowers(o, newTs) {
          if (!newTs) return Promise.resolve();
          _acked[o.entity + ":" + o.payload.id] = newTs;   // remember our own ack (see ackedBase)
          return getAll("outbox").then(function (all) {
            var c2 = Promise.resolve();
            (all || []).forEach(function (f) {
              if (f.opId !== o.opId && f.userId === o.userId) {
                c2 = c2.then(function () { return rebaseFollower(f.opId, o.entity, o.payload.id, newTs); });
              }
            });
            return c2;
          });
        }
        var chain = Promise.resolve();
        run.forEach(function (snap) {
          chain = chain.then(function () {
            // F-M2/F-M3: CLAIM the op atomically (queued→sending in one tx). A concurrent coalesce,
            // discard or another tab's claim makes this return null — we never act on the snapshot.
            return claimOp(snap.opId, Date.now()).then(function (o) {
              if (!o) return null;   // gone, changed, or claimed elsewhere — nothing to send from here
              var sentRev = o.rev || 1;
              if (onChange) onChange();
              return Promise.resolve()
                .then(function () {
                  if (o.op === "insert") {
                    // append/insert (class A + class-B creates): client uuid = idempotency key
                    return sb.from(o.entity).upsert(o.payload, { onConflict: "id" });
                  }
                  if (o.op === "update") {
                    // v1.5 LWW with base-version check (doc-80 §1 class B): 0 rows = CONFLICT (not an
                    // error): server wins; the losing edit goes to "trenger gjennomsyn".
                    var fields = {}; for (var k in o.payload) if (k !== "id") fields[k] = o.payload[k];
                    return sb.from(o.entity).update(fields).eq("id", o.payload.id).eq("updated_at", o.baseUpdatedAt).select()
                      .then(function (r) {
                        if (r.error) return r;                                    // real error → classification below
                        if ((r.data || []).length > 0) {                          // base matched → applied
                          return rebaseFollowers(o, r.data[0] && r.data[0].updated_at).then(function () { return { error: null }; });
                        }
                        return sb.from(o.entity).select("*").eq("id", o.payload.id).maybeSingle().then(function (cur) {
                          if (cur && cur.error) return cur;   // couldn't SEE the winning row → retry later, no review yet
                          return queueReview({
                            userId: o.userId, entity: o.entity, recordId: o.payload.id,
                            buildingId: o.buildingId, tenantId: o.tenantId, recordName: o.title || o.entity,
                            fields: fields, baseUpdatedAt: o.baseUpdatedAt,
                            serverRow: (cur && cur.data) || null,                 // null = row gone server-side
                            serverUpdatedAt: (cur && cur.data && cur.data.updated_at) || null
                          }).then(function () { return { error: null, conflicted: true }; });   // op is DONE (conflict-resolved)
                        });
                      });
                  }
                  return { error: { message: "ukjent op-type: " + o.entity + "/" + o.op } };
                })
                .then(function (r) {
                  if (!r || !r.error) { return ackDeleteOp(o.opId, sentRev).then(note); }   // rev-verified: a mid-flight change survives as queued
                  if (classifyError(r.error) === "rejected") {
                    return failOp(o.opId, sentRev, function (c) { c.status = "rejected"; c.lastError = (r.error.message || "avvist"); }).then(note);
                  }
                  return failOp(o.opId, sentRev, function (c) {
                    c.attempts = (c.attempts || 0) + 1; c.lastError = (r.error.message || "nettverksfeil");
                    c.status = c.attempts >= ATTEMPT_CAP ? "held" : "queued";
                    c.nextAt = Date.now() + backoff(c.attempts);
                  }).then(note);
                })
                .catch(function (e) {   // F-m7: one op's unexpected failure never aborts the rest of the run
                  return failOp(o.opId, sentRev, function (c) {
                    c.attempts = (c.attempts || 0) + 1; c.lastError = (e && e.message) || "uventet feil";
                    c.status = c.attempts >= ATTEMPT_CAP ? "held" : "queued";
                    c.nextAt = Date.now() + backoff(c.attempts);
                  }).then(note).catch(function () {});
                });
            });
          });
        });
        return chain;
      }).then(function () { return drainPhotos(sb, userId, onChange); })
        .then(function () { _draining = false; return changed; })
        .catch(function () { _draining = false; return changed; });
    }).then(function (r) { return r === false ? false : r; });
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
          if (p.status === "rejected" || p.status === "held" || p.status === "draft") return null;   // drafts belong to an open form
          if ((p.nextAt || 0) > now) return null;
          if (!p.dataUrl || typeof p.dataUrl !== "string" || p.dataUrl.indexOf("data:") !== 0) {
            // belt-and-braces (field-findings #1c): a queued photo whose blob is gone/corrupt is
            // surfaced as avvist in the outbox — never a silent skip, never an infinite retry
            p.status = "rejected"; p.lastError = "foto-data mangler på enheten";
            return setPhoto(p).then(function () { if (onChange) onChange(); });
          }
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
    // F-m4: the user's review items go too — "Forkast alt" means the device holds nothing unresolved of theirs
    return Promise.all([listOps(userId), listPhotos(userId), listReview(userId)]).then(function (r) {
      var chain = Promise.resolve();
      r[0].forEach(function (o) { chain = chain.then(function () { return delOp(o.opId); }); });
      r[1].forEach(function (p) { chain = chain.then(function () { return delPhoto(p.path); }); });
      r[2].forEach(function (v) { chain = chain.then(function () { return delReview(v.reviewId); }); });
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
    queuePhoto: queuePhoto, promotePhoto: promotePhoto, listPhotos: listPhotos, getPhoto: getPhoto, delPhoto: delPhoto,
    queueUpdate: queueUpdate,   // self-conflict fix: coalescing queue for class-B update ops
    // review-3: the atomic outbox steps — public so the committed interleaving harness drives them directly
    claimOp: claimOp, ackDeleteOp: ackDeleteOp, failOp: failOp, mergeInto: mergeInto, rebaseFollower: rebaseFollower,
    listReview: listReview, delReview: delReview,   // v1.5: the LWW-loser surface
    countPending: countPending, drain: drain, retryHeld: retryHeld, discardAll: discardAll,
    registerSW: registerSW, applyUpdate: applyUpdate
  };
})();
