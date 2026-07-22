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
// Actions:
//   GET  ?action=getTree                      → { payload } (the encrypted tree, or 404)
//   POST { action:'saveTree', passcode, payload }
//   POST { action:'putRecord', passcode, name, base64, contentType } → { url }

import { put, list } from "@vercel/blob";

const TREE = "family-tree.json";
const COMMENTS = "comments.json";   // { [personId]: [ {id, name, text, at} ] }
const VIEWERKEY = "viewer-key.json"; // family password wrapped (encrypted) under the shared viewer password

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
  // Match by var name (custom-named store) OR by the token's own value prefix,
  // so it's found however the variable ended up named — and cleaned either way.
  for (const [k, v] of Object.entries(process.env)) {
    const t = clean(v);
    if (t && (/BLOB_READ_WRITE_TOKEN$/.test(k) || t.startsWith("vercel_blob_rw_"))) return t;
  }
  return direct || null;
}

export default async function handler(req, res) {
  const passcode = process.env.IMPORT_PASSCODE;
  const token = blobToken();

  // Diagnostic: tells you (without revealing secrets) what the server can see —
  // visit /api/store?action=status to check your setup.
  if (req.method === "GET" && req.query.action === "status") {
    res.status(200).json({ blobStoreConnected: !!token, importPasscodeSet: !!passcode });
    return;
  }

  if (!token) {
    res.status(503).json({ error: "Cloud save isn't set up yet — the server can't see a Blob store. In Vercel: create a Blob store, make sure it's connected to THIS project, then redeploy (env vars only apply to new deployments)." });
    return;
  }

  // Try a public blob first (stable, directly-fetchable URL); if this store only
  // allows private blobs, fall back to private. The tree is read back through
  // this function, so a private tree blob is fine.
  // Vercel Blob serves files through a CDN that caches aggressively: an
  // overwritten blob can keep serving its OLD bytes for up to 30 days at the
  // same URL. Every read of a mutable blob must bust that cache with a unique
  // query param, or devices keep downloading an ancient copy (which then fails
  // to decrypt with the current password — the "stale phone" bug).
  const fresh = (u) => u + (u.includes("?") ? "&" : "?") + "ts=" + Date.now();
  async function putBlob(pathname, body, contentType) {
    const base = { token, addRandomSuffix: false, contentType, allowOverwrite: true, cacheControlMaxAge: 60 };
    try { return await put(pathname, body, { ...base, access: "public" }); }
    catch (ePub) { try { return await put(pathname, body, { ...base, access: "private" }); } catch (ePriv) { throw ePub; } }
  }
  // The tree blob's server-set write time — the authority for "is the cloud newer?"
  async function treeSavedAt() {
    try { const { blobs } = await list({ prefix: TREE, token }); const b = blobs.find((x) => x.pathname === TREE); return b ? (Date.parse(b.uploadedAt) || 0) : 0; }
    catch (e) { return 0; }
  }
  // Comments live in one small JSON blob, read/written only through this function
  // (never exposed as a public URL) so they aren't world-readable.
  async function readComments() {
    try { const { blobs } = await list({ prefix: COMMENTS, token }); const b = blobs.find((x) => x.pathname === COMMENTS); if (!b) return {}; const r = await fetch(fresh(b.downloadUrl || b.url)); return JSON.parse((await r.text()) || "{}") || {}; }
    catch (e) { return {}; }
  }
  // Store comments PRIVATE where the store allows it (they're only ever read back
  // through this function), falling back to public if the store is public-only.
  async function putComments(map) {
    const body = JSON.stringify(map);
    const base = { token, addRandomSuffix: false, contentType: "application/json", allowOverwrite: true };
    try { return await put(COMMENTS, body, { ...base, access: "private" }); }
    catch (e) { return await put(COMMENTS, body, { ...base, access: "public" }); }
  }

  try {
    // Lightweight freshness probe: when was the cloud tree last written? Lets a
    // device decide whether the cloud has newer data than its local copy WITHOUT
    // downloading (or decrypting) the whole tree.
    if (req.method === "GET" && req.query.action === "treeInfo") {
      const { blobs } = await list({ prefix: TREE, token });
      const b = blobs.find((x) => x.pathname === TREE);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ exists: !!b, savedAt: b ? (Date.parse(b.uploadedAt) || 0) : 0 });
      return;
    }

    // The wrapped family password for the shared viewer password. It's ciphertext
    // (only the viewer password opens it), so serving it to anyone is safe.
    if (req.method === "GET" && req.query.action === "viewerKey") {
      const { blobs } = await list({ prefix: VIEWERKEY, token });
      const b = blobs.find((x) => x.pathname === VIEWERKEY);
      res.setHeader("Cache-Control", "no-store");
      if (!b) { res.status(404).json({ error: "No viewer password is set." }); return; }
      const r = await fetch(fresh(b.downloadUrl || b.url));
      res.status(200).json({ wrap: await r.text() });
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
    // blocked by CORS on some phones/browsers).
    if (req.method === "GET" && req.query.action === "getTreePart") {
      const { blobs } = await list({ prefix: TREE, token });
      const b = blobs.find((x) => x.pathname === TREE);
      if (!b) { res.status(404).json({ error: "No saved tree in the cloud yet." }); return; }
      const r = await fetch(fresh(b.downloadUrl || b.url));
      const text = await r.text();
      const start = Math.max(0, parseInt(req.query.start, 10) || 0);
      const len = Math.min(Math.max(1, parseInt(req.query.len, 10) || 3000000), 4000000);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ chunk: text.slice(start, start + len), size: text.length });
      return;
    }

    if (req.method === "GET" && (req.query.action || "getTree") === "getTree") {
      const { blobs } = await list({ prefix: TREE, token });
      const b = blobs.find((x) => x.pathname === TREE);
      if (!b) { res.status(404).json({ error: "No saved tree in the cloud yet." }); return; }
      const url = b.downloadUrl || b.url;   // downloadUrl works for private blobs too
      const savedAt = Date.parse(b.uploadedAt) || 0;
      res.setHeader("Cache-Control", "no-store");
      // A big tree would blow the function's ~4.5MB response limit. Tell the client
      // its size so it can read it back in slices through getTreePart (robust), and
      // also hand over the direct blob URL (cache-busted) as a fast path / fallback.
      if ((b.size || 0) > 3.5 * 1024 * 1024) { res.status(200).json({ big: true, size: b.size || 0, url: fresh(url), savedAt }); return; }
      const r = await fetch(fresh(url));
      const payload = await r.text();
      res.status(200).json({ payload, url: fresh(url), savedAt });
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
        await putBlob(TREE, payload, "text/plain");
        res.status(200).json({ ok: true, savedAt: await treeSavedAt() });
        return;
      }

      // Large trees are uploaded in pieces so no single request hits Vercel's
      // ~4.5MB body limit: the browser POSTs each part, then asks us to commit —
      // we stitch the parts back together and write the one tree blob.
      if (action === "putPart") {
        const index = parseInt(body.index, 10);
        if (!(index >= 0 && index < 10000)) { res.status(400).json({ error: "Bad part index." }); return; }
        const chunk = (body.chunk || "").toString();
        if (!chunk || chunk.length > 5 * 1024 * 1024) { res.status(400).json({ error: "Empty or too-large part." }); return; }
        await putBlob("tree-parts/part-" + index, chunk, "text/plain");
        res.status(200).json({ ok: true });
        return;
      }

      if (action === "commitTree") {
        const total = parseInt(body.total, 10);
        if (!(total > 0 && total <= 10000)) { res.status(400).json({ error: "Bad part count." }); return; }
        const { blobs } = await list({ prefix: "tree-parts/part-", token });
        const byName = {}; blobs.forEach((x) => (byName[x.pathname] = x));
        let combined = "";
        for (let i = 0; i < total; i++) {
          const part = byName["tree-parts/part-" + i];
          if (!part) { res.status(400).json({ error: "Missing part " + i + " — please try saving again." }); return; }
          const r = await fetch(fresh(part.downloadUrl || part.url));
          combined += await r.text();
        }
        // Integrity check: the stitched tree must be exactly as long as what the
        // browser uploaded. Catches a stale CDN-cached part sneaking into the mix
        // (which would corrupt the ciphertext and make it undecryptable).
        const expected = parseInt(body.length, 10);
        if (expected > 0 && combined.length !== expected) { res.status(409).json({ error: "The upload didn't reassemble cleanly — please try saving again." }); return; }
        await putBlob(TREE, combined, "text/plain");
        res.status(200).json({ ok: true, savedAt: await treeSavedAt() });
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
        const r = await put("records/" + name, bytes, { access: "public", token, addRandomSuffix: false, contentType: body.contentType || "application/octet-stream", allowOverwrite: true });
        res.status(200).json({ ok: true, url: r.url });
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
