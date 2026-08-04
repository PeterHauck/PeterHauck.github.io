/* Camp Snap photo viewer
 *
 * Photos are imported from the camera (a USB drive) into the app's own
 * library (IndexedDB), so browsing/saving/deleting works even after the
 * camera is unplugged. "Delete" moves a photo to the Deleted album, from
 * which it can be restored or purged for good.
 *
 * On browsers with the File System Access API (desktop Chrome/Edge), the
 * app opens the camera folder with write access: deleting a photo also
 * moves the file into a DELETED folder on the camera itself, restoring
 * moves it back, and purging removes it from the camera.
 */

'use strict';

const $ = (id) => document.getElementById(id);

const APP_VER = 8;
const THUMB_SIZE = 480;
const THUMB_VER = 3;
const IMAGE_RE = /\.(jpe?g|png|gif|bmp|webp)$/i;
const CAMERA_TRASH_DIR = 'DELETED';

/* ================= IndexedDB ================= */

const DB_NAME = 'campsnap';
const DB_VERSION = 2;
let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('tombstones')) db.createObjectStore('tombstones', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      // Full-size originals as raw ArrayBuffers: iOS Safari stores Blob/File
      // values as references it can silently invalidate; raw bytes survive.
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    try { result = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.result !== undefined ? result.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

function idbGetAll(store) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

function idbGet(store, key) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

const idbPut = (store, value) => tx(store, 'readwrite', (s) => s.put(value));
const idbDelete = (store, key) => tx(store, 'readwrite', (s) => s.delete(key));

/* ================= State ================= */

const state = {
  photos: new Map(),        // id -> record (blob refs stay lazy/file-backed)
  thumbUrls: new Map(),     // id -> object URL for the thumbnail
  tab: 'main',              // 'main' | 'trash'
  selecting: false,
  selected: new Set(),
  camDirHandle: null,       // live, permission-granted handle to the camera root
  camConnected: false,
};

const photoId = (name, size) => `${name}|${size}`;

/* ---- durable storage for image bytes ---- */

async function saveOriginal(id, blob) {
  const buf = await blob.arrayBuffer();
  await idbPut('blobs', { id, buf, type: blob.type || 'image/jpeg' });
}

// Full-size image for a photo: the sturdy bytes copy first, then a legacy
// stored Blob if it still reads. Null when the copy is lost (re-import heals).
async function getOriginal(p) {
  const sturdy = await idbGet('blobs', p.id).catch(() => null);
  if (sturdy) return new Blob([sturdy.buf], { type: sturdy.type });
  if (p.blob) {
    try { await p.blob.slice(0, 4).arrayBuffer(); return p.blob; } catch (e) { /* dead */ }
  }
  return null;
}

function thumbBlobOf(p) {
  if (p.thumbBuf) return new Blob([p.thumbBuf], { type: 'image/jpeg' });
  return p.thumb || p.blob || null;
}

// One aspect ratio for the whole album (Camp Snap shots all share one).
function albumAspect() {
  for (const p of state.photos.values()) {
    if (p.photoW && p.photoH) return p.photoH / p.photoW;
  }
  return 3 / 4;
}

function photosIn(tab) {
  const status = tab === 'trash' ? 'trash' : 'main';
  return [...state.photos.values()]
    .filter((p) => p.status === status)
    .sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0) || b.name.localeCompare(a.name));
}

/* ================= Init ================= */

async function init() {
  const records = await idbGetAll('photos');
  for (const r of records) state.photos.set(r.id, r);

  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  wireEvents();
  $('ver').textContent = 'v' + APP_VER;

  if (supportsFsAccess()) {
    $('btn-open-camera').hidden = false;
    $('connect-hint').innerHTML = 'Pick the Camp&nbsp;Snap drive (or its <b>DCIM</b> folder) in the dialog. Allow editing so deletes also tidy up the camera.';
  } else if (isIOS()) {
    // iPhone/iPad: the folder picker is unreliable for USB drives, so use the
    // file picker, which reaches the CampSnap drive through the Files app.
    $('btn-pick-files').textContent = 'Import photos…';
    $('btn-pick-files').classList.replace('btn-secondary', 'btn-primary');
    $('connect-hint').innerHTML =
      '<ol>'
      + '<li>Tap <b>Import photos</b>, then <b>Choose Files</b>.</li>'
      + '<li>Tap <b>Browse</b> and open the <b>CampSnap</b> drive, then <b>DCIM</b> and the folder inside it.</li>'
      + '<li>Tap <b>⋯</b> (or long-press a photo) → <b>Select</b> → <b>Select All</b>, then <b>Open</b>.</li>'
      + '</ol>';
  } else {
    if ('webkitdirectory' in document.createElement('input')) $('btn-pick-folder').hidden = false;
  }

  if (state.photos.size === 0) {
    showScreen('connect');
  } else {
    showScreen('album');
    tryReconnectCamera(); // silent; updates the banner when done
  }
  repairLibrary(); // one-time visible pass; fixes thumbs from older app versions

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

const supportsFsAccess = () => 'showDirectoryPicker' in window;
const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/* ================= Screens ================= */

function showScreen(name) {
  $('connect-screen').hidden = name !== 'connect';
  $('album-screen').hidden = name !== 'album';
  $('viewer-screen').hidden = name !== 'viewer';
  if (name === 'connect') {
    $('btn-skip').hidden = state.photos.size === 0;
  }
  if (name === 'album') renderAlbum();
}

/* ================= Album rendering ================= */

function renderAlbum() {
  const list = photosIn(state.tab);
  const grid = $('grid');
  const scrollTop = grid.scrollTop;
  grid.textContent = '';

  const tilePad = `${albumAspect() * 100}%`;
  const frag = document.createDocumentFragment();
  for (const p of list) {
    // A div, not a button: Safari's special button rendering mangles image
    // layout inside buttons on iOS.
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.setAttribute('role', 'button');
    tile.tabIndex = 0;
    tile.dataset.id = p.id;
    if (state.selected.has(p.id)) tile.classList.add('selected');

    // The spacer fixes the tile's shape; the image stretches to fill it, so
    // layout never depends on how (or how badly) a thumbnail was decoded.
    const spacer = document.createElement('div');
    spacer.className = 'tile-spacer';
    spacer.style.paddingTop = tilePad;
    tile.appendChild(spacer);

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = p.name;
    img.src = thumbUrl(p);
    tile.appendChild(img);

    const check = document.createElement('span');
    check.className = 'check';
    check.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7" fill="none" stroke="#1a1206" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    tile.appendChild(check);

    frag.appendChild(tile);
  }
  grid.appendChild(frag);
  grid.scrollTop = scrollTop;

  // Tabs + counts
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === state.tab));
  const trashCount = photosIn('trash').length;
  const badge = $('trash-count');
  badge.hidden = trashCount === 0;
  badge.textContent = trashCount;

  // Deleted-tab tools
  const showTrashTools = state.tab === 'trash' && trashCount > 0 && !state.selecting;
  $('trash-tools').hidden = !showTrashTools;
  if (showTrashTools) {
    $('trash-tools-label').textContent = `${trashCount} photo${trashCount === 1 ? '' : 's'}`;
  }

  // Empty state
  const empty = $('empty-state');
  empty.hidden = list.length > 0;
  if (list.length === 0) {
    if (state.tab === 'main') {
      $('empty-text').textContent = 'No photos yet. Connect your Camp Snap to import them.';
      $('btn-empty-import').hidden = false;
    } else {
      $('empty-text').textContent = 'Nothing in Deleted.';
      $('btn-empty-import').hidden = true;
    }
  }

  renderBanner();
  renderSelectBar();
}

function thumbUrl(p) {
  let url = state.thumbUrls.get(p.id);
  if (!url) {
    const blob = thumbBlobOf(p);
    if (!blob) return '';
    url = URL.createObjectURL(blob);
    state.thumbUrls.set(p.id, url);
  }
  return url;
}

function renderBanner() {
  const banner = $('cam-banner');
  const dead = [...state.photos.values()].filter((p) => p.blobDead).length;
  if (dead > 0) {
    banner.hidden = false;
    banner.innerHTML = `⚠️ ${dead} photo${dead === 1 ? '' : 's'} lost their full-size copy — plug in your Camp&nbsp;Snap and <b>tap here to re-import</b>. They'll slot back in automatically.`;
    return;
  }
  if (state.camConnected) {
    banner.hidden = true;
    return;
  }
  banner.hidden = state.tab !== 'main';
  banner.innerHTML = '📷 Camera not connected — plug in your Camp&nbsp;Snap and <b>tap here to import</b> new photos.';
}

/* ================= Selection ================= */

function setSelecting(on) {
  state.selecting = on;
  if (!on) state.selected.clear();
  document.body.classList.toggle('selecting', on);
  $('btn-select').textContent = on ? 'Cancel' : 'Select';
  renderAlbum();
}

function toggleSelected(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  const tile = document.querySelector(`.tile[data-id="${CSS.escape(id)}"]`);
  if (tile) tile.classList.toggle('selected', state.selected.has(id));
  renderSelectBar();
}

function renderSelectBar() {
  const bar = $('select-bar');
  bar.hidden = !state.selecting;
  if (!state.selecting) return;
  const n = state.selected.size;
  $('select-count').textContent = `${n} selected`;
  const inTrash = state.tab === 'trash';
  $('btn-sel-save').hidden = inTrash;
  $('btn-sel-delete').hidden = inTrash;
  $('btn-sel-restore').hidden = !inTrash;
  $('btn-sel-purge').hidden = !inTrash;
  for (const id of ['btn-sel-save', 'btn-sel-delete', 'btn-sel-restore', 'btn-sel-purge']) {
    $(id).disabled = n === 0;
  }
}

/* ================= Import ================= */

async function importFiles(files, relDirs) {
  const candidates = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = f.name;
    if (name.startsWith('.') || name.startsWith('_')) continue;
    if (!(f.type && f.type.startsWith('image/')) && !IMAGE_RE.test(name)) continue;
    candidates.push([f, relDirs ? relDirs[i] : null]);
  }
  if (candidates.length === 0) {
    toast('No photos found — open the camera’s DCIM folder.');
    return 0;
  }

  showProgress(`Importing… 0 / ${candidates.length}`);
  let added = 0;
  let done = 0;
  try {
    for (const [f, relDir] of candidates) {
      const id = photoId(f.name, f.size);
      done++;
      if (done % 5 === 0 || done === candidates.length) {
        $('progress-text').textContent = `Importing… ${done} / ${candidates.length}`;
      }
      const existing = state.photos.get(id);
      if (existing) {
        if (relDir && !existing.relDir) existing.relDir = relDir;
        // Heal records whose stored full-size copy was lost: replace the
        // bytes and rebuild the thumbnail, keeping status (album vs Deleted).
        if (!(await getOriginal(existing))) {
          try {
            await saveOriginal(id, f);
            const t = await makeThumb(f);
            existing.thumbBuf = await t.blob.arrayBuffer();
            existing.thumbW = t.w;
            existing.thumbH = t.h;
            const dims = await jpegDims(f);
            if (dims) { existing.photoW = dims.w; existing.photoH = dims.h; }
            delete existing.blob;
            delete existing.thumb;
            existing.blobDead = false;
            existing.thumbVer = THUMB_VER;
            const url = state.thumbUrls.get(id);
            if (url) { URL.revokeObjectURL(url); state.thumbUrls.delete(id); }
            added++;
          } catch (e) { /* keep whatever we had */ }
        }
        await idbPut('photos', existing);
        continue;
      }
      if (await idbGet('tombstones', id)) continue; // purged before — don't resurrect

      let thumbBuf = null;
      let thumbW = 0;
      let thumbH = 0;
      try {
        const t = await makeThumb(f);
        thumbBuf = await t.blob.arrayBuffer();
        thumbW = t.w;
        thumbH = t.h;
      } catch (e) { /* tile will fall back to the original */ }
      const dims = await jpegDims(f);
      const record = {
        id,
        name: f.name,
        size: f.size,
        lastModified: f.lastModified || Date.now(),
        thumbBuf,
        thumbW,
        thumbH,
        thumbVer: THUMB_VER,
        photoW: dims ? dims.w : 0, // true pixel size, parsed from the file bytes
        photoH: dims ? dims.h : 0,
        status: 'main',
        addedAt: Date.now(),
        relDir: relDir || null, // path segments on the camera, when known
      };
      await saveOriginal(id, f);
      await idbPut('photos', record);
      state.photos.set(id, record);
      added++;
    }
  } finally {
    hideProgress();
  }
  return added;
}

/* Read a JPEG's pixel dimensions straight from its bytes (SOF marker), so
 * layout never depends on how the browser decodes the image. Returns null
 * for non-JPEGs or unparseable files. */
async function jpegDims(blob) {
  try {
    const buf = new Uint8Array(await blob.slice(0, 256 * 1024).arrayBuffer());
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return null; // not a JPEG
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xFF) { p++; continue; }
      const marker = buf[p + 1];
      if (marker === 0xFF) { p++; continue; }
      if (marker === 0xD8 || (marker >= 0xD0 && marker <= 0xD9)) { p += 2; continue; }
      const len = (buf[p + 2] << 8) | buf[p + 3];
      // SOF0..SOF15, minus DHT (C4), JPG (C8), DAC (CC)
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        const h = (buf[p + 5] << 8) | buf[p + 6];
        const w = (buf[p + 7] << 8) | buf[p + 8];
        return (w > 0 && h > 0) ? { w, h } : null;
      }
      p += 2 + len;
    }
  } catch (e) { /* fall through */ }
  return null;
}

function loadImageEl(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
    img.src = url;
  });
}

async function makeThumb(file) {
  // Prefer createImageBitmap: it fully decodes to known pixel dimensions and
  // avoids iOS Safari's subsampled/squashed drawImage path for large JPEGs.
  let source = null;
  let sw = 0;
  let sh = 0;
  let cleanup = () => {};
  if (window.createImageBitmap) {
    try {
      try { source = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
      catch (e) { source = await createImageBitmap(file); }
      sw = source.width;
      sh = source.height;
      cleanup = () => source.close && source.close();
    } catch (e) { source = null; }
  }
  if (!source) {
    const { img, url } = await loadImageEl(file);
    source = img;
    sw = img.naturalWidth;
    sh = img.naturalHeight;
    cleanup = () => URL.revokeObjectURL(url);
  }
  try {
    if (!sw || !sh) throw new Error('bad dimensions');
    const scale = Math.min(1, THUMB_SIZE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(source, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.8));
    if (!blob) throw new Error('toBlob failed');
    return { blob, w, h };
  } finally {
    cleanup();
  }
}

async function repairLibrary() {
  const todo = [...state.photos.values()].filter((p) => p.thumbVer !== THUMB_VER);
  if (todo.length === 0) return;
  showProgress(`Checking photos… 0 / ${todo.length}`);
  let i = 0;
  for (const p of todo) {
    i++;
    $('progress-text').textContent = `Checking photos… ${i} / ${todo.length}`;
    try {
      let original = await getOriginal(p);
      if (original) {
        // Move legacy Blob storage onto sturdy bytes, refresh dims + thumb.
        if (!(await idbGet('blobs', p.id).catch(() => null))) await saveOriginal(p.id, original);
        const dims = await jpegDims(original);
        if (dims) { p.photoW = dims.w; p.photoH = dims.h; }
        try {
          const t = await makeThumb(original);
          p.thumbBuf = await t.blob.arrayBuffer();
          p.thumbW = t.w;
          p.thumbH = t.h;
          const url = state.thumbUrls.get(p.id);
          if (url) { URL.revokeObjectURL(url); state.thumbUrls.delete(p.id); }
        } catch (e) { /* keep the old thumb */ }
        p.blobDead = false;
        delete p.blob;
      } else {
        // The stored full-size copy is gone (iOS can invalidate stored
        // Files). Keep the thumbnail; re-importing from the camera heals it.
        p.blobDead = true;
        if (p.thumb && !p.thumbBuf) {
          try { p.thumbBuf = await p.thumb.arrayBuffer(); } catch (e) { /* thumb dead too */ }
        }
      }
      if (p.thumbBuf) delete p.thumb;
    } catch (e) { /* leave record as-is */ }
    p.thumbVer = THUMB_VER; // stamp even on failure so we don't loop forever
    try { await idbPut('photos', p); } catch (e) { /* non-fatal */ }
  }
  hideProgress();
  if (!$('album-screen').hidden) renderAlbum();
}

async function afterImport(added) {
  state.camConnected = true;
  showScreen('album');
  toast(added > 0
    ? `Imported ${added} new photo${added === 1 ? '' : 's'}`
    : 'No new photos — album is up to date');
}

/* ================= File System Access (desktop) ================= */

async function connectCameraFs() {
  let dir;
  try {
    dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'campsnap' });
  } catch (e) {
    return; // user cancelled
  }
  state.camDirHandle = dir;
  await idbPut('meta', { key: 'camDir', handle: dir }).catch(() => {});
  const added = await scanCameraDir(dir);
  await afterImport(added);
}

async function scanCameraDir(dir) {
  const files = [];
  const relDirs = [];
  async function walk(handle, path) {
    for await (const entry of handle.values()) {
      if (entry.name.startsWith('.')) continue;
      if (entry.kind === 'directory') {
        if (entry.name.toUpperCase() === CAMERA_TRASH_DIR) continue;
        await walk(entry, [...path, entry.name]);
      } else if (IMAGE_RE.test(entry.name)) {
        files.push(await entry.getFile());
        relDirs.push(path);
      }
    }
  }
  await walk(dir, []);
  return importFiles(files, relDirs);
}

async function tryReconnectCamera() {
  if (!supportsFsAccess()) return;
  const meta = await idbGet('meta', 'camDir').catch(() => null);
  const handle = meta && meta.handle;
  if (!handle) return;
  try {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') return; // needs a user gesture; the banner covers it
    // Verify the drive is actually plugged in by touching the directory.
    await handle.values().next();
    state.camDirHandle = handle;
    const added = await scanCameraDir(handle);
    state.camConnected = true;
    renderAlbum();
    if (added > 0) toast(`Imported ${added} new photo${added === 1 ? '' : 's'}`);
  } catch (e) {
    // Not plugged in (or permission lost) — leave the banner showing.
  }
}

async function getCameraSubdir(pathSegments, create) {
  let dir = state.camDirHandle;
  for (const seg of pathSegments) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
}

async function cameraMoveToTrash(record) {
  if (!state.camDirHandle || !record.relDir) return;
  try {
    const srcDir = await getCameraSubdir(record.relDir, false);
    const file = await srcDir.getFileHandle(record.name).then((h) => h.getFile());
    const trashDir = await state.camDirHandle.getDirectoryHandle(CAMERA_TRASH_DIR, { create: true });

    let trashName = record.name;
    for (let i = 1; i < 100; i++) {
      try { await trashDir.getFileHandle(trashName); } catch { break; } // free name
      trashName = record.name.replace(/(\.[^.]*)?$/, `-${i}$1`);
    }
    const dest = await trashDir.getFileHandle(trashName, { create: true });
    const w = await dest.createWritable();
    await w.write(file);
    await w.close();
    await srcDir.removeEntry(record.name);

    record.trashName = trashName;
    await idbPut('photos', record);
  } catch (e) {
    toast('Deleted in app — couldn’t update the camera');
  }
}

async function cameraRestoreFromTrash(record) {
  if (!state.camDirHandle || !record.trashName) return;
  try {
    const trashDir = await state.camDirHandle.getDirectoryHandle(CAMERA_TRASH_DIR, { create: false });
    const file = await trashDir.getFileHandle(record.trashName).then((h) => h.getFile());
    const destDir = await getCameraSubdir(record.relDir || [], true);
    const dest = await destDir.getFileHandle(record.name, { create: true });
    const w = await dest.createWritable();
    await w.write(file);
    await w.close();
    await trashDir.removeEntry(record.trashName);
    delete record.trashName;
    await idbPut('photos', record);
  } catch (e) {
    toast('Restored in app — couldn’t update the camera');
  }
}

async function cameraPurge(record) {
  if (!state.camDirHandle || !record.trashName) return;
  try {
    const trashDir = await state.camDirHandle.getDirectoryHandle(CAMERA_TRASH_DIR, { create: false });
    await trashDir.removeEntry(record.trashName);
  } catch (e) { /* already gone, or camera unplugged */ }
}

/* ================= Actions ================= */

async function moveToTrash(ids) {
  const moved = [];
  for (const id of ids) {
    const p = state.photos.get(id);
    if (!p || p.status === 'trash') continue;
    p.status = 'trash';
    p.deletedAt = Date.now();
    await idbPut('photos', p);
    await cameraMoveToTrash(p);
    moved.push(id);
  }
  setSelecting(false);
  renderAlbum();
  if (moved.length > 0) {
    toast(`Moved ${moved.length === 1 ? 'photo' : moved.length + ' photos'} to Deleted`, {
      label: 'Undo',
      fn: () => restoreFromTrash(moved, true),
    });
  }
  return moved;
}

async function restoreFromTrash(ids, isUndo) {
  let n = 0;
  for (const id of ids) {
    const p = state.photos.get(id);
    if (!p || p.status !== 'trash') continue;
    p.status = 'main';
    delete p.deletedAt;
    await idbPut('photos', p);
    await cameraRestoreFromTrash(p);
    n++;
  }
  setSelecting(false);
  renderAlbum();
  if (n > 0 && !isUndo) toast(`Restored ${n === 1 ? 'photo' : n + ' photos'}`);
}

async function purgePhotos(ids) {
  for (const id of ids) {
    const p = state.photos.get(id);
    if (!p) continue;
    await cameraPurge(p);
    await idbDelete('photos', id);
    await idbDelete('blobs', id).catch(() => {});
    await idbPut('tombstones', { id, purgedAt: Date.now() }).catch(() => {});
    state.photos.delete(id);
    const url = state.thumbUrls.get(id);
    if (url) { URL.revokeObjectURL(url); state.thumbUrls.delete(id); }
  }
  setSelecting(false);
  renderAlbum();
}

async function savePhotos(ids) {
  const files = [];
  let missing = 0;
  for (const id of ids) {
    const p = state.photos.get(id);
    if (!p) continue;
    const blob = await getOriginal(p);
    if (!blob) { missing++; continue; }
    files.push(new File([blob], p.name, { type: blob.type || 'image/jpeg', lastModified: p.lastModified }));
  }
  if (missing > 0) {
    toast(`${missing} photo${missing === 1 ? '' : 's'} unavailable — re-import from the camera first`);
  }
  if (files.length === 0) return;

  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
      setSelecting(false);
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return; // user closed the share sheet
      // fall through to downloads
    }
  }
  for (const f of files) {
    const url = URL.createObjectURL(f);
    const a = document.createElement('a');
    a.href = url;
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    await new Promise((r) => setTimeout(r, 250)); // let sequential downloads breathe
  }
  setSelecting(false);
  toast(`Saved ${files.length === 1 ? 'photo' : files.length + ' photos'} to downloads`);
}

/* ================= Viewer ================= */

const viewer = { list: [], observer: null };

function openViewer(startId) {
  const list = photosIn(state.tab);
  const startIdx = Math.max(0, list.findIndex((p) => p.id === startId));
  viewer.list = list;

  const strip = $('strip');
  strip.textContent = '';
  if (viewer.observer) viewer.observer.disconnect();
  viewer.observer = new IntersectionObserver(onSlideIntersect, { root: strip, rootMargin: '0% 150%' });

  const frag = document.createDocumentFragment();
  for (const p of list) {
    const slide = document.createElement('div');
    slide.className = 'slide';
    slide.dataset.id = p.id;
    frag.appendChild(slide);
    viewer.observer.observe(slide);
  }
  strip.appendChild(frag);

  const inTrash = state.tab === 'trash';
  $('btn-viewer-restore').hidden = !inTrash;
  $('viewer-delete-label').textContent = inTrash ? 'Delete forever' : 'Delete';
  $('btn-viewer-save').hidden = inTrash;

  showScreen('viewer');
  strip.scrollLeft = startIdx * strip.clientWidth;
  updateViewerHeader();
}

function onSlideIntersect(entries) {
  for (const entry of entries) {
    const slide = entry.target;
    const id = slide.dataset.id;
    const p = state.photos.get(id);
    if (!p) continue;
    if (entry.isIntersecting) {
      if (slide.firstChild || slide.dataset.loading) continue;
      slide.dataset.loading = '1';
      getOriginal(p).then((blob) => {
        delete slide.dataset.loading;
        if (slide.firstChild || !slide.isConnected) return;
        const img = document.createElement('img');
        img.decoding = 'async';
        img.alt = p.name;
        if (!blob) {
          // Full-size copy lost — show the thumbnail at the right shape
          // rather than a broken image.
          blob = thumbBlobOf(p);
          if (!blob) return;
          img.style.width = '100%';
          img.style.height = 'auto';
          img.style.aspectRatio = `${p.photoW || 4} / ${p.photoH || 3}`;
          img.style.objectFit = 'fill';
        }
        img.src = URL.createObjectURL(blob);
        slide.appendChild(img);
      });
    } else if (slide.firstChild) {
      URL.revokeObjectURL(slide.firstChild.src);
      slide.textContent = '';
    }
  }
}

function currentViewerIndex() {
  const strip = $('strip');
  if (strip.clientWidth === 0) return 0;
  return Math.min(viewer.list.length - 1, Math.max(0, Math.round(strip.scrollLeft / strip.clientWidth)));
}

function updateViewerHeader() {
  const idx = currentViewerIndex();
  const p = viewer.list[idx];
  $('viewer-counter').textContent = viewer.list.length ? `${idx + 1} / ${viewer.list.length}` : '';
  $('viewer-name').textContent = p ? p.name : '';
}

function closeViewer() {
  if (viewer.observer) viewer.observer.disconnect();
  for (const slide of $('strip').children) {
    if (slide.firstChild) URL.revokeObjectURL(slide.firstChild.src);
  }
  $('strip').textContent = '';
  viewer.list = [];
  showScreen('album');
}

function removeCurrentSlide() {
  const strip = $('strip');
  const idx = currentViewerIndex();
  const slide = strip.children[idx];
  if (slide) {
    if (slide.firstChild) URL.revokeObjectURL(slide.firstChild.src);
    slide.remove();
  }
  viewer.list.splice(idx, 1);
  if (viewer.list.length === 0) {
    closeViewer();
    return;
  }
  const newIdx = Math.min(idx, viewer.list.length - 1);
  strip.scrollLeft = newIdx * strip.clientWidth;
  updateViewerHeader();
}

/* ================= UI chrome: toast / modal / progress ================= */

let toastTimer = null;
function toast(text, action) {
  const el = $('toast');
  $('toast-text').textContent = text;
  const btn = $('toast-action');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => { el.hidden = true; action.fn(); };
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 6000 : 3000);
}

function confirmDialog(title, body, okLabel) {
  return new Promise((resolve) => {
    $('modal-title').textContent = title;
    $('modal-body').textContent = body;
    $('modal-ok').textContent = okLabel || 'OK';
    const overlay = $('modal');
    overlay.hidden = false;
    const done = (val) => { overlay.hidden = true; resolve(val); };
    $('modal-ok').onclick = () => done(true);
    $('modal-cancel').onclick = () => done(false);
  });
}

const showProgress = (text) => { $('progress-text').textContent = text; $('progress').hidden = false; };
const hideProgress = () => { $('progress').hidden = true; };

/* ================= Events ================= */

function wireEvents() {
  // --- Connect screen ---
  $('btn-open-camera').onclick = connectCameraFs;
  $('btn-pick-folder').onclick = () => $('dir-input').click();
  $('btn-pick-files').onclick = () => $('file-input').click();
  $('btn-skip').onclick = () => showScreen('album');

  const onPicked = async (input) => {
    const files = [...input.files];
    input.value = '';
    if (files.length === 0) {
      // A cancelled pick usually doesn't fire change; an empty change event
      // means the folder couldn't be read (common with USB drives on phones).
      if (input.id === 'dir-input') toast('Couldn’t read that folder — try “Choose photos…” instead');
      return;
    }
    const added = await importFiles(files);
    await afterImport(added);
  };
  $('file-input').onchange = () => onPicked($('file-input'));
  $('dir-input').onchange = () => onPicked($('dir-input'));

  // --- Album header ---
  $('tabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab || tab.dataset.tab === state.tab) return;
    state.tab = tab.dataset.tab;
    setSelecting(false);
  });
  $('btn-import').onclick = () => showScreen('connect');
  $('btn-empty-import').onclick = () => showScreen('connect');
  $('cam-banner').onclick = async () => {
    // With a remembered camera folder we can reconnect in one tap.
    const meta = await idbGet('meta', 'camDir').catch(() => null);
    if (supportsFsAccess() && meta && meta.handle) {
      try {
        const perm = await meta.handle.requestPermission({ mode: 'readwrite' });
        if (perm === 'granted') {
          state.camDirHandle = meta.handle;
          const added = await scanCameraDir(meta.handle);
          await afterImport(added);
          return;
        }
      } catch (e) { /* fall through to the connect screen */ }
    }
    showScreen('connect');
  };
  $('btn-select').onclick = () => setSelecting(!state.selecting);

  // --- Grid: tap to view or select; long-press to start selecting ---
  const grid = $('grid');
  let pressTimer = null;
  let pressedTile = null;
  let suppressClick = false;
  grid.addEventListener('pointerdown', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile || state.selecting) return;
    pressedTile = tile;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      suppressClick = true; // the release still fires a click; swallow it
      setSelecting(true);
      toggleSelected(tile.dataset.id);
    }, 450);
  });
  const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; pressedTile = null; };
  grid.addEventListener('pointermove', (e) => {
    if (pressedTile && !pressedTile.contains(document.elementFromPoint(e.clientX, e.clientY))) cancelPress();
  });
  grid.addEventListener('pointerup', cancelPress);
  grid.addEventListener('pointercancel', cancelPress);
  grid.addEventListener('scroll', cancelPress, { passive: true });
  grid.addEventListener('contextmenu', (e) => { if (e.target.closest('.tile')) e.preventDefault(); });

  grid.addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; return; }
    const tile = e.target.closest('.tile');
    if (!tile) return;
    if (state.selecting) toggleSelected(tile.dataset.id);
    else openViewer(tile.dataset.id);
  });

  // --- Selection bar ---
  $('btn-cancel-select').onclick = () => setSelecting(false);
  $('btn-select-all').onclick = () => {
    const all = photosIn(state.tab);
    const everything = state.selected.size === all.length;
    state.selected = everything ? new Set() : new Set(all.map((p) => p.id));
    renderAlbum();
  };
  $('btn-sel-save').onclick = () => savePhotos([...state.selected]);
  $('btn-sel-delete').onclick = () => moveToTrash([...state.selected]);
  $('btn-sel-restore').onclick = () => restoreFromTrash([...state.selected]);
  $('btn-sel-purge').onclick = async () => {
    const n = state.selected.size;
    if (await confirmDialog('Delete forever?', `${n === 1 ? 'This photo' : `These ${n} photos`} will be permanently deleted.`, 'Delete forever')) {
      await purgePhotos([...state.selected]);
    }
  };

  // --- Purge all ---
  $('btn-purge').onclick = async () => {
    const ids = photosIn('trash').map((p) => p.id);
    if (ids.length === 0) return;
    if (await confirmDialog('Purge Deleted?', `All ${ids.length} photo${ids.length === 1 ? '' : 's'} in Deleted will be permanently deleted.`, 'Purge all')) {
      await purgePhotos(ids);
      toast('Deleted folder emptied');
    }
  };

  // --- Viewer ---
  $('btn-close-viewer').onclick = closeViewer;
  $('strip').addEventListener('scroll', () => {
    if (!$('viewer-screen').hidden) requestAnimationFrame(updateViewerHeader);
  }, { passive: true });

  $('btn-viewer-save').onclick = () => {
    const p = viewer.list[currentViewerIndex()];
    if (p) savePhotos([p.id]);
  };
  $('btn-viewer-delete').onclick = async () => {
    const p = viewer.list[currentViewerIndex()];
    if (!p) return;
    if (state.tab === 'trash') {
      if (!(await confirmDialog('Delete forever?', 'This photo will be permanently deleted.', 'Delete forever'))) return;
      removeCurrentSlide();
      await purgePhotos([p.id]);
    } else {
      removeCurrentSlide();
      await moveToTrash([p.id]);
    }
  };
  $('btn-viewer-restore').onclick = async () => {
    const p = viewer.list[currentViewerIndex()];
    if (!p) return;
    removeCurrentSlide();
    await restoreFromTrash([p.id]);
  };

  document.addEventListener('keydown', (e) => {
    if ($('viewer-screen').hidden) return;
    const strip = $('strip');
    if (e.key === 'ArrowRight') strip.scrollBy({ left: strip.clientWidth, behavior: 'smooth' });
    else if (e.key === 'ArrowLeft') strip.scrollBy({ left: -strip.clientWidth, behavior: 'smooth' });
    else if (e.key === 'Escape') closeViewer();
  });

  // Keep the viewer snapped to a whole slide when the phone rotates.
  let lastViewerIdx = 0;
  $('strip').addEventListener('scroll', () => { lastViewerIdx = currentViewerIndex(); }, { passive: true });
  window.addEventListener('resize', () => {
    if ($('viewer-screen').hidden) return;
    const strip = $('strip');
    strip.scrollLeft = Math.min(lastViewerIdx, Math.max(0, viewer.list.length - 1)) * strip.clientWidth;
  });
}

init();
