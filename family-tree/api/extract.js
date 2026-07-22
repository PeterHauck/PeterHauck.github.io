// Vercel serverless function: turn an obituary (pasted text, a link, or an
// uploaded PDF/image) into structured family-tree additions using Claude.
//
// The Anthropic API key lives ONLY in the ANTHROPIC_API_KEY environment
// variable on the server — it is never sent to the browser. Access is gated by
// IMPORT_PASSCODE so visitors can't spend your API credits.
//
// Env vars to set in the Vercel project:
//   ANTHROPIC_API_KEY  – your Anthropic API key (required)
//   IMPORT_PASSCODE    – a passcode you choose; the editor must send it (required)

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-4-8";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["people", "couples", "children"],
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "name", "sex", "birthYear", "deathYear", "birthDate", "deathDate"],
        properties: {
          key: { type: "string" },
          name: { type: "string" },
          sex: { type: "string", enum: ["male", "female", "unknown"] },
          birthYear: { type: "string" },
          deathYear: { type: "string" },
          birthDate: { type: "string" },
          deathDate: { type: "string" },
        },
      },
    },
    couples: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["a", "b", "status"],
        properties: {
          a: { type: "string" },
          b: { type: "string" },
          status: { type: "string", enum: ["married", "divorced", "partners"] },
        },
      },
    },
    children: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["child", "parentA", "parentB", "relationship"],
        properties: {
          child: { type: "string" },
          parentA: { type: "string" },
          parentB: { type: "string" },
          relationship: { type: "string", enum: ["bio", "adopted"] },
        },
      },
    },
  },
};

const SYSTEM = `You extract family relationships from obituaries and similar biographical text to build a family tree.

Return people, couples, and parent-child links using the provided schema.

Rules:
- Give every NEW person a short unique "key" (e.g. "m1", "wife", "child2"). Anywhere you reference a person (in couples or children), use either that key OR — if the person already exists in the tree — their EXACT existing name.
- "sex": use male/female when the text makes it clear (from pronouns, relationship words like son/daughter/husband/wife/mother/father, or clearly gendered names); otherwise "unknown".
- Years are strings. Use "" when unknown. Only include a deathYear if the person is stated or clearly implied to be deceased (e.g. the obituary's subject, "preceded in death by", "the late").
- "birthDate"/"deathDate": the EXACT full date in ISO format "YYYY-MM-DD", but ONLY when the day and month are actually given in the text (e.g. "born March 4, 1931" -> "1931-03-04"; "passed away on July 22, 2026" -> "2026-07-22"). If only the year is known, or the full date isn't stated, use "" — never guess a day or month. Keep birthYear/deathYear filled with the year whenever it's known, whether or not the full date is.
- A "couple" is two partners. Set "b" to "" for a single parent. status: "married" normally; "divorced" for divorces/separations; "partners" for unmarried partners.
- Children attach to the specific couple they belong to (parentA + parentB identify that couple). Set parentB to "" if only one parent is known. relationship: "bio" normally, "adopted" when the text says adopted / raised / took in.
- Handle remarriages by emitting multiple couples for the same person, and put each child under the correct couple.
- Do NOT invent people or relationships that aren't supported by the text. Prefer fewer, well-supported entries.
- If existing people are listed, connect new relationships to them by their exact name rather than creating duplicates.`;

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&rsquo;|&lsquo;/gi, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function readBody(req) {
  if (req.body) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const passcode = process.env.IMPORT_PASSCODE;
  if (!apiKey || !passcode) {
    res.status(503).json({
      error: "Import isn't configured yet. Set ANTHROPIC_API_KEY and IMPORT_PASSCODE in the Vercel project settings.",
    });
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    res.status(400).json({ error: "Bad request body." });
    return;
  }

  if ((body.passcode || "") !== passcode) {
    res.status(401).json({ error: "Wrong import passcode." });
    return;
  }

  // Assemble the source material.
  const content = [];
  let sourceText = (body.text || "").toString();

  if (body.url) {
    try {
      const r = await fetch(body.url, { headers: { "user-agent": "Mozilla/5.0 (FamilyTree bot)" } });
      if (r.ok) sourceText += "\n\n" + htmlToText(await r.text());
    } catch (e) {
      // A failed fetch is non-fatal; the model can still work from any text/file provided.
    }
  }

  if (body.file && body.file.data) {
    const mt = body.file.mediaType || "";
    if (mt === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: body.file.data } });
    } else if (mt.startsWith("image/")) {
      content.push({ type: "image", source: { type: "base64", media_type: mt, data: body.file.data } });
    }
  }

  sourceText = sourceText.slice(0, 24000).trim();
  if (!sourceText && !content.length) {
    res.status(400).json({ error: "Nothing to import — paste text, add a link, or upload a file." });
    return;
  }

  const existing = (Array.isArray(body.existing) ? body.existing : [])
    .map((p) => `- ${p.name}${p.birth ? ` (b. ${p.birth})` : ""}${p.death ? `–${p.death}` : ""}`)
    .join("\n");

  const subject = (body.subject || "").toString().trim();

  content.push({
    type: "text",
    text:
      (subject
        ? `This obituary is primarily about "${subject}", who is ALREADY in the tree. Use that EXACT name for them, connect the relatives to them, and do NOT create a duplicate of them.\n\n`
        : "") +
      `People already in the tree (link to these by their exact name; don't duplicate them):\n${existing || "(none yet)"}\n\n` +
      (sourceText ? `Obituary / source text:\n"""\n${sourceText}\n"""\n\n` : "") +
      `Extract the family members and their relationships.`,
  });

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      system: SYSTEM,
      messages: [{ role: "user", content }],
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
    });

    if (resp.stop_reason === "refusal") {
      res.status(422).json({ error: "The request was declined. Try a different source." });
      return;
    }

    const textBlock = resp.content.find((b) => b.type === "text");
    if (!textBlock) {
      res.status(502).json({ error: "No result returned." });
      return;
    }
    const data = JSON.parse(textBlock.text);
    res.status(200).json(data);
  } catch (err) {
    console.error("extract error", err);
    const status = err && err.status ? err.status : 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: (err && err.message) || "Extraction failed.",
    });
  }
}
