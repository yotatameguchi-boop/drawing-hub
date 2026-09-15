// Drawing Hub — self-hosted server.
// Provides the parts the Claude Artifact runtime normally supplies:
// a document store (db), an asset store (assets), file saving and the AI call.
// No npm dependencies on purpose: the image stays small and there is no supply chain.
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DATA = process.env.DATA_DIR || "/data";
const PORT = +(process.env.PORT || 8080);
const SECRET = process.env.SESSION_SECRET || "";
const PW_EDITOR = process.env.EDITOR_PASSWORD || "";
const PW_VIEWER = process.env.VIEWER_PASSWORD || "";
const AI_KEY = process.env.ANTHROPIC_API_KEY || "";
const AI_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";
const MAX_ASSET = 20 * 1024 * 1024;

if (!SECRET) { console.error("SESSION_SECRET is required"); process.exit(1); }
if (!PW_EDITOR) { console.error("EDITOR_PASSWORD is required"); process.exit(1); }

/* ---------------- storage ---------------- */
const DOCS = path.join(DATA, "docs.json");
const BLOBDIR = path.join(DATA, "blobs");
const BLOBMETA = path.join(DATA, "blobs.json");
let docs = {};
let blobs = {};
let queue = Promise.resolve();

async function boot() {
  await fsp.mkdir(BLOBDIR, { recursive: true });
  docs = await readJson(DOCS, {});
  blobs = await readJson(BLOBMETA, {});
}
async function readJson(f, dflt) {
  try { return JSON.parse(await fsp.readFile(f, "utf8")); } catch { return dflt; }
}
function persist(file, obj) {
  // Serialised writes, tmp file + rename, so a crash can never leave a half-written store.
  queue = queue.then(async () => {
    const tmp = file + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(obj));
    await fsp.rename(tmp, file);
  }).catch(e => console.error("persist failed", e));
  return queue;
}

/* ---------------- paths & access ---------------- */
const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
function validPath(p, wantDoc) {
  if (typeof p !== "string" || !p || p.length > 1000) return null;
  const segs = p.split("/");
  if (segs.length > 16) return null;
  for (const s of segs) if (!SEG.test(s) || s === "." || s === "..") return null;
  if (wantDoc != null && (segs.length % 2 === 0) !== wantDoc) return null;
  return segs;
}
// The app keeps private projects under `vault/`; only editors may see or touch them.
const needsEditor = (p) => p === "vault" || p.startsWith("vault/");
const canRead = (p, role) => !needsEditor(p) || role === "editor";
const canWrite = (p, role) => canRead(p, role);

/* ---------------- sessions ---------------- */
function sign(role) {
  const body = `${role}.${Date.now()}`;
  const mac = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return `${Buffer.from(body).toString("base64url")}.${mac}`;
}
function verify(cookie) {
  if (!cookie) return null;
  const [b, mac] = cookie.split(".");
  if (!b || !mac) return null;
  let body;
  try { body = Buffer.from(b, "base64url").toString("utf8"); } catch { return null; }
  const want = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  const a = Buffer.from(mac), c = Buffer.from(want);
  if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null;
  const [role, ts] = body.split(".");
  if (!["editor", "viewer"].includes(role)) return null;
  if (Date.now() - +ts > 1000 * 60 * 60 * 24 * 30) return null;
  return role;
}
function roleOf(req) {
  const raw = req.headers.cookie || "";
  const hit = raw.split(";").map(s => s.trim()).find(s => s.startsWith("dh="));
  return hit ? verify(decodeURIComponent(hit.slice(3))) : null;
}
const eq = (a, b) => {
  if (!a || !b) return false;
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y);
};

/* ---------------- http helpers ---------------- */
const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "content-length": b.length });
  res.end(b);
};
const text = (res, code, s, type = "text/plain; charset=utf-8") => {
  const b = Buffer.from(s);
  res.writeHead(code, { "content-type": type, "content-length": b.length });
  res.end(b);
};
function body(req, limit = MAX_ASSET) {
  return new Promise((ok, ng) => {
    const chunks = []; let n = 0;
    req.on("data", c => { n += c.length; if (n > limit) { ng(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => ok(Buffer.concat(chunks)));
    req.on("error", ng);
  });
}

/* ---------------- page shell ----------------
   The artifact runtime wraps a page in a small skeleton before serving it.
   We reproduce it here so index.html stays the single source of truth. */
async function page(file) {
  const inner = await fsp.readFile(path.join(ROOT, file), "utf8");
  return `<!doctype html>
<html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<style>:root{color-scheme:light dark}body{margin:0;font:14px system-ui,sans-serif;background:#fafafa}
img{max-width:100%}[hidden]{display:none!important}</style>
<script src="/claude-shim.js"></script>
</head><body>
${inner}
</body></html>`;
}
const LOGIN = `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Drawing Hub</title>
<style>:root{color-scheme:light dark;--bg:#F1F2F6;--card:#fff;--ink:#131C28;--ink3:#8593A4;--line:#D2D9E3;--accent:#234B85}
@media(prefers-color-scheme:dark){:root{--bg:#0B0E13;--card:#171D26;--ink:#E5EBF3;--ink3:#6B7A8D;--line:#2B3441;--accent:#7FA8E8}}
body{background:var(--bg);color:var(--ink);margin:0;min-height:100dvh;display:grid;place-items:center;
font-family:-apple-system,"Hiragino Kaku Gothic ProN","Noto Sans JP",sans-serif;padding:20px}
form{background:var(--card);border-radius:16px;padding:26px;width:min(380px,100%);
box-shadow:0 1px 2px rgba(19,28,40,.06),0 8px 24px rgba(19,28,40,.08)}
h1{font-size:20px;margin:0 0 4px}p{color:var(--ink3);font-size:13px;margin:0 0 18px;line-height:1.7}
input{width:100%;padding:11px 13px;border:1px solid var(--line);border-radius:9px;background:transparent;
color:inherit;font-size:16px;box-sizing:border-box}
button{width:100%;margin-top:12px;padding:12px;border:0;border-radius:9px;background:var(--accent);
color:#fff;font-size:15px;font-weight:500;cursor:pointer}
.err{color:#BC3B2B;font-size:13px;margin-top:10px}</style></head><body>
<form method="post" action="/api/login">
<h1>Drawing Hub</h1><p>合言葉を入力してください。編集用の合言葉なら図面の取り込みとプライベートな工事の閲覧ができます。</p>
<input type="password" name="password" placeholder="合言葉" autofocus required>
<button type="submit">開く</button>ERRSLOT</form></body></html>`;

/* ---------------- server ---------------- */
const srv = http.createServer(async (req, res) => {
  try { await handle(req, res); }
  catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: "server_error" });
  }
});

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const role = roleOf(req);

  if (p === "/claude-shim.js") {
    const js = await fsp.readFile(path.join(HERE, "shim.js"));
    res.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache" });
    return res.end(js);
  }
  if (p === "/healthz") return text(res, 200, "ok");

  if (p === "/api/login" && req.method === "POST") {
    const raw = (await body(req, 4096)).toString();
    const pw = new URLSearchParams(raw).get("password") || (() => { try { return JSON.parse(raw).password; } catch { return ""; } })();
    let r = null;
    if (eq(pw, PW_EDITOR)) r = "editor";
    else if (PW_VIEWER && eq(pw, PW_VIEWER)) r = "viewer";
    if (!r) {
      if ((req.headers.accept || "").includes("application/json")) return json(res, 401, { error: "bad_password" });
      return text(res, 401, LOGIN.replace("ERRSLOT", '<div class="err">合言葉が違います。</div>'), "text/html; charset=utf-8");
    }
    res.writeHead(303, {
      "set-cookie": `dh=${encodeURIComponent(sign(r))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`,
      location: "/"
    });
    return res.end();
  }
  if (p === "/api/logout") {
    res.writeHead(303, { "set-cookie": "dh=; Path=/; Max-Age=0", location: "/" });
    return res.end();
  }

  if (!role) {
    if (p === "/" || p === "/guide" || p === "/login")
      return text(res, 200, LOGIN.replace("ERRSLOT", ""), "text/html; charset=utf-8");
    return json(res, 401, { error: "not_authenticated" });
  }

  if (p === "/" ) return text(res, 200, await page("index.html"), "text/html; charset=utf-8");
  if (p === "/guide") return text(res, 200, await page("guide.html"), "text/html; charset=utf-8");
  if (p === "/api/me") return json(res, 200, {
    role, caps: { db: true, assets: role === "editor", downloads: true, sample: !!AI_KEY }
  });

  /* ---- db ---- */
  if (p === "/api/db/doc") {
    const dp = url.searchParams.get("path") || "";
    if (!validPath(dp, true)) return json(res, 400, { code: "invalid_argument", message: "bad path" });
    if (req.method === "GET") {
      if (!canRead(dp, role)) return json(res, 200, { exists: false });
      const d = docs[dp];
      return json(res, 200, d ? { exists: true, data: d } : { exists: false });
    }
    if (req.method === "POST") {
      if (!canWrite(dp, role)) return json(res, 403, { code: "invalid_argument", message: "not permitted" });
      const { op, data } = JSON.parse((await body(req, 2 * 1024 * 1024)).toString() || "{}");
      if (op === "delete") delete docs[dp];
      else if (op === "update") docs[dp] = { ...(docs[dp] || {}), ...(data || {}) };
      else docs[dp] = data || {};
      await persist(DOCS, docs);
      return json(res, 200, { ok: true });
    }
  }
  if (p === "/api/db/col") {
    const cp = url.searchParams.get("path") || "";
    if (!validPath(cp, false)) return json(res, 400, { code: "invalid_argument", message: "bad path" });
    if (req.method === "GET") {
      if (!canRead(cp, role)) return json(res, 200, { docs: [] });
      const depth = cp.split("/").length + 1;
      const out = [];
      for (const k of Object.keys(docs)) {
        if (!k.startsWith(cp + "/")) continue;
        const segs = k.split("/");
        if (segs.length !== depth) continue;
        out.push({ id: segs[segs.length - 1], data: docs[k] });
      }
      return json(res, 200, { docs: out });
    }
    if (req.method === "POST") {
      if (!canWrite(cp, role)) return json(res, 403, { code: "invalid_argument", message: "not permitted" });
      const { data } = JSON.parse((await body(req, 2 * 1024 * 1024)).toString() || "{}");
      const id = crypto.randomBytes(10).toString("hex");
      docs[`${cp}/${id}`] = data || {};
      await persist(DOCS, docs);
      return json(res, 200, { id });
    }
  }

  /* ---- assets ---- */
  if (p.startsWith("/_blob/")) {
    const id = p.slice(7);
    const meta = blobs[id];
    if (!meta || !/^[0-9a-f]{32}$/.test(id)) return text(res, 404, "not found");
    const f = path.join(BLOBDIR, id);
    let st; try { st = await fsp.stat(f); } catch { return text(res, 404, "not found"); }
    res.writeHead(200, {
      "content-type": meta.contentType, "content-length": st.size,
      "cache-control": "public, max-age=31536000, immutable"
    });
    return fs.createReadStream(f).pipe(res);
  }
  if (p === "/api/assets" && req.method === "GET") {
    const list = Object.entries(blobs).map(([id, m]) => ({ id, url: "/_blob/" + id, ...m }));
    return json(res, 200, {
      assets: list,
      usage: { files: list.length, bytes: list.reduce((n, a) => n + a.sizeBytes, 0), maxFiles: 10000, maxBytes: 5e9 }
    });
  }
  if (p === "/api/assets" && req.method === "POST") {
    if (role !== "editor") return json(res, 403, { code: "not_granted", message: "editor only" });
    const ct = (req.headers["content-type"] || "application/octet-stream").split(";")[0].trim();
    let buf;
    try { buf = await body(req); } catch { return json(res, 413, { code: "too_large", message: "over 20MB" }); }
    if (!buf.length) return json(res, 400, { code: "invalid_request", message: "empty" });
    const id = crypto.randomBytes(16).toString("hex");
    await fsp.writeFile(path.join(BLOBDIR, id), buf);
    blobs[id] = { contentType: ct, sizeBytes: buf.length, createdAt: new Date().toISOString() };
    await persist(BLOBMETA, blobs);
    return json(res, 200, { id, url: "/_blob/" + id, sizeBytes: buf.length, contentType: ct });
  }
  if (p.startsWith("/api/assets/") && req.method === "DELETE") {
    if (role !== "editor") return json(res, 403, { code: "not_granted", message: "editor only" });
    const id = p.slice(12);
    if (blobs[id]) {
      delete blobs[id];
      await fsp.rm(path.join(BLOBDIR, id), { force: true });
      await persist(BLOBMETA, blobs);
    }
    return json(res, 200, { ok: true });
  }

  /* ---- AI ---- */
  if (p === "/api/sample" && req.method === "POST") {
    if (!AI_KEY) return json(res, 503, { code: "not_granted", message: "no api key" });
    const { prompt, image, imageType, tier } = JSON.parse((await body(req, 25 * 1024 * 1024)).toString() || "{}");
    const content = [];
    if (image) content.push({ type: "image", source: { type: "base64", media_type: imageType || "image/jpeg", data: image } });
    content.push({ type: "text", text: String(prompt || "") });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": AI_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: tier === "quick" ? 1200 : 4000,
        messages: [{ role: "user", content }]
      })
    });
    if (!r.ok) {
      const t = await r.text();
      console.error("anthropic", r.status, t.slice(0, 300));
      return json(res, 502, { code: r.status === 429 ? "rate_limited" : "unavailable", message: "ai call failed" });
    }
    const j = await r.json();
    return json(res, 200, { text: (j.content || []).filter(b => b.type === "text").map(b => b.text).join("") });
  }

  return text(res, 404, "not found");
}

await boot();
srv.listen(PORT, () => console.log(`Drawing Hub listening on :${PORT} (data: ${DATA})`));
