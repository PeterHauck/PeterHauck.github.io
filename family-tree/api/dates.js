// Vercel serverless function: pull one person's exact birth and death dates
// out of obituary text, so saved obituaries can retroactively fill in the
// day/month dates on people's profiles. Cheap + focused (one named person).
//
// Env vars (same as the other functions):
//   ANTHROPIC_API_KEY  – your Anthropic API key (required)
//   IMPORT_PASSCODE    – the passcode the editor must send (required)

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5-20251001"; // fast + inexpensive

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

const SYSTEM = `You extract ONE named person's birth and death dates from an obituary or family record.

Return only that person's dates using the schema.

Rules:
- Only report dates for the SPECIFIED person — ignore dates that belong to relatives, even if they appear in the same text.
- "birthDate"/"deathDate": the EXACT full date as ISO "YYYY-MM-DD", but ONLY when the day and month are actually stated (e.g. "born March 4, 1931" -> "1931-03-04"). If only the year is given, or the full date isn't stated, use "".
- "birthYear"/"deathYear": the year as a string when known, whether or not the full date is; otherwise "".
- Only report a death date/year if the person is stated or clearly implied to be deceased.
- Never guess a day, month, or year that isn't supported by the text. When unsure, return "".`;

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Use POST." }); return; }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const passcode = process.env.IMPORT_PASSCODE;
  if (!apiKey || !passcode) {
    res.status(503).json({ error: "Date extraction isn't configured yet. Set ANTHROPIC_API_KEY and IMPORT_PASSCODE in the Vercel project settings." });
    return;
  }

  let body;
  try { body = await readBody(req); } catch (e) { res.status(400).json({ error: "Bad request body." }); return; }
  if ((body.passcode || "") !== passcode) { res.status(401).json({ error: "Wrong import passcode." }); return; }

  const name = (body.name || "").toString().trim();
  const text = (body.text || "").toString().slice(0, 24000).trim();
  if (!name || !text) { res.status(400).json({ error: "Need a person's name and obituary text." }); return; }

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 400,
      system: SYSTEM,
      messages: [{ role: "user", content: [{ type: "text", text: `Person: "${name}"\n\nObituary / record text:\n"""\n${text}\n"""\n\nExtract ${name}'s birth and death dates.` }] }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    });
    if (resp.stop_reason === "refusal") { res.status(422).json({ error: "The request was declined." }); return; }
    const textBlock = (resp.content || []).find((b) => b.type === "text");
    if (!textBlock) { res.status(502).json({ error: "No result returned." }); return; }
    res.status(200).json(JSON.parse(textBlock.text));
  } catch (err) {
    console.error("dates error", err);
    const status = err && err.status ? err.status : 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: (err && err.message) || "Date extraction failed." });
  }
}
