/* Drawing Hub — window.claude shim for self-hosting.
   Implements the same call contract the page uses inside a Claude Artifact:
   claude.use("db" | "assets" | "downloads" | "sample") -> namespace, or null. */
(function () {
  "use strict";
  const POLL_MS = 2500;
  let mePromise = null;
  const me = () => (mePromise ||= fetch("/api/me", { credentials: "same-origin" })
    .then(r => r.ok ? r.json() : { role: null, caps: {} })
    .catch(() => ({ role: null, caps: {} })));

  const fail = (code, message) => { const e = new Error(message); e.code = code; e.message = message; throw e; };
  async function api(url, opts) {
    let r;
    try { r = await fetch(url, { credentials: "same-origin", ...opts }); }
    catch { fail("unavailable", "network"); }
    if (r.status === 401) fail("revoked", "signed out");
    if (r.status === 403) fail("invalid_argument", "not permitted");
    if (r.status === 413) fail("too_large", "file too large");
    if (!r.ok) {
      let j = null; try { j = await r.json(); } catch {}
      fail((j && j.code) || "unavailable", (j && j.message) || "request failed");
    }
    return r.json();
  }
  const META = { fromCache: false, hasPendingWrites: false };
  const snapOf = (id, data) => ({ id, exists: data != null, data: () => data == null ? undefined : data, metadata: META });

  /* poll a fetcher and push changes to a listener; returns unsubscribe */
  function watch(fetcher, cb, err) {
    let stop = false, last = null, timer = null;
    const tick = async () => {
      if (stop) return;
      try {
        const v = await fetcher();
        const s = JSON.stringify(v.raw);
        if (s !== last) { last = s; cb(v.snap); }
      } catch (e) { if (err) err(e); }
      if (!stop) timer = setTimeout(tick, POLL_MS);
    };
    tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }

  function docRef(p) {
    const segs = p.split("/");
    return {
      id: segs[segs.length - 1],
      path: p,
      async get() {
        const j = await api("/api/db/doc?path=" + encodeURIComponent(p));
        return snapOf(segs[segs.length - 1], j.exists ? j.data : null);
      },
      set: (data) => api("/api/db/doc?path=" + encodeURIComponent(p),
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "set", data }) }).then(() => {}),
      update: (data) => api("/api/db/doc?path=" + encodeURIComponent(p),
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "update", data }) }).then(() => {}),
      delete: () => api("/api/db/doc?path=" + encodeURIComponent(p),
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "delete" }) }).then(() => {}),
      onSnapshot(cb, err) {
        return watch(async () => {
          const j = await api("/api/db/doc?path=" + encodeURIComponent(p));
          const data = j.exists ? j.data : null;
          return { raw: data, snap: snapOf(segs[segs.length - 1], data) };
        }, cb, err);
      },
      collection: (sub) => colRef(p + "/" + sub)
    };
  }

  function colRef(p, filters) {
    const f = filters || { where: [], order: null, limit: 0 };
    const apply = (rows) => {
      let out = rows;
      for (const [field, op, val] of f.where) {
        out = out.filter(r => {
          const v = r.data[field];
          switch (op) {
            case "eq": case "==": return v === val;
            case "ne": case "!=": return v !== val;
            case "lt": case "<": return v < val;
            case "lte": case "<=": return v <= val;
            case "gt": case ">": return v > val;
            case "gte": case ">=": return v >= val;
            case "in": return Array.isArray(val) && val.includes(v);
            case "not-in": return Array.isArray(val) && !val.includes(v);
            case "array-contains": return Array.isArray(v) && v.includes(val);
            default: return true;
          }
        });
      }
      if (f.order) {
        const { field, direction } = f.order, dir = direction === "desc" ? -1 : 1;
        out = out.slice().sort((a, b) => (a.data[field] > b.data[field] ? 1 : a.data[field] < b.data[field] ? -1 : 0) * dir);
      }
      if (f.limit) out = out.slice(0, f.limit);
      return out;
    };
    const querySnap = (rows) => {
      const ds = rows.map(r => snapOf(r.id, r.data));
      return {
        docs: ds, size: ds.length, empty: !ds.length, metadata: META,
        docChanges: () => ds.map((d, i) => ({ type: "added", doc: d, oldIndex: -1, newIndex: i }))
      };
    };
    const load = async () => apply((await api("/api/db/col?path=" + encodeURIComponent(p))).docs);
    return {
      path: p,
      doc: (id) => docRef(p + "/" + (id || Math.random().toString(36).slice(2, 12))),
      async add(data) {
        const j = await api("/api/db/col?path=" + encodeURIComponent(p),
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data }) });
        return docRef(p + "/" + j.id);
      },
      get: async () => querySnap(await load()),
      onSnapshot(cb, err) {
        return watch(async () => { const rows = await load(); return { raw: rows, snap: querySnap(rows) }; }, cb, err);
      },
      where: (field, op, value) => colRef(p, { ...f, where: [...f.where, [field, op, value]] }),
      orderBy: (field, direction) => colRef(p, { ...f, order: { field, direction } }),
      limit: (n) => colRef(p, { ...f, limit: n })
    };
  }

  const DB = { doc: docRef, collection: colRef };

  const ASSETS = {
    async upload(blob, opts) {
      const type = (opts && opts.type) || blob.type || "application/octet-stream";
      return api("/api/assets", { method: "POST", headers: { "content-type": type }, body: blob });
    },
    list: () => api("/api/assets"),
    delete: (id) => api("/api/assets/" + encodeURIComponent(id), { method: "DELETE" }).then(() => {})
  };

  const DOWNLOADS = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = filename || "download";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
  };

  const b64 = (blob) => new Promise((ok, ng) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1]);
    r.onerror = ng;
    r.readAsDataURL(blob);
  });
  async function callSample(input, opts) {
    const o = opts || {};
    const img = o.images && o.images[0];
    const payload = {
      prompt: typeof input === "string" ? input : JSON.stringify(input),
      tier: o.modelTier || "default"
    };
    if (img) { payload.image = await b64(img); payload.imageType = img.type || "image/jpeg"; }
    const j = await api("/api/sample", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload)
    });
    return { text: j.text || "", truncated: false };
  }
  const SAMPLE = Object.assign(callSample, {
    limits: async () => ({ images: true }),
    json: async (input, opts) => {
      const { text } = await callSample(input, opts);
      const cleaned = text.replace(/^[\s\S]*?```(?:json)?/i, "").replace(/```[\s\S]*$/, "").trim() || text.trim();
      try { return JSON.parse(cleaned); } catch {}
      const m = cleaned.match(/[[{][\s\S]*[\]}]/);
      if (m) { try { return JSON.parse(m[0]); } catch {} }
      fail("invalid_argument", "could not parse JSON");
    }
  });

  window.claude = {
    async use(name) {
      const { caps } = await me();
      if (name === "db") return caps.db ? DB : null;
      if (name === "assets") return caps.assets ? ASSETS : null;
      if (name === "downloads") return caps.downloads ? DOWNLOADS : null;
      if (name === "sample") return caps.sample ? SAMPLE : null;
      return null;
    }
  };
})();
