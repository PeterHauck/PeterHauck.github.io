/* Keeps the tree openable with no signal, and quick to open with one.
   Only the app itself is kept here — the page, its script and styles, the
   icons, and the two big libraries the first time they're needed. The family
   data is NOT cached: it lives in the browser's own store and is synced
   through /api, which this never touches.

   The page always comes from the network when there is one, so a new version
   lands as soon as it ships; the copy here is the fallback for when there
   isn't. Adding ?nosw=1 to the address turns it off and clears it. */
const VERSION = "ft-1";
const SHELL = ["./", "./index.html", "./app.js", "./styles.css", "./manifest.webmanifest",
  "./icon-192.png", "./icon-512.png", "./icon-180.png", "./starter.js", "./family-data.js"];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    // one at a time, so one missing file can't fail the whole install
    await Promise.all(SHELL.map((u) => c.add(new Request(u, { cache: "reload" })).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isShell = (url) => /\.(html|js|css|webmanifest)$/.test(url.pathname) || url.pathname.endsWith("/");
const isAsset = (url) => /\.(png|jpg|jpeg|webp|svg|woff2?)$/.test(url.pathname);

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;         // somebody else's server: not ours to cache
  if (url.pathname.includes("/api/")) return;              // the tree itself always goes to the site
  if (isShell(url)) {
    // newest when there's a signal, the kept copy when there isn't
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(VERSION);
        c.put(req, fresh.clone()).catch(() => {});
        return fresh;
      } catch (err) {
        const hit = await caches.match(req, { ignoreSearch: true });
        return hit || caches.match("./index.html") || Response.error();
      }
    })());
    return;
  }
  if (isAsset(url)) {
    e.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const fresh = await fetch(req);
      const c = await caches.open(VERSION);
      c.put(req, fresh.clone()).catch(() => {});
      return fresh;
    })());
  }
});
