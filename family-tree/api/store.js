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

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// Find the Blob token. Vercel names it BLOB_READ_WRITE_TOKEN by default, but a
// store connected under a custom name gets <PREFIX>_BLOB_READ_WRITE_TOKEN — accept
// either so it works however the store was named.
function blobToken() {
  if (process.env.BLOB_READ_WRITE_TOKEN) return process.env.BLOB_READ_WRITE_TOKEN;
  for (const k of Object.keys(process.env)) if (/BLOB_READ_WRITE_TOKEN$/.test(k) && process.env[k]) return process.env[k];
  return null;
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

  try {
    if (req.method === "GET" && (req.query.action || "getTree") === "getTree") {
      const { blobs } = await list({ prefix: TREE, token });
      const b = blobs.find((x) => x.pathname === TREE);
      if (!b) { res.status(404).json({ error: "No saved tree in the cloud yet." }); return; }
      const r = await fetch(b.url);
      const payload = await r.text();
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ payload });
      return;
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      if (passcode && (body.passcode || "") !== passcode) { res.status(401).json({ error: "Wrong import passcode." }); return; }
      const action = body.action || "saveTree";

      if (action === "saveTree") {
        const payload = (body.payload || "").toString();
        if (!payload || payload.length > 30 * 1024 * 1024) { res.status(400).json({ error: "Nothing to save (or too large)." }); return; }
        await put(TREE, payload, { access: "public", token, addRandomSuffix: false, contentType: "text/plain", allowOverwrite: true });
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
