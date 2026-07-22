// Vercel serverless function: read ONE person's birth & death dates out of an
// obituary — plain text, a PDF, an image, or a link — using Claude. Obituaries
// are full of other dates (marriages, other people's deaths, graduations), so a
// language model is used to attribute the right dates to the right person; naive
// text matching gets this wrong.
//
// Env vars (same as the other functions):
//   ANTHROPIC_API_KEY  – your Anthropic API key (required)
//   IMPORT_PASSCODE    – the passcode the editor must send (required)

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-4-8"; // accuracy matters here (whose date is whose)

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["birthDate", "deathDate", "birthYear", "deathYear"],
  properties: {
    birthDate: { type: "string" },
    deathDate: { type: "string" },
    birthYear: { type: "string" },
    deathYear: { type: "string" },
  },
};

const SYSTEM = `You are given an obituary or memorial record and the name of ONE person. Extract only THAT person's own birth and death dates.

Return using the schema.

Critical rules:
- Report dates for the named person ONLY. Obituaries mention many other dates — the deaths of relatives ("preceded in death by", "She died in 1978"), marriage dates ("married … on …"), graduations, service dates. NEVER use any of those. If a "died"/"born" statement is about someone else, ignore it.
- "birthDate"/"deathDate": the person's EXACT full date as ISO "YYYY-MM-DD", but only when the day AND month are actually stated (e.g. "born July 5, 1906" -> "1906-07-05"). If the month/day aren't given, use "".
- "birthYear"/"deathYear": the year as a string when known (from a full date, a "1906–1991" life span, an age, or a clear statement), otherwise "".
- A life-span header like "Palmer Eide, July 5, 1906 – Aug. 29, 1991" gives both the birth (left) and death (right) dates for the subject.
- Only give a death date/year if the named person is actually deceased.
- Never guess. When a piece isn't clearly stated for THIS person, return "".`;

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&#39;|&rsquo;|&lsquo;/gi, "'").replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/\s+/g, " ").trim();
}
async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = []; for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST." }); return; }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const passcode = process.env.IMPORT_PASSCODE;
  if (!apiKey || !passcode) {
    res.status(503).json({ error: "Date reading isn't configured yet. Set ANTHROPIC_API_KEY and IMPORT_PASSCODE in the Vercel project settings." });
    return;
  }
  let body;
  try { body = await readBody(req); } catch (e) { res.status(400).json({ error: "Bad request body." }); return; }
  if ((body.passcode || "") !== passcode) { res.status(401).json({ error: "Wrong import passcode." }); return; }

  const name = (body.name || "").toString().trim();
  if (!name) { res.status(400).json({ error: "Need a person's name." }); return; }

  const content = [];
  let sourceText = (body.text || "").toString();
  if (body.url) {
    try { const r = await fetch(body.url, { headers: { "user-agent": "Mozilla/5.0 (FamilyTree bot)" } }); if (r.ok) sourceText += "\n\n" + htmlToText(await r.text()); } catch (e) {}
  }
  if (body.file && body.file.data) {
    const mt = body.file.mediaType || "";
    if (mt === "application/pdf") content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: body.file.data } });
    else if (mt.startsWith("image/")) content.push({ type: "image", source: { type: "base64", media_type: mt, data: body.file.data } });
  }
  sourceText = sourceText.slice(0, 24000).trim();
  if (!sourceText && !content.length) { res.status(400).json({ error: "Nothing to read — no text, file, or link." }); return; }

  content.push({ type: "text", text: `Person: "${name}"\n\n${sourceText ? `Obituary / record text:\n"""\n${sourceText}\n"""\n\n` : ""}Extract ${name}'s own birth and death dates.` });

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: MODEL, max_tokens: 400, system: SYSTEM,
      messages: [{ role: "user", content }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    });
    if (resp.stop_reason === "refusal") { res.status(422).json({ error: "The request was declined." }); return; }
    const textBlock = (resp.content || []).find((b) => b.type === "text");
    if (!textBlock) { res.status(502).json({ error: "No result returned." }); return; }
    res.status(200).json(JSON.parse(textBlock.text));
  } catch (err) {
    console.error("dates error", err);
    const status = err && err.status ? err.status : 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: (err && err.message) || "Date reading failed." });
  }
}
