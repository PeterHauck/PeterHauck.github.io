# Family Tree Builder

A boundary-less, scrollable family genealogy chart you can build in the browser
and host — behind a password — for family to view. It uses the standard
**pedigree symbols** from the NIH/genome.gov *Your Family Health History* tool.

Live at: **https://peterhauck.github.io/family-tree/**

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
  marriage** a child came from. A child can be marked **adopted** (drawn with a
  green dashed connector). A child can belong to more than one couple — e.g.
  connected to their birth parents *and* the relatives who adopted them, so the
  chart shows both at once.
- **Layout** is automatic and even; it re-arranges as you add people. You can
  drag any person to fine-tune, and press ✦ to auto-arrange again.
- **Canvas** pans (drag the background) and zooms (scroll / the ± buttons) with
  no boundaries — ⤢ fits everything to the screen.

Click **"Load example family"** on a fresh page to see divorce, remarriage, and
the adopted-cousins case all at once.

## Building your tree

Everything you do auto-saves in your browser (localStorage). Use the toolbar:

| Button | Action |
| ------ | ------ |
| ＋ | add a person |
| 💍 | add a couple / relationship |
| 👶 | add a child (choose the couple + biological/adopted) |
| ✦ | auto-arrange |
| ⤢ | fit to screen |
| ± | zoom |

**Export / Import** save the tree as a plain `.json` file for backup or moving
between computers.

## Publishing behind a password

The chart is a static site, so it can't do server-side logins. Instead it uses
**real in-browser encryption** (PBKDF2 + AES-GCM): the tree is encrypted with a
password you choose, and only someone with the password can decrypt and view it.

1. In the editor, click **🔒 Publish for family** and set a password.
2. It downloads a `family-data.js` file.
3. Replace `family-tree/family-data.js` in this repo with that file and commit
   it (or upload it via GitHub's web UI).
4. Now anyone visiting **/family-tree/** gets a password prompt; the correct
   password decrypts and shows the tree **read-only**.

Share the link and the password with your family.

### Editing again later

- On the computer where you built it, just open `/family-tree/` — your working
  copy is still in the browser and opens straight into the editor.
- On a different computer, open `/family-tree/?edit=1` and enter the password;
  it decrypts the published tree into the editor so you can make changes and
  re-publish.

> **Security note:** this keeps the data private from casual visitors and search
> engines — the content is genuinely encrypted at rest. It is only as strong as
> the password you choose and the fact that you share it privately. Anyone you
> give the password to can view (and, with `?edit=1`, edit and re-publish) the
> tree. Don't reuse an important password here.

## Files

- `index.html` — markup and the password gate
- `styles.css` — styling (light + dark)
- `app.js` — the whole app: model, auto-layout, rendering, encryption
- `family-data.js` — empty until you publish; holds the encrypted tree
