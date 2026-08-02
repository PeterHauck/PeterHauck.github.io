# Rink Rabbit Instagram Auto-Responder

A small webhook app that runs the same DM funnel as the teescrossedgolf
example:

1. **Welcome message** with a *"Yes, send it over!"* quick-reply button
2. Tap the button → **"Drop your email right here…"**
3. They send an email → it's saved as a **Shopify customer** (tagged
   `instagram-follower`) and they get the **discount code** with a
   **Shop Now** button linking to rinkrabbit.com

All copy, the discount code, and the shop URL live in `config.js` and can be
overridden with environment variables.

## ⚠️ One honest caveat: the "new follower" trigger

Meta's official Instagram API **does not offer a "someone followed you"
trigger** — it's in a limited private beta that only a few partners (notably
ManyChat) have access to. The teescrossedgolf message you screenshotted was
almost certainly sent through ManyChat's beta follow trigger.

What this app uses instead — all officially supported:

- **Someone DMs you anything** → the welcome funnel starts.
- **Comment-to-DM**: someone comments your keyword (default `DISCOUNT`) on any
  post → they get the welcome message as a private reply. Put *"Comment
  DISCOUNT for 15% off"* in your captions/stories/bio and this converts well.
- **Ice breakers**: in Instagram's professional settings you can add tappable
  "Frequently asked questions" that appear when someone opens a chat with you
  — e.g. *"Get my discount"* — which lands in this same funnel.

If the follow-trigger specifically is a must-have today, ManyChat (~$15/mo) is
the realistic option; you can still keep this repo's copy/flow as the design.
The trigger is expected to widen availability over time, and this app's
webhook is where it would plug in when it does.

## Setup

### 1. Instagram + Meta app

You need an Instagram **professional** account (Business or Creator).

1. Go to [developers.facebook.com](https://developers.facebook.com) → Create
   App → type **Business**.
2. Add the **Instagram** product → choose **Instagram API with Instagram
   Login**.
3. Under **API setup with Instagram login**, connect the Rink Rabbit
   Instagram account and **Generate token** — this is your `IG_ACCESS_TOKEN`
   (long-lived, ~60 days; regenerate or set up refresh before expiry).
4. Copy the **App secret** from App settings → Basic → `APP_SECRET`.

### 2. Deploy (Render free tier)

This folder ships a `render.yaml`:

1. [render.com](https://render.com) → New → **Blueprint** → point it at this
   GitHub repo. It picks up `instagram-auto-responder/`.
2. Fill in the environment variables (see `.env.example`).
3. Deploy — note your app URL, e.g. `https://rinkrabbit-ig.onrender.com`.

(Railway, Fly.io, or any Node host works the same: `npm install && npm start`.)

> Render's free tier sleeps after idle and cold-starts in ~30s. Meta retries
> webhook deliveries, so events aren't lost, but replies can be slow after
> idle periods. The $7/mo starter instance removes that.

### 3. Wire up the webhook

In the Meta app dashboard → Instagram → **Set up webhooks**:

1. Callback URL: `https://<your-app>/webhook`
2. Verify token: the same `VERIFY_TOKEN` value you deployed with.
3. Subscribe to the **`messages`** and **`comments`** fields.

### 4. Shopify

1. Create the discount code (default `RABBIT15`): Shopify admin → Discounts →
   Create discount → *Amount off order* → 15%. (The "next 24 hours" line is
   copy — set a real end date on the discount, or reword it in `config.js`.)
2. For email capture into Shopify: admin → Settings → Apps and sales
   channels → Develop apps → create an app with Admin API scopes
   `read_customers` + `write_customers`, install it, and copy the
   `shpat_...` token into `SHOPIFY_ADMIN_TOKEN`. Set `SHOPIFY_STORE_DOMAIN`
   to your `*.myshopify.com` domain.
3. Captured emails appear as customers tagged `instagram-follower`, so you
   can build a Shopify segment / email flow off that tag. If Shopify vars are
   unset, leads append to `leads.jsonl` on the server instead.

Note: creating a customer does **not** opt them into marketing email — that
requires their explicit consent under CAN-SPAM/GDPR. Sending the discount
code in the DM (which this app does) is fine.

### 5. Go live

While the Meta app is in **Development mode**, only Instagram accounts with a
role on the app (you + testers) can talk to the bot — perfect for testing.
To let the general public use it, request **Advanced Access** for
`instagram_business_manage_messages` via App Review (record a short screen
capture of the funnel; approval typically takes a few days).

## Testing locally

```bash
cd instagram-auto-responder
npm install
VERIFY_TOKEN=test IG_ACCESS_TOKEN=x npm start

# webhook verification handshake
curl "localhost:3000/webhook?hub.mode=subscribe&hub.verify_token=test&hub.challenge=123"
# -> 123
```

Then DM your account from a test account: any message → welcome; tap the
button → email ask; send an email → code + Shop Now.

## Flow reference

| Incoming | Bot response |
|---|---|
| Any first DM / keyword comment | Welcome + "Yes, send it over!" quick reply |
| Quick-reply tap (`SEND_DISCOUNT`) | "Drop your email right here…" |
| Message containing an email | Save lead → discount code + Shop Now button |
| Non-email text while we're waiting for one | Gentle nudge to send the email |
| Stickers/likes/attachments, own echoes | Ignored |
