// Rink Rabbit Instagram auto-responder
//
// The funnel (mirrors the teescrossedgolf flow):
//   1. Follower opens a DM (or comments the keyword on a post)
//      -> welcome message with a "Yes, send it over!" quick reply
//   2. They tap the button -> we ask for their email
//   3. They send an email -> we save it (Shopify customer + tag) and
//      reply with the discount code + a "Shop Now" button
//
// See README.md for setup and deployment.

import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import config from './config.js';

const {
  VERIFY_TOKEN, // any string you choose; must match the Meta webhook config
  IG_ACCESS_TOKEN, // long-lived Instagram access token
  APP_SECRET, // Meta app secret, used to verify webhook signatures
  SHOPIFY_STORE_DOMAIN, // e.g. rink-rabbit.myshopify.com (optional)
  SHOPIFY_ADMIN_TOKEN, // Admin API access token, shpat_... (optional)
  PORT = 3000,
} = process.env;

const GRAPH = 'https://graph.instagram.com/v23.0';
const SHOPIFY_API_VERSION = '2025-07';
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;

// Light in-memory state. If the process restarts we fall back to treating
// any email-shaped message as the email step, so nothing breaks.
const awaitingEmail = new Map(); // senderId -> timestamp
const seenMessages = new Set(); // message ids, for webhook redelivery dedupe
const welcomedRecently = new Map(); // senderId -> timestamp, avoid welcome spam

const app = express();
app.use(express.json({ verify: (req, _res, buf) => (req.rawBody = buf) }));

app.get('/', (_req, res) => res.send('Rink Rabbit auto-responder is running.'));

// ---------------------------------------------------------------------------
// Webhook verification (Meta calls this once when you save the webhook URL)
// ---------------------------------------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// Webhook events
// ---------------------------------------------------------------------------
app.post('/webhook', (req, res) => {
  // Always ack fast; Meta retries (and eventually disables) slow webhooks.
  res.sendStatus(200);

  if (!verifySignature(req)) {
    console.warn('Dropped event with bad X-Hub-Signature-256.');
    return;
  }
  if (req.body.object !== 'instagram') return;

  for (const entry of req.body.entry ?? []) {
    const accountId = entry.id; // your IG professional account id

    for (const event of entry.messaging ?? []) {
      handleMessagingEvent(event, accountId).catch(logError);
    }
    for (const change of entry.changes ?? []) {
      if (change.field === 'comments') {
        handleComment(change.value, accountId).catch(logError);
      }
    }
  }
});

async function handleMessagingEvent(event, accountId) {
  const senderId = event.sender?.id;
  if (!senderId || senderId === accountId) return; // ignore our own messages
  if (event.message?.is_echo) return;

  const msgId = event.message?.mid;
  if (msgId) {
    if (seenMessages.has(msgId)) return;
    seenMessages.add(msgId);
    if (seenMessages.size > 5000) seenMessages.clear();
  }

  // 2. They tapped "Yes, send it over!" (quick reply or ice-breaker postback)
  const payload = event.message?.quick_reply?.payload ?? event.postback?.payload;
  if (payload === 'SEND_DISCOUNT') {
    awaitingEmail.set(senderId, Date.now());
    await sendText(senderId, config.messages.askEmail);
    return;
  }

  const text = event.message?.text?.trim();
  if (!text) return; // stickers, likes, shares, attachments — stay quiet

  // 3. They sent an email address
  const email = text.match(EMAIL_RE)?.[0];
  if (email) {
    awaitingEmail.delete(senderId);
    await saveLead(email, senderId);
    await sendDiscount(senderId);
    return;
  }

  // Mid-funnel text that isn't an email -> gentle nudge
  if (awaitingEmail.has(senderId)) {
    await sendText(senderId, config.messages.emailNudge);
    return;
  }

  // 1. Anything else starts the funnel (at most once per 24h per person)
  const last = welcomedRecently.get(senderId) ?? 0;
  if (Date.now() - last < 24 * 60 * 60 * 1000) return;
  welcomedRecently.set(senderId, Date.now());
  await sendWelcome({ id: senderId });
}

// Comment-to-DM: someone comments the keyword on any post and we open the
// funnel with a private reply. This is the officially supported stand-in
// for the follow trigger (see README).
async function handleComment(comment, accountId) {
  if (!comment?.id || comment.from?.id === accountId) return;
  const text = (comment.text ?? '').toLowerCase();
  if (!text.includes(config.commentKeyword.toLowerCase())) return;
  await sendWelcome({ comment_id: comment.id });
}

// ---------------------------------------------------------------------------
// Outbound messages
// ---------------------------------------------------------------------------
async function sendWelcome(recipient) {
  await callSendApi(recipient, {
    text: config.messages.welcome,
    quick_replies: [
      {
        content_type: 'text',
        title: config.messages.welcomeButton,
        payload: 'SEND_DISCOUNT',
      },
    ],
  });
}

async function sendDiscount(senderId) {
  await callSendApi(
    { id: senderId },
    {
      attachment: {
        type: 'template',
        payload: {
          template_type: 'generic',
          elements: [
            {
              title: config.messages.deliverCode.replace('{{code}}', config.discountCode),
              buttons: [
                {
                  type: 'web_url',
                  url: config.shopUrl,
                  title: config.messages.shopButton,
                },
              ],
            },
          ],
        },
      },
    }
  );
}

async function sendText(recipientId, text) {
  await callSendApi({ id: recipientId }, { text });
}

async function callSendApi(recipient, message) {
  const res = await fetch(`${GRAPH}/me/messages?access_token=${IG_ACCESS_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient, message }),
  });
  if (!res.ok) {
    throw new Error(`Send API ${res.status}: ${await res.text()}`);
  }
}

// ---------------------------------------------------------------------------
// Lead capture — Shopify customer if configured, local file otherwise
// ---------------------------------------------------------------------------
async function saveLead(email, senderId) {
  try {
    if (SHOPIFY_STORE_DOMAIN && SHOPIFY_ADMIN_TOKEN) {
      await saveToShopify(email);
    } else {
      fs.appendFileSync(
        'leads.jsonl',
        JSON.stringify({ email, senderId, at: new Date().toISOString() }) + '\n'
      );
    }
    console.log(`Captured lead: ${email}`);
  } catch (err) {
    // Never let a capture failure block the discount message.
    logError(err);
  }
}

async function saveToShopify(email) {
  const TAG = 'instagram-follower';
  const existing = await shopifyGraphql(
    `query ($q: String!) { customers(first: 1, query: $q) { nodes { id } } }`,
    { q: `email:${email}` }
  );
  const found = existing.customers?.nodes?.[0];

  if (found) {
    await shopifyGraphql(
      `mutation ($id: ID!, $tags: [String!]!) {
        tagsAdd(id: $id, tags: $tags) { userErrors { message } }
      }`,
      { id: found.id, tags: [TAG] }
    );
  } else {
    const created = await shopifyGraphql(
      `mutation ($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id }
          userErrors { message }
        }
      }`,
      { input: { email, tags: [TAG] } }
    );
    const errs = created.customerCreate?.userErrors;
    if (errs?.length) throw new Error(`Shopify: ${errs.map((e) => e.message).join('; ')}`);
  }
}

async function shopifyGraphql(query, variables) {
  const res = await fetch(
    `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// ---------------------------------------------------------------------------
function verifySignature(req) {
  if (!APP_SECRET) return true; // signature checking disabled
  const header = req.get('X-Hub-Signature-256');
  if (!header || !req.rawBody) return false;
  const expected =
    'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

function logError(err) {
  console.error(err.message ?? err);
}

app.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
  if (!IG_ACCESS_TOKEN) console.warn('IG_ACCESS_TOKEN is not set — sending will fail.');
  if (!VERIFY_TOKEN) console.warn('VERIFY_TOKEN is not set — webhook verification will fail.');
  if (!APP_SECRET) console.warn('APP_SECRET is not set — webhook signatures are NOT checked.');
});
