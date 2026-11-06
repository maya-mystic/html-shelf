'use strict';

/* All data lives in this device's IndexedDB. This file makes no network
   requests of its own, so nothing you add ever leaves the phone. */

const $ = (id) => document.getElementById(id);
const COLORS = ['#1f6f5c', '#2c5f9e', '#8a4b9c', '#b0562a', '#9a3b4f', '#55702b', '#3d6b7d', '#7a5c2e'];

/* ---------- Storage ---------- */

let dbPromise;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('html-shelf', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('meta', { keyPath: 'id' }); // list details
        db.createObjectStore('content');                 // file text, by id
        db.createObjectStore('pagedata');                // what each page saved, by id
        db.createObjectStore('settings');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return dbPromise;
}

const result = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

async function dbGet(store, key) {
  const db = await openDb();
  return result(db.transaction(store).objectStore(store).get(key));
}

async function dbAll(store) {
  const db = await openDb();
  return result(db.transaction(store).objectStore(store).getAll());
}

/* Runs several writes together: either all are saved or none are. */
async function dbWrite(stores, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite');
    fn((name) => tx.objectStore(name));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/* ---------- Small helpers ---------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

let toastTimer;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 3000);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
function formatTime(time) {
  const minutes = Math.round((time - Date.now()) / 60000);
  if (Math.abs(minutes) < 1) return 'just now';
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return relative.format(days, 'day');
  return new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function colorFor(text) {
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

/* Honours the file's own encoding, so older non-UTF-8 pages don't look garbled. */
function decodeHtml(buffer) {
  const bytes = new Uint8Array(buffer);
  let charset = 'utf-8';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) charset = 'utf-16le';
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) charset = 'utf-16be';
  else {
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
    const match = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i);
    if (match) charset = match[1];
  }
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/* ---------- Dashboard ---------- */

let files = [];

const lastUsed = (file) => Math.max(file.lastOpened, file.updatedAt);

async function loadFiles() {
  files = (await dbAll('meta')).sort((a, b) => lastUsed(b) - lastUsed(a));
  renderList();
}

function renderList() {
  const query = $('search').value.trim().toLowerCase();
  const shown = files.filter((file) => file.name.toLowerCase().includes(query));

  $('empty').hidden = files.length > 0;
  $('search').hidden = files.length < 5;
  $('noMatch').hidden = shown.length > 0 || files.length === 0;

  $('list').replaceChildren(...shown.map((file) => {
    const initial = [...file.name][0] || '?';
    const tile = el('span', { className: 'tile', textContent: initial.toUpperCase() });
    tile.style.background = colorFor(file.name);
    const when = file.lastOpened ? `Opened ${formatTime(file.lastOpened)}` : `Added ${formatTime(file.updatedAt)}`;

    const open = el('button', { className: 'open-btn', type: 'button', onclick: () => openFile(file.id) },
      tile,
      el('span', { className: 'file-text' },
        el('span', { className: 'file-name', textContent: file.name }),
        el('span', { className: 'file-sub', textContent: `${when} · ${formatSize(file.size)}` })));

    const more = el('button', { className: 'icon-btn', type: 'button', onclick: () => showFileMenu(file) });
    more.setAttribute('aria-label', `Options for ${file.name}`);
    more.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/></svg>';

    return el('li', {}, open, more);
  }));
}

async function addFiles(picked) {
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const file of picked) {
    if (!/\.x?html?$/i.test(file.name)) { skipped += 1; continue; }
    const html = decodeHtml(await file.arrayBuffer());
    const existing = files.find((item) => item.source === file.name);
    const now = Date.now();
    const meta = {
      id: existing ? existing.id : crypto.randomUUID(),
      name: existing ? existing.name : file.name.replace(/\.x?html?$/i, ''),
      source: file.name,
      size: file.size,
      lastOpened: existing ? existing.lastOpened : 0,
      updatedAt: now,
    };
    await dbWrite(['meta', 'content'], (store) => {
      store('meta').put(meta);
      store('content').put(html, meta.id);
    });
    if (existing) updated += 1; else added += 1;
    files = files.filter((item) => item.id !== meta.id).concat(meta);
  }

  await loadFiles();
  // Ask iOS to treat this app's storage as something it shouldn't clear.
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  const parts = [];
  if (added) parts.push(`${added} added`);
  if (updated) parts.push(`${updated} updated`);
  if (skipped) parts.push(`${skipped} skipped (not HTML)`);
  if (parts.length) toast(parts.join(', '));
}

/* ---------- Sheets ---------- */

function showSheet(...children) {
  const sheet = $('sheet');
  sheet.replaceChildren(...children);
  if (!sheet.open) sheet.showModal();
}

const closeSheet = () => $('sheet').close();

$('sheet').addEventListener('click', (event) => {
  if (event.target === $('sheet')) {
    const box = $('sheet').getBoundingClientRect();
    const outside = event.clientX < box.left || event.clientX > box.right
      || event.clientY < box.top || event.clientY > box.bottom;
    if (outside) closeSheet();
  }
});

function sheetButton(label, onclick, kind = '') {
  return el('button', { className: `sheet-btn ${kind}`, type: 'button', textContent: label, onclick });
}

function showFileMenu(file) {
  showSheet(
    el('h2', { textContent: file.name }),
    el('div', { className: 'sheet-actions' },
      sheetButton('Rename', () => showRename(file)),
      sheetButton('Clear saved page data', () => showClearData(file)),
      sheetButton('Delete', () => showDelete(file), 'danger'),
      sheetButton('Cancel', closeSheet)));
}

function showRename(file) {
  const input = el('input', { type: 'text', value: file.name, maxLength: 120 });
  input.setAttribute('aria-label', 'File name');
  const save = async (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    await dbWrite(['meta'], (store) => store('meta').put({ ...file, name }));
    closeSheet();
    await loadFiles();
  };
  showSheet(el('form', { onsubmit: save },
    el('h2', { textContent: 'Rename' }),
    input,
    el('div', { className: 'sheet-actions' },
      el('button', { className: 'sheet-btn main', type: 'submit', textContent: 'Save' }),
      sheetButton('Cancel', closeSheet))));
  input.focus();
}

function showClearData(file) {
  showSheet(
    el('h2', { textContent: 'Clear saved page data?' }),
    el('p', { textContent: `This removes anything “${file.name}” saved, like progress or settings. The page itself stays.` }),
    el('div', { className: 'sheet-actions' },
      sheetButton('Clear data', async () => {
        await dbWrite(['pagedata'], (store) => store('pagedata').delete(file.id));
        closeSheet();
        toast('Saved page data cleared');
      }, 'danger'),
      sheetButton('Cancel', closeSheet)));
}

function showDelete(file) {
  showSheet(
    el('h2', { textContent: `Delete “${file.name}”?` }),
    el('p', { textContent: 'This removes the copy in this app and anything the page saved. Your original file isn’t touched.' }),
    el('div', { className: 'sheet-actions' },
      sheetButton('Delete', async () => {
        await dbWrite(['meta', 'content', 'pagedata'], (store) => {
          store('meta').delete(file.id);
          store('content').delete(file.id);
          store('pagedata').delete(file.id);
        });
        closeSheet();
        await loadFiles();
        toast('Deleted');
      }, 'danger'),
      sheetButton('Cancel', closeSheet)));
}

async function showSettings() {
  const blocked = Boolean(await dbGet('settings', 'blockInternet'));
  const toggle = el('input', {
    type: 'checkbox',
    checked: blocked,
    onchange: () => dbWrite(['settings'], (store) => store('settings').put(toggle.checked, 'blockInternet')),
  });
  const usage = el('p', { textContent: 'Files stay on this device.' });

  showSheet(
    el('h2', { textContent: 'Settings' }),
    el('label', { className: 'switch-row' },
      el('span', {},
        el('strong', { textContent: 'Block internet for pages' }),
        el('small', { textContent: 'Stops opened pages loading fonts, images and scripts or sending data online. Pages that need these may look broken.' })),
      toggle),
    usage,
    el('div', { className: 'sheet-actions' }, sheetButton('Done', closeSheet)));

  if (navigator.storage && navigator.storage.estimate) {
    const { usage: used } = await navigator.storage.estimate();
    if (used !== undefined) usage.textContent = `Files stay on this device. Using ${formatSize(used)}.`;
  }
}

/* ---------- Opening a page ---------- */

/* This runs inside each opened page, which is sandboxed: it can't reach the app
   or other files. Because a sandboxed page has no storage of its own, this gives
   it one, kept per file by the app. It must not use anything outside itself. */
function pageShim(seed) {
  const send = (message) => parent.postMessage({ htmlShelf: true, ...message }, '*');

  function makeStorage(initial, persist) {
    const map = new Map(Object.entries(initial));
    const api = {
      get length() { return map.size; },
      key: (index) => [...map.keys()][index] ?? null,
      getItem: (key) => (map.has(String(key)) ? map.get(String(key)) : null),
      setItem(key, value) {
        map.set(String(key), String(value));
        if (persist) send({ type: 'set', key: String(key), value: String(value) });
      },
      removeItem(key) {
        map.delete(String(key));
        if (persist) send({ type: 'remove', key: String(key) });
      },
      clear() {
        map.clear();
        if (persist) send({ type: 'clear' });
      },
    };
    return new Proxy({}, {
      get: (target, key) => (key in api ? api[key] : map.get(key)),
      set(target, key, value) { api.setItem(key, value); return true; },
      deleteProperty(target, key) { api.removeItem(key); return true; },
      has: (target, key) => key in api || map.has(key),
      ownKeys: () => [...map.keys()],
      getOwnPropertyDescriptor: (target, key) => (map.has(key)
        ? { value: map.get(key), enumerable: true, configurable: true, writable: true }
        : undefined),
    });
  }

  const define = (object, name, descriptor) => {
    try { Object.defineProperty(object, name, { configurable: true, ...descriptor }); } catch {}
  };
  define(window, 'localStorage', { value: makeStorage(seed.data, true) });
  define(window, 'sessionStorage', { value: makeStorage({}, false) });
  define(document, 'cookie', { get: () => '', set() {} });

  /* Links would otherwise resolve against the app's address and reload the app
     inside the page, so each kind is handled here. */
  window.addEventListener('click', (event) => {
    if (event.defaultPrevented || !event.target.closest) return;
    const link = event.target.closest('a[href]');
    if (!link || link.hasAttribute('download')) return;
    const href = (link.getAttribute('href') || '').trim();

    if (href.startsWith('#')) {
      event.preventDefault();
      location.hash = href;
    } else if (/^(https?:)?\/\//i.test(href)) {
      event.preventDefault();
      if (seed.blocked) send({ type: 'toast', text: 'Link blocked: internet is off for pages' });
      else window.open(link.href, '_blank');
    } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      event.preventDefault();
      send({ type: 'toast', text: 'That link points to another file, which isn’t loaded here' });
    }
  });

  window.addEventListener('submit', (event) => {
    if (!/^https?:/i.test(event.target.getAttribute('action') || '')) event.preventDefault();
  });

  document.currentScript.remove();
}

const BLOCK_POLICY = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; "
  + "style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; "
  + "media-src data: blob:; worker-src blob:; frame-src data: blob:; form-action 'none'";

function buildDocument(html, data, blocked) {
  // Keeps saved text from ending the script tag early.
  const seed = JSON.stringify({ data, blocked })
    .replace(/</g, '\\u003c');
  const policy = blocked ? `<meta http-equiv="Content-Security-Policy" content="${BLOCK_POLICY}">` : '';
  const injected = `${policy}<script>(${pageShim})(${seed})<\/script>`;

  // Goes after any doctype, so the page keeps its normal rendering mode.
  const start = html.match(/^(?:﻿|\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?/i)[0].length;
  return html.slice(0, start) + injected + html.slice(start);
}

let current = null; // { id, data, frame }
let saveTimer = null;

function savePageData() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!current) return Promise.resolve();
  const { id, data } = current;
  return dbWrite(['pagedata'], (store) => store('pagedata').put(data, id));
}

window.addEventListener('message', (event) => {
  if (!current || event.source !== current.frame.contentWindow) return;
  const message = event.data;
  if (!message || message.htmlShelf !== true) return;

  if (message.type === 'toast') {
    toast(String(message.text));
    return;
  }
  if (message.type === 'set') current.data[String(message.key)] = String(message.value);
  else if (message.type === 'remove') delete current.data[String(message.key)];
  else if (message.type === 'clear') current.data = {};
  else return;

  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePageData, 150);
});

async function loadFrame(id) {
  const [html, data, blocked] = await Promise.all([
    dbGet('content', id), dbGet('pagedata', id), dbGet('settings', 'blockInternet'),
  ]);
  if (html === undefined) {
    toast('This file could not be found');
    return false;
  }

  const frame = document.createElement('iframe');
  // No allow-same-origin: this is what keeps pages away from the app and each other.
  const permissions = ['allow-scripts', 'allow-forms', 'allow-modals', 'allow-downloads'];
  if (!blocked) permissions.push('allow-popups', 'allow-popups-to-escape-sandbox');
  frame.setAttribute('sandbox', permissions.join(' '));
  frame.setAttribute('allow', 'fullscreen');
  frame.title = 'Opened page';
  frame.srcdoc = buildDocument(html, data || {}, Boolean(blocked));

  current = { id, data: data || {}, frame };
  $('frameHost').replaceChildren(frame);
  return true;
}

async function openFile(id) {
  const file = files.find((item) => item.id === id);
  if (!file || !(await loadFrame(id))) return;

  $('viewer').hidden = false;
  $('home').hidden = true;
  history.pushState({ viewing: id }, '');
  placeBackButton(await dbGet('settings', 'backButton'));
  wakeBackButton();

  await dbWrite(['meta'], (store) => store('meta').put({ ...file, lastOpened: Date.now() }));
  await loadFiles();
}

async function closeViewer() {
  await savePageData();
  current = null;
  $('frameHost').replaceChildren();
  $('viewer').hidden = true;
  $('home').hidden = false;
}

/* ---------- Floating back button ---------- */

/* Opened pages fill the screen, so this button is the way out. It fades after a
   moment and can be dragged off anything it covers; its spot is remembered. */
let fadeTimer;
let dragStart = null;
let wasDragged = false;

function wakeBackButton() {
  const button = $('backBtn');
  button.classList.remove('faded');
  clearTimeout(fadeTimer);
  fadeTimer = setTimeout(() => button.classList.add('faded'), 2500);
}

function placeBackButton(spot) {
  if (!spot) return;
  const button = $('backBtn');
  const margin = 4;
  button.style.left = `${Math.min(Math.max(spot.left, margin), innerWidth - button.offsetWidth - margin)}px`;
  button.style.top = `${Math.min(Math.max(spot.top, margin), innerHeight - button.offsetHeight - margin)}px`;
  button.style.bottom = 'auto';
}

$('backBtn').addEventListener('pointerdown', (event) => {
  const box = $('backBtn').getBoundingClientRect();
  dragStart = { x: event.clientX, y: event.clientY, left: box.left, top: box.top };
  wasDragged = false;
  $('backBtn').setPointerCapture(event.pointerId);
  wakeBackButton();
});

$('backBtn').addEventListener('pointermove', (event) => {
  if (!dragStart) return;
  const moveX = event.clientX - dragStart.x;
  const moveY = event.clientY - dragStart.y;
  if (!wasDragged && Math.hypot(moveX, moveY) < 8) return;
  wasDragged = true;
  placeBackButton({ left: dragStart.left + moveX, top: dragStart.top + moveY });
});

$('backBtn').addEventListener('pointerup', () => {
  dragStart = null;
  wakeBackButton();
  if (wasDragged) {
    const { left, top } = $('backBtn').getBoundingClientRect();
    dbWrite(['settings'], (store) => store('settings').put({ left, top }, 'backButton'));
  }
});

$('backBtn').addEventListener('pointercancel', () => { dragStart = null; });

$('backBtn').addEventListener('click', () => {
  if (wasDragged) {
    wasDragged = false; // this click is just the end of a drag
    return;
  }
  history.back();
});

/* ---------- Wiring ---------- */

$('addBtn').addEventListener('click', () => $('picker').click());
$('picker').addEventListener('change', async (event) => {
  const picked = [...event.target.files];
  event.target.value = ''; // lets the same file be picked again later
  try {
    await addFiles(picked);
  } catch {
    toast('That file could not be added');
  }
});

$('search').addEventListener('input', renderList);
$('settingsBtn').addEventListener('click', showSettings);
window.addEventListener('popstate', closeViewer);

// iOS can end a backgrounded app with no warning, so save as soon as it's hidden.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && saveTimer !== null) savePageData();
});

/* Safari and the installed app keep separate storage, so point people to install first. */
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
const isInstalled = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
if (isIos && !isInstalled) $('installHint').hidden = false;
$('hintClose').addEventListener('click', () => { $('installHint').hidden = true; });

if (history.state && history.state.viewing) history.replaceState(null, '');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

loadFiles().catch(() => toast('Storage is unavailable in this browser mode'));
