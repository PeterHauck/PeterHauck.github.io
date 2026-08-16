// Vercel serverless function: durable cloud storage for the family tree using
// Vercel Blob — no GitHub required. Stores an ENCRYPTED copy of the tree (the
// browser encrypts with the family password first, so only ciphertext is ever
// stored) plus each obituary record (PDF/photo) as its own blob, so the saved
// tree stays small and scales to any number of uploads.
//
// Setup (one time): in the Vercel project → Storage → Create → Blob. That adds
// BLOB_READ_WRITE_TOKEN to the project automatically. IMPORT_PASSCODE gates
// writes so only you can save.
//
// WRITE-ONCE STORAGE: Vercel Blob overwrites are eventually consistent — after
// rewriting a file at the same path, reads can return the OLD bytes for up to a
// minute (and the CDN can cache them far longer). Overwriting in place is what
// kept corrupting the tree (mixed-generation chunks) and serving stale copies.
// So every save now writes to a FRESH, unique path under tree-v/ (and upload
// chunks under a per-upload folder); readers always pick the newest complete
// copy. Old copies are pruned best-effort, keeping the last few as backups.
//
// Actions:
//   GET  ?action=getTree                      → { payload | big+size+url, savedAt, v }
//   GET  ?action=getTreePart&start&len&v      → { chunk, size } (one slice of version v)
//   GET  ?action=treeInfo | passCheck | viewerKey | comments | status
//   POST { action:'saveTree', passcode, payload, check }
//   POST { action:'putPart', passcode, uploadId, index, chunk }
//   POST { action:'commitTree', passcode, uploadId, total, length, check }
//   POST { action:'putRecord' | 'saveViewerKey' | 'addComment' | 'deleteComment', ... }

import { put, list, del, get } from "@vercel/blob";

const TREE = "family-tree.json"; // legacy single-file location (read fallback only)
const TREEDIR = "tree-v/";       // versioned, write-once tree copies: tree-v/<id>.json + <id>.check
const PARTSDIR = "tree-parts/";  // upload chunks: tree-parts/<uploadId>/part-<i> (legacy: tree-parts/part-<i>)
const COMMENTS = "comments.json";   // { [personId]: [ {id, name, text, at} ] }
const VIEWERKEY = "viewer-key.json"; // family password wrapped (encrypted) under the shared viewer password
const PASSCHECK = "pass-check.json"; // legacy password-check location (read fallback only)
const KEEP_COPIES = 3;

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// Find the Blob token. Vercel names it BLOB_READ_WRITE_TOKEN by default, but a
// store connected under a custom name gets <PREFIX>_BLOB_READ_WRITE_TOKEN — accept
// either so it works however the store was named.
// Strip stray whitespace and surrounding quotes — a token pasted straight from
// the ".env.local" snippet (BLOB_READ_WRITE_TOKEN="vercel_blob_rw_…") often keeps
// its quotes, which makes Vercel reject it with "Access denied".
const clean = (v) => String(v == null ? "" : v).trim().replace(/^['"]+|['"]+$/g, "");
function blobToken() {
  const direct = clean(process.env.BLOB_READ_WRITE_TOKEN);
  if (direct.startsWith("vercel_blob_rw_")) return direct;
  for (const [k, v] of Object.entries(process.env)) {
    const t = clean(v);
    if (t && (/BLOB_READ_WRITE_TOKEN$/.test(k) || t.startsWith("vercel_blob_rw_"))) return t;
  }
  return direct || null;
}

export const config = { maxDuration: 60 };

/* ===================== GitHub-backed storage (primary) =====================
   Vercel Blob's free tier allows only 2,000 "advanced operations" a month —
   the tree's instant-save + freshness polling burns through that in a day or
   two, after which Vercel pauses the store for 30 days. GitHub has no such
   metering, the repo token is already configured (it powered the old backup
   feature), and the data is ciphertext anyway. So when GITHUB_TOKEN is set,
   ALL cloud storage lives on an orphan branch of the repo (default
   "family-data") that keeps NO history — every save force-replaces the single
   commit, so the repo never grows. Files on that branch:
     family-cipher.json  – the encrypted tree (same payload the client sends)
     meta.json           – { savedAt, size, check, blobSha }
     comments.json, viewer-key.json, records/<name>
   Client-facing actions are unchanged; putPart returns a part `sha` that the
   client passes back to commitTree. Vercel Blob remains as a fallback backend
   when no GitHub token is configured, and as a read-fallback during migration. */

const GH_REPO = process.env.GITHUB_REPO || "PeterHauck/PeterHauck.github.io";
const GH_BRANCH = process.env.GITHUB_DATA_BRANCH || "family-data";
const GH_BASE = process.env.GITHUB_API_BASE || "https://api.github.com";

export default async function handler(req, res) {
  const passcode = process.env.IMPORT_PASSCODE;
  const token = blobToken();
  const ghToken = clean(process.env.GITHUB_TOKEN);

  // Diagnostic: tells you (without revealing secrets) what the server can see —
  // visit /api/store?action=status to check your setup.
  if (req.method === "GET" && req.query.action === "status") {
    res.status(200).json({ githubConnected: !!ghToken, blobStoreConnected: !!token, importPasscodeSet: !!passcode });
    return;
  }

  // GitHub-backed storage takes over whenever its token is available.
  if (ghToken) { await handleGitHub(req, res, passcode, ghToken); return; }

  if (!token) {
    res.status(503).json({ error: "Cloud save isn't set up yet — the server can't see a Blob store or a GitHub token. In Vercel: add GITHUB_TOKEN (Contents read+write on the repo), then redeploy." });
    return;
  }

  // Cache-buster for reads of the few remaining OVERWRITTEN blobs (comments,
  // viewer key, legacy files). Versioned tree copies are write-once, so their
  // content can never be stale — but busting is harmless there too.
  const fresh = (u) => u + (u.includes("?") ? "&" : "?") + "ts=" + Date.now();
  // Read a blob's content AUTHENTICATED (SDK get() sends the store token). A
  // plain fetch of a blob URL returns "Forbidden" on a PRIVATE Blob store —
  // which is exactly what corrupted reassembly and served unreadable trees.
  // Bypass the CDN cache and retry briefly: a JUST-written blob can 404 for a
  // few seconds while it propagates, and a failed read must never be mistaken
  // for content.
  async function fetchBlobBytes(u) {
    const url = String(u || "").split("?")[0];
    for (let a = 0; a < 5; a++) {
      if (a) await new Promise((resolve) => setTimeout(resolve, 1500));
      try {
        const r = await get(url, { access: "private", token, useCache: false });
        if (r && r.statusCode === 200 && r.stream) {
          const chunks = [];
          for await (const c of r.stream) chunks.push(Buffer.from(c));
          return { bytes: Buffer.concat(chunks), contentType: (r.blob && r.blob.contentType) || "" };
        }
      } catch (e) {}
    }
    return null;
  }
  async function fetchBlobText(u) {
    const r = await fetchBlobBytes(u);
    return r ? r.bytes.toString("utf8") : null;
  }
  async function putBlob(pathname, body, contentType) {
    const base = { token, addRandomSuffix: false, contentType, allowOverwrite: true, cacheControlMaxAge: 60 };
    try { return await put(pathname, body, { ...base, access: "public" }); }
    catch (ePub) { try { return await put(pathname, body, { ...base, access: "private" }); } catch (ePriv) { throw ePub; } }
  }

  // The newest complete tree copy: versioned first, legacy single file as a
  // fallback for data saved by older versions of the app.
  async function newestTree() {
    try {
      const { blobs } = await list({ prefix: TREEDIR, token });
      const trees = blobs.filter((b) => b.pathname.endsWith(".json"));
      if (trees.length) return trees.reduce((a, b) => (Date.parse(a.uploadedAt) >= Date.parse(b.uploadedAt) ? a : b));
    } catch (e) {}
    try { const { blobs } = await list({ prefix: TREE, token }); return blobs.find((x) => x.pathname === TREE) || null; } catch (e) { return null; }
  }
  // Find one specific version by pathname (so multi-slice reads never mix
  // versions). Only tree paths are allowed.
  async function treeByPath(v) {
    if (!v || !(v.startsWith(TREEDIR) || v === TREE)) return null;
    try { const { blobs } = await list({ prefix: v, token }); return blobs.find((x) => x.pathname === v) || null; } catch (e) { return null; }
  }
  // Write a NEW tree copy (never overwrites) + its password-check sibling, then
  // prune old copies, keeping the newest few as backups. Returns the new blob.
  async function writeTree(payload, check) {
    const id = TREEDIR + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const written = await putBlob(id + ".json", payload, "text/plain");
    if (check) { try { await putBlob(id + ".check", String(check).slice(0, 5000), "application/json"); } catch (e) {} }
    try {
      const { blobs } = await list({ prefix: TREEDIR, token });
      const trees = blobs.filter((b) => b.pathname.endsWith(".json")).sort((a, b) => Date.parse(b.uploadedAt) - Date.parse(a.uploadedAt));
      const keep = new Set(trees.slice(0, KEEP_COPIES).map((b) => b.pathname.replace(/\.json$/, "")));
      const gone = blobs.filter((b) => !keep.has(b.pathname.replace(/\.(json|check)$/, "")));
      if (gone.length) await del(gone.map((b) => b.url), { token });
    } catch (e) {}
    return written;
  }

  // Comments live in one small JSON blob, read/written only through this function
  // (never exposed as a public URL) so they aren't world-readable.
  async function readComments() {
    try { const { blobs } = await list({ prefix: COMMENTS, token }); const b = blobs.find((x) => x.pathname === COMMENTS); if (!b) return {}; const t = await fetchBlobText(b.downloadUrl || b.url); return JSON.parse(t || "{}") || {}; }
    catch (e) { return {}; }
  }
  async function putComments(map) {
    const body = JSON.stringify(map);
    const base = { token, addRandomSuffix: false, contentType: "application/json", allowOverwrite: true, cacheControlMaxAge: 60 };
    try { return await put(COMMENTS, body, { ...base, access: "private" }); }
    catch (e) { return await put(COMMENTS, body, { ...base, access: "public" }); }
  }

  try {
    // Lightweight freshness probe: when was the cloud tree last written? Lets a
    // device decide whether the cloud has newer data than its local copy WITHOUT
    // downloading (or decrypting) the whole tree.
    if (req.method === "GET" && req.query.action === "treeInfo") {
      const b = await newestTree();
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ exists: !!b, savedAt: b ? (Date.parse(b.uploadedAt) || 0) : 0 });
      return;
    }

    // The tiny password-check ciphertext written with each tree save. Safe to
    // serve — it's encrypted; it only confirms whether a password matches.
    if (req.method === "GET" && req.query.action === "passCheck") {
      res.setHeader("Cache-Control", "no-store");
      const b = await newestTree();
      if (b && b.pathname.startsWith(TREEDIR)) {
        const base = b.pathname.replace(/\.json$/, "");
        const { blobs } = await list({ prefix: base + ".check", token });
        const cb = blobs.find((x) => x.pathname === base + ".check");
        if (cb) { const t = await fetchBlobText(cb.downloadUrl || cb.url); if (t) { res.status(200).json({ check: t }); return; } }
      }
      const { blobs } = await list({ prefix: PASSCHECK, token });   // legacy location
      const lb = blobs.find((x) => x.pathname === PASSCHECK);
      if (!lb) { res.status(404).json({ error: "No password check saved yet." }); return; }
      const lt = await fetchBlobText(lb.downloadUrl || lb.url);
      if (lt == null) { res.status(503).json({ error: "Password check unreadable — try again shortly." }); return; }
      res.status(200).json({ check: lt });
      return;
    }

    // The wrapped family password for the shared viewer password. It's ciphertext
    // (only the viewer password opens it), so serving it to anyone is safe.
    if (req.method === "GET" && req.query.action === "viewerKey") {
      const { blobs } = await list({ prefix: VIEWERKEY, token });
      const b = blobs.find((x) => x.pathname === VIEWERKEY);
      res.setHeader("Cache-Control", "no-store");
      if (!b) { res.status(404).json({ error: "No viewer password is set." }); return; }
      const wt = await fetchBlobText(b.downloadUrl || b.url);
      if (wt == null) { res.status(503).json({ error: "Viewer key unreadable — try again shortly." }); return; }
      res.status(200).json({ wrap: wt });
      return;
    }

    // Comments for a person (or all). Open to anyone with the link (family view).
    if (req.method === "GET" && req.query.action === "comments") {
      const all = await readComments();
      res.setHeader("Cache-Control", "no-store");
      const pid = req.query.personId;
      if (pid) { res.status(200).json({ comments: Array.isArray(all[pid]) ? all[pid] : [] }); return; }
      res.status(200).json({ comments: all });
      return;
    }

    // Read one slice of the tree back through the function (used for big trees so
    // every device can read them without a direct-to-Blob fetch, which can be
    // blocked by CORS on some phones/browsers). Pass v=<pathname> so every slice
    // of a multi-slice read comes from the SAME write-once version.
    if (req.method === "GET" && req.query.action === "getTreePart") {
      const b = (await treeByPath(req.query.v)) || (await newestTree());
      if (!b) { res.status(404).json({ error: "No saved tree in the cloud yet." }); return; }
      const text = await fetchBlobText(b.downloadUrl || b.url);
      if (text == null) { res.status(503).json({ error: "The tree copy isn't readable yet — try again shortly." }); return; }
      const start = Math.max(0, parseInt(req.query.start, 10) || 0);
      const len = Math.min(Math.max(1, parseInt(req.query.len, 10) || 3000000), 4000000);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ chunk: text.slice(start, start + len), size: text.length, v: b.pathname });
      return;
    }

    // Serve a stored record (obituary PDF/photo) through the function, so it
    // works even when the Blob store is private (direct blob URLs would 403).
    if (req.method === "GET" && req.query.action === "getRecord") {
      const p = (req.query.p || "").toString();
      if (!/^records\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)) { res.status(400).json({ error: "Bad record path." }); return; }
      const { blobs } = await list({ prefix: p, token });
      const b = blobs.find((x) => x.pathname === p);
      if (!b) { res.status(404).json({ error: "No such record." }); return; }
      const r = await fetchBlobBytes(b.downloadUrl || b.url);
      if (!r) { res.status(503).json({ error: "The record isn't readable yet — try again shortly." }); return; }
      res.setHeader("Content-Type", r.contentType || "application/octet-stream");
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.status(200).send(r.bytes);
      return;
    }

    if (req.method === "GET" && (req.query.action || "getTree") === "getTree") {
      const b = await newestTree();
      if (!b) { res.status(404).json({ error: "No saved tree in the cloud yet." }); return; }
      const url = b.downloadUrl || b.url;   // direct-URL fast path (public stores only; clients fall back to slices)
      const savedAt = Date.parse(b.uploadedAt) || 0;
      res.setHeader("Cache-Control", "no-store");
      // A big tree would blow the function's ~4.5MB response limit. Tell the client
      // its size so it can read it back in slices through getTreePart (robust), and
      // also hand over the direct blob URL (cache-busted) as a fast path / fallback.
      if ((b.size || 0) > 3.5 * 1024 * 1024) { res.status(200).json({ big: true, size: b.size || 0, url: fresh(url), savedAt, v: b.pathname }); return; }
      const payload = await fetchBlobText(url);
      if (payload == null) { res.status(503).json({ error: "The tree copy isn't readable yet — try again shortly." }); return; }
      res.status(200).json({ payload, url: fresh(url), savedAt, v: b.pathname });
      return;
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const action = body.action || "saveTree";
      // Anyone with view access can leave a comment; everything else (saving the
      // tree, records, deleting comments) is owner-only and needs the passcode.
      const openAction = action === "addComment";
      if (!openAction && passcode && (body.passcode || "") !== passcode) { res.status(401).json({ error: "Wrong import passcode." }); return; }

      if (action === "addComment") {
        const personId = (body.personId || "").toString();
        const name = (body.name || "").toString().trim().slice(0, 60);
        const text = (body.text || "").toString().trim().slice(0, 2000);
        if (!personId || !name || !text) { res.status(400).json({ error: "Need a person, a name, and a comment." }); return; }
        const all = await readComments();
        const listp = Array.isArray(all[personId]) ? all[personId] : [];
        if (listp.length >= 500) { res.status(400).json({ error: "Too many comments here." }); return; }
        const comment = { id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36), name, text, at: Date.now() };
        listp.push(comment); all[personId] = listp;
        await putComments(all);
        res.status(200).json({ ok: true, comment });
        return;
      }
      if (action === "deleteComment") {
        const personId = (body.personId || "").toString();
        const id = (body.id || "").toString();
        const all = await readComments();
        if (Array.isArray(all[personId])) { all[personId] = all[personId].filter((c) => c.id !== id); await putComments(all); }
        res.status(200).json({ ok: true });
        return;
      }

      if (action === "saveTree") {
        const payload = (body.payload || "").toString();
        if (!payload || payload.length > 30 * 1024 * 1024) { res.status(400).json({ error: "Nothing to save (or too large)." }); return; }
        const written = await writeTree(payload, body.check);
        res.status(200).json({ ok: true, savedAt: Date.parse(written.uploadedAt) || Date.now(), size: payload.length });
        return;
      }

      // Large trees are uploaded in pieces so no single request hits Vercel's
      // ~4.5MB body limit. Each upload gets its OWN folder of chunks (write-once,
      // so eventual-consistency can never mix chunks from different saves), then
      // commitTree stitches them into a new versioned tree copy.
      if (action === "putPart") {
        const index = parseInt(body.index, 10);
        if (!(index >= 0 && index < 10000)) { res.status(400).json({ error: "Bad part index." }); return; }
        const chunk = (body.chunk || "").toString();
        if (!chunk || chunk.length > 5 * 1024 * 1024) { res.status(400).json({ error: "Empty or too-large part." }); return; }
        const up = (body.uploadId || "").toString();
        const dir = /^[a-z0-9-]{4,40}$/.test(up) ? PARTSDIR + up + "/" : PARTSDIR;   // legacy clients: shared folder
        await putBlob(dir + "part-" + index, chunk, "text/plain");
        res.status(200).json({ ok: true });
        return;
      }

      if (action === "commitTree") {
        const total = parseInt(body.total, 10);
        if (!(total > 0 && total <= 10000)) { res.status(400).json({ error: "Bad part count." }); return; }
        const up = (body.uploadId || "").toString();
        const dir = /^[a-z0-9-]{4,40}$/.test(up) ? PARTSDIR + up + "/" : PARTSDIR;
        const expected = parseInt(body.length, 10);
        // Old clients (loaded before the write-once rework) still upload chunks
        // to the SHARED legacy folder, where overwrites are eventually
        // consistent — a chunk read moments after writing can be stale. For
        // them, retry assembly a few times before giving up; new clients use
        // write-once folders and assemble correctly on the first pass.
        const attempts = 3;
        let combined = "", failure = "";
        for (let a = 0; a < attempts; a++) {
          if (a) await new Promise((resolve) => setTimeout(resolve, 2000));
          const { blobs } = await list({ prefix: dir + "part-", token });
          const byName = {}; blobs.forEach((x) => (byName[x.pathname] = x));
          combined = ""; failure = "";
          for (let i = 0; i < total; i++) {
            const part = byName[dir + "part-" + i];
            if (!part) { failure = "Missing part " + i + " — please try saving again."; break; }
            const t = await fetchBlobText(part.downloadUrl || part.url);
            if (t == null) { failure = "Part " + i + " isn't readable yet — please try saving again."; break; }
            combined += t;
          }
          // Integrity check: the stitched tree must be exactly as long as what
          // the browser uploaded — a corrupted save is never stored.
          if (!failure && expected > 0 && combined.length !== expected) failure = "The upload didn't reassemble cleanly — please try saving again.";
          if (!failure) break;
        }
        if (failure) { res.status(409).json({ error: failure }); return; }
        const written = await writeTree(combined, body.check);
        try { const { blobs } = await list({ prefix: dir + "part-", token }); if (blobs.length) await del(blobs.map((b) => b.url), { token }); } catch (e) {}   // clean up this upload's chunks
        res.status(200).json({ ok: true, savedAt: Date.parse(written.uploadedAt) || Date.now(), size: combined.length });
        return;
      }

      if (action === "saveViewerKey") {   // owner-only (passcode gate above)
        const wrap = (body.wrap || "").toString();
        if (!wrap || wrap.length > 10000) { res.status(400).json({ error: "Bad viewer key." }); return; }
        await putBlob(VIEWERKEY, wrap, "application/json");
        res.status(200).json({ ok: true });
        return;
      }

      if (action === "putRecord") {
        const name = (body.name || "").toString();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) { res.status(400).json({ error: "Bad record name." }); return; }
        const bytes = Buffer.from((body.base64 || "").toString(), "base64");
        if (!bytes.length || bytes.length > 20 * 1024 * 1024) { res.status(400).json({ error: "Empty or too-large file." }); return; }
        await putBlob("records/" + name, bytes, body.contentType || "application/octet-stream");
        // Hand back a same-site proxy URL rather than the direct blob URL: on a
        // private Blob store the direct URL isn't publicly fetchable.
        res.status(200).json({ ok: true, url: "api/store?action=getRecord&p=" + encodeURIComponent("records/" + name) });
        return;
      }

      res.status(400).json({ error: "Unknown action." });
      return;
    }

    res.status(405).json({ error: "Use GET or POST." });
  } catch (err) {
    console.error("store error", err);
    res.status(500).json({ error: (err && err.message) || "Cloud storage failed." });
  }
}

/* ======================= GitHub storage engine ======================= */

async function handleGitHub(req, res, passcode, ghToken) {
  const hdr = (extra) => ({ Authorization: "Bearer " + ghToken, "User-Agent": "FamilyTree store", "X-GitHub-Api-Version": "2022-11-28", ...extra });
  // JSON API call; 404 → null, other failures → throw with GitHub's message.
  async function gh(method, path, body) {
    const r = await fetch(GH_BASE + path, {
      method,
      headers: hdr({ Accept: "application/vnd.github+json", ...(body ? { "Content-Type": "application/json" } : {}) }),
      body: body ? JSON.stringify(body) : undefined,
    });
    if (r.status === 404) return null;
    if (!r.ok) {
      let m = "GitHub request failed (" + r.status + ")";
      try { m = (await r.json()).message || m; } catch (e) {}
      if (r.status === 401 || r.status === 403) m = "The GitHub token is missing, expired, or lacks Contents read+write permission.";
      throw new Error(m);
    }
    return await r.json();
  }
  // Raw content read; 404 → null.
  async function ghRawBytes(path) {
    const r = await fetch(GH_BASE + path, { headers: hdr({ Accept: "application/vnd.github.raw+json" }) });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error("GitHub read failed (" + r.status + ")");
    return Buffer.from(await r.arrayBuffer());
  }
  const repo = "/repos/" + GH_REPO;
  const ghFile = (p) => ghRawBytes(repo + "/contents/" + p + "?ref=" + encodeURIComponent(GH_BRANCH));
  const ghGitBlob = (sha) => ghRawBytes(repo + "/git/blobs/" + sha);
  const ghMakeBlob = async (content, encoding) => (await gh("POST", repo + "/git/blobs", { content, encoding: encoding || "utf-8" })).sha;
  async function ghHeadSha() {
    const j = await gh("GET", repo + "/git/ref/heads/" + GH_BRANCH);
    return (j && j.object && j.object.sha) || null;
  }
  // Commit a set of already-uploaded blobs onto the data branch as a fresh
  // ORPHAN commit (no parents) that force-replaces the branch head. base_tree
  // carries over every file not being changed (records, comments, …), and the
  // no-history design means the repo never grows with each save.
  async function ghCommitFiles(entries, message) {
    const head = await ghHeadSha();
    let baseTree;
    if (head) { const c = await gh("GET", repo + "/git/commits/" + head); baseTree = c && c.tree && c.tree.sha; }
    // First commit on the data branch: include a vercel.json that turns off
    // deployments for pushes of this branch — otherwise every save would
    // trigger a site build. base_tree carries it forward on later saves.
    if (!head) entries = entries.concat([{ path: "vercel.json", blobSha: await ghMakeBlob('{"git":{"deploymentEnabled":false}}') }]);
    const tree = await gh("POST", repo + "/git/trees", {
      ...(baseTree ? { base_tree: baseTree } : {}),
      tree: entries.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.blobSha })),
    });
    const commit = await gh("POST", repo + "/git/commits", { message, tree: tree.sha, parents: [] });
    if (head) await gh("PATCH", repo + "/git/refs/heads/" + GH_BRANCH, { sha: commit.sha, force: true });
    else await gh("POST", repo + "/git/refs", { ref: "refs/heads/" + GH_BRANCH, sha: commit.sha });
    return commit.sha;
  }
  async function readMeta() {
    const b = await ghFile("meta.json");
    if (!b) return null;
    try { return JSON.parse(b.toString("utf8")); } catch (e) { return null; }
  }
  async function readCommentsGh() {
    const b = await ghFile("comments.json");
    if (!b) return {};
    try { return JSON.parse(b.toString("utf8")) || {}; } catch (e) { return {}; }
  }
  const commitComments = async (all) => ghCommitFiles([{ path: "comments.json", blobSha: await ghMakeBlob(JSON.stringify(all)) }], "Update comments");
  // Store a fresh tree payload (+ its metadata) in one commit.
  async function commitTreePayload(payload, check) {
    const savedAt = Date.now();
    const blobSha = await ghMakeBlob(payload);
    const meta = { savedAt, size: payload.length, check: String(check || "").slice(0, 5000), blobSha };
    const metaSha = await ghMakeBlob(JSON.stringify(meta));
    await ghCommitFiles([{ path: "family-cipher.json", blobSha }, { path: "meta.json", blobSha: metaSha }], "Save family tree");
    return meta;
  }
  const recordType = (name) => (/\.pdf$/i.test(name) ? "application/pdf" : /\.png$/i.test(name) ? "image/png" : /\.webp$/i.test(name) ? "image/webp" : /\.gif$/i.test(name) ? "image/gif" : /\.jpe?g$/i.test(name) ? "image/jpeg" : "application/octet-stream");

  try {
    // GitHub reports a fine-grained token's expiry on every authenticated
    // request; surface it so the app can warn the owner BEFORE saves break.
    if (req.method === "GET" && req.query.action === "tokenHealth") {
      res.setHeader("Cache-Control", "no-store");
      const r = await fetch(GH_BASE + repo, { headers: hdr({ Accept: "application/vnd.github+json" }) });
      if (r.status === 401 || r.status === 403) { res.status(200).json({ ok: false, auth: false }); return; }
      const h = (r.headers.get("github-authentication-token-expiration") || "").trim();
      let expiresAt = null;
      if (h) { const t = Date.parse(h.replace(" UTC", "Z").replace(" ", "T")); if (!isNaN(t)) expiresAt = t; }
      res.status(200).json({ ok: r.ok, expiresAt });
      return;
    }

    if (req.method === "GET" && req.query.action === "treeInfo") {
      const meta = await readMeta();
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ exists: !!meta, savedAt: meta ? meta.savedAt : 0 });
      return;
    }

    if (req.method === "GET" && req.query.action === "passCheck") {
      const meta = await readMeta();
      res.setHeader("Cache-Control", "no-store");
      if (!meta || !meta.check) { res.status(404).json({ error: "No password check saved yet." }); return; }
      res.status(200).json({ check: meta.check });
      return;
    }

    if (req.method === "GET" && req.query.action === "viewerKey") {
      const b = await ghFile("viewer-key.json");
      res.setHeader("Cache-Control", "no-store");
      if (!b) { res.status(404).json({ error: "No viewer password is set." }); return; }
      res.status(200).json({ wrap: b.toString("utf8") });
      return;
    }

    if (req.method === "GET" && req.query.action === "comments") {
      const all = await readCommentsGh();
      res.setHeader("Cache-Control", "no-store");
      const pid = req.query.personId;
      if (pid) { res.status(200).json({ comments: Array.isArray(all[pid]) ? all[pid] : [] }); return; }
      res.status(200).json({ comments: all });
      return;
    }

    if (req.method === "GET" && req.query.action === "getRecord") {
      const p = (req.query.p || "").toString();
      if (!/^records\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)) { res.status(400).json({ error: "Bad record path." }); return; }
      const b = await ghFile(p);
      if (!b) { res.status(404).json({ error: "No such record." }); return; }
      res.setHeader("Content-Type", recordType(p));
      res.setHeader("Cache-Control", "public, max-age=3600");
      res.status(200).send(b);
      return;
    }

    if (req.method === "GET" && req.query.action === "getTreePart") {
      const meta = await readMeta();
      const v = (req.query.v || "").toString() || (meta && meta.blobSha) || "";
      if (!/^[0-9a-f]{40,64}$/.test(v)) { res.status(404).json({ error: "No saved tree in the cloud yet." }); return; }
      const b = await ghGitBlob(v);
      if (!b) { res.status(404).json({ error: "That tree version is gone — reload to get the newest." }); return; }
      const text = b.toString("utf8");
      const start = Math.max(0, parseInt(req.query.start, 10) || 0);
      const len = Math.min(Math.max(1, parseInt(req.query.len, 10) || 3000000), 4000000);
      // A slice is pinned to an immutable content hash — cache it at the edge so
      // repeat loads don't re-download from GitHub.
      res.setHeader("Cache-Control", req.query.v ? "public, s-maxage=31536000, immutable" : "no-store");
      res.status(200).json({ chunk: text.slice(start, start + len), size: text.length, v });
      return;
    }

    if (req.method === "GET" && (req.query.action || "getTree") === "getTree") {
      const meta = await readMeta();
      if (!meta) { res.status(404).json({ error: "No saved tree in the cloud yet." }); return; }
      res.setHeader("Cache-Control", "no-store");
      if ((meta.size || 0) > 3.5 * 1024 * 1024) { res.status(200).json({ big: true, size: meta.size || 0, savedAt: meta.savedAt, v: meta.blobSha }); return; }
      const b = await ghFile("family-cipher.json");
      if (!b) { res.status(503).json({ error: "The tree copy isn't readable yet — try again shortly." }); return; }
      res.status(200).json({ payload: b.toString("utf8"), savedAt: meta.savedAt, v: meta.blobSha });
      return;
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const action = body.action || "saveTree";
      const openAction = action === "addComment";
      if (!openAction && passcode && (body.passcode || "") !== passcode) { res.status(401).json({ error: "Wrong import passcode." }); return; }

      if (action === "addComment") {
        const personId = (body.personId || "").toString();
        const name = (body.name || "").toString().trim().slice(0, 60);
        const text = (body.text || "").toString().trim().slice(0, 2000);
        if (!personId || !name || !text) { res.status(400).json({ error: "Need a person, a name, and a comment." }); return; }
        const all = await readCommentsGh();
        const listp = Array.isArray(all[personId]) ? all[personId] : [];
        if (listp.length >= 500) { res.status(400).json({ error: "Too many comments here." }); return; }
        const comment = { id: Math.random().toString(36).slice(2, 10) + Date.now().toString(36), name, text, at: Date.now() };
        listp.push(comment); all[personId] = listp;
        await commitComments(all);
        res.status(200).json({ ok: true, comment });
        return;
      }
      if (action === "deleteComment") {
        const personId = (body.personId || "").toString();
        const id = (body.id || "").toString();
        const all = await readCommentsGh();
        if (Array.isArray(all[personId])) { all[personId] = all[personId].filter((c) => c.id !== id); await commitComments(all); }
        res.status(200).json({ ok: true });
        return;
      }

      if (action === "saveTree") {
        const payload = (body.payload || "").toString();
        if (!payload || payload.length > 30 * 1024 * 1024) { res.status(400).json({ error: "Nothing to save (or too large)." }); return; }
        const meta = await commitTreePayload(payload, body.check);
        res.status(200).json({ ok: true, savedAt: meta.savedAt, size: payload.length });
        return;
      }

      if (action === "putPart") {
        const index = parseInt(body.index, 10);
        if (!(index >= 0 && index < 10000)) { res.status(400).json({ error: "Bad part index." }); return; }
        const chunk = (body.chunk || "").toString();
        if (!chunk || chunk.length > 5 * 1024 * 1024) { res.status(400).json({ error: "Empty or too-large part." }); return; }
        const sha = await ghMakeBlob(chunk);
        res.status(200).json({ ok: true, sha });
        return;
      }

      if (action === "commitTree") {
        const total = parseInt(body.total, 10);
        if (!(total > 0 && total <= 10000)) { res.status(400).json({ error: "Bad part count." }); return; }
        const shas = Array.isArray(body.shas) ? body.shas.filter((s) => /^[0-9a-f]{40,64}$/.test(String(s))) : [];
        if (shas.length !== total) { res.status(409).json({ error: "Your app just updated — reload the page, then save again." }); return; }
        const expected = parseInt(body.length, 10);
        let combined = "";
        for (let i = 0; i < total; i++) {
          const b = await ghGitBlob(shas[i]);
          if (!b) { res.status(409).json({ error: "Part " + i + " isn't readable yet — please try saving again." }); return; }
          combined += b.toString("utf8");
        }
        if (expected > 0 && combined.length !== expected) { res.status(409).json({ error: "The upload didn't reassemble cleanly — please try saving again." }); return; }
        const meta = await commitTreePayload(combined, body.check);
        res.status(200).json({ ok: true, savedAt: meta.savedAt, size: combined.length });
        return;
      }

      if (action === "saveViewerKey") {
        const wrap = (body.wrap || "").toString();
        if (!wrap || wrap.length > 10000) { res.status(400).json({ error: "Bad viewer key." }); return; }
        await ghCommitFiles([{ path: "viewer-key.json", blobSha: await ghMakeBlob(wrap) }], "Update viewer key");
        res.status(200).json({ ok: true });
        return;
      }

      if (action === "putRecord") {
        const name = (body.name || "").toString();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) { res.status(400).json({ error: "Bad record name." }); return; }
        const b64 = (body.base64 || "").toString();
        if (!b64 || b64.length > 28 * 1024 * 1024) { res.status(400).json({ error: "Empty or too-large file." }); return; }
        await ghCommitFiles([{ path: "records/" + name, blobSha: await ghMakeBlob(b64, "base64") }], "Add record " + name);
        res.status(200).json({ ok: true, url: "api/store?action=getRecord&p=" + encodeURIComponent("records/" + name) });
        return;
      }

      res.status(400).json({ error: "Unknown action." });
      return;
    }

    res.status(405).json({ error: "Use GET or POST." });
  } catch (err) {
    console.error("store github error", err);
    res.status(500).json({ error: (err && err.message) || "Cloud storage failed." });
  }
}
