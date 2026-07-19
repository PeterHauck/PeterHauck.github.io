// Vercel serverless function: fetch an obituary page server-side and return a
// clean text copy, so it can be saved permanently in the app even if the
// original listing later goes offline. Runs server-side to avoid the browser's
// cross-origin (CORS) restrictions.
//
// Gated by IMPORT_PASSCODE so it can't be used as an open web proxy.
// No Anthropic key needed — this only fetches and cleans HTML.

function extractTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (og) return decode(og[1]).trim();
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? decode(t[1]).trim() : "";
}

function decode(s) {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function htmlToText(html) {
  return decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<\/(p|div|br|li|h[1-6]|tr)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .replace(/^\s+|\s+$/gm, "")
    .trim();
}

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST." }); return; }

  const passcode = process.env.IMPORT_PASSCODE;
  if (!passcode) {
    res.status(503).json({ error: "Archiving isn't configured yet. Set IMPORT_PASSCODE in the Vercel project settings." });
    return;
  }

  let body;
  try { body = await readBody(req); } catch (e) { res.status(400).json({ error: "Bad request body." }); return; }
  if ((body.passcode || "") !== passcode) { res.status(401).json({ error: "Wrong import passcode." }); return; }

  const url = (body.url || "").toString();
  if (!/^https?:\/\//i.test(url)) { res.status(400).json({ error: "Enter a valid http(s) link." }); return; }

  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (FamilyTree archiver)" } });
    if (!r.ok) { res.status(502).json({ error: "Couldn't fetch that page (status " + r.status + ")." }); return; }
    const html = await r.text();
    const text = htmlToText(html);
    if (!text) { res.status(422).json({ error: "That page had no readable text." }); return; }
    res.status(200).json({ title: extractTitle(html) || "Saved page", text: text.slice(0, 40000) });
  } catch (err) {
    console.error("archive error", err);
    res.status(500).json({ error: (err && err.message) || "Fetch failed." });
  }
}
