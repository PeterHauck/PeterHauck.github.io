# Family Tree Builder

A boundary-less, scrollable family genealogy chart you can build in the browser
and host — behind a password — for family to view. It uses the standard
**pedigree symbols** from the NIH/genome.gov *Your Family Health History* tool,
and can populate itself from obituaries using Claude.

## What it does

- **People** — each person has a name, birth year, optional death year, and an
  optional photo. The photo is cropped to the person's shape.
- **Shapes** (from the health-history document):
  - ⬛ square = male ・ ⚪ circle = female ・ ◇ diamond = unknown/unspecified
  - a **diagonal slash** through the shape = deceased
  - no photo → just the empty shape
- **Relationships**
  - a **horizontal line** between two people = a couple
  - **double red slash** on that line = divorced/separated
  - **dashed** couple line = unmarried partners
  - add a **second couple** for the same person to show a remarriage
- **Children** attach to a *specific couple*, so it's always clear **which
  marriage** a child came from. A child can be marked **adopted** (green dashed
  connector), and can belong to more than one couple — e.g. linked to their
  birth parents *and* the relatives who adopted them, so both show at once.
- **AI import** — paste an obituary (or a link, PDF, or photo) and Claude fills
  in the people and relationships for you to review. (Requires the Vercel
  deployment below.)
- **Obituaries & records** — attach obituaries (and other documents) to a
  person's profile. Save a **durable copy** — paste the text, or upload a
  PDF/photo — so it survives even if the original listing goes offline. You can
  also keep just a **link** and archive it later. A 📄 badge appears on people
  with records; anyone viewing the tree can click it to read them. On the Vercel
  deployment, a link can be fetched and archived to text in one click.
- **Layout** is automatic and even; it re-arranges as you add people. Drag any
  person to fine-tune, and press ✦ to auto-arrange again.
- **Canvas** pans (drag the background) and zooms (scroll / the ± buttons) with
  no boundaries — ⤢ fits everything to the screen.

Click **"Load example family"** on a fresh page to see divorce, remarriage, and
the adopted-cousins case all at once.

## Opening it on your phone

Once it's deployed (either option below), it's just a **web page** — open the
URL in Safari or Chrome on your phone. No app to install. Add it to your home
screen if you want an icon. Family members enter the password to view.

## Building your tree

Everything you do auto-saves in your browser (IndexedDB — it holds photos and
PDFs with no practical size limit, and needs no account or server). Use the
toolbar:

| Button | Action |
| ------ | ------ |
| ☰ | people list + add a person / auto-arrange |
| ✨ | add people from an obituary (Claude reads it) |
| ✥ | Move mode (drag / box-select people) |
| 🧲 | tidy up (line up people on the same level) |
| ⤢ | fit to screen |
| ± | zoom |

Add relatives straight on the tree with the **＋ handles** around each person
(parent above, child below, spouse to the sides), or from the **Relationships**
list on a profile.

**Backing up:** your tree lives in this browser. Use **⬇︎ Download a backup**
now and then to keep an offsite copy (and to move to another device via **⬆︎
Restore from a backup file**). GitHub is **not required** — the repo backup
under *Advanced* is optional.

---

## Hosting

There are two ways to host this. **Vercel is recommended** — it gives you the
custom domain *and* the AI obituary import. GitHub Pages works too but is
static-only (no AI import).

### Option A — Vercel at `family.petermhauck.com` (recommended)

Vercel serves the page and runs the small `api/extract` function that powers the
obituary import (your Anthropic API key stays on the server, never in the
browser).

1. **Create a Vercel project** from this GitHub repo (vercel.com → *Add New… →
   Project* → import `PeterHauck/PeterHauck.github.io`).
2. In the project settings, set **Root Directory** to `family-tree`. That makes
   this folder the site root, so the tree is served at the domain root and the
   function at `/api/extract`.
3. Add **Environment Variables**:
   - `ANTHROPIC_API_KEY` — your Anthropic API key (from console.anthropic.com).
   - `IMPORT_PASSCODE` — any passcode you choose; you'll type it in the editor
     to authorize an import. This stops visitors from spending your API credits.
   - *(That's all that's required.)*

   **Durable cloud save (recommended — no GitHub needed).** So your tree isn't
   only in one browser, turn on **cloud save**: in the Vercel project, go to
   **Storage → Create → Blob**. That adds a `BLOB_READ_WRITE_TOKEN` to the
   project automatically — nothing to copy. Then in the editor, **Save & back
   up → “☁︎ Save to my site now.”** From then on an **encrypted** copy of the
   tree (and each obituary PDF/photo, stored as its own file) saves to your
   site a few seconds after every change, and opens on any device with the
   family password. The browser encrypts before sending, so only ciphertext
   leaves your computer.

   `GITHUB_TOKEN` *(optional, legacy)* — a fine-grained GitHub token with
   **Contents: Read and write** on this repo enables the older “back up to the
   GitHub repo” option under *Advanced* instead. Not needed if you use cloud
   save above. Optional overrides: `GITHUB_REPO` / `GITHUB_BRANCH`.
4. **Add the domain**: project → *Settings → Domains* → add
   `family.petermhauck.com`. Vercel shows you the DNS record to create.
5. **At your domain registrar** (wherever `petermhauck.com` is managed), add the
   DNS record Vercel gave you — typically a `CNAME` for `family` pointing at
   `cname.vercel-dns.com`. Wait a few minutes for it to go live.

Then visit **https://family.petermhauck.com** on any device.

> Your existing personal site at `peterhauck.github.io` is untouched — this is a
> separate deployment.

### Option B — GitHub Pages (static, no AI import)

Merge this folder to the `master` branch and it's live at
**https://peterhauck.github.io/family-tree/**. The obituary import won't work
there (there's no server), but everything else does.

---

## Publishing behind a password

The chart itself is a static page, so it can't do server-side logins for
viewers. Instead it uses **real in-browser encryption** (PBKDF2 + AES-GCM): the
tree is encrypted with a password you choose, and only someone with the password
can decrypt and view it. This works the same on Vercel or GitHub Pages.

1. In the editor, click **🔒 Publish for family** and set a password.
2. It downloads a `family-data.js` file.
3. Replace `family-tree/family-data.js` in this repo with that file and commit
   it (or upload it via GitHub's web UI). Vercel/Pages redeploys automatically.
4. Now anyone visiting the page gets a password prompt; the correct password
   decrypts and shows the tree **read-only**.

Share the link and the password with your family.

### Editing again later

- On the computer where you built it, just open the page — your working copy is
  still in the browser and opens straight into the editor.
- On a different computer, add `?edit=1` to the URL (e.g.
  `family.petermhauck.com/?edit=1`) and enter the password; it decrypts the
  published tree into the editor so you can make changes and re-publish.

> **Security note:** this keeps the data private from casual visitors and search
> engines — the content is genuinely encrypted at rest. It's only as strong as
> the password you choose and share privately. The obituary import is separately
> gated by `IMPORT_PASSCODE`, so only you can trigger (and pay for) AI calls.

## Files

- `index.html` — markup and the password gate
- `styles.css` — styling (light + dark)
- `app.js` — the app: model, auto-layout, rendering, encryption, obituary import
- `api/extract.js` — Vercel serverless function that calls Claude (server-side)
- `package.json` — declares the `@anthropic-ai/sdk` dependency for the function
- `family-data.js` — empty until you publish; holds the encrypted tree
