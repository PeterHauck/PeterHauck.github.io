// Vercel serverless function: commit a file into the repository — either the
// (already-encrypted) family-tree backup, or an individual obituary RECORD
// (PDF/image) stored as its own file so the tree itself stays small and scales
// to any number of uploads.
//
// The browser encrypts the tree with the family password BEFORE sending it here,
// so this function (and the repo) only ever hold ciphertext for the backup.
// Record files are the obituary documents themselves (not secret).
//
// Env vars to set in the Vercel project:
//   IMPORT_PASSCODE  – the passcode the editor must send (required)
//   GITHUB_TOKEN     – a fine-grained token with Contents: Read+Write on the repo (required)
//   GITHUB_REPO      – "owner/repo" (optional; defaults to PeterHauck/PeterHauck.github.io)
//   GITHUB_BRANCH    – branch to commit to (optional; defaults to "master")

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// Only ever write inside family-tree/: the backup file, or records/<name>.
// Prevents the endpoint from being used to write arbitrary repo paths.
function resolvePath(rel) {
  if (!rel) return "family-tree/family-data.js";
  if (/^records\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rel) && !rel.includes("..")) return "family-tree/" + rel;
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST." }); return; }

  const passcode = process.env.IMPORT_PASSCODE;
  const token = process.env.GITHUB_TOKEN;
  if (!passcode || !token) {
    res.status(503).json({ error: "Backup isn't configured yet. Set IMPORT_PASSCODE and GITHUB_TOKEN in the Vercel project settings." });
    return;
  }
  const repo = process.env.GITHUB_REPO || "PeterHauck/PeterHauck.github.io";
  const branch = process.env.GITHUB_BRANCH || "master";

  let body;
  try { body = await readBody(req); } catch (e) { res.status(400).json({ error: "Bad request body." }); return; }
  if ((body.passcode || "") !== passcode) { res.status(401).json({ error: "Wrong import passcode." }); return; }

  const path = resolvePath(body.path);
  if (!path) { res.status(400).json({ error: "Invalid path." }); return; }

  // encoding: "utf8" (default) commits text as-is; "base64" commits raw bytes the
  // client already base64-encoded (obituary PDFs/images).
  const raw = (body.content || "").toString();
  if (!raw || raw.length > 20 * 1024 * 1024) { res.status(400).json({ error: "Nothing to save (or too large)." }); return; }
  const ghContent = body.encoding === "base64" ? raw : Buffer.from(raw, "utf8").toString("base64");

  const api = `https://api.github.com/repos/${repo}/contents/${path}`;
  const headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "User-Agent": "FamilyTree backup", "X-GitHub-Api-Version": "2022-11-28" };

  try {
    // Need the current file's SHA to update it in place (omit when it doesn't exist yet).
    let sha;
    const cur = await fetch(api + "?ref=" + encodeURIComponent(branch), { headers });
    if (cur.ok) { try { sha = (await cur.json()).sha; } catch (e) {} }
    else if (cur.status !== 404) { /* transient; still try the PUT */ }

    const put = await fetch(api, {
      method: "PUT",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ message: body.message || "Update family tree", content: ghContent, branch, sha }),
    });
    if (!put.ok) {
      let msg = "GitHub write failed (" + put.status + ").";
      try { msg = (await put.json()).message || msg; } catch (e) {}
      if (put.status === 401 || put.status === 403) msg = "GitHub token is missing or lacks Contents write permission.";
      res.status(502).json({ error: msg });
      return;
    }
    const j = await put.json().catch(() => ({}));
    res.status(200).json({ ok: true, path, commit: j.commit && j.commit.sha });
  } catch (err) {
    console.error("save error", err);
    res.status(500).json({ error: (err && err.message) || "Save failed." });
  }
}
