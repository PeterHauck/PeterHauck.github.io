# Tests

Each file here drives the real page in a real browser: it serves `../family-tree`
over a local http server, opens it, clicks and types like a person would, and
prints one line per thing it checked.

    node tests/run.mjs          # everything
    node tests/mobile-nav.mjs   # just one

They need [Playwright](https://playwright.dev) (`npm i -D playwright`) and a
Chromium for it to drive. If Playwright is installed somewhere unusual, point
`PLAYWRIGHT_MODULE` at its `index.mjs`; if the browser is, set `CHROME_PATH`.

Nothing here touches the live site: each test builds its own small family in
local storage, and every password in a test is a made-up one.
