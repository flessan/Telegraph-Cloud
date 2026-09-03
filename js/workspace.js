import { applyStaticI18n, getLanguage, initI18n, onLanguageChange, setLanguage, t } from './i18n.js';
import {
  ROOT_ID,
  ancestorIds,
  canMove,
  childrenOf,
  countObjects,
  createAlbum,
  flattenTree,
  indexAlbums,
  mergeRemoteAlbums,
  normalizeAlbum,
  objectsIn,
  pathLabel,
  pathOf,
  resolveAlbumId,
  serializeAlbum,
  subtreeIds,
  validateName,
} from './albums.js';
import {
  CATEGORY,
  canPreviewLocally,
  categorize,
  categoryLabelKey,
  formatOutput,
  previewKind,
} from './mime.js';
import {
  classifyFailure,
  createPushQueue,
  parseRetryAfter,
  roundEtaMs,
} from './push-queue.js';

const PREFS_KEY = 'ti.prefs';
const DB_NAME = 'ti-workspace';
const DB_STORE = 'items';
const DB_ALBUMS = 'albums';
const DB_VERSION = 2;
// Push spacing: one file at a time, with a short jittered gap between files so
// a large batch does not turn into a burst. The two intervals are advanced
// preferences (persisted with the other workspace prefs) rather than constants,
// so a slow or strict host can be given more room without touching the code.
const PUSH_DELAY_DEFAULT_MS = 1200;
const PUSH_RETRY_BASE_DEFAULT_MS = 2000;
const PUSH_JITTER = 0.25;
const PUSH_MAX_RETRIES = 3;

function prefInterval(key, fallback, max) {
  const value = Number(loadPrefs()[key]);
  return Number.isFinite(value) && value >= 0 && value <= max ? value : fallback;
}
const pushDelayMs = () => prefInterval('pushDelayMs', PUSH_DELAY_DEFAULT_MS, 60000);
const pushRetryBaseMs = () => prefInterval('pushRetryBaseMs', PUSH_RETRY_BASE_DEFAULT_MS, 60000);
const RECENT_MS = 48 * 60 * 60 * 1000;
const REMOTE_PAGE_SIZE = 100;
// Text/code previews are read-only and never run as markup (content is written
// through textContent), so they are safe. A size cap keeps a large log or data
// file from being slurped into the DOM; bigger text falls back to the generic
// surface plus Download.
const TEXT_PREVIEW_MAX = 512 * 1024;

const state = {
  items: [],
  albums: [],
  remoteCursor: null,
  remoteComplete: false,
  remoteLoading: false,
  remoteError: false,
  remoteReady: false,       // true once the initial remote index fetch has settled
  remoteLoaded: 0,
  session: null,
  albumId: null,          // album currently open in the Albums view (null = root)
  expanded: new Set(),    // expanded nodes of the sidebar album tree
  albumSync: 'unknown',   // unknown | synced | local (remote management unavailable)
  view: 'files',
  layout: 'grid',
  sort: 'date:desc',
  query: '',
  selected: new Set(),
  lastSelectedId: null,
  theme: 'light',
  format: 'url',
  config: null,
  pushing: false,
  online: typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  previewId: null,
  previewZoom: false,
  queue: null,            // last snapshot from the sequential push queue
  objectUrls: new Map(),
};

let dbPromise = null;
let toastTimer = null;
let confirmResolver = null;
let activeMenu = null;
let lastFocus = null;
let dragState = null;      // { kind: 'objects' | 'album', ids | albumId }
let moveContext = null;    // state of the "Move to…" dialog
let albumDialogContext = null;
let renameTarget = null;
let pushQueue = null;      // sequential upload queue (js/push-queue.js)
let queueTicker = null;    // countdown/ETA ticker while a push is running
let activeUpload = null;   // in-flight XHR, kept so state stays inspectable
let stageSeq = 0;          // monotonic staging order, independent of the clock
let textPreviewSeq = 0;    // invalidates stale async text-preview loads

const $ = (id) => document.getElementById(id);

function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {};
  } catch (_) {
    return {};
  }
}

function savePrefs() {
  try {
    const prefs = loadPrefs();
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      theme: state.theme,
      layout: state.layout,
      sort: state.sort,
      view: state.view,
      albumId: state.albumId,
      expanded: Array.from(state.expanded),
      // Advanced, optional: preserved verbatim when present.
      ...(prefs.pushDelayMs !== undefined ? { pushDelayMs: prefs.pushDelayMs } : {}),
      ...(prefs.pushRetryBaseMs !== undefined ? { pushRetryBaseMs: prefs.pushRetryBaseMs } : {}),
    }));
  } catch (_) { /* ignore */ }
}

function detectTheme(prefs) {
  if (prefs.theme === 'light' || prefs.theme === 'dark') return prefs.theme;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const btn = $('theme-btn');
  if (btn) {
    btn.setAttribute('aria-pressed', state.theme === 'dark' ? 'true' : 'false');
    btn.setAttribute('aria-label', t(state.theme === 'dark' ? 'themeDark' : 'themeLight'));
    btn.setAttribute('title', t(state.theme === 'dark' ? 'themeDark' : 'themeLight'));
  }
}

function uid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

function openDb() {
  if (dbPromise) return dbPromise;
  if (!('indexedDB' in window)) {
    dbPromise = Promise.resolve(null);
    return dbPromise;
  }
  dbPromise = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (_) { resolve(null); return; }
    req.onerror = () => resolve(null);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: 'id' });
      }
      // v2 adds the local album catalog. Existing item records are untouched:
      // they simply gain an optional albumId field the next time they are saved.
      if (!db.objectStoreNames.contains(DB_ALBUMS)) {
        db.createObjectStore(DB_ALBUMS, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
  return dbPromise;
}

async function idbAll() {
  const db = await openDb();
  if (!db) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function idbPut(item) {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(toRecord(item));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function idbDelete(id) {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function idbAlbumsAll() {
  const db = await openDb();
  if (!db || !db.objectStoreNames.contains(DB_ALBUMS)) return [];
  return new Promise((resolve) => {
    const tx = db.transaction(DB_ALBUMS, 'readonly');
    const req = tx.objectStore(DB_ALBUMS).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  });
}

async function idbAlbumPut(album) {
  const db = await openDb();
  if (!db || !db.objectStoreNames.contains(DB_ALBUMS)) return;
  return new Promise((resolve) => {
    const tx = db.transaction(DB_ALBUMS, 'readwrite');
    tx.objectStore(DB_ALBUMS).put(serializeAlbum(album));
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

async function idbAlbumDelete(id) {
  const db = await openDb();
  if (!db || !db.objectStoreNames.contains(DB_ALBUMS)) return;
  return new Promise((resolve) => {
    const tx = db.transaction(DB_ALBUMS, 'readwrite');
    tx.objectStore(DB_ALBUMS).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
}

function toRecord(item) {
  const record = {
    id: item.id,
    name: item.name,
    type: item.type,
    size: item.size,
    addedAt: item.addedAt,
    seq: item.seq,
    pushedAt: item.pushedAt,
    status: item.status === 'pushing' ? 'pending' : item.status,
    src: item.src,
    url: item.url,
    error: item.error,
    width: item.width,
    height: item.height,
    albumId: item.albumId || null,
    albumSynced: item.albumSynced !== false,
    remoteId: item.remoteId || null,
    remote: !!item.remote,
    remoteMetadata: item.remoteMetadata || null,
    blob: null,
  };
  if (item.status !== 'synced' && item.file) record.blob = item.file;
  return record;
}

function rememberUrl(id, blob) {
  const prev = state.objectUrls.get(id);
  if (prev) URL.revokeObjectURL(prev);
  if (!blob) {
    state.objectUrls.delete(id);
    return null;
  }
  const url = URL.createObjectURL(blob);
  state.objectUrls.set(id, url);
  return url;
}

function localPreview(item) {
  if (item.previewUrl) return item.previewUrl;
  // Object URLs are only worth creating for things the browser can render.
  if (item.file && canPreviewLocally(itemCategory(item))) {
    item.previewUrl = rememberUrl(item.id, item.file);
    return item.previewUrl;
  }
  return item.url || '';
}

/**
 * Semantic category of a staged/synced object. `File.type` is authoritative
 * locally; the filename is only consulted when no MIME type was reported.
 */
function itemCategory(item) {
  if (!item) return CATEGORY.FILE;
  if (!item._category) item._category = categorize({ mime: item.type, name: item.name });
  return item._category;
}

function isImage(item) {
  return itemCategory(item) === CATEGORY.IMAGE;
}

function extOf(name) {
  const parts = String(name || '').split('.');
  return parts.length > 1 ? parts.pop().toUpperCase().slice(0, 5) : 'FILE';
}

/**
 * A short, translated, human-friendly label for an object's kind, e.g.
 * "Image", "PDF document", "Archive". Falls back to "File" for anything
 * unrecognised. Used for the grid card meta line and the list "Type" column.
 */
function itemTypeLabel(item) {
  if (!item) return t('unknownType');
  return t(categoryLabelKey(itemCategory(item)));
}

/** A slightly richer description used as hover detail for a file node. */
function itemTypeDetail(item) {
  if (!item) return '';
  return item.type || String(itemTypeLabel(item));
}

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return t('bytes', { n });
  if (n < 1024 * 1024) return t('kb', { n: (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) });
  if (n < 1024 * 1024 * 1024) return t('mb', { n: (n / 1024 / 1024).toFixed(2) });
  return t('gb', { n: (n / 1024 / 1024 / 1024).toFixed(2) });
}

function formatWhen(ts) {
  if (!ts) return t('noDimensions');
  const delta = Date.now() - ts;
  if (delta < 60 * 1000) return t('justNow');
  if (delta < 60 * 60 * 1000) return t('minutesAgo', { n: Math.floor(delta / 60000) });
  if (delta < 24 * 60 * 60 * 1000) return t('hoursAgo', { n: Math.floor(delta / 3600000) });
  if (delta < 7 * 24 * 60 * 60 * 1000) return t('daysAgo', { n: Math.floor(delta / 86400000) });
  try {
    return new Date(ts).toLocaleString(getLanguage());
  } catch (_) {
    return new Date(ts).toLocaleString();
  }
}

function statusLabel(status) {
  if (status === 'pending') return t('statusPending');
  if (status === 'pushing') return t('statusPushing');
  if (status === 'synced') return t('statusSynced');
  if (status === 'failed') return t('statusFailed');
  return t('statusLocal');
}

/** Chip text for an item, preferring its live queue state during a push. */
function itemStateLabel(item) {
  const active = state.queue && state.queue.active;
  if (active && item.queue) {
    if (item.queue === 'queued' && item.status !== 'synced') return t('statusQueued');
    if (item.queue === 'uploading') return t('statusPushing');
    if (item.queue === 'retrying') {
      return t('queueRetryCount', { n: Math.max(1, (item.queueAttempt || 1) - 1), max: PUSH_MAX_RETRIES });
    }
  }
  if (item.queue === 'cancelled' && item.status !== 'synced') return t('statusCancelled');
  return statusLabel(item.status);
}

function plural(key, n) {
  return t(n === 1 ? key : key + 'Plural', { n });
}

function announce(message) {
  const live = $('live');
  if (live) live.textContent = message;
}

function showToast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function copyText(text) {
  const done = () => showToast(t('copied'));
  const fail = () => showToast(t('copyFailed'));
  if (!text) return fail();
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => {
      legacyCopy(text) ? done() : fail();
    });
  } else {
    legacyCopy(text) ? done() : fail();
  }
}

function legacyCopy(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  document.body.removeChild(textarea);
  return ok;
}

/**
 * Copy/paste output for an object. The snippet follows the object's real
 * category: only images become image markup.
 */
function formatLink(item, format) {
  if (!item || !item.url) return '';
  return formatOutput({
    url: item.url,
    name: item.name,
    mime: item.type,
    category: itemCategory(item),
  }, format);
}

/** Reads a local Blob/File as UTF-8 text; resolves null when it cannot. */
function readFileText(blob) {
  if (blob && typeof blob.text === 'function') {
    return blob.text().then((text) => String(text), () => null);
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => resolve(null);
    try { reader.readAsText(blob); } catch (_) { resolve(null); }
  });
}

/**
 * Whether a file warrants an inline text/code preview: a genuine text-like
 * object that is small enough to read, and whose bytes are reachable (a staged
 * local file or a published remote URL). Images/audio/video/pdf keep their own
 * richer surfaces.
 */
function isTextPreviewable(item) {
  return itemCategory(item) === CATEGORY.TEXT
    && Number(item.size || 0) <= TEXT_PREVIEW_MAX
    && !!((item.file) || item.url);
}

/**
 * Read-only text/code surface. Content is always injected via `textContent`,
 * never innerHTML, so an untrusted file cannot inject markup or script into
 * the admin page. Oversized/unreadable files degrade to a caption plus the
 * dialog's Download action rather than a blank surface.
 */
function previewTextSurface(item) {
  const wrap = document.createElement('div');
  wrap.className = 'preview-text';

  const caption = document.createElement('p');
  caption.className = 'preview-caption';
  caption.setAttribute('role', 'status');
  caption.textContent = t('previewTextLoading');
  wrap.appendChild(caption);

  const pre = document.createElement('pre');
  pre.className = 'preview-text-body';
  pre.setAttribute('aria-label', t('previewTextAria', { name: item.name }));
  pre.tabIndex = 0;
  wrap.appendChild(pre);

  const token = ++textPreviewSeq;
  (async () => {
    let text;
    if (item.file) {
      text = await readFileText(item.file);
    } else if (item.url) {
      try {
        const res = await fetch(item.url, { headers: { Accept: '*/*' }, cache: 'no-cache' });
        text = res.ok ? await res.text() : null;
      } catch (_) { text = null; }
    } else {
      text = null;
    }
    // The preview may have moved on (opened another file, closed) while the
    // bytes were loading; only populate if this request is still current.
    if (textPreviewSeq !== token || state.previewId !== item.id) return;
    if (text == null) {
      caption.textContent = t('previewTextFailed');
      pre.remove();
      return;
    }
    caption.remove();
    pre.textContent = text === '' ? t('previewTextEmpty') : text;
  })();

  return wrap;
}

/** Clears the active search and re-renders, restoring the unfiltered view. */
function clearSearch({ focus = false } = {}) {
  const search = $('search');
  if (search) search.value = '';
  state.query = '';
  const wrap = $('search-wrap');
  if (wrap) wrap.classList.remove('expanded');
  render();
  if (focus && search) search.focus();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isPendingLike(item) {
  return item.status === 'pending' || item.status === 'pushing' || item.status === 'failed';
}

function matchesQuery(item, raw) {
  const q = String(raw || '').trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every((token) => tokenMatches(item, token));
}

function tokenMatches(item, token) {
  if (!token) return true;
  if (token.charAt(0) === '.') {
    return String(item.name || '').toLowerCase().endsWith(token);
  }
  if (token.indexOf('status:') === 0) {
    const wanted = token.slice(7);
    return item.status === wanted || (wanted === 'local' && item.status !== 'synced');
  }
  if (token.indexOf('album:') === 0) {
    const wanted = token.slice(6);
    const path = albumShortPath(item.albumId || null).toLowerCase();
    if (wanted === 'none' || wanted === 'root') return !item.albumId;
    return path.indexOf(wanted) !== -1;
  }
  if (token.indexOf('type:') === 0) {
    const wanted = token.slice(5);
    return (item.type || '').toLowerCase().indexOf(wanted) !== -1
      || extOf(item.name).toLowerCase() === wanted;
  }
  if (token === 'image' || token === 'images' || token === 'gambar') return isImage(item);
  if (token === 'pending' || token === 'menunggu' || token === 'local' || token === 'lokal') {
    return item.status === 'pending' || item.status === 'pushing';
  }
  if (token === 'synced' || token === 'tersimpan' || token === 'remote') return item.status === 'synced';
  if (token === 'failed' || token === 'gagal') return item.status === 'failed';
  const name = String(item.name || '').toLowerCase();
  const type = String(item.type || '').toLowerCase();
  const ext = extOf(item.name).toLowerCase();
  // The album path is derived from the local catalog, so searching by album
  // name or path stays truthful about what this device actually knows.
  const album = albumShortPath(item.albumId || null).toLowerCase();
  return name.indexOf(token) !== -1 || type.indexOf(token) !== -1
    || ext.indexOf(token) !== -1 || album.indexOf(token) !== -1;
}

function visibleItems() {
  let list = state.items.slice();
  if (state.view === 'albums') list = albumObjects(currentAlbumId());
  if (state.view === 'images') list = list.filter(isImage);
  if (state.view === 'recent') {
    const cutoff = Date.now() - RECENT_MS;
    list = list.filter((item) => (item.pushedAt || item.addedAt) >= cutoff);
  }
  if (state.view === 'changes') list = list.filter(isPendingLike);
  if (state.view === 'whitelist') list = list.filter((item) => item.remote && item.remoteMetadata?.ListType === 'White');
  if (state.view === 'blacklist') list = list.filter((item) => item.remote && item.remoteMetadata?.ListType === 'Block');
  if (state.view === 'overview' || state.view === 'tools') list = [];
  if (state.query) list = list.filter((item) => matchesQuery(item, state.query));

  const [key, dir] = state.sort.split(':');
  list.sort((a, b) => {
    let cmp = 0;
    if (key === 'name') cmp = String(a.name).localeCompare(String(b.name), getLanguage(), { sensitivity: 'base' });
    else if (key === 'size') cmp = (a.size || 0) - (b.size || 0);
    else cmp = (a.addedAt || 0) - (b.addedAt || 0);
    if (cmp === 0) cmp = String(a.id).localeCompare(String(b.id));
    return dir === 'asc' ? cmp : -cmp;
  });
  return list;
}

function counts() {
  const pendingItems = state.items.filter((i) => i.status === 'pending' || i.status === 'pushing');
  const failedItems = state.items.filter((i) => i.status === 'failed');
  const synced = state.items.filter((i) => i.status === 'synced').length;
  const totalSize = state.items.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  const pendingSize = pendingItems.concat(failedItems).reduce((sum, item) => sum + (Number(item.size) || 0), 0);
  return {
    pending: pendingItems.length,
    failed: failedItems.length,
    synced,
    total: state.items.length,
    totalSize,
    pendingSize,
  };
}

async function addFiles(fileList, albumId) {
  const files = Array.prototype.slice.call(fileList || []).filter(Boolean);
  if (!files.length) return;
  // Files staged while an album is open land in that album immediately, but
  // still only locally: nothing is uploaded until Push.
  const target = albumId !== undefined
    ? (albumId || null)
    : (state.view === 'albums' ? currentAlbumId() : null);
  const added = [];
  for (const file of files) {
    const item = {
      id: uid(),
      seq: ++stageSeq,
      name: file.name || 'untitled',
      type: file.type || '',
      size: file.size || 0,
      addedAt: Date.now(),
      pushedAt: null,
      status: 'pending',
      src: null,
      url: null,
      error: null,
      progress: 0,
      width: null,
      height: null,
      albumId: target,
      albumSynced: true,
      file,
      previewUrl: null,
    };
    if (isImage(item)) {
      try {
        const dims = await readImageSize(file);
        item.width = dims.width;
        item.height = dims.height;
      } catch (_) { /* ignore */ }
    }
    state.items.unshift(item);
    added.push(item);
    idbPut(item);
  }
  const message = target
    ? t('announceAddedToAlbum', { n: added.length, target: albumShortPath(target) })
    : plural('announceAdded', added.length);
  announce(message);
  showToast(message);
  render();
}

function readImageSize(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      resolve({ width: null, height: null });
      URL.revokeObjectURL(url);
    };
    img.src = url;
  });
}

function findItem(id) {
  return state.items.find((item) => item.id === id);
}

async function removeItem(id) {
  const item = findItem(id);
  if (!item || item.status === 'pushing') return;
  state.items = state.items.filter((entry) => entry.id !== id);
  state.selected.delete(id);
  rememberUrl(id, null);
  await idbDelete(id);
  announce(t('announceRemoved', { name: item.name }));
  render();
}

/* ==================================================================== *
 * Push — a deliberate, sequential, rate-limit-aware queue.
 *
 * One file is uploaded at a time, with a small jittered gap between files, a
 * bounded exponential backoff for transient failures, and progress/ETA derived
 * only from measurements this session actually made. The queue itself lives in
 * js/push-queue.js; everything here adapts it to the workspace: the XHR
 * uploader, the item catalog and the queue surface.
 * ==================================================================== */

/** Staging order: sequence first, then time added, then id as a last resort. */
function byStagingOrder(a, b) {
  return (a.seq || 0) - (b.seq || 0)
    || (a.addedAt || 0) - (b.addedAt || 0)
    || String(a.id).localeCompare(String(b.id));
}

function queueEntryItem(entry) {
  return findItem(entry.id);
}

/** Uploads one staged file through the existing /upload contract. */
function uploadStagedFile(entry, ctx) {
  const item = queueEntryItem(entry);
  if (!item || !item.file) {
    return Promise.resolve({ ok: false, retriable: false, error: t('pushMissingFile') });
  }

  item.status = 'pushing';
  item.queue = 'uploading';
  item.progress = 0;
  item.error = null;
  patchCard(item);

  return new Promise((resolve) => {
    const formData = new FormData();
    formData.append('file', item.file, item.name);

    const xhr = new XMLHttpRequest();
    activeUpload = xhr;
    xhr.open('POST', '/upload');

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      item.progress = Math.round((event.loaded / event.total) * 100);
      patchCard(item);
      ctx.onProgress(event.loaded, event.total);
    };

    xhr.onload = () => {
      activeUpload = null;
      let src = null;
      let errorMessage = null;
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status === 200 && data && data[0] && data[0].src) {
          src = data[0].src;
        } else {
          errorMessage = (data && data.error) || t('httpError', { status: xhr.status });
        }
      } catch (_) {
        errorMessage = t('httpError', { status: xhr.status });
      }

      if (src) {
        item.status = 'synced';
        item.queue = 'synced';
        item.progress = 100;
        item.src = src;
        item.remoteId = objectIdOf({ src });
        item.remote = true;
        item.url = location.origin + src;
        item.pushedAt = Date.now();
        // The object now exists remotely; its album membership (if any) is
        // persisted separately by the album sync step of this push.
        if (item.albumId) item.albumSynced = false;
        item.error = null;
        item.file = null;
        rememberUrl(item.id, null);
        item.previewUrl = null;
        idbPut(item);
        announce(t('announcePushed', { name: item.name }));
        patchCard(item);
        renderLinks();
        resolve({ ok: true });
        return;
      }

      let retryAfterMs = null;
      try { retryAfterMs = parseRetryAfter(xhr.getResponseHeader('Retry-After')); } catch (_) { /* header unavailable */ }
      const verdict = classifyFailure({ status: xhr.status });
      resolve({ ok: false, retriable: verdict.retriable, code: verdict.code, retryAfterMs, error: errorMessage });
    };

    xhr.onerror = () => {
      activeUpload = null;
      const verdict = classifyFailure({ networkError: true });
      resolve({ ok: false, retriable: verdict.retriable, code: verdict.code, error: t('networkError') });
    };

    xhr.send(formData);
  });
}

/** Mirrors queue state onto the catalog items so cards stay truthful. */
function applyQueueToItems(snapshot) {
  for (const entry of snapshot.entries) {
    const item = findItem(entry.id);
    if (!item) continue;
    item.queue = entry.state;
    item.queueAttempt = entry.attempt;
    if (entry.state === 'uploading') {
      item.status = 'pushing';
    } else if (entry.state === 'retrying') {
      item.status = 'pushing';
      item.error = entry.error || item.error;
    } else if (entry.state === 'failed') {
      if (item.status !== 'failed') {
        item.status = 'failed';
        item.progress = 100;
        item.error = entry.error || t('networkError');
        idbPut(item);
        announce(t('announceFailed', { name: item.name }));
      }
    } else if (entry.state === 'cancelled' || entry.state === 'queued') {
      if (item.status !== 'synced') item.status = 'pending';
    }
  }
}

function ensureQueue() {
  if (pushQueue) return pushQueue;
  pushQueue = createPushQueue({
    upload: uploadStagedFile,
    delayMs: pushDelayMs(),
    jitterRatio: PUSH_JITTER,
    maxRetries: PUSH_MAX_RETRIES,
    retryBaseMs: pushRetryBaseMs(),
    isOnline: () => state.online,
    onChange: (snapshot) => {
      state.queue = snapshot;
      applyQueueToItems(snapshot);
      renderPushPanel();
      renderChrome();
    },
  });
  return pushQueue;
}

async function pushItems(ids) {
  if (!state.online) {
    showToast(t('offlinePush'));
    return;
  }
  const targets = state.items.filter((item) => {
    if (ids && ids.indexOf(item.id) === -1) return false;
    return (item.status === 'pending' || item.status === 'failed') && item.file;
  // Deterministic order: the order the files were staged in, regardless of how
  // the browser view happens to be sorted. `seq` is monotonic, so files staged
  // within the same millisecond keep their selection order.
  }).sort(byStagingOrder);
  if (!targets.length) {
    showToast(t('pushNothing'));
    return;
  }

  const queue = ensureQueue();
  const snapshot = queue.getState();
  // A finished batch is cleared before a new one starts so the surface always
  // describes the push in front of the user.
  if (!snapshot.active && (snapshot.phase === 'done' || snapshot.phase === 'cancelled')) queue.reset();

  queue.enqueue(targets.map((item) => ({ id: item.id, name: item.name, size: item.size })));
  state.pushing = true;
  startQueueTicker();
  renderChrome();

  const result = await queue.start();

  state.pushing = result.active;
  stopQueueTicker();
  renderPushPanel();
  render();

  if (result.phase === 'paused') return;

  const { done, failed, cancelled } = result.stats;
  if (result.phase === 'cancelled') {
    showToast(t('queueCancelledToast', { n: cancelled }));
  } else if (failed) {
    showToast(t('queueSummary', { ok: done, failed, cancelled }));
  } else if (done) {
    showToast(t('pushComplete'));
  }

  // Album organization is persisted after the objects exist remotely, so a
  // staged file can be filed locally first and keep that album after Push.
  if (done && unsyncedAlbumWork().total) await syncAlbums({ silent: true });
}

function pauseQueue() {
  if (!pushQueue) return;
  pushQueue.pause();
  announce(t('queuePausedAnnounce'));
  renderPushPanel();
}

function resumeQueue() {
  if (!pushQueue) return;
  if (!state.online) {
    showToast(t('offlinePush'));
    return;
  }
  state.pushing = true;
  startQueueTicker();
  renderChrome();
  pushQueue.resume().then((result) => {
    state.pushing = result.active;
    stopQueueTicker();
    renderPushPanel();
    render();
  });
}

function cancelQueue() {
  if (!pushQueue) return;
  pushQueue.cancel();
  announce(t('queueCancelledAnnounce'));
  renderPushPanel();
}

function retryFailedQueue() {
  if (!pushQueue) return;
  if (!state.online) {
    showToast(t('offlinePush'));
    return;
  }
  // Failed files kept their local blob, so a retry needs no re-selection.
  const retryable = state.items
    .filter((item) => item.status === 'failed' && item.file)
    .sort(byStagingOrder);
  if (!retryable.length) {
    showToast(t('pushNothing'));
    return;
  }
  // Entries the queue already knows about are re-queued by retryFailed();
  // anything else (a failure from an earlier, dismissed batch) is added first.
  const known = new Set(pushQueue.getState().entries.map((entry) => entry.id));
  const fresh = retryable.filter((item) => !known.has(item.id));
  if (fresh.length) pushQueue.enqueue(fresh.map((item) => ({ id: item.id, name: item.name, size: item.size })));
  state.pushing = true;
  startQueueTicker();
  pushQueue.retryFailed().then((result) => {
    state.pushing = result.active;
    stopQueueTicker();
    renderPushPanel();
    render();
  });
}

function dismissQueue() {
  if (pushQueue) pushQueue.reset();
  state.queue = null;
  renderPushPanel();
  renderChrome();
}

/** Cheap in-place refresh of one card/row while its state changes. */
function patchCard(item) {
  const card = document.querySelector('[data-id="' + item.id + '"]');
  if (!card) {
    render();
    return;
  }
  const chip = card.querySelector('[data-role="status"]');
  if (chip) {
    chip.className = 'status-chip ' + item.status;
    chip.textContent = itemStateLabel(item);
  }
  const bar = card.querySelector('.progress > i');
  if (bar) bar.style.width = (item.progress || 0) + '%';
  const progress = card.querySelector('.progress');
  if (progress) progress.hidden = item.status !== 'pushing';
  const img = card.querySelector('img');
  if (img && item.url) img.src = item.url;
  card.classList.toggle('pushing', item.status === 'pushing');
  card.classList.toggle('failed', item.status === 'failed');
  renderChrome();
}

/* --------------------------- queue rendering -------------------------- */

function startQueueTicker() {
  if (queueTicker) return;
  // A slow tick is enough for a countdown and keeps the surface calm.
  queueTicker = setInterval(() => {
    if (!state.queue) return;
    state.queue = pushQueue ? pushQueue.getState() : state.queue;
    renderPushPanel();
  }, 250);
}

function stopQueueTicker() {
  if (!queueTicker) return;
  clearInterval(queueTicker);
  queueTicker = null;
}

function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return t('durationSeconds', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) {
    return rest ? t('durationMinutesSeconds', { m: minutes, s: rest }) : t('durationMinutes', { n: minutes });
  }
  return t('durationMinutes', { n: minutes });
}

function queuePhaseLabel(snapshot) {
  return t({
    uploading: 'queuePhaseUploading',
    waiting: 'queuePhaseWaiting',
    retrying: 'queuePhaseRetrying',
    paused: 'queuePhasePaused',
    done: 'queuePhaseDone',
    cancelled: 'queuePhaseCancelled',
    idle: 'queuePhaseIdle',
  }[snapshot.phase] || 'queuePhaseIdle');
}

function renderPushPanel() {
  const panel = $('push-panel');
  if (!panel) return;
  const snapshot = state.queue;
  if (!snapshot || !snapshot.stats.total) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;

  const s = snapshot.stats;
  const finished = snapshot.phase === 'done' || snapshot.phase === 'cancelled';
  $('push-phase').textContent = queuePhaseLabel(snapshot);

  // Overall progress prefers real bytes and degrades to file counts when the
  // browser cannot report them.
  const useBytes = s.bytesTotal > 0;
  const ratio = useBytes
    ? s.bytesDone / s.bytesTotal
    : (s.total ? s.processed / s.total : 0);
  const percent = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  const bar = $('push-bar');
  const fill = $('push-bar-fill');
  if (fill) fill.style.width = percent + '%';
  if (bar) {
    bar.setAttribute('aria-valuenow', String(percent));
    bar.setAttribute('aria-label', t('queueProgress', { done: s.processed, total: s.total }));
  }

  const parts = [t('queueProgress', { done: Math.min(s.processed + (snapshot.current ? 1 : 0), s.total), total: s.total })];
  if (useBytes) parts.push(t('queueBytes', { done: formatSize(s.bytesDone), total: formatSize(s.bytesTotal) }));
  if (!finished) {
    const eta = roundEtaMs(snapshot.etaMs);
    parts.push(eta == null ? t('queueEstimating') : t('queueEta', { time: formatDuration(eta) }));
  }
  $('push-progress-text').textContent = parts.join(' · ');

  const current = $('push-current');
  if (snapshot.current) {
    current.hidden = false;
    $('push-current-name').textContent = snapshot.current.name;
    $('push-current-state').textContent = snapshot.current.attempt > 1
      ? t('queueRetryCount', { n: snapshot.current.attempt - 1, max: snapshot.config.maxRetries })
      : t('queuePhaseUploading');
    $('push-current-fill').style.width = Math.round((snapshot.current.progress || 0) * 100) + '%';
  } else {
    current.hidden = true;
  }

  const note = $('push-note');
  if (finished) {
    note.textContent = t('queueSummary', { ok: s.done, failed: s.failed, cancelled: s.cancelled });
  } else if (snapshot.phase === 'waiting') {
    note.textContent = t('queueWaitingNext', { s: (snapshot.waitMsRemaining / 1000).toFixed(1) });
  } else if (snapshot.phase === 'retrying' && snapshot.retrying) {
    note.textContent = t('queueRetryIn', {
      s: Math.ceil(snapshot.waitMsRemaining / 1000),
      name: snapshot.retrying.name,
    });
  } else if (snapshot.phase === 'paused') {
    note.textContent = t('queuePausedNote', { n: s.remaining });
  } else {
    note.textContent = '';
  }

  const pause = $('push-pause');
  const cancel = $('push-cancel');
  const retry = $('push-retry-failed');
  const dismiss = $('push-dismiss');
  pause.hidden = finished;
  pause.textContent = snapshot.phase === 'paused' ? t('queueResume') : t('queuePause');
  pause.disabled = snapshot.phase === 'paused' && !state.online;
  cancel.hidden = finished;
  cancel.disabled = false;
  retry.hidden = !finished || (s.failed === 0 && s.cancelled === 0);
  retry.textContent = s.failed ? t('queueRetryFailed') : t('queueResumeRemaining');
  dismiss.hidden = !finished;
}

function glyph(item) {
  const type = item.type || '';
  let kind = 'FILE';
  if (type.indexOf('image/') === 0) kind = 'IMG';
  else if (type.indexOf('video/') === 0) kind = 'VID';
  else if (type.indexOf('audio/') === 0) kind = 'AUD';
  else if (type.indexOf('pdf') !== -1) kind = 'PDF';
  else if (type.indexOf('zip') !== -1 || type.indexOf('compressed') !== -1) kind = 'ZIP';
  else if (type.indexOf('text/') === 0 || type.indexOf('json') !== -1) kind = 'TXT';
  return kind;
}

/* ==================================================================== *
 * Albums — an organizational layer over the local catalog.
 *
 * Albums never change an object's identity: the id, filename, public URL,
 * moderation state and storage location are untouched by any operation here.
 * Album records live next to the item catalog in IndexedDB and are pushed to
 * the remote album API only through the deliberate Push / Sync albums action.
 * ==================================================================== */

function albumIndex() {
  return indexAlbums(state.albums);
}

function currentAlbumId() {
  return resolveAlbumId(albumIndex(), state.albumId);
}

function albumById(id) {
  return albumIndex().get(id) || null;
}

/** "Storage / Projects / Website" — display only. */
function albumCrumbLabel(id) {
  return pathLabel(albumIndex(), id, { rootLabel: t('breadcrumbRoot') });
}

/** "Projects / Website" without the storage root, for chips and messages. */
function albumShortPath(id) {
  if (!id) return t('albumRoot');
  return pathLabel(albumIndex(), id) || t('albumRoot');
}

function albumChildren(id) {
  return childrenOf(state.albums, id, getLanguage());
}

/** Objects directly inside an album (root = everything not filed anywhere). */
function albumObjects(id) {
  return objectsIn(state.items, id, { index: albumIndex() });
}

/** Counts come from this device's catalog only — never presented as a remote total. */
function albumCount(id, recursive) {
  return countObjects(state.items, id, { albums: state.albums, recursive: !!recursive });
}

/** A cover is only ever a real image already in the catalog. Never invented. */
function albumCover(id) {
  const scope = subtreeIds(state.albums, id);
  const index = albumIndex();
  const candidate = state.items.find((item) => (
    isImage(item) && scope.has(resolveAlbumId(index, item.albumId) || '')
  ));
  if (!candidate) return null;
  return candidate.status === 'synced' ? candidate.url : localPreview(candidate);
}

function albumIsUnsynced(album) {
  return album && album.synced !== true;
}

function unsyncedAlbumWork() {
  const albums = state.albums.filter(albumIsUnsynced).length;
  const memberships = state.items.filter((item) => item.status === 'synced' && item.albumSynced === false).length;
  return { albums, memberships, total: albums + memberships };
}

function albumErrorMessage(code) {
  const keys = {
    name_required: 'albumErrorName',
    name_too_long: 'albumErrorNameLong',
    name_invalid: 'albumErrorNameInvalid',
    duplicate_name: 'albumErrorDuplicate',
    parent_not_found: 'albumErrorParentMissing',
    self_parent: 'albumErrorSelf',
    cycle: 'albumErrorCycle',
    too_deep: 'albumErrorDepth',
  };
  return t(keys[code] || 'albumErrorGeneric');
}

/* ------------------------------ mutations ----------------------------- */

async function saveAlbum(album) {
  const idx = state.albums.findIndex((a) => a.id === album.id);
  if (idx === -1) state.albums.push(album);
  else state.albums[idx] = album;
  await idbAlbumPut(album);
}

async function addAlbum(name, parentId) {
  const nameCheck = validateName(name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error };
  const check = canMove(state.albums, null, parentId, nameCheck.name);
  if (!check.ok) return { ok: false, error: check.error };
  const album = createAlbum(nameCheck.name, check.parentId);
  await saveAlbum(album);
  if (check.parentId) state.expanded.add(check.parentId);
  savePrefs();
  render();
  showToast(t('albumCreated', { name: album.name }));
  announce(t('albumCreated', { name: album.name }));
  return { ok: true, album };
}

async function renameAlbumById(id, name) {
  const album = albumById(id);
  if (!album) return { ok: false, error: 'parent_not_found' };
  const nameCheck = validateName(name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error };
  const check = canMove(state.albums, id, album.parentId, nameCheck.name);
  if (!check.ok) return { ok: false, error: check.error };
  // Renaming keeps the id, so children and object memberships are unaffected.
  await saveAlbum({ ...album, name: nameCheck.name, updatedAt: Date.now(), synced: false });
  render();
  showToast(t('albumRenamed', { name: nameCheck.name }));
  return { ok: true };
}

async function moveAlbumTo(id, parentId) {
  const album = albumById(id);
  if (!album) return { ok: false, error: 'parent_not_found' };
  if ((album.parentId || null) === (parentId || null)) return { ok: true, unchanged: true };
  const check = canMove(state.albums, id, parentId, album.name);
  if (!check.ok) return { ok: false, error: check.error };
  await saveAlbum({ ...album, parentId: check.parentId, updatedAt: Date.now(), synced: false });
  if (check.parentId) state.expanded.add(check.parentId);
  render();
  showToast(t('albumMoved', { name: album.name, target: albumShortPath(check.parentId) }));
  announce(t('albumMoved', { name: album.name, target: albumShortPath(check.parentId) }));
  return { ok: true };
}

/**
 * Deleting an album removes organization only. Child albums are lifted to the
 * deleted album's parent and its objects move to that parent as well — no file
 * is ever removed by this action.
 */
async function deleteAlbumById(id) {
  const album = albumById(id);
  if (!album) return;
  const parentId = album.parentId || null;

  for (const child of albumChildren(id)) {
    await saveAlbum({ ...child, parentId, updatedAt: Date.now(), synced: false });
  }
  for (const item of state.items.filter((entry) => entry.albumId === id)) {
    item.albumId = parentId;
    item.albumSynced = item.status === 'synced' ? false : true;
    await idbPut(item);
  }

  state.albums = state.albums.filter((entry) => entry.id !== id);
  state.expanded.delete(id);
  await idbAlbumDelete(id);
  if (state.albumId === id) state.albumId = parentId;
  if (album.synced) deleteRemoteAlbum(id);

  savePrefs();
  render();
  showToast(t('albumDeleted', { name: album.name }));
  announce(t('albumDeletedAnnounce', { name: album.name }));
}

async function moveObjectsToAlbum(ids, albumId) {
  const target = albumId && albumId !== ROOT_ID ? albumId : null;
  if (target && !albumById(target)) {
    showToast(albumErrorMessage('parent_not_found'));
    return;
  }
  const items = ids.map(findItem).filter(Boolean);
  if (!items.length) return;
  for (const item of items) {
    if ((item.albumId || null) === target) continue;
    item.albumId = target;
    // A synced object needs its membership persisted remotely on the next push.
    item.albumSynced = item.status === 'synced' ? false : true;
    await idbPut(item);
  }
  render();
  const message = items.length === 1
    ? t('objectMoved', { name: items[0].name, target: albumShortPath(target) })
    : t('objectsMoved', { n: items.length, target: albumShortPath(target) });
  showToast(message);
  announce(message);
}

function openAlbum(id) {
  const resolved = id && id !== ROOT_ID ? id : null;
  state.view = 'albums';
  state.albumId = resolved;
  if (resolved) ancestorIds(albumIndex(), resolved).forEach((parent) => state.expanded.add(parent));
  savePrefs();
  render();
  announce(t('albumOpened', { name: albumCrumbLabel(resolved) }));
}

function goToParentAlbum() {
  const album = albumById(currentAlbumId());
  openAlbum(album ? album.parentId : null);
}

/* ------------------------- remote album sync -------------------------- */

/**
 * The album API lives behind the existing manage middleware. A public visitor
 * without a session keeps a perfectly usable local hierarchy; we simply say so
 * instead of pretending it is stored remotely.
 */
async function albumApi(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    redirect: 'manual',
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    ...options,
  });
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403 || [301, 302, 303, 307, 308].indexOf(res.status) !== -1) {
    const error = new Error('unauthenticated');
    error.unauthenticated = true;
    throw error;
  }
  return res;
}

function objectIdOf(item) {
  if (!item) return null;
  if (item.remoteId) return item.remoteId;
  if (!item.src) return null;
  const match = String(item.src).match(/\/file\/([^/?#]+)/);
  if (!match) return null;
  try { return decodeURIComponent(match[1]); } catch (_) { return match[1]; }
}

function storedMime(metadata) {
  const meta = metadata || {};
  return meta.mimeType || meta.mimetype || meta.contentType || meta.type || '';
}

function normalizedRemoteMetadata(metadata, id) {
  const meta = metadata || {};
  return {
    ListType: meta.ListType || 'None',
    Label: meta.Label || 'None',
    TimeStamp: Number(meta.TimeStamp) || 0,
    liked: !!meta.liked,
    fileName: meta.fileName || id,
    fileSize: Number(meta.fileSize) || 0,
    ...meta,
  };
}

async function manageApi(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    ...options,
  });
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403
    || [301, 302, 303, 307, 308].indexOf(res.status) !== -1) {
    const error = new Error('unauthenticated');
    error.unauthenticated = true;
    throw error;
  }
  return res;
}

function redirectToLogin() {
  try { sessionStorage.setItem('ti.session-expired', '1'); } catch (_) { /* ignore */ }
  window.location.href = '/login?next=' + encodeURIComponent('/admin');
}

async function requireSession() {
  try {
    const res = await manageApi('/api/manage/session');
    if (!res.ok) throw new Error('session_failed');
    const data = await res.json();
    if (!data.authenticated) return false;
    state.session = data;
    return true;
  } catch (error) {
    if (error && error.unauthenticated) return false;
    return false;
  }
}

function publicObjectUrl(id, metadata) {
  const publicId = (metadata && metadata.shortId) || id;
  return location.origin + '/file/' + encodeURIComponent(publicId);
}

function mergeRemoteRecords(keys, reset) {
  if (reset) state.items = state.items.filter((item) => !item.remoteOnly);
  for (const key of keys || []) {
    const remoteId = String(key.name || '');
    if (!remoteId) continue;
    const metadata = normalizedRemoteMetadata(key.metadata, remoteId);
    let item = state.items.find((entry) => objectIdOf(entry) === remoteId);
    if (!item) {
      item = {
        id: 'remote:' + remoteId,
        seq: 0,
        addedAt: metadata.TimeStamp || 0,
        pushedAt: metadata.TimeStamp || 0,
        status: 'synced',
        src: '/file/' + encodeURIComponent(remoteId),
        progress: 100,
        error: null,
        width: Number(metadata.width) || null,
        height: Number(metadata.height) || null,
        albumSynced: true,
        file: null,
        previewUrl: null,
        remoteOnly: true,
      };
      state.items.push(item);
    }
    item.remote = true;
    item.remoteId = remoteId;
    item.remoteMetadata = metadata;
    item.name = metadata.fileName || remoteId;
    item.type = storedMime(metadata);
    item.size = Number(metadata.fileSize) || item.size || 0;
    item.addedAt = metadata.TimeStamp || item.addedAt || 0;
    item.pushedAt = metadata.TimeStamp || item.pushedAt || null;
    item.albumId = metadata.albumId || null;
    item.url = publicObjectUrl(remoteId, metadata);
    item._category = null;
  }
  state.remoteLoaded = state.items.filter((item) => item.remote).length;
}

async function loadRemotePage(reset = false) {
  if (state.remoteLoading || (!reset && state.remoteComplete)) return false;
  state.remoteLoading = true;
  state.remoteError = false;
  renderChrome();
  try {
    const params = new URLSearchParams({ limit: String(REMOTE_PAGE_SIZE) });
    if (!reset && state.remoteCursor) params.set('cursor', state.remoteCursor);
    const res = await manageApi('/api/manage/list?' + params.toString());
    if (!res.ok) throw new Error('remote_list_' + res.status);
    const data = await res.json();
    mergeRemoteRecords(data.keys || [], reset);
    state.remoteCursor = data.list_complete ? null : data.cursor;
    state.remoteComplete = !!data.list_complete;
    return true;
  } catch (error) {
    if (error && error.unauthenticated) {
      redirectToLogin();
      return false;
    }
    state.remoteError = true;
    return false;
  } finally {
    state.remoteLoading = false;
    if (reset) state.remoteReady = true;
    render();
  }
}

async function deleteRemoteAlbum(id) {
  try {
    await albumApi('/api/manage/albums/' + encodeURIComponent(id), { method: 'DELETE' });
  } catch (_) {
    state.albumSync = 'local';
    renderChrome();
  }
}

/**
 * Deliberate, bounded synchronization: album records first, then the object
 * memberships of objects that already exist remotely. No background loop.
 */
async function syncAlbums({ silent } = {}) {
  if (!state.online) {
    if (!silent) showToast(t('albumSyncOffline'));
    return false;
  }
  const work = unsyncedAlbumWork();
  if (!work.total) {
    state.albumSync = state.albums.length ? 'synced' : state.albumSync;
    if (!silent) showToast(t('albumSyncNothing'));
    renderChrome();
    return true;
  }

  try {
    // Parents before children so a nested album always has a valid destination.
    const ordered = [];
    const walk = (parentId) => {
      for (const album of childrenOf(state.albums, parentId, getLanguage())) {
        ordered.push(album);
        walk(album.id);
      }
    };
    walk(null);

    for (const album of ordered) {
      if (!albumIsUnsynced(album)) continue;
      // Creating with a client id is idempotent; the PATCH converges name/parent.
      await albumApi('/api/manage/albums', {
        method: 'POST',
        body: JSON.stringify({ id: album.id, name: album.name, parentId: album.parentId }),
      });
      const patch = await albumApi('/api/manage/albums/' + encodeURIComponent(album.id), {
        method: 'PATCH',
        body: JSON.stringify({ name: album.name, parentId: album.parentId }),
      });
      if (!patch.ok) throw new Error('album_sync_failed');
      await saveAlbum({ ...album, synced: true });
    }

    const pending = state.items.filter((item) => item.status === 'synced' && item.albumSynced === false && objectIdOf(item));
    const groups = new Map();
    for (const item of pending) {
      const key = item.albumId || ROOT_ID;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    for (const [key, items] of groups) {
      const res = await albumApi('/api/manage/albums/assign', {
        method: 'POST',
        body: JSON.stringify({ albumId: key === ROOT_ID ? null : key, ids: items.map(objectIdOf) }),
      });
      if (!res.ok) throw new Error('assign_failed');
      for (const item of items) {
        item.albumSynced = true;
        await idbPut(item);
      }
    }

    state.albumSync = 'synced';
    if (!silent) showToast(t('albumSyncDone', { n: work.total }));
    announce(t('albumSyncDone', { n: work.total }));
    render();
    return true;
  } catch (error) {
    state.albumSync = 'local';
    if (!silent) showToast(error && error.unauthenticated ? t('albumSyncUnauthenticated') : t('albumSyncFailed'));
    render();
    return false;
  }
}

/** Pulls remote album definitions when the visitor is allowed to see them. */
async function loadRemoteAlbums() {
  try {
    const res = await albumApi('/api/manage/albums');
    if (!res.ok) return false;
    const data = await res.json();
    const merged = mergeRemoteAlbums(state.albums, (data.albums || []).map(normalizeAlbum).filter(Boolean));
    state.albums = merged;
    for (const album of merged) await idbAlbumPut(album);
    state.albumSync = unsyncedAlbumWork().total ? 'local' : 'synced';
    return true;
  } catch (_) {
    if (state.albums.length) state.albumSync = 'local';
    return false;
  }
}

/* --------------------------- album rendering -------------------------- */

function folderIcon(open) {
  const span = document.createElement('span');
  span.className = 'album-icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = open
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h3.1l1.8 1.8h7.7A2.2 2.2 0 0 1 20.5 10H7.6a2 2 0 0 0-1.9 1.4L3.5 18z"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h3.1l1.8 1.8h7.7A2.2 2.2 0 0 1 20.5 10v7.3a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/></svg>';
  return span;
}

function renderAlbumTree() {
  const tree = $('album-tree');
  const empty = $('album-nav-empty');
  if (!tree) return;
  tree.replaceChildren();

  const rows = flattenTree(state.albums, { expanded: state.expanded, locale: getLanguage() });
  if (empty) empty.hidden = rows.length > 0;

  const rootRow = buildTreeRow({
    id: null,
    label: t('albumRoot'),
    depth: 0,
    hasChildren: state.albums.length > 0,
    expandable: false,
  });
  tree.appendChild(rootRow);

  rows.forEach(({ album, depth, hasChildren }) => {
    tree.appendChild(buildTreeRow({
      id: album.id,
      label: album.name,
      depth: depth + 1,
      hasChildren,
      expandable: hasChildren,
      album,
    }));
  });

  const syncRow = $('album-sync-row');
  if (syncRow) {
    const work = unsyncedAlbumWork();
    syncRow.hidden = work.total === 0;
    const note = $('album-sync-note');
    if (note) note.textContent = t('albumUnsyncedCount', { n: work.total });
    const button = $('album-sync-btn');
    if (button) button.disabled = !state.online;
  }

  updateTreeRoving();
}

function buildTreeRow({ id, label, depth, hasChildren, expandable, album }) {
  const li = document.createElement('li');
  li.className = 'album-row';
  li.setAttribute('role', 'treeitem');
  li.dataset.albumId = id || ROOT_ID;
  const active = (currentAlbumId() || null) === (id || null) && state.view === 'albums';
  if (active) li.classList.add('active');
  li.setAttribute('aria-selected', active ? 'true' : 'false');
  li.setAttribute('aria-level', String(depth + 1));
  // Only genuinely collapsible nodes advertise an expanded state; the root row
  // is a navigation target whose children are the top-level rows.
  if (expandable) li.setAttribute('aria-expanded', state.expanded.has(id) ? 'true' : 'false');

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'album-row-btn';
  button.style.paddingInlineStart = (8 + depth * 14) + 'px';
  button.tabIndex = -1;

  if (expandable) {
    const twisty = document.createElement('span');
    twisty.className = 'album-twisty' + (state.expanded.has(id) ? ' open' : '');
    twisty.setAttribute('aria-hidden', 'true');
    twisty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
    twisty.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleExpanded(id);
    });
    button.appendChild(twisty);
  } else {
    const spacer = document.createElement('span');
    spacer.className = 'album-twisty placeholder';
    spacer.setAttribute('aria-hidden', 'true');
    button.appendChild(spacer);
  }

  button.appendChild(folderIcon(active));

  const text = document.createElement('span');
  text.className = 'album-row-name';
  text.textContent = label;
  button.appendChild(text);

  const count = albumCount(id, false);
  if (count) {
    const badge = document.createElement('span');
    badge.className = 'album-row-count';
    badge.textContent = String(count);
    badge.title = t('albumCountLocal', { n: count });
    button.appendChild(badge);
  }
  if (album && albumIsUnsynced(album)) {
    const dot = document.createElement('span');
    dot.className = 'album-unsynced-dot';
    dot.title = t('albumUnsynced');
    dot.setAttribute('aria-label', t('albumUnsynced'));
    button.appendChild(dot);
  }

  button.addEventListener('click', () => openAlbum(id));
  if (album) {
    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      openAlbumMenu(album, null, event.clientX, event.clientY);
    });
    li.draggable = true;
    li.addEventListener('dragstart', (event) => startAlbumDrag(event, album.id));
    li.addEventListener('dragend', endDrag);
  }

  li.appendChild(button);
  attachAlbumDropTarget(li, id);
  li.addEventListener('keydown', (event) => onTreeKeydown(event, id));
  return li;
}

function toggleExpanded(id) {
  if (!id) return;
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  savePrefs();
  renderAlbumTree();
}

function treeRows() {
  return Array.prototype.slice.call(document.querySelectorAll('#album-tree .album-row'));
}

function updateTreeRoving() {
  const rows = treeRows();
  const activeIndex = Math.max(0, rows.findIndex((row) => row.classList.contains('active')));
  rows.forEach((row, index) => { row.tabIndex = index === activeIndex ? 0 : -1; });
}

function onTreeKeydown(event, id) {
  const rows = treeRows();
  const index = rows.findIndex((row) => row.dataset.albumId === (id || ROOT_ID));
  const focusRow = (next) => {
    if (!next) return;
    rows.forEach((row) => { row.tabIndex = -1; });
    next.tabIndex = 0;
    next.focus();
  };
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      focusRow(rows[index + 1]);
      break;
    case 'ArrowUp':
      event.preventDefault();
      focusRow(rows[index - 1]);
      break;
    case 'ArrowRight':
      event.preventDefault();
      if (id && albumChildren(id).length && !state.expanded.has(id)) toggleExpanded(id);
      else focusRow(rows[index + 1]);
      break;
    case 'ArrowLeft': {
      event.preventDefault();
      if (id && state.expanded.has(id)) { toggleExpanded(id); break; }
      const album = id ? albumById(id) : null;
      const parent = album ? (album.parentId || ROOT_ID) : null;
      if (parent) focusRow(rows.find((row) => row.dataset.albumId === parent));
      break;
    }
    case 'Home':
      event.preventDefault();
      focusRow(rows[0]);
      break;
    case 'End':
      event.preventDefault();
      focusRow(rows[rows.length - 1]);
      break;
    case 'Enter':
    case ' ':
      event.preventDefault();
      openAlbum(id);
      break;
    case 'F2':
      if (id) {
        event.preventDefault();
        openAlbumDialog({ mode: 'rename', albumId: id });
      }
      break;
    default:
      break;
  }
}

function renderCrumbs() {
  const list = $('crumbs');
  if (!list) return;
  list.replaceChildren();

  const addCrumb = (label, { onClick, current, albumId } = {}) => {
    const li = document.createElement('li');
    if (onClick) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'crumb-link';
      btn.textContent = label;
      btn.addEventListener('click', onClick);
      if (albumId !== undefined) attachAlbumDropTarget(btn, albumId);
      li.appendChild(btn);
    } else {
      const span = document.createElement('span');
      span.textContent = label;
      li.appendChild(span);
    }
    if (!current) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.setAttribute('aria-hidden', 'true');
      sep.textContent = '/';
      li.appendChild(sep);
    } else {
      li.setAttribute('aria-current', 'page');
      li.id = 'crumb-current';
    }
    list.appendChild(li);
  };

  if (state.view !== 'albums') {
    const keys = {
      overview: 'consoleOverview', files: 'navFiles', images: 'navImages', recent: 'navRecent',
      changes: 'navChanges', whitelist: 'navWhitelist', blacklist: 'navBlacklist', tools: 'navTools',
    };
    const key = keys[state.view] || 'navFiles';
    addCrumb(t('breadcrumbRoot'), { onClick: () => { state.view = 'files'; savePrefs(); render(); } });
    addCrumb(t(key), { current: true });
    return;
  }

  const chain = pathOf(albumIndex(), currentAlbumId());
  const atRoot = chain.length === 0;
  addCrumb(t('breadcrumbRoot'), atRoot ? { current: true } : { onClick: () => openAlbum(null), albumId: null });
  chain.forEach((album, i) => {
    const current = i === chain.length - 1;
    addCrumb(album.name, current
      ? { current: true }
      : { onClick: () => openAlbum(album.id), albumId: album.id });
  });
}

function buildAlbumCard(album) {
  const card = document.createElement('article');
  card.className = 'album-card';
  card.dataset.albumId = album.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', t('openAlbumAria', { name: album.name }));
  card.draggable = true;
  card.addEventListener('dragstart', (event) => startAlbumDrag(event, album.id));
  card.addEventListener('dragend', endDrag);

  const cover = document.createElement('div');
  cover.className = 'album-cover';
  const src = albumCover(album.id);
  if (src) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = '';
    img.loading = 'lazy';
    cover.appendChild(img);
  } else {
    cover.classList.add('placeholder');
    cover.appendChild(folderIcon(false));
  }
  card.appendChild(cover);

  const body = document.createElement('div');
  body.className = 'album-card-body';
  const name = document.createElement('div');
  name.className = 'album-card-name';
  name.textContent = album.name;
  const meta = document.createElement('div');
  meta.className = 'album-card-meta';
  const objectsHere = albumCount(album.id, true);
  const subAlbums = albumChildren(album.id).length;
  const parts = [];
  if (!objectsHere && !subAlbums) parts.push(t('albumEmptyMeta'));
  else parts.push(t('albumCountLocal', { n: objectsHere }));
  if (subAlbums) parts.push(t('albumSubcount', { n: subAlbums }));
  meta.textContent = parts.join(' · ');
  body.appendChild(name);
  body.appendChild(meta);

  if (albumIsUnsynced(album)) {
    const chip = document.createElement('span');
    chip.className = 'status-chip local album-chip';
    chip.textContent = t('albumUnsynced');
    body.appendChild(chip);
  }
  card.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'album-card-actions';
  actions.appendChild(iconAction('more', t('albumMenuAria', { name: album.name }), (event) => {
    event.stopPropagation();
    openAlbumMenu(album, event.currentTarget);
  }));
  card.appendChild(actions);

  card.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    openAlbum(album.id);
  });
  card.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openAlbum(album.id);
    }
  });
  card.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openAlbumMenu(album, null, event.clientX, event.clientY);
  });
  attachAlbumDropTarget(card, album.id);
  return card;
}

function openAlbumMenu(album, anchor, x, y) {
  const menu = $('context-menu');
  menu.innerHTML = '';
  const add = (label, fn, disabled) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = label;
    btn.disabled = !!disabled;
    btn.addEventListener('click', () => { closeMenus(); fn(); });
    menu.appendChild(btn);
  };
  add(t('openAlbum'), () => openAlbum(album.id));
  add(t('createInside'), () => openAlbumDialog({ mode: 'create', parentId: album.id }));
  add(t('renameAlbum'), () => openAlbumDialog({ mode: 'rename', albumId: album.id }));
  add(t('moveAlbum'), () => openMoveDialog({ kind: 'album', albumId: album.id }));
  if (album.parentId) {
    // "Move to parent" lifts the album one level out of its current parent.
    const grandparent = (albumById(album.parentId) || {}).parentId || null;
    add(t('moveToParent'), () => moveAlbumTo(album.id, grandparent));
  }
  const sep = document.createElement('div');
  sep.className = 'sep';
  menu.appendChild(sep);
  add(t('deleteAlbum'), () => askDeleteAlbum(album));
  placeMenu(menu, anchor, x, y);
}

function askDeleteAlbum(album) {
  const objects = albumCount(album.id, true);
  const children = albumChildren(album.id).length;
  $('confirm-title').textContent = t('deleteAlbumTitle', { name: album.name });
  $('confirm-body').textContent = children
    ? t('deleteAlbumBodyNested', { n: objects, c: children })
    : t('deleteAlbumBody', { n: objects });
  $('confirm-ok').textContent = t('deleteAlbumConfirm');
  lastFocus = document.activeElement;
  openOverlayDialog($('confirm-dialog'));
  confirmResolver = (ok) => {
    $('confirm-ok').textContent = t('confirmRemove');
    if (ok) deleteAlbumById(album.id);
  };
}

/* ------------------------------ dialogs ------------------------------- */

function openAlbumDialog({ mode, parentId, albumId, onCreated }) {
  const dialog = $('album-dialog');
  const input = $('album-name-input');
  const error = $('album-name-error');
  const album = albumId ? albumById(albumId) : null;
  albumDialogContext = { mode, parentId: album ? album.parentId : (parentId || null), albumId, onCreated };
  lastFocus = document.activeElement;

  $('album-dialog-title').textContent = mode === 'rename' ? t('renameAlbum') : t('newAlbum');
  $('album-dialog-context').textContent = mode === 'rename'
    ? t('albumPathLabel', { path: albumCrumbLabel(albumId) })
    : t('albumCreateIn', { path: albumCrumbLabel(parentId || null) });
  $('album-save').textContent = mode === 'rename' ? t('save') : t('create');
  error.textContent = '';
  input.value = album ? album.name : '';
  openOverlayDialog(dialog);
  input.focus();
  input.select();
}

async function submitAlbumDialog() {
  if (!albumDialogContext) return;
  const input = $('album-name-input');
  const error = $('album-name-error');
  const value = input.value;
  const context = albumDialogContext;
  const result = context.mode === 'rename'
    ? await renameAlbumById(context.albumId, value)
    : await addAlbum(value, context.parentId);
  if (!result.ok) {
    error.textContent = albumErrorMessage(result.error);
    input.focus();
    return;
  }
  albumDialogContext = null;
  closeDialogs();
  if (context.mode !== 'rename' && context.onCreated) context.onCreated(result.album);
}

/**
 * Move sheet: shows the whole hierarchy and disables destinations that would
 * create an invalid tree (self, descendant, too deep, duplicate sibling).
 */
function openMoveDialog(context) {
  moveContext = { ...context, target: undefined };
  lastFocus = document.activeElement;
  const dialog = $('move-dialog');
  $('move-dialog-title').textContent = context.kind === 'album' ? t('moveAlbum') : t('moveToAlbum');
  const subject = context.kind === 'album'
    ? (albumById(context.albumId) || {}).name
    : (context.ids.length === 1 ? (findItem(context.ids[0]) || {}).name : t('selectedCount', { n: context.ids.length }));
  $('move-dialog-context').textContent = t('moveSubject', { name: subject || '' });
  renderMovePicker();
  openOverlayDialog(dialog);
}

function moveTargetInvalid(targetId) {
  if (!moveContext) return 'albumErrorGeneric';
  if (moveContext.kind === 'album') {
    const check = canMove(state.albums, moveContext.albumId, targetId, (albumById(moveContext.albumId) || {}).name);
    return check.ok ? null : check.error;
  }
  return null;
}

function renderMovePicker() {
  const picker = $('move-picker');
  const note = $('move-dialog-note');
  if (!picker) return;
  picker.replaceChildren();

  const rows = [{ id: null, name: t('albumRoot'), depth: 0 }].concat(
    flattenTree(state.albums, { locale: getLanguage() }).map(({ album, depth }) => ({
      id: album.id, name: album.name, depth: depth + 1,
    })),
  );

  const current = moveContext.kind === 'album'
    ? (albumById(moveContext.albumId) || {}).parentId || null
    : (findItem(moveContext.ids[0]) || {}).albumId || null;
  if (moveContext.target === undefined) moveContext.target = current;

  rows.forEach((row) => {
    const li = document.createElement('li');
    li.setAttribute('role', 'treeitem');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'album-picker-row';
    btn.style.paddingInlineStart = (12 + row.depth * 16) + 'px';
    const invalid = moveTargetInvalid(row.id);
    btn.disabled = !!invalid;
    if (invalid) btn.title = albumErrorMessage(invalid);
    btn.setAttribute('aria-selected', moveContext.target === row.id ? 'true' : 'false');
    if (moveContext.target === row.id) btn.classList.add('selected');
    btn.appendChild(folderIcon(false));
    const label = document.createElement('span');
    label.className = 'album-picker-name';
    label.textContent = row.name;
    btn.appendChild(label);
    if (row.id === current) {
      const chip = document.createElement('span');
      chip.className = 'album-picker-chip';
      chip.textContent = t('currentLocation');
      btn.appendChild(chip);
    }
    btn.addEventListener('click', () => {
      moveContext.target = row.id;
      renderMovePicker();
    });
    li.appendChild(btn);
    picker.appendChild(li);
  });

  if (note) note.textContent = t('movePickerNote', { path: albumCrumbLabel(moveContext.target || null) });
  const confirm = $('move-confirm');
  if (confirm) confirm.disabled = !!moveTargetInvalid(moveContext.target || null);
}

async function submitMoveDialog() {
  if (!moveContext) return;
  const context = moveContext;
  const target = context.target || null;
  moveContext = null;
  closeDialogs();
  if (context.kind === 'album') {
    const result = await moveAlbumTo(context.albumId, target);
    if (!result.ok) showToast(albumErrorMessage(result.error));
  } else {
    await moveObjectsToAlbum(context.ids, target);
    clearSelection();
  }
}

/* --------------------------- drag and drop ---------------------------- */

function showDragHint(message, invalid) {
  const hint = $('drag-hint');
  if (!hint) return;
  hint.textContent = message;
  hint.hidden = !message;
  hint.classList.toggle('invalid', !!invalid);
}

function hideDragHint() {
  const hint = $('drag-hint');
  if (!hint) return;
  hint.hidden = true;
  hint.textContent = '';
  hint.classList.remove('invalid');
}

function startObjectDrag(event, item) {
  const ids = state.selected.has(item.id) ? Array.from(state.selected) : [item.id];
  dragState = { kind: 'objects', ids };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    try {
      event.dataTransfer.setData('application/x-ti-objects', JSON.stringify(ids));
      event.dataTransfer.setData('text/plain', ids.map((id) => (findItem(id) || {}).name || id).join('\n'));
    } catch (_) { /* older browsers */ }
  }
  document.body.classList.add('dragging-internal');
}

function startAlbumDrag(event, albumId) {
  dragState = { kind: 'album', albumId };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    try {
      event.dataTransfer.setData('application/x-ti-album', albumId);
      event.dataTransfer.setData('text/plain', (albumById(albumId) || {}).name || albumId);
    } catch (_) { /* older browsers */ }
  }
  event.stopPropagation();
  document.body.classList.add('dragging-internal');
}

function endDrag() {
  dragState = null;
  document.body.classList.remove('dragging-internal');
  hideDragHint();
  document.querySelectorAll('.drop-target, .drop-invalid').forEach((el) => {
    el.classList.remove('drop-target', 'drop-invalid');
  });
}

/** Validity of the current drag against an album destination. */
function dropVerdict(targetId) {
  if (!dragState) return null;
  if (dragState.kind === 'album') {
    if (dragState.albumId === targetId) return { ok: false, message: t('dropInvalidSelf') };
    const check = canMove(state.albums, dragState.albumId, targetId, (albumById(dragState.albumId) || {}).name);
    if (!check.ok) return { ok: false, message: albumErrorMessage(check.error) };
    return { ok: true, message: t('dropReparent', { name: (albumById(dragState.albumId) || {}).name, target: albumShortPath(targetId) }) };
  }
  const ids = dragState.ids || [];
  const unchanged = ids.every((id) => ((findItem(id) || {}).albumId || null) === (targetId || null));
  if (unchanged) return { ok: false, message: t('dropAlreadyHere') };
  return { ok: true, message: t('dropMoveHere', { target: albumShortPath(targetId) }) };
}

/**
 * Makes an element an album destination for both internal drags (objects,
 * albums) and OS file drops (which stage locally, exactly like the workspace
 * dropzone). Targeting is forgiving: the whole row/card is the target.
 */
function attachAlbumDropTarget(el, albumId) {
  const target = albumId && albumId !== ROOT_ID ? albumId : null;

  el.addEventListener('dragover', (event) => {
    if (hasFiles(event)) {
      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      el.classList.add('drop-target');
      showDragHint(t('dropFilesIntoAlbum', { target: albumShortPath(target) }));
      return;
    }
    const verdict = dropVerdict(target);
    if (!verdict) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = verdict.ok ? 'move' : 'none';
    el.classList.toggle('drop-target', verdict.ok);
    el.classList.toggle('drop-invalid', !verdict.ok);
    showDragHint(verdict.message, !verdict.ok);
  });

  el.addEventListener('dragleave', (event) => {
    if (el.contains(event.relatedTarget)) return;
    el.classList.remove('drop-target', 'drop-invalid');
  });

  el.addEventListener('drop', async (event) => {
    const files = event.dataTransfer && event.dataTransfer.files;
    el.classList.remove('drop-target', 'drop-invalid');
    if (files && files.length) {
      event.preventDefault();
      event.stopPropagation();
      hideDragHint();
      await addFiles(files, target);
      return;
    }
    const verdict = dropVerdict(target);
    if (!verdict) return;
    event.preventDefault();
    event.stopPropagation();
    const drag = dragState;
    endDrag();
    if (!verdict.ok) {
      showToast(verdict.message);
      return;
    }
    if (drag.kind === 'album') {
      const result = await moveAlbumTo(drag.albumId, target);
      if (!result.ok) showToast(albumErrorMessage(result.error));
    } else {
      await moveObjectsToAlbum(drag.ids, target);
    }
  });
}

function render() {
  applyStaticI18n(document);
  applyTheme();
  renderChrome();
  renderPushPanel();
  renderAlbumTree();
  renderChanges();
  renderBrowser();
  renderLinks();
  if (state.previewId && !$('preview-dialog').hidden) fillPreview(findItem(state.previewId));
}

function renderChrome() {
  const c = counts();
  renderCrumbs();

  const newAlbumBtn = $('new-album-btn');
  if (newAlbumBtn) newAlbumBtn.hidden = state.view !== 'albums';

  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.setAttribute('aria-current', btn.getAttribute('data-view') === state.view ? 'page' : 'false');
  });

  $('view-grid').setAttribute('aria-pressed', state.layout === 'grid' ? 'true' : 'false');
  $('view-list').setAttribute('aria-pressed', state.layout === 'list' ? 'true' : 'false');
  if ($('view-masonry')) $('view-masonry').setAttribute('aria-pressed', state.layout === 'masonry' ? 'true' : 'false');
  $('sort-select').value = state.sort;
  const moreRow = $('load-more-row');
  const pageableView = ['files', 'images', 'albums', 'recent', 'whitelist', 'blacklist'].indexOf(state.view) !== -1;
  if (moreRow) moreRow.hidden = !pageableView || state.remoteComplete || state.remoteError || state.remoteLoading || !state.remoteCursor;
  const more = $('load-more');
  if (more) { more.disabled = state.remoteLoading; more.textContent = t(state.remoteLoading ? 'loadingMore' : 'loadMore'); }

  updateFooterMeter();

  const push = $('push-changes');
  const pushLabel = $('push-label');
  const canPush = state.online && !state.pushing && state.items.some((i) => (i.status === 'pending' || i.status === 'failed') && i.file);
  push.disabled = !canPush;
  push.setAttribute('aria-label', state.online ? t('pushChangesAria') : t('pushOfflineAria'));
  pushLabel.textContent = state.pushing ? t('pushing') : t('pushChanges');

  const stagingCount = $('staging-count');
  const stagingCopy = $('staging-copy');
  const stagingSize = $('staging-size');
  const changeCount = c.pending + c.failed;
  if (stagingCount) stagingCount.textContent = String(changeCount);
  if (stagingCopy) stagingCopy.textContent = changeCount ? plural('pendingBanner', changeCount) : t('stagingEmpty');
  if (stagingSize) stagingSize.textContent = changeCount ? t('pendingSizeLabel', { size: formatSize(c.pendingSize) }) : '';

  const badge = $('nav-changes-badge');
  if (badge) {
    badge.hidden = changeCount === 0;
    badge.textContent = String(changeCount);
  }

  const offline = $('offline-banner');
  if (offline) {
    offline.hidden = state.online;
    offline.textContent = t('offlineBanner');
  }

  const retry = $('retry-failed');
  if (retry) retry.hidden = c.failed === 0;
  const clearPending = $('clear-pending');
  if (clearPending) clearPending.disabled = c.pending === 0 || state.pushing;

  $('visible-count').textContent = t('fileCount', { n: visibleItems().length });
  const localStats = $('status-local');
  if (localStats) localStats.textContent = t('localStats', { n: c.total, size: formatSize(c.totalSize) });
  $('status-files').textContent = plural('statusBarFiles', c.total);
  $('status-pending').textContent = c.pending ? t('statusBarPending', { n: c.pending }) : '';
  $('status-failed').textContent = c.failed ? t('statusBarFailed', { n: c.failed }) : '';
  $('status-synced').textContent = c.synced ? t('statusBarSynced', { n: c.synced }) : '';
  $('status-selection').textContent = state.selected.size ? t('selectedCount', { n: state.selected.size }) : '';

  const clear = $('search-clear');
  if (clear) clear.hidden = !state.query;
  renderBulkBar();
}

/** Footer hairline progress: overall bytes when known, file counts otherwise. */
function updateFooterMeter() {
  const meter = $('push-meter');
  const bar = meter && meter.firstElementChild;
  if (!meter || !bar) return;
  const snapshot = state.queue;
  if (!snapshot || !snapshot.active || !snapshot.stats.total) {
    meter.hidden = true;
    bar.style.width = '0';
    return;
  }
  const s = snapshot.stats;
  const ratio = s.bytesTotal > 0 ? s.bytesDone / s.bytesTotal : s.processed / s.total;
  meter.hidden = false;
  bar.style.width = Math.round(Math.max(0, Math.min(1, ratio)) * 100) + '%';
}

function renderBulkBar() {
  const bar = $('bulk-bar');
  if (!bar) return;
  const count = state.selected.size;
  bar.hidden = count === 0;
  $('bulk-count').textContent = count ? t('selectedCount', { n: count }) : '';
  const selected = selectedItems();
  const remote = selected.filter((item) => item.remote && item.remoteId);
  const canPush = state.online && selected.some((item) => (item.status === 'pending' || item.status === 'failed') && item.file);
  const canCopy = selected.some((item) => item.url);
  $('bulk-push').disabled = !canPush;
  $('bulk-copy').disabled = !canCopy;
  const move = $('bulk-move');
  if (move) move.disabled = count === 0;
  if ($('bulk-whitelist')) $('bulk-whitelist').disabled = remote.length === 0;
  if ($('bulk-blacklist')) $('bulk-blacklist').disabled = remote.length === 0;
  if ($('bulk-delete')) $('bulk-delete').disabled = remote.length === 0;
  if ($('bulk-remove')) $('bulk-remove').disabled = selected.every((item) => item.remoteOnly);
}

function selectedItems() {
  return state.items.filter((item) => state.selected.has(item.id));
}

function changeSetItems() {
  return state.items.filter(isPendingLike).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

function renderChanges() {
  const panel = $('changes-panel');
  const list = $('changes-list');
  if (!panel || !list) return;
  const items = changeSetItems();
  const c = counts();
  if (!items.length) {
    panel.hidden = true;
    list.replaceChildren();
    return;
  }
  panel.hidden = false;
  const summary = $('changes-summary');
  if (summary) {
    summary.textContent = c.failed && !c.pending
      ? t('changesSummaryFailed', { n: c.failed, size: formatSize(c.pendingSize) })
      : t('changesSummary', { n: items.length, size: formatSize(c.pendingSize) });
  }
  list.replaceChildren();
  items.forEach((item) => list.appendChild(buildChangeRow(item)));
}

function buildChangeRow(item) {
  const row = document.createElement('li');
  row.className = 'change-row';
  row.dataset.id = item.id;
  const thumb = document.createElement('div');
  thumb.className = 'list-thumb';
  thumb.appendChild(thumbContent(item, false));
  const body = document.createElement('div');
  body.className = 'change-name';
  body.textContent = item.name;
  const meta = document.createElement('div');
  meta.className = 'change-meta';
  meta.textContent = formatSize(item.size) + ' · ' + itemStateLabel(item);
  const actions = document.createElement('div');
  actions.className = 'change-actions';
  const review = document.createElement('button');
  review.type = 'button';
  review.className = 'btn text';
  review.textContent = t('changesReview');
  review.addEventListener('click', () => openPreview(item.id));
  actions.appendChild(review);
  if (item.status === 'failed') {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'btn text';
    retry.textContent = t('retry');
    retry.addEventListener('click', () => pushItems([item.id]));
    actions.appendChild(retry);
  }
  if (item.status !== 'pushing') {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn text';
    remove.textContent = t('remove');
    remove.addEventListener('click', () => askRemove(item));
    actions.appendChild(remove);
  }
  row.appendChild(thumb);
  row.appendChild(body);
  row.appendChild(meta);
  row.appendChild(actions);
  return row;
}

function renderOverview(stage) {
  const localChanges = state.items.filter(isPendingLike).length;
  const moderated = state.items.filter((item) => item.remote
    && ['White', 'Block'].indexOf(item.remoteMetadata?.ListType) !== -1).length;
  const section = document.createElement('section');
  section.className = 'management-view';
  const head = document.createElement('div');
  head.className = 'management-head';
  const title = document.createElement('h2');
  title.textContent = t('overviewTitle');
  const copy = document.createElement('p');
  copy.textContent = t('overviewBody');
  head.append(title, copy);
  const stats = document.createElement('div');
  stats.className = 'overview-grid';
  [
    [t('overviewLocal'), localChanges],
    [t('overviewRemote'), state.remoteLoaded],
    [t('overviewAlbums'), state.albums.length],
    [t('overviewModerated'), moderated],
  ].forEach(([label, value]) => {
    const card = document.createElement('article');
    const number = document.createElement('strong');
    number.textContent = String(value);
    const caption = document.createElement('span');
    caption.textContent = label;
    card.append(number, caption);
    stats.appendChild(card);
  });
  const note = document.createElement('p');
  note.className = 'management-note';
  note.textContent = state.remoteError ? t('remoteLoadFailed')
    : state.remoteComplete ? t('listComplete') : t('remoteIndexPartial');
  section.append(head, stats, note);
  stage.replaceChildren(section);
}

function renderTools(stage) {
  const section = document.createElement('section');
  section.className = 'management-view';
  const head = document.createElement('div');
  head.className = 'management-head';
  const title = document.createElement('h2');
  title.textContent = t('toolsTitle');
  const copy = document.createElement('p');
  copy.textContent = t('toolsBody');
  head.append(title, copy);
  const grid = document.createElement('div');
  grid.className = 'tools-grid';
  const tool = (name, body, action, run) => {
    const card = document.createElement('article');
    const h = document.createElement('h3'); h.textContent = name;
    const p = document.createElement('p'); p.textContent = body;
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'btn outlined'; button.textContent = action;
    button.addEventListener('click', run);
    card.append(h, p, button); grid.appendChild(card);
  };
  tool(t('brokenCheck'), t('toolsBrokenBody'), t('brokenCheck'), checkBrokenRemote);
  tool(t('refreshRemote'), t('toolsRefreshBody'), t('toolsRefresh'), refreshWorkspace);
  section.append(head, grid);
  stage.replaceChildren(section);
}

/**
 * The views that surface remote-store records directly. When they have nothing
 * to show yet, a brief loading skeleton (or an error state with a retry) beats
 * flashing a premature "this is empty".
 */
const REMOTE_BACKED_VIEWS = ['files', 'images', 'whitelist', 'blacklist'];

function renderRemoteLoading(stage) {
  stage.replaceChildren();
  stage.setAttribute('aria-busy', 'true');
  const note = document.createElement('p');
  note.className = 'stage-status';
  note.setAttribute('role', 'status');
  note.textContent = t('remoteLoading');
  const grid = document.createElement('div');
  grid.className = 'file-grid is-loading';
  for (let i = 0; i < 8; i += 1) {
    const card = document.createElement('div');
    card.className = 'skeleton-card';
    card.setAttribute('aria-hidden', 'true');
    grid.appendChild(card);
  }
  stage.append(note, grid);
}

function renderRemoteError(stage) {
  stage.replaceChildren();
  stage.removeAttribute('aria-busy');
  const wrap = document.createElement('div');
  wrap.className = 'empty empty-error';
  wrap.innerHTML = '<div class="empty-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2h5.5A2.5 2.5 0 0 1 20 9.5v8A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5v-10z"/><path d="M12 9v3M12 15h.01"/></svg></div>';
  const h = document.createElement('h2');
  h.textContent = t('loadFailedTitle');
  const p = document.createElement('p');
  p.textContent = t('remoteLoadFailed');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn tonal';
  btn.textContent = t('retry');
  btn.style.marginTop = '16px';
  btn.addEventListener('click', () => refreshWorkspace());
  wrap.append(h, p, btn);
  stage.appendChild(wrap);
}

function renderBrowser() {
  const stage = $('file-stage');
  const items = visibleItems();

  if (state.view === 'overview') { renderOverview(stage); return; }
  if (state.view === 'tools') { renderTools(stage); return; }
  if (state.view === 'albums') {
    renderAlbumBrowser(stage, items);
    return;
  }

  stage.removeAttribute('aria-busy');

  if (!items.length) {
    // While the remote index is still settling, keep a search active on its
    // own empty copy (so "Clear search" stays the obvious recovery).
    const remoteGated = REMOTE_BACKED_VIEWS.indexOf(state.view) !== -1;
    if (remoteGated && !state.query) {
      if (!state.remoteReady && !state.remoteError) {
        renderRemoteLoading(stage);
        return;
      }
      if (state.remoteError && state.remoteLoaded === 0) {
        renderRemoteError(stage);
        return;
      }
    }

    const empty = emptyCopy();
    stage.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'empty';
    wrap.innerHTML = '<div class="empty-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2h5.5A2.5 2.5 0 0 1 20 9.5v8A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5v-10z"/></svg></div>';
    const h = document.createElement('h2');
    h.textContent = empty.title;
    const p = document.createElement('p');
    p.textContent = empty.body;
    const btn = document.createElement('button');
    btn.type = 'button';
    const searching = !!state.query && empty.title === t('emptySearchTitle');
    btn.textContent = t(searching ? 'clearSearch' : 'addFiles');
    btn.className = 'btn ' + (searching ? 'outlined' : 'tonal');
    btn.style.marginTop = '16px';
    btn.addEventListener('click', () => {
      if (searching) clearSearch({ focus: true });
      else $('file-input').click();
    });
    wrap.appendChild(h);
    wrap.appendChild(p);
    wrap.appendChild(btn);
    stage.appendChild(wrap);
    return;
  }

  if (state.layout === 'list') {
    renderList(stage, items);
  } else {
    renderGrid(stage, items);
  }
}

function emptyCopy() {
  if (state.query) return { title: t('emptySearchTitle'), body: t('emptySearchBody') };
  if (state.view === 'images') return { title: t('emptyImagesTitle'), body: t('emptyImagesBody') };
  if (state.view === 'recent') return { title: t('emptyRecentTitle'), body: t('emptyRecentBody') };
  if (state.view === 'changes') return { title: t('emptyChangesTitle'), body: t('emptyChangesBody') };
  if (state.view === 'albums') {
    return currentAlbumId()
      ? { title: t('emptyAlbumTitle'), body: t('emptyAlbumBody') }
      : { title: t('emptyAlbumsTitle'), body: t('emptyAlbumsBody') };
  }
  return { title: t('emptyFilesTitle'), body: t('emptyFilesBody') };
}

/**
 * Album view: child albums first, then the objects filed directly in the album
 * being viewed. Both sections are drop destinations.
 */
function renderAlbumBrowser(stage, items) {
  stage.replaceChildren();
  const albums = albumChildren(currentAlbumId());

  if (albums.length) {
    const section = document.createElement('section');
    section.className = 'album-section';
    const head = document.createElement('div');
    head.className = 'album-section-head';
    const title = document.createElement('h2');
    title.textContent = t('albumsInHere');
    head.appendChild(title);
    const hint = document.createElement('span');
    hint.className = 'album-section-hint';
    hint.textContent = t('albumDragHint');
    head.appendChild(hint);
    section.appendChild(head);

    const grid = document.createElement('div');
    grid.className = 'album-grid';
    albums.forEach((album) => grid.appendChild(buildAlbumCard(album)));
    section.appendChild(grid);
    stage.appendChild(section);
  }

  const section = document.createElement('section');
  section.className = 'album-section';
  if (albums.length) {
    const head = document.createElement('div');
    head.className = 'album-section-head';
    const title = document.createElement('h2');
    title.textContent = t('objectsInAlbum');
    head.appendChild(title);
    section.appendChild(head);
  }

  if (!items.length) {
    const empty = emptyCopy();
    const wrap = document.createElement('div');
    wrap.className = 'empty';
    wrap.innerHTML = '<div class="empty-mark" aria-hidden="true"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h3.1l1.8 1.8h7.7A2.2 2.2 0 0 1 20.5 10v7.3a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/></svg></div>';
    const h = document.createElement('h2');
    h.textContent = empty.title;
    const p = document.createElement('p');
    p.textContent = empty.body;
    const actions = document.createElement('div');
    actions.className = 'empty-actions';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'btn tonal';
    addBtn.textContent = t('addFiles');
    addBtn.addEventListener('click', () => $('file-input').click());
    const albumBtn = document.createElement('button');
    albumBtn.type = 'button';
    albumBtn.className = 'btn outlined';
    albumBtn.textContent = t('newAlbum');
    albumBtn.addEventListener('click', () => openAlbumDialog({ mode: 'create', parentId: currentAlbumId() }));
    actions.appendChild(addBtn);
    actions.appendChild(albumBtn);
    wrap.appendChild(h);
    wrap.appendChild(p);
    wrap.appendChild(actions);
    section.appendChild(wrap);
  } else if (state.layout === 'list') {
    renderList(section, items);
  } else {
    renderGrid(section, items);
  }
  stage.appendChild(section);
  attachAlbumDropTarget(stage, currentAlbumId());
}

function renderGrid(stage, items) {
  const grid = document.createElement('div');
  grid.className = 'file-grid' + (state.layout === 'masonry' ? ' masonry' : '');
  items.forEach((item) => grid.appendChild(buildCard(item)));
  if (stage.classList.contains('album-section')) stage.appendChild(grid);
  else stage.replaceChildren(grid);
}

function buildCard(item) {
  const card = document.createElement('article');
  card.className = 'file-card' + (state.selected.has(item.id) ? ' selected' : '') + (item.status === 'failed' ? ' failed' : '') + (item.status === 'pushing' ? ' pushing' : '');
  card.dataset.id = item.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', item.name);
  card.draggable = true;
  card.addEventListener('dragstart', (event) => startObjectDrag(event, item));
  card.addEventListener('dragend', endDrag);

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  thumb.appendChild(thumbContent(item, true));

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.className = 'card-check';
  check.checked = state.selected.has(item.id);
  check.setAttribute('aria-label', t('selectFile', { name: item.name }));
  check.addEventListener('click', (event) => event.stopPropagation());
  check.addEventListener('change', () => toggleSelect(item.id, check.checked));

  const chip = document.createElement('span');
  chip.className = 'status-chip ' + item.status;
  chip.dataset.role = 'status';
  chip.textContent = itemStateLabel(item);

  const progress = document.createElement('div');
  progress.className = 'progress';
  progress.hidden = item.status !== 'pushing';
  const bar = document.createElement('i');
  bar.style.width = (item.progress || 0) + '%';
  progress.appendChild(bar);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  if (item.url) {
    actions.appendChild(iconAction('copy', t('copyOneAria', { name: item.name }), () => copyText(formatLink(item, state.format))));
  }
  actions.appendChild(iconAction('more', t('cardMenuAria', { name: item.name }), (event) => {
    event.stopPropagation();
    openItemMenu(item, event.currentTarget);
  }));

  thumb.appendChild(check);
  thumb.appendChild(chip);
  thumb.appendChild(progress);
  thumb.appendChild(actions);

  const body = document.createElement('div');
  body.className = 'card-body';
  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = item.name;
  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const detail = isImage(item) && item.width && item.height
    ? item.width + ' × ' + item.height
    : itemTypeLabel(item);
  meta.textContent = formatSize(item.size) + ' · ' + detail;
  meta.title = itemTypeDetail(item);
  body.appendChild(name);
  body.appendChild(meta);
  if (item.albumId) body.appendChild(albumBadge(item));

  card.appendChild(thumb);
  card.appendChild(body);
  bindItemOpen(card, item);
  card.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openItemMenu(item, null, event.clientX, event.clientY);
  });
  return card;
}

/** Small, truthful chip showing where an object is filed locally. */
function albumBadge(item) {
  const chip = document.createElement('span');
  chip.className = 'album-badge';
  const path = albumShortPath(item.albumId);
  chip.textContent = path;
  chip.title = t('albumPathLabel', { path: albumCrumbLabel(item.albumId) });
  if (item.status === 'synced' && item.albumSynced === false) {
    chip.classList.add('unsynced');
    chip.title += ' · ' + t('albumUnsyncedObject');
  }
  chip.addEventListener('click', (event) => {
    event.stopPropagation();
    openAlbum(item.albumId);
  });
  return chip;
}

function iconAction(kind, label, handler) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn';
  btn.setAttribute('aria-label', label);
  btn.innerHTML = kind === 'copy'
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M6 15.5H5.4A1.9 1.9 0 0 1 3.5 13.6V5.4A1.9 1.9 0 0 1 5.4 3.5h8.2A1.9 1.9 0 0 1 15.5 5.4V6"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="18" cy="12" r="1.5"/></svg>';
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    handler(event);
  });
  return btn;
}

function thumbContent(item, large) {
  if (isImage(item)) {
    const src = item.status === 'synced' ? item.url : localPreview(item);
    if (src) {
      const img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = src;
      return img;
    }
  }
  const glyphWrap = document.createElement('div');
  glyphWrap.className = 'file-glyph';
  const ext = document.createElement('span');
  ext.className = 'ext';
  ext.textContent = extOf(item.name) || glyph(item);
  if (!large) {
    ext.style.fontSize = '10px';
    ext.style.padding = '1px 5px';
  }
  glyphWrap.appendChild(ext);
  return glyphWrap;
}

function renderList(stage, items) {
  const list = document.createElement('div');
  list.className = 'file-list';
  const head = document.createElement('div');
  head.className = 'list-head';
  head.innerHTML = '<span></span><span></span><span>' + escapeHtml(t('colName')) + '</span><span class="hide-sm">' + escapeHtml(t('colSize')) + '</span><span class="hide-sm">' + escapeHtml(t('colType')) + '</span><span class="hide-sm">' + escapeHtml(t('colAdded')) + '</span><span>' + escapeHtml(t('colStatus')) + '</span><span></span>';
  list.appendChild(head);
  items.forEach((item) => list.appendChild(buildRow(item)));
  if (stage.classList.contains('album-section')) stage.appendChild(list);
  else stage.replaceChildren(list);
}

function buildRow(item) {
  const row = document.createElement('div');
  row.className = 'list-row' + (state.selected.has(item.id) ? ' selected' : '');
  row.dataset.id = item.id;
  row.tabIndex = 0;
  row.setAttribute('role', 'row');
  row.draggable = true;
  row.addEventListener('dragstart', (event) => startObjectDrag(event, item));
  row.addEventListener('dragend', endDrag);

  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = state.selected.has(item.id);
  check.setAttribute('aria-label', t('selectFile', { name: item.name }));
  check.addEventListener('click', (event) => event.stopPropagation());
  check.addEventListener('change', () => toggleSelect(item.id, check.checked));

  const thumb = document.createElement('div');
  thumb.className = 'list-thumb';
  thumb.appendChild(thumbContent(item, false));

  const name = document.createElement('div');
  name.className = 'list-name';
  name.textContent = item.name;
  if (item.albumId) name.appendChild(albumBadge(item));

  const size = document.createElement('div');
  size.className = 'list-cell hide-sm';
  size.textContent = formatSize(item.size);

  const type = document.createElement('div');
  type.className = 'list-cell hide-sm';
  type.textContent = itemTypeLabel(item);
  type.title = itemTypeDetail(item);

  const added = document.createElement('div');
  added.className = 'list-cell hide-sm';
  added.textContent = formatWhen(item.addedAt);

  const status = document.createElement('span');
  status.className = 'status-chip ' + item.status;
  status.dataset.role = 'status';
  status.textContent = itemStateLabel(item);

  const more = iconAction('more', t('cardMenuAria', { name: item.name }), (event) => {
    event.stopPropagation();
    openItemMenu(item, event.currentTarget);
  });

  row.appendChild(check);
  row.appendChild(thumb);
  row.appendChild(name);
  row.appendChild(size);
  row.appendChild(type);
  row.appendChild(added);
  row.appendChild(status);
  row.appendChild(more);
  bindItemOpen(row, item);
  row.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    openItemMenu(item, null, event.clientX, event.clientY);
  });
  return row;
}

function bindItemOpen(el, item) {
  el.addEventListener('click', (event) => {
    if (event.target.closest('input, button, a')) return;
    if (event.metaKey || event.ctrlKey) {
      toggleSelect(item.id, !state.selected.has(item.id));
      state.lastSelectedId = item.id;
      return;
    }
    if (event.shiftKey) {
      rangeSelect(item.id);
      return;
    }
    openPreview(item.id);
  });
  el.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      openPreview(item.id);
    } else if (event.key === ' ') {
      event.preventDefault();
      toggleSelect(item.id, !state.selected.has(item.id));
      state.lastSelectedId = item.id;
    }
  });
}

/** The visible file cards/list rows in the browser stage, in list order. */
function browserNodeList() {
  const wanted = new Set(visibleItems().map((i) => i.id));
  const out = [];
  document.querySelectorAll('#file-stage .file-card, #file-stage .list-row').forEach((el) => {
    if (el.dataset.id && wanted.has(el.dataset.id)) out.push(el);
  });
  return out;
}

function focusBrowserNode(node) {
  if (!node) return;
  node.focus();
  if (node.dataset.id) state.lastSelectedId = node.dataset.id;
}

/**
 * Keyboard movement & safe removal for the file browser. Moves with the arrow
 * keys / Home / End (focus only — it never changes the selection), and maps
 * Delete/Backspace to the guarded "remove from workspace" confirmation. Only
 * active when a card/row itself is the focused element and no dialog is open.
 */
function handleBrowserKey(event) {
  const target = event.target;
  if (!target || !target.classList) return false;
  if (isTyping(target)) return false;
  if (target !== document.activeElement) return false;
  if (!(target.classList.contains('file-card') || target.classList.contains('list-row'))) return false;
  if (activeMenu) return false;
  if (!$('preview-dialog').hidden || !$('confirm-dialog').hidden || !$('command-dialog').hidden
    || !$('album-dialog').hidden || !$('move-dialog').hidden || !$('rename-dialog').hidden) return false;

  const key = event.key;
  const moving = key === 'ArrowUp' || key === 'ArrowDown' || key === 'ArrowLeft'
    || key === 'ArrowRight' || key === 'Home' || key === 'End';
  if (moving) {
    const nodes = browserNodeList();
    if (!nodes.length) return true;
    const idx = Math.max(0, nodes.findIndex((n) => n.dataset.id === target.dataset.id));
    let next;
    if (key === 'Home') next = nodes[0];
    else if (key === 'End') next = nodes[nodes.length - 1];
    else {
      const delta = (key === 'ArrowDown' || key === 'ArrowRight') ? 1 : -1;
      next = nodes[(idx + delta + nodes.length) % nodes.length];
    }
    event.preventDefault();
    focusBrowserNode(next);
    return true;
  }

  if (key === 'Delete' || key === 'Backspace') {
    const item = findItem(target.dataset.id);
    if (!item) return true;
    event.preventDefault();
    if (state.selected.size > 1 && state.selected.has(item.id)) {
      askRemoveMany(Array.from(state.selected));
    } else {
      askRemove(item);
    }
    return true;
  }
  return false;
}

function toggleSelect(id, on) {
  if (on) state.selected.add(id);
  else state.selected.delete(id);
  state.lastSelectedId = id;
  applySelectionClasses();
}

function rangeSelect(id) {
  const items = visibleItems();
  const target = items.findIndex((item) => item.id === id);
  const origin = items.findIndex((item) => item.id === state.lastSelectedId);
  if (target === -1) return;
  const start = origin === -1 ? target : Math.min(origin, target);
  const end = origin === -1 ? target : Math.max(origin, target);
  for (let i = start; i <= end; i++) state.selected.add(items[i].id);
  applySelectionClasses();
}

function applySelectionClasses() {
  document.querySelectorAll('[data-id]').forEach((el) => {
    const on = state.selected.has(el.dataset.id);
    el.classList.toggle('selected', on);
    const box = el.querySelector('input[type="checkbox"]');
    if (box) box.checked = on;
  });
  renderChrome();
  renderLinks();
}

function clearSelection() {
  if (!state.selected.size) return;
  state.selected.clear();
  applySelectionClasses();
}

function selectAllVisible() {
  visibleItems().forEach((item) => state.selected.add(item.id));
  announce(t('announceSelected', { n: state.selected.size }));
  applySelectionClasses();
}

function renderLinks() {
  const synced = state.items.filter((item) => item.url);
  const panel = $('results-card');
  const output = $('link-output');
  if (!synced.length) {
    panel.hidden = true;
    output.value = '';
    return;
  }
  panel.hidden = false;
  const selectedSynced = synced.filter((item) => state.selected.has(item.id));
  const source = selectedSynced.length ? selectedSynced : synced;
  output.value = source.map((item) => formatLink(item, state.format)).join('\n');
}

function previewSet() {
  const items = visibleItems();
  // Stepping through a folder should walk the things that actually render.
  const media = items.filter((item) => previewKind({ mime: item.type, name: item.name }) !== 'file');
  return media.length ? media : items;
}

function openPreview(id) {
  const item = findItem(id);
  if (!item) return;
  lastFocus = document.activeElement;
  state.previewId = id;
  fillPreview(item);
  openOverlayDialog($('preview-dialog'));
}

/**
 * Preview surface for an object, chosen from its real MIME category. A binary
 * file is never rendered as an image just because of its filename.
 */
function buildPreviewSurface(item) {
  const kind = previewKind({ mime: item.type, name: item.name });
  const src = item.url || localPreview(item);

  if (kind === 'image' && src) {
    const img = document.createElement('img');
    img.alt = item.name;
    img.src = src;
    img.addEventListener('click', () => {
      state.previewZoom = !state.previewZoom;
      $('preview-stage').classList.toggle('zoomed', state.previewZoom);
    });
    return img;
  }

  if (kind === 'audio' && src) {
    const wrap = document.createElement('div');
    wrap.className = 'preview-media audio';
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'metadata';
    audio.src = src;
    audio.setAttribute('aria-label', t('previewAudioAria', { name: item.name }));
    const caption = document.createElement('p');
    caption.className = 'preview-caption';
    caption.textContent = t('previewAudio');
    wrap.appendChild(audio);
    wrap.appendChild(caption);
    return wrap;
  }

  if (kind === 'video' && src) {
    const video = document.createElement('video');
    video.controls = true;
    video.preload = 'metadata';
    video.src = src;
    video.className = 'preview-media video';
    video.setAttribute('aria-label', t('previewVideoAria', { name: item.name }));
    return video;
  }

  if (kind === 'pdf' && src) {
    const wrap = document.createElement('div');
    wrap.className = 'preview-media document';
    const frame = document.createElement('iframe');
    frame.src = src;
    frame.title = t('previewPdfAria', { name: item.name });
    frame.loading = 'lazy';
    wrap.appendChild(frame);
    const link = document.createElement('a');
    link.href = src;
    link.target = '_blank';
    link.rel = 'noopener';
    link.className = 'preview-caption';
    link.textContent = t('previewOpenExternally');
    wrap.appendChild(link);
    return wrap;
  }

  // Generic, honest surface: what it is, how big, and how to get it.
  const wrap = document.createElement('div');
  wrap.className = 'preview-generic';
  const glyphWrap = document.createElement('div');
  glyphWrap.className = 'file-glyph';
  glyphWrap.style.height = '160px';
  const ext = document.createElement('span');
  ext.className = 'ext';
  ext.textContent = extOf(item.name);
  glyphWrap.appendChild(ext);
  const label = document.createElement('p');
  label.className = 'preview-caption';
  label.textContent = t(categoryLabelKey(itemCategory(item))) + ' · ' + t('previewNoInline');
  wrap.appendChild(glyphWrap);
  wrap.appendChild(label);
  return wrap;
}

function fillPreview(item) {
  if (!item) return;
  $('preview-title').textContent = item.name;
  $('meta-name').textContent = item.name;
  $('meta-dims').textContent = item.width && item.height ? item.width + ' × ' + item.height : t('noDimensions');
  $('meta-mime').textContent = item.type || t('unknownType');
  $('meta-size').textContent = formatSize(item.size);
  const addedEl = $('meta-added');
  if (addedEl) addedEl.textContent = item.addedAt ? formatWhen(item.addedAt) : t('notAvailable');
  const pushedEl = $('meta-pushed');
  if (pushedEl) pushedEl.textContent = item.pushedAt ? formatWhen(item.pushedAt) : t('notAvailable');
  $('meta-status').textContent = itemStateLabel(item) + (item.error ? ' — ' + item.error : '');
  $('meta-url').value = item.url || t('noPublicUrl');

  const stage = $('preview-stage');
  stage.classList.toggle('zoomed', !!state.previewZoom);
  stage.replaceChildren();
  stage.appendChild(isTextPreviewable(item) ? previewTextSurface(item) : buildPreviewSurface(item));

  const copyBtn = $('preview-copy');
  copyBtn.disabled = !item.url;
  copyBtn.textContent = t('copyOne');
  copyBtn.onclick = () => {
    if (!item.url) return;
    copyText(formatLink(item, state.format));
    copyBtn.textContent = t('copiedShort');
    setTimeout(() => { copyBtn.textContent = t('copyOne'); }, 1400);
  };
  $('preview-download').onclick = () => downloadItem(item);
  const retry = $('preview-retry');
  retry.hidden = item.status !== 'failed';
  retry.onclick = () => {
    closeDialogs();
    pushItems([item.id]);
  };

  const set = previewSet();
  const index = set.findIndex((entry) => entry.id === item.id);
  const prev = $('preview-prev');
  const next = $('preview-next');
  if (prev) prev.disabled = index <= 0;
  if (next) next.disabled = index === -1 || index >= set.length - 1;
}

function stepPreview(delta) {
  const set = previewSet();
  const index = set.findIndex((entry) => entry.id === state.previewId);
  const next = set[index + delta];
  if (!next) return;
  state.previewId = next.id;
  state.previewZoom = false;
  fillPreview(next);
}

function downloadItem(item) {
  const href = item.url || localPreview(item);
  if (!href && !item.file) return;
  const a = document.createElement('a');
  if (item.file && !item.url) {
    a.href = localPreview(item) || URL.createObjectURL(item.file);
  } else {
    a.href = href;
  }
  a.download = item.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function openItemMenu(item, anchor, x, y) {
  const menu = $('context-menu');
  menu.innerHTML = '';
  const add = (label, fn, disabled) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitem');
    btn.textContent = label;
    btn.disabled = !!disabled;
    btn.addEventListener('click', () => { closeMenus(); fn(); });
    menu.appendChild(btn);
  };
  add(t('openPreview'), () => openPreview(item.id));
  add(state.selected.has(item.id) ? t('clearSelection') : t('selectFile', { name: item.name }), () => {
    toggleSelect(item.id, !state.selected.has(item.id));
  });
  add(t('moveToAlbum'), () => openMoveDialog({ kind: 'objects', ids: state.selected.has(item.id) ? Array.from(state.selected) : [item.id] }));
  if (item.albumId) add(t('openAlbum'), () => openAlbum(item.albumId));
  add(t('copyOne'), () => copyText(formatLink(item, state.format)), !item.url);
  add(t('download'), () => downloadItem(item), !(item.url || item.file));
  if (item.status === 'pending' || item.status === 'failed') {
    add(t('pushChanges'), () => pushItems([item.id]), !state.online || !item.file);
  }
  if (item.status === 'failed') add(t('retry'), () => pushItems([item.id]), !state.online);
  if (item.remoteId) {
    const remoteSep = document.createElement('div');
    remoteSep.className = 'sep';
    menu.appendChild(remoteSep);
    add(t('rename'), () => openRemoteRename(item));
    add(t('whitelist'), () => moderateRemote(item, 'White'));
    add(t('blacklist'), () => moderateRemote(item, 'Block'));
    add(t('toggleLike'), () => toggleRemoteLike(item));
    add(t('deleteObject'), () => askRemoteDelete([item]));
  }
  const sep = document.createElement('div');
  sep.className = 'sep';
  menu.appendChild(sep);
  add(t('remove'), () => askRemove(item), item.status === 'pushing' || item.remoteOnly);
  placeMenu(menu, anchor, x, y);
}

function openEmptyMenu(x, y) {
  const menu = $('context-menu');
  menu.replaceChildren();
  const add = (label, action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.textContent = label;
    button.addEventListener('click', () => { closeMenus(); action(); });
    menu.appendChild(button);
  };
  add(t('addFiles'), () => $('file-input').click());
  add(t('newAlbum'), () => openAlbumDialog({ mode: 'create', parentId: currentAlbumId() }));
  add(t('selectAllVisible'), selectAllVisible);
  add(t('refresh'), refreshWorkspace);
  placeMenu(menu, null, x, y);
}

function askRemove(item) {
  $('confirm-title').textContent = t('confirmRemoveTitle');
  $('confirm-body').textContent = item.status === 'synced' ? t('confirmRemoveSynced') : t('confirmRemovePending');
  lastFocus = document.activeElement;
  openOverlayDialog($('confirm-dialog'));
  confirmResolver = (ok) => {
    if (ok) removeItem(item.id);
  };
}

function openRemoteRename(item) {
  if (!item?.remoteId) return;
  renameTarget = item;
  const input = $('rename-input');
  input.value = item.name || '';
  lastFocus = document.activeElement;
  openOverlayDialog($('rename-dialog'));
  input.select();
}

function askRemoteDelete(items) {
  const remote = items.filter((item) => item?.remoteId);
  if (!remote.length) return;
  $('confirm-title').textContent = t('confirmDeleteTitle');
  $('confirm-body').textContent = t(remote.length === 1 ? 'confirmDeleteBody' : 'confirmBulkDeleteBody', {
    name: remote[0].name,
    n: remote.length,
  });
  lastFocus = document.activeElement;
  openOverlayDialog($('confirm-dialog'));
  confirmResolver = (ok) => {
    if (ok) deleteRemoteItems(remote);
  };
}

function askRemoveMany(ids) {
  const removable = ids.filter((id) => {
    const item = findItem(id);
    return item && item.status !== 'pushing';
  });
  if (!removable.length) return;
  $('confirm-title').textContent = t('confirmRemoveTitle');
  $('confirm-body').textContent = t('confirmRemoveMany', { n: removable.length });
  lastFocus = document.activeElement;
  openOverlayDialog($('confirm-dialog'));
  confirmResolver = (ok) => {
    if (!ok) return;
    removable.forEach((id) => removeItem(id));
  };
}

function askClearPending() {
  const ids = state.items.filter((item) => item.status === 'pending' || item.status === 'failed').map((item) => item.id);
  if (!ids.length) return;
  $('confirm-title').textContent = t('confirmClearPendingTitle');
  $('confirm-body').textContent = t('confirmClearPending');
  lastFocus = document.activeElement;
  openOverlayDialog($('confirm-dialog'));
  confirmResolver = (ok) => {
    if (!ok) return;
    ids.forEach((id) => removeItem(id));
  };
}

function openOverlayDialog(dialog) {
  closeMenus();
  $('overlay').hidden = false;
  $('overlay').classList.add('open');
  dialog.hidden = false;
  dialog.classList.add('open');
  const focusable = dialog.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusable) focusable.focus();
}

function closeDialogs() {
  ['preview-dialog', 'confirm-dialog', 'command-dialog', 'album-dialog', 'move-dialog', 'rename-dialog'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.classList.remove('open');
    el.hidden = true;
  });
  $('overlay').classList.remove('open');
  $('overlay').hidden = true;
  state.previewId = null;
  state.previewZoom = false;
  albumDialogContext = null;
  moveContext = null;
  renameTarget = null;
  if (confirmResolver) {
    const resolver = confirmResolver;
    confirmResolver = null;
    resolver(false);
  }
  if (lastFocus && lastFocus.focus) lastFocus.focus();
}

function closeMenus() {
  ['context-menu', 'lang-menu', 'overflow-menu'].forEach((id) => {
    const el = $(id);
    el.classList.remove('open');
    el.hidden = true;
  });
  activeMenu = null;
}

function placeMenu(menu, anchor, x, y) {
  closeMenus();
  menu.hidden = false;
  menu.classList.add('open');
  activeMenu = menu;
  const pad = 8;
  let left = x;
  let top = y;
  if (anchor) {
    const rect = anchor.getBoundingClientRect();
    left = rect.left;
    top = rect.bottom + 4;
  }
  requestAnimationFrame(() => {
    const w = menu.offsetWidth;
    const h = menu.offsetHeight;
    if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
    if (top + h > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - h - pad);
    if (left < pad) left = pad;
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    const first = menu.querySelector('button:not([disabled])');
    if (first) first.focus();
  });
}

function openLangMenu(anchor) {
  const menu = $('lang-menu');
  menu.innerHTML = '';
  [
    { id: 'en', label: t('langEn') },
    { id: 'id', label: t('langId') },
  ].forEach((opt) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'menuitemradio');
    btn.setAttribute('aria-checked', getLanguage() === opt.id ? 'true' : 'false');
    btn.textContent = opt.label;
    btn.addEventListener('click', () => {
      setLanguage(opt.id);
      closeMenus();
    });
    menu.appendChild(btn);
  });
  const rect = anchor.getBoundingClientRect();
  placeMenu(menu, null, rect.left, rect.bottom + 4);
}

function menuLink(href, label, extra) {
  const link = document.createElement('a');
  link.href = href;
  link.setAttribute('role', 'menuitem');
  link.style.cssText = 'display:flex;align-items:center;min-height:40px;padding:0 16px;text-decoration:none;color:inherit';
  link.textContent = label;
  if (extra) Object.assign(link, extra);
  return link;
}

function openOverflowMenu(anchor) {
  const menu = $('overflow-menu');
  menu.innerHTML = '';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.setAttribute('role', 'menuitem');
  refresh.textContent = t('refresh');
  refresh.addEventListener('click', () => { closeMenus(); refreshWorkspace(); });
  menu.appendChild(refresh);
  const lang = document.createElement('button');
  lang.type = 'button';
  lang.setAttribute('role', 'menuitem');
  lang.textContent = t('language');
  lang.addEventListener('click', () => openLangMenu(anchor));
  menu.appendChild(lang);
  menu.appendChild(menuLink('/admin', t('dashboard')));
  menu.appendChild(menuLink('https://github.com/flessan/Telegraph-Image', t('github'), { target: '_blank', rel: 'noopener' }));
  const rect = anchor.getBoundingClientRect();
  placeMenu(menu, null, rect.right - 220, rect.bottom + 4);
}

async function runRemoteAction(item, endpoint) {
  if (!item || !item.remoteId) throw new Error('Remote object unavailable');
  const response = await manageApi(`/api/manage/${endpoint}/${encodeURIComponent(item.remoteId)}`);
  if (!response.ok) throw new Error(`remote_action_${response.status}`);
  return response.json();
}

async function moderateRemote(item, type, { quiet = false } = {}) {
  try {
    const endpoint = type === 'White' ? 'white' : 'block';
    const metadata = await runRemoteAction(item, endpoint);
    item.remoteMetadata = { ...(item.remoteMetadata || {}), ...(metadata || {}), ListType: type };
    item.remote = true;
    if (!item.remoteOnly) await idbPut(item);
    if (!quiet) showToast(t(type === 'White' ? 'actionWhitelistSuccess' : 'actionBlacklistSuccess'));
    render();
    return true;
  } catch (error) {
    if (!quiet) showToast(t('actionFailed'));
    return false;
  }
}

async function toggleRemoteLike(item) {
  try {
    const result = await runRemoteAction(item, 'toggleLike');
    item.remoteMetadata = { ...(item.remoteMetadata || {}), liked: !!result.liked };
    if (!item.remoteOnly) await idbPut(item);
    showToast(t(result.liked ? 'actionLikeSuccess' : 'actionUnlikeSuccess'));
    render();
  } catch (error) {
    showToast(t('actionFailed'));
  }
}

async function renameRemote(item, name) {
  const clean = String(name || '').trim();
  if (!clean || !item?.remoteId) return false;
  try {
    const response = await manageApi(`/api/manage/editName/${encodeURIComponent(item.remoteId)}?newName=${encodeURIComponent(clean)}`);
    if (!response.ok) throw new Error(`remote_rename_${response.status}`);
    const result = await response.json();
    item.name = result.fileName || clean;
    item.remoteMetadata = { ...(item.remoteMetadata || {}), fileName: item.name };
    if (!item.remoteOnly) await idbPut(item);
    showToast(t('actionRenameSuccess'));
    render();
    return true;
  } catch (error) {
    showToast(t('actionFailed'));
    return false;
  }
}

async function deleteRemoteItems(items) {
  let failed = 0;
  for (const item of items.filter((entry) => entry.remoteId)) {
    try {
      await runRemoteAction(item, 'delete');
      state.items = state.items.filter((entry) => entry.id !== item.id);
      state.selected.delete(item.id);
      rememberUrl(item.id, null);
      await idbDelete(item.id);
    } catch (error) {
      failed += 1;
    }
  }
  showToast(t(failed ? 'bulkSomeFailed' : 'actionDeleteSuccess', { failed }));
  render();
}

async function bulkModerateRemote(type) {
  const items = selectedItems().filter((item) => item.remoteId);
  if (!items.length) return;
  let failed = 0;
  for (const item of items) {
    if (!await moderateRemote(item, type, { quiet: true })) failed += 1;
  }
  state.selected.clear();
  showToast(t(failed ? 'bulkSomeFailed' : 'bulkComplete', { failed, success: items.length - failed, total: items.length }));
  render();
}

async function checkBrokenRemote() {
  const items = state.items.filter((item) => item.remoteId);
  let broken = 0;
  state.selected.clear();
  showToast(t('brokenChecking', { done: 0, total: items.length }));
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    try {
      const response = await fetch(item.url || publicObjectUrl(item.remoteId), { method: 'HEAD', cache: 'no-cache' });
      if (!response.ok) { state.selected.add(item.id); broken += 1; }
    } catch (error) {
      state.selected.add(item.id);
      broken += 1;
    }
    if ((i + 1) % 10 === 0) showToast(t('brokenChecking', { done: i + 1, total: items.length }));
  }
  showToast(t(broken ? 'brokenFound' : 'brokenNone', { n: broken }));
  render();
}

async function refreshWorkspace() {
  try {
    await Promise.all([loadConfig(), loadRemoteAlbums()]);
    state.remoteCursor = null;
    state.remoteComplete = false;
    state.remoteError = null;
    state.remoteReady = false;
    state.remoteLoaded = 0;
    state.items = state.items.filter((item) => !item.remoteOnly);
    render();
    await loadRemotePage(true);
    showToast(t('refreshed'));
  } catch (_) {
    showToast(t('refreshFailed'));
  }
}

async function loadConfig() {
  const res = await fetch('/api/config', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('config');
  const config = await res.json();
  state.config = config;
  if (config.siteName) $('site-name').textContent = config.siteName;
  if (config.siteTitle) document.title = config.siteTitle;
  // showAdminEntry is a legacy hint for public/custom frontends. This page is
  // already the dashboard, so it must not hide its unrelated Home action.
  renderSetup(config);
}

function renderSetup(config) {
  const box = $('setup-notice');
  box.replaceChildren();
  const problems = (config && config.problems) || [];
  problems.forEach((problem) => {
    const el = document.createElement('div');
    el.className = 'problem ' + (problem.severity || 'info');
    const label = document.createElement('b');
    const titles = { error: t('setupNeedsAttention'), warning: t('setupWarning'), info: t('setupInfo') };
    label.textContent = titles[problem.severity] || titles.info;
    el.appendChild(label);
    el.appendChild(document.createTextNode(problem.message));
    box.appendChild(el);
  });
  if (config && config.uploadRequiresAuth) {
    const el = document.createElement('div');
    el.className = 'problem warning';
    const label = document.createElement('b');
    label.textContent = t('setupWarning');
    el.appendChild(label);
    el.appendChild(document.createTextNode(t('uploadProtected')));
    box.appendChild(el);
  }
}

function wireEvents() {
  const fileInput = $('file-input');
  const openPicker = () => fileInput.click();
  $('add-files').addEventListener('click', openPicker);
  $('fab-add').addEventListener('click', openPicker);
  fileInput.addEventListener('change', () => {
    addFiles(fileInput.files);
    fileInput.value = '';
  });

  $('push-changes').addEventListener('click', () => pushItems());
  if ($('push-pause')) $('push-pause').addEventListener('click', () => {
    const snapshot = state.queue;
    if (snapshot && snapshot.phase === 'paused') resumeQueue();
    else pauseQueue();
  });
  if ($('push-cancel')) $('push-cancel').addEventListener('click', cancelQueue);
  if ($('push-retry-failed')) $('push-retry-failed').addEventListener('click', retryFailedQueue);
  if ($('push-dismiss')) $('push-dismiss').addEventListener('click', dismissQueue);
  if ($('new-album-btn')) $('new-album-btn').addEventListener('click', () => openAlbumDialog({ mode: 'create', parentId: currentAlbumId() }));
  if ($('album-new')) $('album-new').addEventListener('click', () => openAlbumDialog({ mode: 'create', parentId: state.view === 'albums' ? currentAlbumId() : null }));
  if ($('album-sync-btn')) $('album-sync-btn').addEventListener('click', () => syncAlbums());
  if ($('album-cancel')) $('album-cancel').addEventListener('click', closeDialogs);
  if ($('album-save')) $('album-save').addEventListener('click', submitAlbumDialog);
  if ($('album-name-input')) $('album-name-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submitAlbumDialog();
    }
  });
  if ($('move-cancel')) $('move-cancel').addEventListener('click', closeDialogs);
  if ($('move-confirm')) $('move-confirm').addEventListener('click', submitMoveDialog);
  if ($('move-create')) $('move-create').addEventListener('click', () => {
    if (!moveContext) return;
    // Create a sub-album of the highlighted destination, then continue the move
    // with the new album pre-selected.
    const parentId = moveContext.target || null;
    const pending = { kind: moveContext.kind, ids: moveContext.ids, albumId: moveContext.albumId };
    closeDialogs();
    openAlbumDialog({
      mode: 'create',
      parentId,
      onCreated: (album) => {
        openMoveDialog(pending);
        moveContext.target = album.id;
        renderMovePicker();
      },
    });
  });
  if ($('bulk-move')) $('bulk-move').addEventListener('click', () => {
    if (!state.selected.size) return;
    openMoveDialog({ kind: 'objects', ids: Array.from(state.selected) });
  });
  $('retry-failed').addEventListener('click', () => {
    const ids = state.items.filter((i) => i.status === 'failed').map((i) => i.id);
    pushItems(ids);
  });
  if ($('clear-pending')) $('clear-pending').addEventListener('click', askClearPending);
  if ($('staging-card')) $('staging-card').addEventListener('click', () => {
    state.view = 'changes';
    savePrefs();
    render();
  });
  if ($('bulk-push')) $('bulk-push').addEventListener('click', () => pushItems(selectedItems().map((item) => item.id)));
  if ($('bulk-copy')) $('bulk-copy').addEventListener('click', () => {
    const text = selectedItems().filter((item) => item.url).map((item) => formatLink(item, state.format)).join('\n');
    if (text) copyText(text);
  });
  if ($('bulk-download')) $('bulk-download').addEventListener('click', () => selectedItems().forEach(downloadItem));
  if ($('bulk-remove')) $('bulk-remove').addEventListener('click', () => askRemoveMany(Array.from(state.selected)));
  if ($('bulk-whitelist')) $('bulk-whitelist').addEventListener('click', () => bulkModerateRemote('White'));
  if ($('bulk-blacklist')) $('bulk-blacklist').addEventListener('click', () => bulkModerateRemote('Block'));
  if ($('bulk-delete')) $('bulk-delete').addEventListener('click', () => askRemoteDelete(selectedItems()));
  if ($('bulk-clear')) $('bulk-clear').addEventListener('click', clearSelection);
  if ($('preview-prev')) $('preview-prev').addEventListener('click', () => stepPreview(-1));
  if ($('preview-next')) $('preview-next').addEventListener('click', () => stepPreview(1));
  if ($('preview-zoom')) $('preview-zoom').addEventListener('click', () => {
    state.previewZoom = !state.previewZoom;
    $('preview-stage').classList.toggle('zoomed', state.previewZoom);
  });
  if ($('command-input')) {
    $('command-input').addEventListener('input', () => renderCommandList());
    $('command-input').addEventListener('keydown', onCommandKey);
  }
  $('refresh-btn').addEventListener('click', refreshWorkspace);
  if ($('load-more')) $('load-more').addEventListener('click', () => loadRemotePage());
  if ($('logout-btn')) $('logout-btn').addEventListener('click', async () => {
    try {
      await fetch('/api/manage/logout', { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' } });
    } finally {
      window.location.href = '/login';
    }
  });
  $('theme-btn').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    savePrefs();
    applyTheme();
  });
  $('lang-btn').addEventListener('click', (event) => openLangMenu(event.currentTarget));
  $('overflow-btn').addEventListener('click', (event) => openOverflowMenu(event.currentTarget));

  $('view-grid').addEventListener('click', () => { state.layout = 'grid'; savePrefs(); render(); });
  $('view-list').addEventListener('click', () => { state.layout = 'list'; savePrefs(); render(); });
  if ($('view-masonry')) $('view-masonry').addEventListener('click', () => { state.layout = 'masonry'; savePrefs(); render(); });
  $('sort-select').addEventListener('change', (event) => {
    state.sort = event.target.value;
    savePrefs();
    render();
  });

  const setDrawer = (open) => {
    const sidebar = $('workspace-sidebar');
    const scrim = $('drawer-scrim');
    if (!sidebar || !scrim) return;
    sidebar.classList.toggle('drawer-open', open);
    scrim.hidden = !open;
    document.body.classList.toggle('drawer-visible', open);
    $('drawer-toggle')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  };
  if ($('drawer-toggle')) $('drawer-toggle').addEventListener('click', () => {
    setDrawer(!$('workspace-sidebar').classList.contains('drawer-open'));
  });
  if ($('drawer-scrim')) $('drawer-scrim').addEventListener('click', () => setDrawer(false));

  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.view = btn.getAttribute('data-view');
      savePrefs();
      setDrawer(false);
      render();
    });
  });

  if ($('rename-cancel')) $('rename-cancel').addEventListener('click', closeDialogs);
  if ($('rename-save')) $('rename-save').addEventListener('click', async () => {
    const item = renameTarget;
    const input = $('rename-input');
    const clean = input.value.trim();
    $('rename-error').textContent = clean ? '' : t('nameRequired');
    if (!item || !clean) return;
    const button = $('rename-save');
    button.disabled = true;
    const ok = await renameRemote(item, clean);
    button.disabled = false;
    if (ok) closeDialogs();
  });
  if ($('rename-input')) $('rename-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); $('rename-save').click(); }
  });

  const search = $('search');
  search.addEventListener('input', () => {
    state.query = search.value;
    renderChrome();
    renderBrowser();
  });
  $('search-clear').addEventListener('click', () => clearSearch({ focus: true }));
  $('mobile-search-toggle').addEventListener('click', () => {
    $('search-wrap').classList.add('expanded');
    search.focus();
  });

  $('format-tabs').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-format]');
    if (!button) return;
    state.format = button.dataset.format;
    $('format-tabs').querySelectorAll('button').forEach((other) => {
      const on = other === button;
      other.classList.toggle('active', on);
      other.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderLinks();
  });
  $('copy-all').addEventListener('click', () => {
    if ($('link-output').value) copyText($('link-output').value);
  });

  $('preview-close').addEventListener('click', closeDialogs);
  $('overlay').addEventListener('click', closeDialogs);
  $('confirm-cancel').addEventListener('click', closeDialogs);
  $('confirm-ok').addEventListener('click', () => {
    const resolver = confirmResolver;
    confirmResolver = null;
    closeDialogs();
    if (resolver) resolver(true);
  });

  document.addEventListener('keydown', (event) => {
    if (handleBrowserKey(event)) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      openCommandPalette();
      return;
    }
    if (event.key === 'Escape') {
      if (activeMenu) { closeMenus(); return; }
      if (!$('preview-dialog').hidden || !$('confirm-dialog').hidden || !$('command-dialog').hidden
        || !$('album-dialog').hidden || !$('move-dialog').hidden || !$('rename-dialog').hidden) {
        closeDialogs();
        return;
      }
      if ($('workspace-sidebar')?.classList.contains('drawer-open')) {
        setDrawer(false);
        return;
      }
      if (state.selected.size) {
        clearSelection();
        return;
      }
      if ($('search-wrap').classList.contains('expanded')) {
        $('search-wrap').classList.remove('expanded');
      }
    }
    if (!$('preview-dialog').hidden && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      if (isTyping(event.target)) return;
      event.preventDefault();
      stepPreview(event.key === 'ArrowLeft' ? -1 : 1);
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a' && !isTyping(event.target) && $('preview-dialog').hidden && $('command-dialog').hidden) {
      event.preventDefault();
      selectAllVisible();
    }
    if (activeMenu && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const items = Array.prototype.slice.call(activeMenu.querySelectorAll('button, a'));
      if (!items.length) return;
      const index = items.indexOf(document.activeElement);
      const next = event.key === 'ArrowDown'
        ? items[(index + 1 + items.length) % items.length]
        : items[(index - 1 + items.length) % items.length];
      next.focus();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (!state.pushing) pushItems();
    }
    if ((event.metaKey || event.ctrlKey) && (event.key === 'u' || event.key === 'U')) {
      event.preventDefault();
      fileInput.click();
    }
    if (event.key === '/' && !isTyping(event.target)) {
      event.preventDefault();
      search.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (activeMenu && !activeMenu.contains(event.target) && !event.target.closest('#lang-btn, #overflow-btn')) {
      closeMenus();
    }
  });

  $('browser').addEventListener('contextmenu', (event) => {
    if (isTyping(event.target) || event.target.closest('pre, code, output, .file-card, .list-row, .album-card, button, a')) return;
    event.preventDefault();
    openEmptyMenu(event.clientX, event.clientY);
  });

  wireDragAndPaste();
}

function isTyping(el) {
  if (!el) return false;
  const tag = (el.tagName || '').toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

function setDragOver(on) {
  const zone = $('dropzone');
  const app = $('app');
  if (zone) zone.classList.toggle('dragover', on);
  if (app) app.classList.toggle('dragover', on);
}

function wireDragAndPaste() {
  const zone = $('dropzone');
  let dragDepth = 0;
  const prevent = (event) => { event.preventDefault(); event.stopPropagation(); };

  document.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    prevent(event);
    dragDepth += 1;
    setDragOver(true);
  });
  document.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    prevent(event);
    setDragOver(true);
  });
  document.addEventListener('dragleave', (event) => {
    if (!hasFiles(event) && dragDepth === 0) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragOver(false);
  });
  document.addEventListener('drop', (event) => {
    if (!hasFiles(event) && !(event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length)) {
      setDragOver(false);
      return;
    }
    prevent(event);
    dragDepth = 0;
    setDragOver(false);
    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
      addFiles(event.dataTransfer.files);
    }
  });

  zone.addEventListener('dragenter', prevent);
  zone.addEventListener('dragover', prevent);
  zone.addEventListener('drop', (event) => {
    prevent(event);
    dragDepth = 0;
    setDragOver(false);
    if (event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files.length) {
      addFiles(event.dataTransfer.files);
    }
  });

  document.addEventListener('paste', (event) => {
    if (isTyping(event.target) || !$('command-dialog').hidden) return;
    const files = filesFromClipboardEvent(event);
    if (files.length) {
      event.preventDefault();
      addFiles(files);
      showToast(t('pasteSuccess'));
      announce(t('announcePasted'));
    }
  });
}

function filesFromClipboardEvent(event) {
  const files = [];
  if (!event.clipboardData) return files;
  for (let i = 0; i < event.clipboardData.items.length; i++) {
    const item = event.clipboardData.items[i];
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  return files;
}

async function pasteFromClipboard() {
  if (navigator.clipboard && navigator.clipboard.read) {
    try {
      const items = await navigator.clipboard.read();
      const files = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const type = item.types.find((entry) => entry.indexOf('image/') === 0);
        if (!type) continue;
        const blob = await item.getType(type);
        const ext = type.split('/')[1] || 'png';
        files.push(new File([blob], 'clipboard-' + Date.now() + '.' + ext, { type: blob.type || type }));
      }
      if (files.length) {
        await addFiles(files);
        showToast(t('pasteSuccess'));
        announce(t('announcePasted'));
        return;
      }
    } catch (_) { /* permission or empty clipboard */ }
  }
  showToast(t('pasteEmpty'));
}

function commandItems() {
  const pending = state.items.some((item) => (item.status === 'pending' || item.status === 'failed') && item.file);
  const inAlbums = state.view === 'albums';
  const album = albumById(currentAlbumId());
  const unsynced = unsyncedAlbumWork().total;
  return [
    { id: 'new-album', label: t('commandNewAlbum'), run: () => openAlbumDialog({ mode: 'create', parentId: inAlbums ? currentAlbumId() : null }) },
    { id: 'albums', label: t('commandOpenAlbums'), disabled: inAlbums && !currentAlbumId(), run: () => openAlbum(inAlbums ? currentAlbumId() : null) },
    { id: 'move-album', label: t('commandMoveToAlbum'), disabled: state.selected.size === 0, run: () => openMoveDialog({ kind: 'objects', ids: Array.from(state.selected) }) },
    { id: 'rename-album', label: t('commandRenameAlbum'), disabled: !album, run: () => openAlbumDialog({ mode: 'rename', albumId: album.id }) },
    { id: 'parent-album', label: t('commandParentAlbum'), disabled: !inAlbums || !currentAlbumId(), run: goToParentAlbum },
    { id: 'root-album', label: t('commandGoRoot'), disabled: !inAlbums || !currentAlbumId(), run: () => openAlbum(null) },
    { id: 'sync-albums', label: t('commandSyncAlbums'), disabled: !unsynced || !state.online, run: () => syncAlbums() },
    { id: 'upload', label: t('commandUpload'), hint: 'Ctrl/Cmd+U', run: () => $('file-input').click() },
    { id: 'paste', label: t('commandPaste'), hint: 'Ctrl/Cmd+V', run: () => pasteFromClipboard() },
    { id: 'push', label: t('commandPush'), hint: 'Ctrl/Cmd+Enter', disabled: !pending || !state.online, run: () => pushItems() },
    { id: 'clear', label: t('commandClearPending'), disabled: !pending, run: askClearPending },
    { id: 'select', label: t('commandSelectAll'), run: selectAllVisible },
    { id: 'grid', label: t('commandGrid'), disabled: state.layout === 'grid', run: () => { state.layout = 'grid'; savePrefs(); render(); } },
    { id: 'list', label: t('commandList'), disabled: state.layout === 'list', run: () => { state.layout = 'list'; savePrefs(); render(); } },
    { id: 'refresh', label: t('commandRefresh'), run: refreshWorkspace },
    { id: 'theme', label: t('commandTheme'), run: () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; savePrefs(); applyTheme(); } },
    { id: 'en', label: t('commandLangEn'), disabled: getLanguage() === 'en', run: () => setLanguage('en') },
    { id: 'id', label: t('commandLangId'), disabled: getLanguage() === 'id', run: () => setLanguage('id') },
  ];
}

function filteredCommands() {
  const q = (($('command-input') && $('command-input').value) || '').trim().toLowerCase();
  return commandItems().filter((item) => !q || item.label.toLowerCase().indexOf(q) !== -1);
}

function renderCommandList(selectedId) {
  const list = $('command-list');
  if (!list) return;
  const items = filteredCommands();
  list.replaceChildren();
  items.forEach((item, index) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'command-item';
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', (!selectedId && index === 0) || selectedId === item.id ? 'true' : 'false');
    btn.disabled = !!item.disabled;
    btn.dataset.command = item.id;
    const label = document.createElement('span');
    label.textContent = item.label;
    btn.appendChild(label);
    if (item.hint) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = item.hint;
      btn.appendChild(hint);
    }
    btn.addEventListener('click', () => runCommand(item));
    li.appendChild(btn);
    list.appendChild(li);
  });
}

function openCommandPalette() {
  lastFocus = document.activeElement;
  const dialog = $('command-dialog');
  $('command-input').value = '';
  renderCommandList();
  openOverlayDialog(dialog);
  $('command-input').focus();
}

function runCommand(item) {
  if (!item || item.disabled) return;
  closeDialogs();
  item.run();
}

function onCommandKey(event) {
  const buttons = Array.prototype.slice.call(document.querySelectorAll('#command-list .command-item:not([disabled])'));
  if (!buttons.length) return;
  const current = buttons.findIndex((btn) => btn.getAttribute('aria-selected') === 'true');
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const next = event.key === 'ArrowDown'
      ? buttons[(current + 1 + buttons.length) % buttons.length]
      : buttons[(current - 1 + buttons.length) % buttons.length];
    buttons.forEach((btn) => btn.setAttribute('aria-selected', btn === next ? 'true' : 'false'));
    next.focus();
    $('command-input').focus();
  }
  if (event.key === 'Enter') {
    event.preventDefault();
    const selected = buttons[current] || buttons[0];
    const item = filteredCommands().find((entry) => entry.id === selected.dataset.command);
    runCommand(item);
  }
}

function hasFiles(event) {
  const types = event.dataTransfer && event.dataTransfer.types;
  if (!types) return false;
  return Array.prototype.indexOf.call(types, 'Files') !== -1;
}

async function restoreLocal() {
  const albumRecords = await idbAlbumsAll();
  state.albums = albumRecords.map(normalizeAlbum).filter(Boolean);
  state.albumSync = unsyncedAlbumWork().total ? 'local' : (state.albums.length ? 'synced' : 'unknown');
  const records = await idbAll();
  state.items = records.map((record) => {
    const item = {
      id: record.id,
      name: record.name,
      type: record.type || '',
      size: record.size || 0,
      addedAt: record.addedAt || Date.now(),
      seq: record.seq || 0,
      pushedAt: record.pushedAt || null,
      status: record.status || (record.url ? 'synced' : 'pending'),
      src: record.src || null,
      url: record.url || null,
      error: record.error || null,
      progress: 0,
      width: record.width || null,
      height: record.height || null,
      albumId: record.albumId || null,
      albumSynced: record.albumSynced !== false,
      remoteId: record.remoteId || null,
      remote: !!record.remote,
      remoteMetadata: record.remoteMetadata || null,
      file: record.blob || null,
      previewUrl: null,
    };
    if (item.status === 'pushing') item.status = 'pending';
    stageSeq = Math.max(stageSeq, item.seq || 0);
    return item;
  }).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

function trapFocus(event) {
  const open = !$('preview-dialog').hidden ? $('preview-dialog')
    : !$('confirm-dialog').hidden ? $('confirm-dialog')
    : !$('album-dialog').hidden ? $('album-dialog')
    : !$('move-dialog').hidden ? $('move-dialog')
    : null;
  if (!open || event.key !== 'Tab') return;
  const nodes = open.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  const list = Array.prototype.filter.call(nodes, (el) => !el.disabled && el.getAttribute('aria-hidden') !== 'true');
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

async function boot() {
  const prefs = loadPrefs();
  state.theme = detectTheme(prefs);
  state.layout = ['grid', 'list', 'masonry'].indexOf(prefs.layout) !== -1 ? prefs.layout : 'grid';
  state.sort = prefs.sort || 'date:desc';
  state.view = ['overview', 'files', 'images', 'albums', 'recent', 'changes', 'whitelist', 'blacklist', 'tools'].indexOf(prefs.view) !== -1 ? prefs.view : 'files';
  state.albumId = typeof prefs.albumId === 'string' ? prefs.albumId : null;
  state.expanded = new Set(Array.isArray(prefs.expanded) ? prefs.expanded : []);
  state.online = navigator.onLine !== false;

  initI18n();
  applyTheme();
  onLanguageChange(() => render());
  wireEvents();
  document.addEventListener('keydown', trapFocus);
  window.addEventListener('online', () => {
    state.online = true;
    announce(t('announceOnline'));
    renderChrome();
  });
  window.addEventListener('offline', () => {
    state.online = false;
    announce(t('announceOffline'));
    renderChrome();
  });

  if (!await requireSession()) {
    redirectToLogin();
    return;
  }

  await restoreLocal();
  render();

  const results = await Promise.allSettled([loadConfig(), loadRemoteAlbums(), loadRemotePage(true)]);
  if (results[0].status === 'fulfilled' || results[1].status === 'fulfilled') render();
}

boot();
