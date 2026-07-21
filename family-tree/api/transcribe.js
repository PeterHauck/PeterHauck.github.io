// Vercel serverless function: read the text out of an uploaded obituary
// screenshot or PDF using Claude, so a durable, searchable text copy can be
// saved alongside the image/PDF — even if the picture is later lost.
//
// Env vars (same as the other functions):
//   ANTHROPIC_API_KEY  – your Anthropic API key (required)
//   IMPORT_PASSCODE    – the passcode the editor must send (required)

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-haiku-4-5-20251001"; // fast + inexpensive; good at reading documents

const SYSTEM = `You transcribe obituaries and family records. Return ONLY the readable text from the document, keeping the original line breaks and paragraphs. Do not add commentary, headings, or explanations. If there is no readable text, return nothing.`;

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
    res.status(503).json({ error: "Text scraping isn't configured yet. Set ANTHROPIC_API_KEY and IMPORT_PASSCODE in the Vercel project settings." });
    return;
  }

  let body;
  try { body = await readBody(req); } catch (e) { res.status(400).json({ error: "Bad request body." }); return; }
  if ((body.passcode || "") !== passcode) { res.status(401).json({ error: "Wrong import passcode." }); return; }

  const file = body.file;
  if (!file || !file.data) { res.status(400).json({ error: "No file provided." }); return; }
  const mt = (file.mediaType || "").toString();
  let block = null;
  if (mt === "application/pdf") block = { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.data } };
  else if (mt.startsWith("image/")) block = { type: "image", source: { type: "base64", media_type: mt, data: file.data } };
  if (!block) { res.status(400).json({ error: "Upload an image or PDF." }); return; }

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: SYSTEM,
      messages: [{ role: "user", content: [block, { type: "text", text: "Transcribe all the text in this obituary / record exactly." }] }],
    });
    if (resp.stop_reason === "refusal") { res.status(422).json({ error: "The request was declined." }); return; }
    const textBlock = (resp.content || []).find((b) => b.type === "text");
    res.status(200).json({ text: textBlock ? textBlock.text.trim() : "" });
  } catch (err) {
    console.error("transcribe error", err);
    const status = err && err.status ? err.status : 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: (err && err.message) || "Transcription failed." });
  }
}
