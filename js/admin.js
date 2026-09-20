import {
  applyStaticI18n, detectLanguage, getLanguage, initI18n,
  onLanguageChange, setLanguage, t,
} from './i18n.js';
import {
  ancestorIds, canMove, childrenOf, countObjects, flattenTree, indexAlbums,
  normalizeAlbum, objectsIn, pathLabel, pathOf, resolveAlbumId, subtreeIds,
  validateName,
} from './albums.js';
import {
  categorize, categoryLabelKey, formatOutput, previewKind,
} from './mime.js';

/* ------------------------------------------------------------------ *
 * Remote Storage Console
 * Vanilla JS, Material 3-inspired. Talks to the existing manage API.
 * ------------------------------------------------------------------ */

const PREFS_KEY = 'ti.prefs';
const PAGE_SIZE = 100;
const RECENT_LIMIT = 8;
const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'ico', 'svg', 'avif'];
const VIDEO_EXTS = ['mp4', 'webm', 'ogg', 'mov', 'm4v', 'avi', 'mkv'];
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'wma'];

const state = {
  ready: false,
  authEnabled: true,
  objects: [],          // loaded objects { name, metadata, _kind }
  cursor: undefined,
  listComplete: false,
  loading: false,
  loadError: false,
  view: 'overview',    // overview | all | images | albums | recent | whitelist | blacklist
  albums: [],          // remote album records
  albumsLoaded: false,
  albumId: null,       // album currently open in the Albums view
  expanded: new Set(), // expanded nodes of the console album tree
  layout: 'grid',      // grid | list | waterfall
  sort: 'dateDesc',
  query: '',
  selected: new Set(),
  detailId: null,
  theme: 'light',
  brokenChecking: false,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* ----------------------------- prefs ----------------------------- */
function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (_) { return {}; }
}
function savePrefs(patch) {
  try {
    const cur = loadPrefs();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch (_) { /* ignore */ }
}
function detectTheme(prefs) {
  if (prefs.theme === 'light' || prefs.theme === 'dark') return prefs.theme;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  const btn = $('theme-btn');
  if (btn) {
    btn.setAttribute('aria-pressed', String(state.theme === 'dark'));
    btn.setAttribute('aria-label', t(state.theme === 'dark' ? 'themeDark' : 'themeLight'));
    btn.setAttribute('title', t(state.theme === 'dark' ? 'themeDark' : 'themeLight'));
  }
}

/* --------------------------- formatting -------------------------- */
function extOf(name) {
  const i = (name || '').lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}
/**
 * Semantic category of a remote object.
 *
 * The KV metadata written by the existing upload endpoint has no MIME field,
 * so remotely the filename is usually the only signal there is — exactly the
 * case the shared helper treats as "fall back to the extension". When a stored
 * MIME type is present (mimetype/contentType/type on the metadata) it wins.
 */
function storedMime(metadata) {
  const meta = metadata || {};
  return meta.mimeType || meta.mimetype || meta.contentType || meta.type || '';
}
function categoryOf(name, metadata) {
  return categorize({ mime: storedMime(metadata), name });
}
/** Legacy coarse kind used by icons/filters: image | video | audio | document. */
function kindOf(name, metadata) {
  const category = categoryOf(name, metadata);
  return category === 'image' || category === 'video' || category === 'audio' ? category : 'document';
}
function kindLabel(kind) {
  return t({ image: 'typeImage', video: 'typeVideo', audio: 'typeAudio', document: 'typeDocument' }[kind] || 'typeFile');
}
/** Precise, translated label for the object's real category. */
function categoryLabel(o) {
  return t(categoryLabelKey(o._category || categoryOf(o.name, o.metadata)));
}
function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return t('bytes', { n });
  if (n < 1024 * 1024) return t('kb', { n: (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) });
  if (n < 1024 * 1024 * 1024) return t('mb', { n: (n / 1024 / 1024).toFixed(2) });
  return t('gb', { n: (n / 1024 / 1024 / 1024).toFixed(2) });
}
function formatWhen(ts) {
  if (!ts) return '—';
  const delta = Date.now() - Number(ts);
  if (delta < 60 * 1000) return t('justNow');
  if (delta < 60 * 60 * 1000) return t('minutesAgo', { n: Math.floor(delta / 60000) });
  if (delta < 24 * 60 * 60 * 1000) return t('hoursAgo', { n: Math.floor(delta / 3600000) });
  if (delta < 7 * 24 * 60 * 60 * 1000) return t('daysAgo', { n: Math.floor(delta / 86400000) });
  try { return new Date(Number(ts)).toLocaleString(getLanguage()); } catch (_) { return new Date(Number(ts)).toLocaleString(); }
}
function fullDate(ts) {
  if (!ts) return '—';
  try { return new Date(Number(ts)).toLocaleString(getLanguage()); } catch (_) { return String(ts); }
}
function publicUrl(obj) {
  const shortId = obj.metadata?.shortId;
  return `${window.location.origin}/file/${shortId || obj.name}`;
}

/* --------------------------- feedback ---------------------------- */
let snackTimer = null;
function announce(msg) { const live = $('live'); if (live) live.textContent = msg; }
function snackbar(message, { action, onAction, isError } = {}) {
  const el = $('snackbar');
  $('snackbar-text').textContent = message;
  const act = $('snackbar-action');
  if (action) {
    act.hidden = false;
    act.textContent = action;
    act.onclick = () => { onAction?.(); el.classList.remove('show'); };
  } else {
    act.hidden = true;
    act.onclick = null;
  }
  el.classList.toggle('is-error', !!isError);
  el.classList.add('show');
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => el.classList.remove('show'), 3600);
  announce(message);
}

/* ----------------------------- API ------------------------------- */
async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    redirect: 'manual',
    headers: { 'Accept': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (res.type === 'opaqueredirect' || [301, 302, 303, 307, 308].includes(res.status)) {
    throw new AuthError('session_redirect');
  }
  if (res.status === 401) throw new AuthError('unauthenticated');
  return res;
}
class AuthError extends Error {}

async function checkSession() {
  try {
    const res = await api('/api/manage/session');
    if (res.ok) return res.json();
  } catch (err) {
    if (err instanceof AuthError) throw err;
    // network issue — don't bounce, let load retry surface it.
  }
  throw new AuthError('unauthenticated');
}

async function loadPage(reset = false) {
  if (state.loading) return;
  if (!reset && state.listComplete) return;
  state.loading = true;
  state.loadError = false;
  renderChrome();
  try {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (!reset && state.cursor) params.set('cursor', state.cursor);
    const res = await api(`/api/manage/list?${params}`);
    if (!res.ok) throw new Error('http ' + res.status);
    const data = await res.json();
    const incoming = (data.keys || []).map(k => {
      const metadata = normalizeMeta(k.metadata, k.name);
      return {
        name: k.name,
        metadata,
        _kind: kindOf(k.name, metadata),
        _category: categoryOf(k.name, metadata),
      };
    });
    state.objects = reset ? incoming : mergeObjects(state.objects, incoming);
    state.cursor = data.list_complete ? undefined : data.cursor;
    state.listComplete = !!data.list_complete;
    state.ready = true;
  } catch (err) {
    state.loadError = true;
    if (err instanceof AuthError) return handleSessionExpired();
    snackbar(t('loadFailedTitle'), { action: t('retry'), onAction: () => loadPage(reset), isError: true });
  } finally {
    state.loading = false;
    render();
  }
}

function normalizeMeta(meta, name) {
  meta = meta || {};
  return {
    ListType: meta.ListType || 'None',
    Label: meta.Label || 'None',
    TimeStamp: meta.TimeStamp || 0,
    liked: !!meta.liked,
    fileName: meta.fileName || name,
    fileSize: meta.fileSize || 0,
    shortId: meta.shortId || undefined,
    provider: meta.provider || undefined,
    ...meta,
  };
}

function mergeObjects(existing, incoming) {
  const map = new Map();
  for (const o of existing) map.set(o.name, o);
  for (const o of incoming) map.set(o.name, { ...(map.get(o.name) || {}), ...o });
  return Array.from(map.values());
}

function upsertObject(name, patch) {
  const idx = state.objects.findIndex(o => o.name === name);
  if (idx >= 0) state.objects[idx] = { ...state.objects[idx], ...patch, metadata: { ...state.objects[idx].metadata, ...(patch.metadata || {}) } };
}
function removeObject(name) {
  state.objects = state.objects.filter(o => o.name !== name);
  state.selected.delete(name);
}

async function runAction(name, url, { method = 'GET', body } = {}) {
  const res = await api(url, { method, body });
  if (!res.ok) throw new Error('http ' + res.status);
  const ct = res.headers.get('Content-Type') || '';
  return ct.includes('json') ? res.json() : res.text();
}

/* ------------------------ session / auth ------------------------- */
function handleSessionExpired() {
  const next = encodeURIComponent('/admin-legacy');
  // Preserve a one-time message across the redirect via sessionStorage.
  try { sessionStorage.setItem('ti.session-expired', '1'); } catch (_) { /* ignore */ }
  window.location.href = `/login?next=${next}`;
}
async function logout() {
  try { await api('/api/manage/logout', { method: 'POST' }); } catch (_) { /* ignore */ }
  window.location.href = '/login';
}

/* --------------------------- clipboard --------------------------- */
function copyText(text, successMsg) {
  const ok = () => snackbar(successMsg || t('copySuccess'));
  const fail = () => snackbar(t('copyFailed'), { isError: true });
  if (!text) return fail();
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(ok, () => legacyCopy(text) ? ok() : fail());
  } else {
    legacyCopy(text) ? ok() : fail();
  }
}
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', '');
  ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
  document.body.removeChild(ta); return ok;
}
/**
 * Copy/paste snippet for a remote object, built from its real category so a
 * PDF or an audio file never becomes image markup.
 */
function linkFor(obj, format) {
  return formatOutput({
    url: publicUrl(obj),
    name: obj.metadata?.fileName || obj.name,
    mime: storedMime(obj.metadata),
    category: obj._category || categoryOf(obj.name, obj.metadata),
  }, format);
}

/* --------------------------- filtering --------------------------- */
function viewPredicate() {
  switch (state.view) {
    case 'images': return (o) => o._kind === 'image' || o._kind === 'video';
    case 'recent': return () => true; // handled by sort/limit
    case 'whitelist': return (o) => o.metadata?.ListType === 'White';
    case 'blacklist': return (o) => o.metadata?.ListType === 'Block' || o.metadata?.Label === 'adult';
    default: return () => true;
  }
}
function filteredObjects() {
  const pred = viewPredicate();
  const q = state.query.trim().toLowerCase();
  let list = state.objects.filter(o => {
    if (!pred(o)) return false;
    if (!q) return true;
    return (
      (o.name || '').toLowerCase().includes(q) ||
      (o.metadata?.fileName || '').toLowerCase().includes(q) ||
      extOf(o.name).includes(q)
    );
  });
  list = sortObjects(list);
  if (state.view === 'recent') list = list.slice(0, 30);
  return list;
}
function sortObjects(list) {
  const sorted = list.slice();
  sorted.sort((a, b) => {
    switch (state.sort) {
      case 'nameAsc': return a.name.localeCompare(b.name);
      case 'nameDesc': return b.name.localeCompare(a.name);
      case 'sizeDesc': return (b.metadata?.fileSize || 0) - (a.metadata?.fileSize || 0);
      case 'sizeAsc': return (a.metadata?.fileSize || 0) - (b.metadata?.fileSize || 0);
      case 'dateAsc': return (a.metadata?.TimeStamp || 0) - (b.metadata?.TimeStamp || 0);
      case 'dateDesc':
      default: return (b.metadata?.TimeStamp || 0) - (a.metadata?.TimeStamp || 0);
    }
  });
  return sorted;
}
function counts() {
  let images = 0, others = 0, white = 0, block = 0;
  for (const o of state.objects) {
    if (o._kind === 'image') images++; else others++;
    if (o.metadata?.ListType === 'White') white++;
    if (o.metadata?.ListType === 'Block' || o.metadata?.Label === 'adult') block++;
  }
  return { total: state.objects.length, images, others, white, block };
}

/* ---------------------------- rendering --------------------------- */
function iconFor(kind) {
  if (kind === 'video') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="14" height="12" rx="2"/><path d="M17 10l4-2v8l-4-2z"/></svg>';
  if (kind === 'audio') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>';
  if (kind === 'image') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M3.8 16.5l4.4-4.2 3.1 3 2.4-2.3 6.3 5.3"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>';
}

function moderationChip(o) {
  const lt = o.metadata?.ListType;
  const label = o.metadata?.Label;
  if (lt === 'White') return `<span class="chip chip-primary"><span class="dot"></span>${t('moderationWhite')}</span>`;
  if (lt === 'Block' || label === 'adult') return `<span class="chip chip-danger"><span class="dot"></span>${t('moderationBlock')}</span>`;
  if (o.metadata?.liked) return `<span class="chip chip-warn"><span class="dot"></span>${t('liked')}</span>`;
  return '';
}

function renderChrome() {
  applyStaticI18n(document);
  applyTheme();
  applyLanguageBadge();
  // nav counts
  const c = counts();
  $('count-all').textContent = c.total;
  $('count-images').textContent = c.images;
  $('count-white').textContent = c.white;
  $('count-block').textContent = c.block;
  const albumCount = $('count-albums');
  if (albumCount) albumCount.textContent = String(state.albums.length);
  renderAlbumTree();
  document.querySelectorAll('.nav-item').forEach(b => {
    const current = b.dataset.view === state.view
      && (b.dataset.view !== 'albums' || !currentAlbumId());
    b.setAttribute('aria-current', current ? 'page' : 'false');
  });

  // footer
  const status = $('footer-status');
  if (state.loading) status.textContent = t('loadingMore');
  else if (state.loadError) status.textContent = t('loadFailedTitle');
  else status.textContent = t('footerLoaded', { n: state.objects.length });
  $('footer-index').textContent = state.listComplete ? t('footerComplete') : (state.objects.length ? t('footerPartial') : '');

  // search clear
  const clear = $('search-clear');
  if (clear) clear.hidden = !state.query;
}

function render() {
  renderChrome();
  const main = $('main');
  if (!state.ready && state.loading && state.objects.length === 0) {
    main.innerHTML = `<div class="page"><div class="skeleton-grid">${Array.from({ length: 8 }, () => (
      '<div class="skeleton"><div class="skeleton-media"></div>' +
      '<div class="skeleton-lines"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div></div>'
    )).join('')}</div></div>`;
    return;
  }
  if (!state.ready && state.loadError) {
    main.innerHTML = `<div class="page">${stateSurface('error')}</div>`;
    main.querySelector('#empty-retry')?.addEventListener('click', () => loadPage(true));
    return;
  }
  if (state.view === 'overview') { renderOverview(main); return; }
  if (state.view === 'albums') { renderAlbumsView(main); return; }
  renderBrowser(main);
}

function stateSurface(kind) {
  if (kind === 'empty') {
    return `<div class="state-surface">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2h5.5A2.5 2.5 0 0 1 20 9.5v8A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z"/></svg>
      <h3>${t('emptyRemoteTitle')}</h3><p>${t('emptyRemoteBody')}</p>
      <button class="btn btn-tonal" id="empty-retry">${t('refreshRemote')}</button>
    </div>`;
  }
  if (kind === 'error') {
    return `<div class="state-surface">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4.5M12 16h.01"/></svg>
      <h3>${t('loadFailedTitle')}</h3><p>${t('loadFailedBody')}</p>
      <button class="btn btn-filled" id="empty-retry">${t('retry')}</button>
    </div>`;
  }
  return `<div class="state-surface"><h3>${t('noResultsTitle')}</h3><p>${t('noResultsBody')}</p></div>`;
}

function renderOverview(main) {
  const c = counts();
  const recent = sortObjects(state.objects).slice(0, RECENT_LIMIT);
  const titles = {
    all: t('navAllFiles'), images: t('navImages'), whitelist: t('navWhitelist'), blacklist: t('navBlacklist'),
  };
  // Every statistic is a plain flow block inside its own card: value, label
  // and (optionally) an explanatory line. Nothing is positioned.
  const stats = [
    { value: c.total, label: t('statObjects'), hint: t('statObjectsHint') },
    { value: c.images, label: t('statImages') },
    { value: c.others, label: t('statOthers') },
    { value: c.white, label: t('statWhitelisted') },
    { value: c.block, label: t('statBlacklisted') },
  ];

  main.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div class="page-titles">
          <h1>${t('consoleOverview')}</h1>
          <p class="subtitle">${t('overviewSubtitle')}</p>
        </div>
        <div class="page-tools">
          <button class="btn btn-tonal" id="ov-refresh">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.2-5.5"/><path d="M20 4v5h-5"/></svg>
            ${t('refreshRemote')}
          </button>
        </div>
      </header>

      <section class="stat-grid" aria-label="${esc(t('overviewSubtitle'))}">
        ${stats.map(sItem => `
          <article class="stat-card">
            <span class="stat-value">${sItem.value}</span>
            <span class="stat-label">${sItem.label}</span>
            ${sItem.hint ? `<span class="stat-hint">${sItem.hint}</span>` : ''}
          </article>`).join('')}
      </section>

      <section class="panel">
        <div class="panel-head">
          <h2>${t('recentObjects')}</h2>
          <button class="btn btn-text" data-jump="recent">${t('navRecent')}</button>
        </div>
        <p class="panel-hint">${t('recentObjectsHint')}</p>
        <div class="context-list">
          ${recent.length ? recent.map(overviewRow).join('') : `<div class="state-surface"><p>${t('emptyRemoteBody')}</p></div>`}
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><h2>${t('operationalContext')}</h2></div>
        <p class="panel-hint">${state.listComplete ? t('listComplete') : t('listIncomplete')}</p>
        <div class="context-list">
          ${['all', 'images', 'whitelist', 'blacklist'].map(v => `
            <button class="context-row" data-jump="${v}">
              <span class="ctx-thumb">${navGlyph(v)}</span>
              <span class="ctx-meta">
                <span class="ctx-name">${titles[v]}</span>
                <span class="ctx-sub">${t('footerLoaded', { n: v === 'all' ? c.total : v === 'images' ? c.images : v === 'whitelist' ? c.white : c.block })}</span>
              </span>
              <span class="ctx-trail">
                <svg class="ctx-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>
              </span>
            </button>`).join('')}
        </div>
      </section>
    </div>
  `;
  main.querySelector('#ov-refresh')?.addEventListener('click', () => loadPage(true));
  main.querySelectorAll('[data-jump]').forEach(b => b.addEventListener('click', () => setView(b.dataset.jump)));
  main.querySelectorAll('.context-row[data-id]').forEach(r => r.addEventListener('click', () => openDetail(r.dataset.id)));
}
function navGlyph(v) {
  const g = {
    all: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H10l2 2h5.5A2.5 2.5 0 0 1 20 9.5v8A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5z"/></svg>',
    images: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M3.8 16.5l4.4-4.2 3.1 3 2.4-2.3 6.3 5.3"/></svg>',
    whitelist: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z"/></svg>',
    blacklist: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
  };
  return g[v] || '';
}
function overviewRow(o) {
  const thumb = (o._kind === 'image' || o._kind === 'video')
    ? `<img src="/file/${esc(o.name)}" alt="" loading="lazy">` : iconFor(o._kind);
  const chip = moderationChip(o);
  return `<button class="context-row" data-id="${esc(o.name)}">
    <span class="ctx-thumb">${thumb}</span>
    <span class="ctx-meta">
      <span class="ctx-name">${esc(o.metadata?.fileName || o.name)}</span>
      <span class="ctx-sub">${esc(kindLabel(o._kind))} · ${esc(formatWhen(o.metadata?.TimeStamp))} · ${esc(formatBytes(o.metadata?.fileSize))}</span>
    </span>
    <span class="ctx-trail">${chip}</span>
  </button>`;
}

function renderBrowser(main) {
  const list = filteredObjects();
  const c = counts();
  const clientFiltered = state.view === 'whitelist' || state.view === 'blacklist' || state.view === 'images';
  const subtitle = viewSubtitle(c);

  main.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div class="page-titles">
          <h1>${viewTitle()}</h1>
          <p class="subtitle">${subtitle}</p>
        </div>
        <div class="page-tools">
          <div class="segmented" role="group" data-i18n-aria="viewModeGroup">
            <button data-layout="grid" aria-pressed="${state.layout === 'grid'}" data-i18n-title="layoutGrid" title="${esc(t('layoutGrid'))}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>
              <span class="btn-label">${t('layoutGrid')}</span>
            </button>
            <button data-layout="list" aria-pressed="${state.layout === 'list'}" data-i18n-title="layoutList" title="${esc(t('layoutList'))}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>
              <span class="btn-label">${t('layoutList')}</span>
            </button>
            <button data-layout="waterfall" aria-pressed="${state.layout === 'waterfall'}" data-i18n-title="layoutWaterfall" title="${esc(t('layoutWaterfall'))}">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="3.5" width="7" height="10" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="6" rx="1.5"/><rect x="3.5" y="16.5" width="7" height="4" rx="1.5"/><rect x="13.5" y="12.5" width="7" height="8" rx="1.5"/></svg>
              <span class="btn-label">${t('layoutWaterfall')}</span>
            </button>
          </div>
        </div>
      </header>

      <div class="browser-bar">
        <span class="result-count">${state.query ? t('resultCount', { n: list.length }) : t('resultCountOf', { shown: list.length, total: state.objects.length })}</span>
        <span class="index-note ${state.listComplete ? 'complete' : ''}">
          <span class="dot"></span>
          ${state.listComplete ? t('listComplete') : t('listIncomplete')}
        </span>
        <span class="spacer"></span>
        <select class="select-field" id="sort-select" aria-label="${esc(t('sortBy'))}">
          <option value="dateDesc">${t('sortNewest')}</option>
          <option value="dateAsc">${t('sortOldest')}</option>
          <option value="nameAsc">${t('sortNameAsc')}</option>
          <option value="nameDesc">${t('sortNameDesc')}</option>
          <option value="sizeDesc">${t('sortSizeDesc')}</option>
          <option value="sizeAsc">${t('sortSizeAsc')}</option>
        </select>
      </div>

      ${clientFiltered ? `<p class="filter-note">${t('listFilteredClient', { n: state.objects.length })}</p>` : ''}

      <div class="browser-region" id="browser" tabindex="-1"></div>

      <div class="load-more-row">
        ${!state.listComplete ? `<button class="btn btn-outlined" id="load-more" ${state.loading ? 'disabled' : ''}>
          ${state.loading ? `<span class="spinner"></span> ${t('loadingMore')}` : t('loadMore')}
        </button>` : ''}
      </div>
    </div>
  `;

  const browser = main.querySelector('#browser');
  if (list.length === 0) {
    browser.innerHTML = stateSurface(state.objects.length === 0 ? 'empty' : 'noresults');
  } else if (state.layout === 'list') {
    browser.innerHTML = renderList(list);
  } else if (state.layout === 'waterfall') {
    browser.innerHTML = renderWaterfall(list);
  } else {
    browser.innerHTML = renderGrid(list);
  }

  const sortSelect = main.querySelector('#sort-select');
  sortSelect.value = state.sort;
  sortSelect.addEventListener('change', (e) => { state.sort = e.target.value; savePrefs({ sort: state.sort }); render(); });
  main.querySelectorAll('[data-layout]').forEach(b => b.addEventListener('click', () => { state.layout = b.dataset.layout; savePrefs({ layout: state.layout }); render(); }));
  main.querySelector('#load-more')?.addEventListener('click', () => loadPage(false));
  main.querySelector('#empty-retry')?.addEventListener('click', () => loadPage(true));

  bindObjectCards(browser);
  bindObjectDragSources(browser);
  renderBulkBar();
}

function viewTitle() {
  return {
    all: t('navAllFiles'), images: t('navImages'), recent: t('navRecent'),
    whitelist: t('navWhitelist'), blacklist: t('navBlacklist'),
  }[state.view] || t('navAllFiles');
}
function viewSubtitle(c) {
  if (state.view === 'recent') return t('recentObjectsHint');
  if (state.view === 'images') return t('subtitleImages', { n: c.images });
  if (state.view === 'whitelist') return t('subtitleWhitelist', { n: c.white });
  if (state.view === 'blacklist') return t('subtitleBlacklist', { n: c.block });
  return t('subtitleAllFiles');
}

function thumb(o) {
  if (o._kind === 'image') return `<img src="/file/${esc(o.name)}" alt="" loading="lazy">`;
  if (o._kind === 'video') return `${iconFor('video')}<span class="video-badge">${esc(kindLabel('video'))}</span>`;
  return iconFor(o._kind);
}

function selectControl(o, extraClass) {
  return `<label class="card-select ${extraClass || ''}">
    <input type="checkbox" data-select="${esc(o.name)}" ${state.selected.has(o.name) ? 'checked' : ''} aria-label="${esc(t('selectObject', { name: o.metadata?.fileName || o.name }))}">
  </label>`;
}

function menuButton(o) {
  return `<button class="icon-btn" data-menu="${esc(o.name)}" aria-label="${esc(t('objectActions', { name: o.metadata?.fileName || o.name }))}" title="${esc(t('objectActions', { name: o.metadata?.fileName || o.name }))}">
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>
  </button>`;
}

function renderGrid(list) {
  return `<div class="obj-grid">${list.map(cardHtml).join('')}</div>`;
}

function renderWaterfall(list) {
  const items = list.map(o => {
    const isMedia = o._kind === 'image' || o._kind === 'video';
    const media = isMedia
      ? (o._kind === 'video'
          ? `<video src="/file/${esc(o.name)}" preload="metadata" muted></video>`
          : `<img src="/file/${esc(o.name)}" alt="" loading="lazy">`)
      : `<div class="wf-placeholder">${iconFor(o._kind)}</div>`;
    const label = esc(o.metadata?.fileName || o.name);
    return `<div class="wf-item ${state.selected.has(o.name) ? 'selected' : ''}" data-id="${esc(o.name)}">
      <span class="wf-moderation">${moderationChip(o)}</span>
      ${selectControl(o, 'wf-select')}
      <div class="wf-media" data-open="${esc(o.name)}" role="button" tabindex="0" aria-label="${esc(t('openDetails', { name: o.metadata?.fileName || o.name }))}">${media}</div>
      <div class="wf-caption">
        <span class="wf-text">
          <span class="obj-name" title="${label}">${label}</span>
          <span class="obj-sub">${esc(kindLabel(o._kind))} · ${esc(formatBytes(o.metadata?.fileSize))}</span>
        </span>
        <span class="card-menu">${menuButton(o)}</span>
      </div>
    </div>`;
  }).join('');
  return `<div class="obj-waterfall">${items}</div>`;
}

function renderList(list) {
  const rows = list.map(o => {
    const label = esc(o.metadata?.fileName || o.name);
    return `
    <div class="obj-row ${state.selected.has(o.name) ? 'selected' : ''}" data-id="${esc(o.name)}">
      <label><input type="checkbox" data-select="${esc(o.name)}" ${state.selected.has(o.name) ? 'checked' : ''} aria-label="${esc(t('selectObject', { name: o.metadata?.fileName || o.name }))}"></label>
      <span class="cell-thumb" data-open="${esc(o.name)}" role="button" tabindex="0" aria-label="${esc(t('openDetails', { name: o.metadata?.fileName || o.name }))}">${o._kind === 'image' ? `<img src="/file/${esc(o.name)}" alt="" loading="lazy">` : iconFor(o._kind)}</span>
      <span class="cell-name">
        <span class="name" title="${label}">${label}</span>
        <span class="sub">${esc(extOf(o.name).toUpperCase() || '—')} · ${esc(fullDate(o.metadata?.TimeStamp))}</span>
      </span>
      <span class="cell-hide-sm cell-mono">${esc(formatBytes(o.metadata?.fileSize))}</span>
      <span class="cell-hide-sm cell-type">${esc(categoryLabel(o))}</span>
      <span class="cell-hide-sm cell-status">${moderationChip(o)}</span>
      <span class="cell-actions">${menuButton(o)}</span>
    </div>`;
  }).join('');
  return `<div class="obj-list">
    <div class="obj-row head">
      <span></span><span></span>
      <span>${t('colName')}</span>
      <span class="cell-hide-sm">${t('colSize')}</span>
      <span class="cell-hide-sm cell-type">${t('colType')}</span>
      <span class="cell-hide-sm">${t('colStatus')}</span>
      <span></span>
    </div>
    ${rows}
  </div>`;
}

function cardHtml(o) {
  const label = esc(o.metadata?.fileName || o.name);
  return `<article class="obj-card ${state.selected.has(o.name) ? 'selected' : ''}" data-id="${esc(o.name)}">
    <span class="obj-moderation">${moderationChip(o)}</span>
    ${selectControl(o)}
    <div class="obj-thumb" data-open="${esc(o.name)}" role="button" tabindex="0" aria-label="${esc(t('openDetails', { name: o.metadata?.fileName || o.name }))}">${thumb(o)}</div>
    <div class="obj-meta">
      <span class="obj-meta-text">
        <span class="obj-name" title="${label}">${label}</span>
        <span class="obj-sub">${esc(categoryLabel(o))} · ${esc(formatBytes(o.metadata?.fileSize))}</span>
      </span>
      <span class="card-menu">${menuButton(o)}</span>
    </div>
  </article>`;
}

function bindObjectCards(scope) {
  scope.querySelectorAll('[data-open]').forEach(el => {
    const handler = () => openDetail(el.dataset.open);
    el.addEventListener('click', handler);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); }
    });
  });
  scope.querySelectorAll('input[data-select]').forEach(cb => {
    cb.addEventListener('click', (e) => e.stopPropagation());
    cb.addEventListener('change', () => toggleSelect(cb.dataset.select, cb.checked));
  });
  scope.querySelectorAll('[data-menu]').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openObjectMenu(btn, btn.dataset.menu); });
  });
  // Waterfall tiles open details when the caption area (not a control) is
  // clicked; the media itself is already handled by the [data-open] binding.
  scope.querySelectorAll('.wf-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('input,button,a,label,[data-open]')) return;
      openDetail(el.dataset.id);
    });
  });
}

/* --------------------------- selection --------------------------- */
function toggleSelect(id, on) {
  if (on) state.selected.add(id); else state.selected.delete(id);
  renderBulkBar();
  document.querySelectorAll(`[data-select="${CSS.escape(id)}"]`).forEach(cb => { cb.checked = on; });
  document.querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach(card => card.classList.toggle('selected', on));
}
function clearSelection() { state.selected.clear(); render(); }
function selectAllVisible() {
  filteredObjects().forEach(o => state.selected.add(o.name));
  render();
}
function selectedObjects() {
  return state.objects.filter(o => state.selected.has(o.name));
}

/* ---------------------------- bulk bar --------------------------- */
function renderBulkBar() {
  let bar = document.querySelector('.bulk-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'bulk-bar';
    bar.innerHTML = `
      <span class="bulk-count" id="bulk-count"></span>
      <button data-bulk="album" data-i18n="bulkMoveAlbum"></button>
      <button data-bulk="copy" data-i18n="bulkCopy"></button>
      <button data-bulk="white" data-i18n="bulkWhitelist"></button>
      <button data-bulk="block" data-i18n="bulkBlacklist"></button>
      <button data-bulk="download" data-i18n="bulkDownload"></button>
      <button data-bulk="delete" class="danger" data-i18n="bulkDelete"></button>
      <button data-bulk="clear" data-i18n="clearSelection"></button>`;
    document.body.appendChild(bar);
    bar.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bulk]');
      if (!btn) return;
      if (btn.dataset.bulk === 'clear') return clearSelection();
      if (btn.dataset.bulk === 'copy') return bulkCopy();
      if (btn.dataset.bulk === 'album') return openMoveDialog({ objects: selectedObjects() });
      if (btn.dataset.bulk === 'white') return bulkModerate('White');
      if (btn.dataset.bulk === 'block') return bulkModerate('Block');
      if (btn.dataset.bulk === 'download') return bulkDownload();
      if (btn.dataset.bulk === 'delete') return bulkDelete();
    });
  }
  applyStaticI18n(bar);
  const n = state.selected.size;
  bar.classList.toggle('show', n > 0);
  bar.querySelector('#bulk-count').textContent = t('bulkBar', { n });
}

/* ----------------------------- menus ----------------------------- */
let activeMenu = null;
function closeMenu() {
  if (activeMenu) { activeMenu.remove(); activeMenu = null; document.removeEventListener('click', closeMenu, true); }
}
function openObjectMenu(anchor, id) {
  closeMenu();
  const obj = state.objects.find(o => o.name === id);
  if (!obj) return;
  const menu = document.createElement('div');
  menu.className = 'menu';
  const items = [
    { label: t('openPreview'), icon: iconFor('image'), fn: () => openDetail(id) },
    { label: t('copyUrl'), fn: () => copyText(linkFor(obj, 'url')) },
    { label: t('copyMarkdown'), fn: () => copyText(linkFor(obj, 'markdown')) },
    { label: t('copyBbcode'), fn: () => copyText(linkFor(obj, 'bbcode')) },
    { label: t('copyHtml'), fn: () => copyText(linkFor(obj, 'html')) },
    { label: t('download'), fn: () => downloadObject(obj) },
    { label: t('rename'), fn: () => openRename(obj) },
    { label: t('moveToAlbum'), fn: () => openMoveDialog({ objects: [obj] }) },
    ...(objectAlbumId(obj) ? [{ label: t('openAlbum'), fn: () => openAlbumView(objectAlbumId(obj)) }] : []),
    { sep: true },
    { label: t('whitelist'), fn: () => moderate(obj, 'White') },
    { label: t('blacklist'), danger: true, fn: () => moderate(obj, 'Block') },
    { label: t('deleteObject'), danger: true, fn: () => confirmDelete([obj]) },
  ];
  menu.innerHTML = items.map((it, i) => it.sep ? '<hr>' :
    `<button data-i="${i}" class="${it.danger ? 'danger' : ''}">${it.icon || ''}<span>${esc(it.label)}</span></button>`).join('');
  document.body.appendChild(menu);
  // Position against the real measured size so the menu always stays inside
  // the viewport instead of relying on a guessed height.
  const gap = 8;
  const mw = Math.min(240, window.innerWidth - gap * 2);
  menu.style.minWidth = mw + 'px';
  const rect = anchor.getBoundingClientRect();
  const mh = menu.offsetHeight;
  let left = Math.min(rect.right - mw, window.innerWidth - mw - gap);
  left = Math.max(gap, left);
  let top = rect.bottom + 4;
  if (top + mh + gap > window.innerHeight) {
    // Flip above the anchor, then clamp so it never leaves the viewport.
    top = rect.top - mh - 4;
    if (top < gap) top = Math.max(gap, window.innerHeight - mh - gap);
  }
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  activeMenu = menu;
  setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    e.stopPropagation();
    const it = items[Number(b.dataset.i)];
    closeMenu();
    it.fn?.();
  });
}

/**
 * Preview surface for the detail sheet, chosen from the object's category.
 * Text and unknown binaries get an honest generic surface rather than a broken
 * <img>.
 */
function detailPreviewHtml(o) {
  const url = `/file/${esc(o.name)}`;
  const label = esc(o.metadata?.fileName || o.name);
  switch (previewKind(o._category || categoryOf(o.name, o.metadata))) {
    case 'image':
      return `<img src="${url}" alt="${label}" loading="lazy">`;
    case 'video':
      return `<video src="${url}" controls preload="metadata"></video>`;
    case 'audio':
      return `<audio src="${url}" controls preload="metadata" style="width:100%" aria-label="${esc(t('previewAudioAria', { name: o.metadata?.fileName || o.name }))}"></audio>`;
    case 'pdf':
      return `<div class="doc-preview">
        <iframe src="${url}" title="${esc(t('previewPdfAria', { name: o.metadata?.fileName || o.name }))}" loading="lazy"></iframe>
        <a href="${url}" target="_blank" rel="noopener">${esc(t('previewOpenExternally'))}</a>
      </div>`;
    default:
      return `<div class="no-preview">${iconFor(o._kind)}<span>${esc(categoryLabel(o))} · ${esc(t('previewNoInline'))}</span></div>`;
  }
}

/* --------------------------- detail sheet ------------------------ */
function openDetail(id) {
  // The whole sheet body refers to `o`; bind it here so the template can be
  // evaluated (previously this was declared as `obj`, which threw a
  // ReferenceError and rendered the sheet empty).
  const o = state.objects.find(item => item.name === id);
  if (!o) return;
  state.detailId = id;
  const sheet = $('detail-sheet');
  const body = $('detail-body');
  const acts = $('detail-actions');
  sheet.hidden = false;
  requestAnimationFrame(() => sheet.classList.add('open'));
  showBackdrop();

  const preview = detailPreviewHtml(o);

  body.innerHTML = `
    <div class="detail-preview">${preview}</div>

    <section class="detail-section">
      <h3 class="detail-section-title">${t('detailShare')}</h3>
      <div class="detail-actions-row">
        <button class="btn btn-filled btn-sm" id="d-copy-url">${t('copyUrl')}</button>
        <button class="btn btn-outlined btn-sm" id="d-copy-md">${t('copyMarkdown')}</button>
        <button class="btn btn-outlined btn-sm" id="d-copy-bb">${t('copyBbcode')}</button>
        <button class="btn btn-outlined btn-sm" id="d-copy-html">${t('copyHtml')}</button>
        <button class="btn btn-tonal btn-sm" id="d-download">${t('download')}</button>
      </div>
      <div class="url-row">
        <input readonly value="${esc(publicUrl(o))}" id="d-url-input" aria-label="${esc(t('metaPublicUrl'))}">
        <button class="btn btn-tonal btn-sm" id="d-copy-2">${t('copyUrl')}</button>
      </div>
    </section>

    <section class="detail-section">
      <h3 class="detail-section-title">${t('detailProperties')}</h3>
      <dl class="detail-dl">
        <dt>${t('metaFilename')}</dt><dd>${esc(o.metadata?.fileName || o.name)}</dd>
        <dt>${t('metaId')}</dt><dd class="mono">${esc(o.name)}</dd>
        <dt>${t('metaType')}</dt><dd>${esc(categoryLabel(o))} · ${esc(extOf(o.name).toUpperCase() || '—')}</dd>
        <dt>${t('metaSize')}</dt><dd>${esc(formatBytes(o.metadata?.fileSize))}</dd>
        <dt>${t('metaAdded')}</dt><dd>${esc(fullDate(o.metadata?.TimeStamp))}</dd>
        <dt>${t('metaModeration')}</dt><dd>${moderationChip(o) || esc(t('moderationNone'))}</dd>
        <dt>${t('metaAlbum')}</dt><dd>${objectAlbumId(o) ? esc(albumCrumbLabel(objectAlbumId(o))) : esc(t('albumUnfiled'))}</dd>
        ${o.metadata?.provider ? `<dt>${t('metaProvider')}</dt><dd>${esc(o.metadata.provider)}</dd>` : ''}
      </dl>
    </section>

    <section class="detail-section">
      <h3 class="detail-section-title">${t('metaRawMetadata')}</h3>
      <pre class="detail-raw">${esc(JSON.stringify(o.metadata, null, 2))}</pre>
    </section>
  `;
  const likeLabel = o.metadata?.liked ? t('toggleLike') : t('liked');
  // Two explicit groups instead of a flex spacer: edit actions and moderation
  // actions each stay together when the row wraps.
  acts.innerHTML = `
    <div class="sheet-action-group">
      <button class="btn btn-tonal btn-sm" id="d-rename">${t('rename')}</button>
      <button class="btn btn-tonal btn-sm" id="d-album">${t('moveToAlbum')}</button>
      <button class="btn btn-tonal btn-sm" id="d-like">${likeLabel}</button>
    </div>
    <div class="sheet-action-group">
      <button class="btn btn-outlined btn-sm" id="d-white">${t('whitelist')}</button>
      <button class="btn btn-outlined btn-sm" id="d-block">${t('blacklist')}</button>
      <button class="btn btn-danger-tonal btn-sm" id="d-delete">${t('deleteObject')}</button>
    </div>
  `;
  body.querySelector('#d-copy-url').onclick = () => copyText(publicUrl(o));
  body.querySelector('#d-copy-md').onclick = () => copyText(linkFor(o, 'markdown'));
  body.querySelector('#d-copy-bb').onclick = () => copyText(linkFor(o, 'bbcode'));
  body.querySelector('#d-copy-html').onclick = () => copyText(linkFor(o, 'html'));
  body.querySelector('#d-copy-2').onclick = () => copyText(publicUrl(o));
  body.querySelector('#d-download').onclick = () => downloadObject(o);
  acts.querySelector('#d-rename').onclick = () => openRename(o);
  acts.querySelector('#d-album').onclick = () => openMoveDialog({ objects: [o] });
  acts.querySelector('#d-like').onclick = () => toggleLike(o);
  acts.querySelector('#d-white').onclick = () => moderate(o, 'White');
  acts.querySelector('#d-block').onclick = () => moderate(o, 'Block');
  acts.querySelector('#d-delete').onclick = () => confirmDelete([o]);

  setTimeout(() => $('detail-close').focus(), 30);
}
function closeDetail() {
  const sheet = $('detail-sheet');
  sheet.classList.remove('open');
  hideBackdrop();
  setTimeout(() => { sheet.hidden = true; }, 250);
  state.detailId = null;
}

/* ---------------------------- actions ----------------------------- */
function downloadObject(o) {
  const a = document.createElement('a');
  a.href = `/file/${o.name}`;
  a.download = o.metadata?.fileName || o.name;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}
function bulkDownload() {
  const objs = selectedObjects();
  if (!objs.length) return;
  snackbar(t('processing'));
  objs.forEach((o, i) => setTimeout(() => downloadObject(o), i * 600));
  clearSelection();
}
function bulkCopy() {
  const objs = selectedObjects();
  if (!objs.length) return;
  copyText(objs.map(o => publicUrl(o)).join('\n'));
}

async function moderate(obj, type) {
  const endpoint = type === 'White' ? 'white' : 'block';
  try {
    const meta = await runAction(obj.name, `/api/manage/${endpoint}/${encodeURIComponent(obj.name)}`);
    upsertObject(obj.name, { metadata: meta || { ListType: type } });
    snackbar(type === 'White' ? t('actionWhitelistSuccess') : t('actionBlacklistSuccess'));
    render();
  } catch (err) {
    if (err instanceof AuthError) return handleSessionExpired();
    snackbar(t('actionFailed'), { isError: true, action: t('retry'), onAction: () => moderate(obj, type) });
  }
}

async function bulkModerate(type) {
  const objs = selectedObjects();
  if (!objs.length) return;
  const endpoint = type === 'White' ? 'white' : 'block';
  const title = t('confirmModerateTitle');
  const body = type === 'White' ? t('confirmBulkWhitelistBody', { n: objs.length }) : t('confirmBulkBlacklistBody', { n: objs.length });
  const ok = await openConfirm({ title, body, confirmText: type === 'White' ? t('whitelist') : t('blacklist') });
  if (!ok) return;
  let success = 0, failed = 0;
  for (const o of objs) {
    try {
      const meta = await runAction(o.name, `/api/manage/${endpoint}/${encodeURIComponent(o.name)}`);
      upsertObject(o.name, { metadata: meta || { ListType: type } });
      success++;
    } catch (err) {
      if (err instanceof AuthError) return handleSessionExpired();
      failed++;
    }
  }
  clearSelection();
  if (failed) snackbar(t('bulkSomeFailed', { failed }), { isError: true });
  else snackbar(t('bulkComplete', { success, total: objs.length }));
  render();
}

async function toggleLike(obj) {
  try {
    const data = await runAction(obj.name, `/api/manage/toggleLike/${encodeURIComponent(obj.name)}`);
    upsertObject(obj.name, { metadata: { liked: data.liked } });
    snackbar(data.liked ? t('actionLikeSuccess') : t('actionUnlikeSuccess'));
    if (state.detailId === obj.name) openDetail(obj.name);
    render();
  } catch (err) {
    if (err instanceof AuthError) return handleSessionExpired();
    snackbar(t('actionFailed'), { isError: true });
  }
}

async function renameObject(obj, newName) {
  try {
    const data = await runAction(obj.name, `/api/manage/editName/${encodeURIComponent(obj.name)}?newName=${encodeURIComponent(newName)}`);
    upsertObject(obj.name, { metadata: { fileName: data.fileName } });
    snackbar(t('actionRenameSuccess'));
    if (state.detailId === obj.name) openDetail(obj.name);
    render();
    return true;
  } catch (err) {
    if (err instanceof AuthError) return handleSessionExpired();
    snackbar(t('actionFailed'), { isError: true });
    return false;
  }
}

// Bulk delete is wired to the selection bar and the command palette, but the
// function was missing, which threw a ReferenceError while building the
// palette command list and left the palette empty.
function bulkDelete() {
  const objs = selectedObjects();
  if (!objs.length) return;
  return confirmDelete(objs);
}

async function deleteObjects(objs) {
  let success = 0, failed = 0;
  for (const o of objs) {
    try {
      await runAction(o.name, `/api/manage/delete/${encodeURIComponent(o.name)}`);
      removeObject(o.name);
      success++;
    } catch (err) {
      if (err instanceof AuthError) return handleSessionExpired();
      failed++;
    }
  }
  clearSelection();
  if (failed) snackbar(t('bulkSomeFailed', { failed }), { isError: true });
  else snackbar(t('actionDeleteSuccess'));
  if (state.detailId && !state.objects.find(o => o.name === state.detailId)) closeDetail();
  render();
}

async function checkBroken() {
  if (state.brokenChecking) return;
  state.brokenChecking = true;
  snackbar(t('brokenChecking', { done: 0, total: state.objects.length }));
  let broken = 0, done = 0;
  for (const o of state.objects) {
    try {
      const res = await fetch(`/file/${o.name}`, { method: 'HEAD', cache: 'no-cache' });
      if (!res.ok) { state.selected.add(o.name); broken++; }
    } catch (_) { state.selected.add(o.name); broken++; }
    done++;
    if (done % 10 === 0) snackbar(t('brokenChecking', { done, total: state.objects.length }));
  }
  state.brokenChecking = false;
  if (broken) snackbar(t('brokenFound', { n: broken }));
  else snackbar(t('brokenNone'));
  render();
}

/* ----------------------------- dialog ---------------------------- */
let dialogResolver = null;
function openConfirm({ title, body, confirmText, danger, extra }) {
  // Focus returns to whatever opened the dialog once it closes.
  const opener = document.activeElement;
  return new Promise((resolve) => {
    const scrim = $('dialog-scrim');
    const dlg = $('dialog');
    $('dialog-title').textContent = title;
    $('dialog-body').textContent = body;
    const extraHost = $('dialog-extra');
    extraHost.innerHTML = '';
    if (extra) extraHost.appendChild(extra);
    const actions = $('dialog-actions');
    actions.innerHTML = '';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-text';
    cancelBtn.textContent = t('cancel');
    const okBtn = document.createElement('button');
    okBtn.className = 'btn ' + (danger ? 'btn-danger-tonal' : 'btn-filled');
    okBtn.textContent = confirmText || t('ok');
    actions.append(cancelBtn, okBtn);
    scrim.hidden = false; dlg.hidden = false;
    requestAnimationFrame(() => { scrim.classList.add('open'); dlg.classList.add('open'); });
    setTimeout(() => okBtn.focus(), 30);

    const cleanup = (val) => {
      scrim.classList.remove('open'); dlg.classList.remove('open');
      setTimeout(() => { scrim.hidden = true; dlg.hidden = true; }, 220);
      dialogResolver = null;
      if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
      resolve(val);
    };
    dialogResolver = cleanup;
    cancelBtn.onclick = () => cleanup(false);
    okBtn.onclick = () => cleanup(true);
  });
}
function closeDialogViaEscape() {
  if (dialogResolver) dialogResolver(false);
}

function confirmDelete(objs) {
  const single = objs.length === 1;
  return openConfirm({
    title: single ? t('confirmDeleteTitle') : t('confirmBulkDeleteTitle', { n: objs.length }),
    body: single ? t('confirmDeleteBody') : t('confirmBulkDeleteBody'),
    confirmText: t('delete'),
    danger: true,
  }).then(ok => { if (ok) deleteObjects(objs); });
}

function openRename(obj) {
  const host = document.createElement('div');
  host.appendChild($('rename-template').content.cloneNode(true));
  const input = host.querySelector('#rename-input');
  const errEl = host.querySelector('#rename-error');
  input.value = obj.metadata?.fileName || obj.name;
  return openConfirm({
    title: t('renameTitle'),
    body: '',
    confirmText: t('renameConfirm'),
    extra: host,
  }).then(async (ok) => {
    if (!ok) return;
    const val = input.value.trim();
    if (!val) { errEl.textContent = t('nameRequired'); snackbar(t('nameRequired'), { isError: true }); return; }
    if (val.length > 64) { errEl.textContent = t('nameTooLong'); snackbar(t('nameTooLong'), { isError: true }); return; }
    await renameObject(obj, val);
  });
}

/* ---------------------------- backdrop --------------------------- */
function showBackdrop() {
  const b = $('backdrop'); b.hidden = false;
  requestAnimationFrame(() => b.classList.add('open'));
}
function hideBackdrop() {
  const b = $('backdrop'); b.classList.remove('open');
  setTimeout(() => { b.hidden = true; }, 220);
}

/* ==================================================================== *
 * Albums (remote)
 *
 * The console manages exactly the same hierarchy as the public workspace,
 * but always shows remote state: album records come from
 * /api/manage/albums and memberships from the object metadata already
 * loaded. Counts therefore describe the loaded page of the index, never a
 * claimed global total. Moving an object between albums never touches its
 * id, public URL, storage location or moderation flags.
 * ==================================================================== */

function albumIndex() { return indexAlbums(state.albums); }
function albumById(id) { return albumIndex().get(id) || null; }
function currentAlbumId() { return resolveAlbumId(albumIndex(), state.albumId); }
function albumChildren(id) { return childrenOf(state.albums, id, getLanguage()); }
function albumShortPath(id) {
  if (!id) return t('albumRoot');
  return pathLabel(albumIndex(), id) || t('albumRoot');
}
function albumCrumbLabel(id) {
  return pathLabel(albumIndex(), id, { rootLabel: t('albumRoot') });
}
function objectAlbumId(o) {
  return resolveAlbumId(albumIndex(), o.metadata && o.metadata.albumId);
}
function albumObjects(id) {
  return objectsIn(state.objects, id, { getAlbumId: (o) => (o.metadata || {}).albumId, index: albumIndex() });
}
function albumLoadedCount(id, recursive) {
  return countObjects(state.objects, id, {
    getAlbumId: (o) => resolveAlbumId(albumIndex(), (o.metadata || {}).albumId),
    albums: state.albums,
    recursive,
  });
}
function albumErrorMessage(code) {
  const keys = {
    name_required: 'albumErrorName',
    name_too_long: 'albumErrorNameLong',
    name_invalid: 'albumErrorNameInvalid',
    duplicate_name: 'albumErrorDuplicate',
    parent_not_found: 'albumErrorParentMissing',
    album_not_found: 'albumErrorParentMissing',
    self_parent: 'albumErrorSelf',
    cycle: 'albumErrorCycle',
    too_deep: 'albumErrorDepth',
  };
  return t(keys[code] || 'albumErrorGeneric');
}

async function albumRequest(path, options = {}) {
  const res = await api(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  let data = null;
  try { data = await res.json(); } catch (_) { /* empty body */ }
  if (!res.ok) {
    const error = new Error((data && data.error) || 'http ' + res.status);
    error.code = data && data.error;
    throw error;
  }
  return data;
}

async function loadAlbums() {
  try {
    const data = await albumRequest('/api/manage/albums');
    state.albums = (data.albums || []).map(normalizeAlbum).filter(Boolean);
    state.albumsLoaded = true;
    return true;
  } catch (err) {
    if (err instanceof AuthError) { handleSessionExpired(); return false; }
    state.albumsLoaded = false;
    snackbar(t('albumsLoadFailed'), { isError: true, action: t('retry'), onAction: loadAlbums });
    return false;
  }
}

function openAlbumView(id) {
  state.view = 'albums';
  state.albumId = id || null;
  if (id) ancestorIds(albumIndex(), id).forEach((parent) => state.expanded.add(parent));
  savePrefs({ adminView: 'albums', albumId: state.albumId });
  closeMobileNav();
  render();
  announce(t('albumOpened', { name: albumCrumbLabel(state.albumId) }));
}

async function createAlbumRemote(parentId) {
  const host = document.createElement('div');
  const field = document.createElement('label');
  field.className = 'field';
  field.innerHTML = `<span class="field-label">${esc(t('albumNameLabel'))}</span>
    <input class="field-control" id="album-name-input" type="text" maxlength="64" autocomplete="off">
    <span class="field-error" id="album-name-error"></span>`;
  const context = document.createElement('p');
  context.className = 'dialog-context';
  context.textContent = t('albumCreateIn', { path: albumCrumbLabel(parentId || null) });
  host.append(context, field);

  const ok = await openConfirm({ title: t('newAlbum'), body: '', confirmText: t('create'), extra: host });
  if (!ok) return null;
  const value = host.querySelector('#album-name-input').value;
  const check = validateName(value);
  if (!check.ok) { snackbar(albumErrorMessage(check.error), { isError: true }); return null; }
  const local = canMove(state.albums, null, parentId || null, check.name);
  if (!local.ok) { snackbar(albumErrorMessage(local.error), { isError: true }); return null; }
  try {
    const data = await albumRequest('/api/manage/albums', {
      method: 'POST',
      body: JSON.stringify({ name: check.name, parentId: parentId || null }),
    });
    state.albums.push(normalizeAlbum({ ...data.album, synced: true }));
    if (parentId) state.expanded.add(parentId);
    snackbar(t('albumCreated', { name: data.album.name }));
    render();
    return data.album;
  } catch (err) {
    if (err instanceof AuthError) return handleSessionExpired();
    snackbar(albumErrorMessage(err.code), { isError: true });
    return null;
  }
}

async function renameAlbumRemote(album) {
  const host = document.createElement('div');
  const field = document.createElement('label');
  field.className = 'field';
  field.innerHTML = `<span class="field-label">${esc(t('albumNameLabel'))}</span>
    <input class="field-control" id="album-name-input" type="text" maxlength="64" autocomplete="off">`;
  const context = document.createElement('p');
  context.className = 'dialog-context';
  context.textContent = t('albumPathLabel', { path: albumCrumbLabel(album.id) });
  host.append(context, field);
  const input = field.querySelector('input');
  input.value = album.name;

  const ok = await openConfirm({ title: t('renameAlbum'), body: '', confirmText: t('save'), extra: host });
  if (!ok) return;
  const check = validateName(input.value);
  if (!check.ok) return snackbar(albumErrorMessage(check.error), { isError: true });
  try {
    const data = await albumRequest('/api/manage/albums/' + encodeURIComponent(album.id), {
      method: 'PATCH',
      body: JSON.stringify({ name: check.name }),
    });
    // The id is unchanged, so children and object memberships stay intact.
    state.albums = state.albums.map((a) => (a.id === album.id ? normalizeAlbum({ ...data.album, synced: true }) : a));
    snackbar(t('albumRenamed', { name: data.album.name }));
    render();
  } catch (err) {
    if (err instanceof AuthError) return handleSessionExpired();
    snackbar(albumErrorMessage(err.code), { isError: true });
  }
}

async function moveAlbumRemote(id, parentId) {
  const album = albumById(id);
  if (!album) return;
  const check = canMove(state.albums, id, parentId || null, album.name);
  if (!check.ok) return snackbar(albumErrorMessage(check.error), { isError: true });
  const previous = state.albums.slice();
  state.albums = state.albums.map((a) => (a.id === id ? { ...a, parentId: check.parentId } : a));
  render();
  try {
    await albumRequest('/api/manage/albums/' + encodeURIComponent(id), {
      method: 'PATCH',
      body: JSON.stringify({ parentId: check.parentId }),
    });
    snackbar(t('albumMoved', { name: album.name, target: albumShortPath(check.parentId) }));
  } catch (err) {
    state.albums = previous; // optimistic move rolled back
    render();
    if (err instanceof AuthError) return handleSessionExpired();
    snackbar(albumErrorMessage(err.code), { isError: true });
  }
}

async function deleteAlbumRemote(album) {
  const objects = albumLoadedCount(album.id, true);
  const children = albumChildren(album.id).length;
  const ok = await openConfirm({
    title: t('deleteAlbumTitle', { name: album.name }),
    body: children ? t('deleteAlbumBodyNested', { n: objects, c: children }) : t('deleteAlbumBody', { n: objects }),
    confirmText: t('deleteAlbumConfirm'),
    danger: true,
  });
  if (!ok) return;
  try {
    await albumRequest('/api/manage/albums/' + encodeURIComponent(album.id), { method: 'DELETE' });
    await loadAlbums();
    if (state.albumId === album.id) state.albumId = album.parentId || null;
    snackbar(t('albumDeleted', { name: album.name }));
    render();
  } catch (err) {
    if (err instanceof AuthError) return handleSessionExpired();
    snackbar(albumErrorMessage(err.code), { isError: true });
  }
}

async function assignObjectsToAlbum(objs, albumId) {
  const ids = objs.map((o) => o.name);
  if (!ids.length) return;
  const target = albumId || null;
  const previous = objs.map((o) => ({ name: o.name, albumId: (o.metadata || {}).albumId || null }));
  // Optimistic: the browser shows the new placement immediately and rolls back
  // if the server refuses. Nothing else about the object is touched.
  for (const o of objs) upsertObject(o.name, { metadata: { albumId: target || undefined } });
  render();
  try {
    await albumRequest('/api/manage/albums/assign', {
      method: 'POST',
      body: JSON.stringify({ albumId: target, ids }),
    });
    snackbar(ids.length === 1
      ? t('objectMoved', { name: objs[0].metadata?.fileName || objs[0].name, target: albumShortPath(target) })
      : t('objectsMoved', { n: ids.length, target: albumShortPath(target) }));
    if (state.detailId && ids.includes(state.detailId)) openDetail(state.detailId);
  } catch (err) {
    for (const entry of previous) upsertObject(entry.name, { metadata: { albumId: entry.albumId || undefined } });
    render();
    if (err instanceof AuthError) return handleSessionExpired();
    snackbar(albumErrorMessage(err.code), { isError: true });
  }
}

/* --------------------------- move dialog -------------------------- */

async function openMoveDialog({ objects, albumId }) {
  const subjectName = objects
    ? (objects.length === 1 ? (objects[0].metadata?.fileName || objects[0].name) : t('bulkBar', { n: objects.length }))
    : (albumById(albumId) || {}).name;
  const start = objects
    ? ((objects[0].metadata || {}).albumId || null)
    : (albumById(albumId) || {}).parentId || null;

  const host = document.createElement('div');
  const context = document.createElement('p');
  context.className = 'dialog-context';
  context.textContent = t('moveSubject', { name: subjectName || '' });
  const picker = document.createElement('ul');
  picker.className = 'album-picker';
  picker.setAttribute('role', 'tree');
  picker.setAttribute('aria-label', t('albumPickerAria'));
  const note = document.createElement('p');
  note.className = 'dialog-note';
  host.append(context, picker, note);

  let target = resolveAlbumId(albumIndex(), start);

  const invalidFor = (id) => {
    if (objects) return null;
    const album = albumById(albumId);
    const check = canMove(state.albums, albumId, id, album ? album.name : undefined);
    return check.ok ? null : check.error;
  };

  const paint = () => {
    picker.replaceChildren();
    const rows = [{ id: null, name: t('albumRoot'), depth: 0 }].concat(
      flattenTree(state.albums, { locale: getLanguage() }).map(({ album, depth }) => ({
        id: album.id, name: album.name, depth: depth + 1,
      })),
    );
    for (const row of rows) {
      const li = document.createElement('li');
      li.setAttribute('role', 'treeitem');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'album-picker-row' + (target === row.id ? ' selected' : '');
      btn.style.paddingInlineStart = (12 + row.depth * 16) + 'px';
      const invalid = invalidFor(row.id);
      btn.disabled = !!invalid;
      if (invalid) btn.title = albumErrorMessage(invalid);
      btn.setAttribute('aria-selected', target === row.id ? 'true' : 'false');
      btn.innerHTML = `<span class="album-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h3.1l1.8 1.8h7.7A2.2 2.2 0 0 1 20.5 10v7.3a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/></svg></span>
        <span class="album-picker-name">${esc(row.name)}</span>` +
        (row.id === start ? `<span class="album-picker-chip">${esc(t('currentLocation'))}</span>` : '');
      btn.onclick = () => { target = row.id; paint(); };
      li.appendChild(btn);
      picker.appendChild(li);
    }
    note.textContent = t('movePickerNote', { path: albumCrumbLabel(target) });
  };
  paint();

  const ok = await openConfirm({
    title: objects ? t('moveToAlbum') : t('moveAlbum'),
    body: '',
    confirmText: t('moveHere'),
    extra: host,
  });
  if (!ok) return;
  if (objects) await assignObjectsToAlbum(objects, target);
  else await moveAlbumRemote(albumId, target);
}

/* ---------------------------- rendering --------------------------- */

function folderSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h3.1l1.8 1.8h7.7A2.2 2.2 0 0 1 20.5 10v7.3a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/></svg>';
}

function renderAlbumTree() {
  const tree = $('album-tree');
  const empty = $('album-nav-empty');
  if (!tree) return;
  const rows = flattenTree(state.albums, { expanded: state.expanded, locale: getLanguage() });
  if (empty) empty.hidden = rows.length > 0;
  tree.replaceChildren();

  rows.forEach(({ album, depth, hasChildren }) => {
    const li = document.createElement('li');
    li.className = 'album-row' + (state.view === 'albums' && currentAlbumId() === album.id ? ' active' : '');
    li.setAttribute('role', 'treeitem');
    li.dataset.albumId = album.id;
    li.setAttribute('aria-level', String(depth + 1));
    li.tabIndex = -1;
    if (hasChildren) li.setAttribute('aria-expanded', state.expanded.has(album.id) ? 'true' : 'false');

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'album-row-btn';
    btn.style.paddingInlineStart = (8 + depth * 14) + 'px';
    btn.tabIndex = -1;

    const twisty = document.createElement('span');
    twisty.className = 'album-twisty' + (state.expanded.has(album.id) ? ' open' : '') + (hasChildren ? '' : ' placeholder');
    twisty.setAttribute('aria-hidden', 'true');
    twisty.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
    if (hasChildren) {
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.expanded.has(album.id)) state.expanded.delete(album.id);
        else state.expanded.add(album.id);
        renderAlbumTree();
      });
    }
    btn.appendChild(twisty);

    const icon = document.createElement('span');
    icon.className = 'album-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = folderSvg();
    btn.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'album-row-name';
    name.textContent = album.name;
    btn.appendChild(name);

    const count = albumLoadedCount(album.id, false);
    if (count) {
      const badge = document.createElement('span');
      badge.className = 'album-row-count';
      badge.textContent = String(count);
      badge.title = t('albumRemoteHint');
      btn.appendChild(badge);
    }

    btn.addEventListener('click', () => openAlbumView(album.id));
    li.appendChild(btn);
    li.draggable = true;
    li.addEventListener('dragstart', (e) => startAlbumDrag(e, album.id));
    li.addEventListener('dragend', endDrag);
    li.addEventListener('keydown', (e) => onAlbumTreeKey(e, album.id));
    attachAlbumDropTarget(li, album.id);
    tree.appendChild(li);
  });

  const rowEls = Array.from(tree.querySelectorAll('.album-row'));
  const activeIndex = Math.max(0, rowEls.findIndex((el) => el.classList.contains('active')));
  rowEls.forEach((el, i) => { el.tabIndex = i === activeIndex ? 0 : -1; });
}

function onAlbumTreeKey(event, id) {
  const rows = Array.from(document.querySelectorAll('#album-tree .album-row'));
  const index = rows.findIndex((row) => row.dataset.albumId === id);
  const focus = (el) => { if (el) { rows.forEach((r) => { r.tabIndex = -1; }); el.tabIndex = 0; el.focus(); } };
  if (event.key === 'ArrowDown') { event.preventDefault(); focus(rows[index + 1]); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); focus(rows[index - 1]); }
  else if (event.key === 'ArrowRight') {
    event.preventDefault();
    if (albumChildren(id).length && !state.expanded.has(id)) { state.expanded.add(id); renderAlbumTree(); }
    else focus(rows[index + 1]);
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (state.expanded.has(id)) { state.expanded.delete(id); renderAlbumTree(); }
    else {
      const parent = (albumById(id) || {}).parentId;
      focus(rows.find((r) => r.dataset.albumId === parent));
    }
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    openAlbumView(id);
  } else if (event.key === 'F2') {
    event.preventDefault();
    const album = albumById(id);
    if (album) renameAlbumRemote(album);
  }
}

function albumCrumbsHtml() {
  const chain = pathOf(albumIndex(), currentAlbumId());
  const parts = [`<button class="crumb-link" data-crumb="root">${esc(t('albumRoot'))}</button>`];
  chain.forEach((album, i) => {
    const last = i === chain.length - 1;
    parts.push(last
      ? `<span class="crumb-current" aria-current="page">${esc(album.name)}</span>`
      : `<button class="crumb-link" data-crumb="${esc(album.id)}">${esc(album.name)}</button>`);
  });
  return `<nav class="album-crumbs" aria-label="${esc(t('albumPathLabel', { path: albumCrumbLabel(currentAlbumId()) }))}">
    ${parts.join('<span class="sep" aria-hidden="true">/</span>')}
  </nav>`;
}

function albumCardHtml(album) {
  const objects = albumLoadedCount(album.id, true);
  const subs = albumChildren(album.id).length;
  const cover = state.objects.find((o) => o._kind === 'image' && subtreeIds(state.albums, album.id).has(objectAlbumId(o) || ''));
  const media = cover
    ? `<img src="/file/${esc(cover.name)}" alt="" loading="lazy">`
    : `<span class="album-icon" aria-hidden="true">${folderSvg()}</span>`;
  return `<article class="album-card" data-album-card="${esc(album.id)}" tabindex="0" role="button"
      aria-label="${esc(t('openAlbumAria', { name: album.name }))}" draggable="true">
    <div class="album-cover ${cover ? '' : 'placeholder'}">${media}</div>
    <div class="album-card-body">
      <span class="album-card-name" title="${esc(album.name)}">${esc(album.name)}</span>
      <span class="album-card-meta">${esc(!objects && !subs ? t('albumEmptyMeta') : t('albumCountRemote', { n: objects }))}${subs ? ' · ' + esc(t('albumSubcount', { n: subs })) : ''}</span>
    </div>
    <div class="album-card-actions">
      <button class="icon-btn" data-album-menu="${esc(album.id)}" aria-label="${esc(t('albumMenuAria', { name: album.name }))}">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>
      </button>
    </div>
  </article>`;
}

function renderAlbumsView(main) {
  const albumId = currentAlbumId();
  const album = albumById(albumId);
  const children = albumChildren(albumId);
  const objects = sortObjects(albumObjects(albumId).filter((o) => {
    const q = state.query.trim().toLowerCase();
    if (!q) return true;
    return (o.name || '').toLowerCase().includes(q)
      || (o.metadata?.fileName || '').toLowerCase().includes(q)
      || albumShortPath(objectAlbumId(o)).toLowerCase().includes(q);
  }));

  main.innerHTML = `
    <div class="page">
      <header class="page-head">
        <div class="page-titles">
          <h1>${esc(album ? album.name : t('adminAlbumsTitle'))}</h1>
          <p class="subtitle">${esc(t('adminAlbumsSubtitle'))}</p>
          ${albumCrumbsHtml()}
        </div>
        <div class="page-tools">
          <button class="btn btn-tonal" id="album-create">${esc(t('newAlbum'))}</button>
          ${album ? `<button class="btn btn-outlined" id="album-rename">${esc(t('renameAlbum'))}</button>
          <button class="btn btn-outlined" id="album-move">${esc(t('moveAlbum'))}</button>
          <button class="btn btn-danger-tonal" id="album-delete">${esc(t('deleteAlbum'))}</button>` : ''}
        </div>
      </header>

      <p class="filter-note">${esc(t('albumRemoteHint'))}</p>

      ${children.length ? `<section class="panel album-panel" id="album-children-panel">
        <div class="panel-head"><h2>${esc(t('albumsInHere'))}</h2></div>
        <div class="album-grid">${children.map(albumCardHtml).join('')}</div>
      </section>` : ''}

      <section class="panel album-panel">
        <div class="panel-head">
          <h2>${esc(t('objectsInAlbum'))}</h2>
          <span class="result-count">${esc(t('resultCount', { n: objects.length }))}</span>
        </div>
        <div class="browser-region" id="browser" tabindex="-1"></div>
      </section>
    </div>`;

  const browser = main.querySelector('#browser');
  if (!objects.length) {
    browser.innerHTML = `<div class="state-surface">
      <h3>${esc(albumId ? t('emptyAlbumTitle') : t('emptyAlbumsTitle'))}</h3>
      <p>${esc(albumId ? t('emptyAlbumBody') : t('emptyAlbumsBody'))}</p>
    </div>`;
  } else if (state.layout === 'list') browser.innerHTML = renderList(objects);
  else if (state.layout === 'waterfall') browser.innerHTML = renderWaterfall(objects);
  else browser.innerHTML = renderGrid(objects);

  main.querySelector('#album-create')?.addEventListener('click', () => createAlbumRemote(albumId));
  main.querySelector('#album-rename')?.addEventListener('click', () => renameAlbumRemote(album));
  main.querySelector('#album-move')?.addEventListener('click', () => openMoveDialog({ albumId: album.id }));
  main.querySelector('#album-delete')?.addEventListener('click', () => deleteAlbumRemote(album));
  main.querySelectorAll('[data-crumb]').forEach((btn) => {
    btn.addEventListener('click', () => openAlbumView(btn.dataset.crumb === 'root' ? null : btn.dataset.crumb));
    attachAlbumDropTarget(btn, btn.dataset.crumb === 'root' ? null : btn.dataset.crumb);
  });
  main.querySelectorAll('[data-album-card]').forEach((card) => {
    const id = card.dataset.albumCard;
    card.addEventListener('click', (e) => { if (!e.target.closest('button')) openAlbumView(id); });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openAlbumView(id); }
    });
    card.addEventListener('dragstart', (e) => startAlbumDrag(e, id));
    card.addEventListener('dragend', endDrag);
    attachAlbumDropTarget(card, id);
  });
  main.querySelectorAll('[data-album-menu]').forEach((btn) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openAlbumMenu(btn, btn.dataset.albumMenu); });
  });

  bindObjectCards(browser);
  bindObjectDragSources(browser);
  renderBulkBar();
}

function openAlbumMenu(anchor, id) {
  const album = albumById(id);
  if (!album) return;
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'menu';
  const items = [
    { label: t('openAlbum'), fn: () => openAlbumView(id) },
    { label: t('createInside'), fn: () => createAlbumRemote(id) },
    { label: t('renameAlbum'), fn: () => renameAlbumRemote(album) },
    { label: t('moveAlbum'), fn: () => openMoveDialog({ albumId: id }) },
    { sep: true },
    { label: t('deleteAlbum'), danger: true, fn: () => deleteAlbumRemote(album) },
  ];
  menu.innerHTML = items.map((it, i) => (it.sep ? '<hr>' :
    `<button data-i="${i}" class="${it.danger ? 'danger' : ''}"><span>${esc(it.label)}</span></button>`)).join('');
  document.body.appendChild(menu);
  const gap = 8;
  const mw = Math.min(240, window.innerWidth - gap * 2);
  menu.style.minWidth = mw + 'px';
  const rect = anchor.getBoundingClientRect();
  const mh = menu.offsetHeight;
  let left = Math.max(gap, Math.min(rect.right - mw, window.innerWidth - mw - gap));
  let top = rect.bottom + 4;
  if (top + mh + gap > window.innerHeight) top = Math.max(gap, rect.top - mh - 4);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  activeMenu = menu;
  setTimeout(() => document.addEventListener('click', closeMenu, true), 0);
  menu.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]');
    if (!b) return;
    e.stopPropagation();
    const it = items[Number(b.dataset.i)];
    closeMenu();
    it.fn?.();
  });
}

/* --------------------------- drag and drop ------------------------- */

let dragState = null;

function showDragHint(message, invalid) {
  const hint = $('drag-hint');
  if (!hint) return;
  hint.textContent = message;
  hint.hidden = !message;
  hint.classList.toggle('invalid', !!invalid);
}
function endDrag() {
  dragState = null;
  document.body.classList.remove('dragging-internal');
  const hint = $('drag-hint');
  if (hint) { hint.hidden = true; hint.textContent = ''; }
  document.querySelectorAll('.drop-target, .drop-invalid').forEach((el) => el.classList.remove('drop-target', 'drop-invalid'));
}
function startAlbumDrag(event, albumId) {
  dragState = { kind: 'album', albumId };
  event.stopPropagation();
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    try { event.dataTransfer.setData('text/plain', (albumById(albumId) || {}).name || albumId); } catch (_) { /* noop */ }
  }
  document.body.classList.add('dragging-internal');
}
function startObjectDrag(event, name) {
  const names = state.selected.has(name) ? Array.from(state.selected) : [name];
  dragState = { kind: 'objects', names };
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    try { event.dataTransfer.setData('text/plain', names.join('\n')); } catch (_) { /* noop */ }
  }
  document.body.classList.add('dragging-internal');
}
function bindObjectDragSources(scope) {
  scope.querySelectorAll('[data-id]').forEach((el) => {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => startObjectDrag(e, el.dataset.id));
    el.addEventListener('dragend', endDrag);
  });
}
function dropVerdict(targetId) {
  if (!dragState) return null;
  if (dragState.kind === 'album') {
    if (dragState.albumId === targetId) return { ok: false, message: t('dropInvalidSelf') };
    const album = albumById(dragState.albumId);
    const check = canMove(state.albums, dragState.albumId, targetId, album ? album.name : undefined);
    if (!check.ok) return { ok: false, message: albumErrorMessage(check.error) };
    return { ok: true, message: t('dropReparent', { name: album ? album.name : '', target: albumShortPath(targetId) }) };
  }
  const objs = state.objects.filter((o) => dragState.names.includes(o.name));
  if (objs.every((o) => (objectAlbumId(o) || null) === (targetId || null))) {
    return { ok: false, message: t('dropAlreadyHere') };
  }
  return { ok: true, message: t('dropMoveHere', { target: albumShortPath(targetId) }) };
}
function attachAlbumDropTarget(el, albumId) {
  const target = albumId || null;
  el.addEventListener('dragover', (event) => {
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
    const verdict = dropVerdict(target);
    el.classList.remove('drop-target', 'drop-invalid');
    if (!verdict) return;
    event.preventDefault();
    event.stopPropagation();
    const drag = dragState;
    endDrag();
    if (!verdict.ok) { snackbar(verdict.message); return; }
    if (drag.kind === 'album') await moveAlbumRemote(drag.albumId, target);
    else await assignObjectsToAlbum(state.objects.filter((o) => drag.names.includes(o.name)), target);
  });
}

/* ----------------------- command palette ------------------------- */
const paletteCommands = () => [
  { id: 'search', label: t('commandFocusSearch'), kbd: '/', run: () => focusSearch() },
  { id: 'grid', label: t('commandGrid'), run: () => { state.layout = 'grid'; savePrefs({ layout: 'grid' }); render(); } },
  { id: 'list', label: t('commandList'), run: () => { state.layout = 'list'; savePrefs({ layout: 'list' }); render(); } },
  { id: 'waterfall', label: t('commandWaterfall'), run: () => { state.layout = 'waterfall'; savePrefs({ layout: 'waterfall' }); render(); } },
  { id: 'refresh', label: t('commandRefresh'), kbd: 'R', run: () => { loadAlbums(); loadPage(true); } },
  { id: 'album-new', label: t('commandNewAlbum'), run: () => createAlbumRemote(state.view === 'albums' ? currentAlbumId() : null) },
  { id: 'album-open', label: t('commandOpenAlbums'), run: () => openAlbumView(state.view === 'albums' ? currentAlbumId() : null) },
  { id: 'album-move', label: t('commandMoveToAlbum'), run: () => { if (state.selected.size) openMoveDialog({ objects: selectedObjects() }); } },
  { id: 'album-parent', label: t('commandParentAlbum'), run: () => { const a = albumById(currentAlbumId()); openAlbumView(a ? a.parentId : null); } },
  { id: 'album-root', label: t('commandGoRoot'), run: () => openAlbumView(null) },
  { id: 'open', label: t('commandOpen'), run: () => { const first = filteredObjects()[0]; if (first) openDetail(first.name); } },
  { id: 'copy', label: t('commandCopyUrls'), run: bulkCopy },
  { id: 'white', label: t('commandWhitelist'), run: () => bulkModerate('White') },
  { id: 'block', label: t('commandBlacklist'), run: () => bulkModerate('Block') },
  { id: 'delete', label: t('commandDelete'), run: bulkDelete },
  { id: 'broken', label: t('commandBroken'), run: checkBroken },
  { id: 'theme', label: t('commandTheme'), run: toggleTheme },
  { id: 'lang-en', label: t('commandLangEn'), run: () => setLanguage('en') },
  { id: 'lang-id', label: t('commandLangId'), run: () => setLanguage('id') },
  { id: 'logout', label: t('commandLogout'), run: logout },
];
let paletteActive = 0;
function openPalette() {
  const p = $('palette'); const scrim = $('palette-scrim'); const input = $('palette-input');
  p.hidden = false; scrim.hidden = false;
  requestAnimationFrame(() => { p.classList.add('open'); scrim.classList.add('open'); input.focus(); input.select(); });
  paletteActive = 0;
  renderPalette('');
}
function closePalette() {
  const p = $('palette'); const scrim = $('palette-scrim');
  p.classList.remove('open'); scrim.classList.remove('open');
  setTimeout(() => { p.hidden = true; scrim.hidden = true; }, 200);
}
function renderPalette(q) {
  const results = $('palette-results');
  const all = paletteCommands();
  const query = q.trim().toLowerCase();
  const items = query ? all.filter(c => c.label.toLowerCase().includes(query)) : all;
  if (paletteActive >= items.length) paletteActive = 0;
  results.innerHTML = items.map((c, i) =>
    `<button class="palette-item ${i === paletteActive ? 'active' : ''}" role="option" data-i="${i}">
      <span>${esc(c.label)}</span>${c.kbd ? `<kbd>${esc(c.kbd)}</kbd>` : ''}
    </button>`).join('') || `<div class="palette-item" style="color:var(--md-sys-color-on-surface-variant)">—</div>`;
  results.querySelectorAll('button[data-i]').forEach(b => {
    b.onmouseenter = () => { paletteActive = Number(b.dataset.i); renderPalette(query); };
    b.onclick = () => { const cmd = items[paletteActive]; closePalette(); cmd?.run(); };
  });
}

/* ----------------------------- view ------------------------------ */
function setView(v) {
  state.view = v;
  if (v === 'albums') state.albumId = null;
  savePrefs({ adminView: v, albumId: state.albumId });
  closeMobileNav();
  render();
}
function focusSearch() {
  const s = $('search');
  if (!s) return;
  closeMobileNav();
  s.focus();
  s.select?.();
}

function toggleTheme() {
  state.theme = state.theme === 'dark' ? 'light' : 'dark';
  savePrefs({ theme: state.theme });
  applyTheme();
}
function cycleLanguage() {
  setLanguage(getLanguage() === 'en' ? 'id' : 'en');
}
function applyLanguageBadge() {
  const code = $('lang-code');
  if (code) code.textContent = getLanguage().toUpperCase();
}

/* --------------------------- mobile nav --------------------------
 * The drawer uses its own scrim element so it participates in the shared
 * layering scale (below sheets/dialogs) instead of reusing the sheet
 * backdrop, which would let a sheet and the drawer fight over one scrim.
 */
function navScrim() {
  let el = document.querySelector('.nav-scrim');
  if (!el) {
    el = document.createElement('div');
    el.className = 'nav-scrim';
    el.addEventListener('click', closeMobileNav);
    document.body.appendChild(el);
  }
  return el;
}
function isMobileNav() { return window.matchMedia('(max-width: 1023.98px)').matches; }
function openMobileNav() {
  $('side-nav').classList.add('open');
  navScrim().classList.add('open');
  $('nav-toggle')?.setAttribute('aria-expanded', 'true');
  $('nav-close')?.focus();
}
function closeMobileNav() {
  const nav = $('side-nav');
  if (!nav.classList.contains('open')) return;
  nav.classList.remove('open');
  navScrim().classList.remove('open');
  $('nav-toggle')?.setAttribute('aria-expanded', 'false');
}
function toggleMobileNav() {
  if ($('side-nav').classList.contains('open')) closeMobileNav();
  else openMobileNav();
}

/* ----------------------------- init ------------------------------ */
function bindEvents() {
  document.querySelectorAll('.nav-item').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  $('nav-toggle')?.addEventListener('click', toggleMobileNav);
  $('nav-close')?.addEventListener('click', () => { closeMobileNav(); $('nav-toggle')?.focus(); });
  $('refresh-btn').addEventListener('click', () => { loadAlbums(); loadPage(true); });
  $('album-new')?.addEventListener('click', () => createAlbumRemote(state.view === 'albums' ? currentAlbumId() : null));
  $('theme-btn').addEventListener('click', toggleTheme);
  $('lang-btn').addEventListener('click', cycleLanguage);
  $('logout-btn').addEventListener('click', logout);
  $('palette-btn').addEventListener('click', openPalette);
  $('detail-close').addEventListener('click', closeDetail);

  const search = $('search');
  let timer = null;
  search.addEventListener('input', () => {
    state.query = search.value;
    if (state.view === 'overview') state.view = 'all';
    clearTimeout(timer);
    timer = setTimeout(render, 120);
  });
  $('search-clear').addEventListener('click', () => { search.value = ''; state.query = ''; search.focus(); render(); });

  $('backdrop').addEventListener('click', () => closeDetail());

  // Keep the drawer state consistent when crossing the desktop breakpoint.
  window.matchMedia('(max-width: 1023.98px)').addEventListener?.('change', (e) => {
    if (!e.matches) closeMobileNav();
  });

  // palette
  const pinput = $('palette-input');
  pinput.addEventListener('input', () => { paletteActive = 0; renderPalette(pinput.value); });
  pinput.addEventListener('keydown', (e) => {
    const items = $('palette-results').querySelectorAll('button[data-i]');
    if (e.key === 'ArrowDown') { e.preventDefault(); paletteActive = (paletteActive + 1) % items.length; renderPalette(pinput.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); paletteActive = (paletteActive - 1 + items.length) % items.length; renderPalette(pinput.value); }
    else if (e.key === 'Enter') { e.preventDefault(); items[paletteActive]?.click(); }
    else if (e.key === 'Escape') { closePalette(); }
  });
  $('palette-scrim').addEventListener('click', closePalette);

  // global keys
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('palette').hidden) return closePalette();
      if (!$('detail-sheet').hidden) return closeDetail();
      if ($('side-nav').classList.contains('open')) { closeMobileNav(); $('nav-toggle')?.focus(); return; }
      closeDialogViaEscape();
      closeMenu();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
      e.preventDefault(); focusSearch();
    }
  });

  onLanguageChange(() => {
    document.documentElement.lang = getLanguage();
    applyLanguageBadge();
    render();
  });
}

async function init() {
  initI18n();
  setLanguage(detectLanguage());
  document.documentElement.lang = getLanguage();

  const prefs = loadPrefs();
  state.theme = detectTheme(prefs);
  state.layout = prefs.layout === 'list' || prefs.layout === 'waterfall' ? prefs.layout : 'grid';
  state.sort = prefs.sort || 'dateDesc';
  state.view = ['overview', 'all', 'images', 'albums', 'recent', 'whitelist', 'blacklist'].includes(prefs.adminView) ? prefs.adminView : 'overview';
  state.albumId = typeof prefs.albumId === 'string' ? prefs.albumId : null;

  applyTheme();
  bindEvents();
  render();

  // session-expired message?
  try {
    if (sessionStorage.getItem('ti.session-expired')) {
      sessionStorage.removeItem('ti.session-expired');
      setTimeout(() => snackbar(t('sessionExpired'), { isError: true }), 300);
    }
  } catch (_) { /* ignore */ }

  try {
    const session = await checkSession();
    state.authEnabled = session.authEnabled !== false;
    if (!state.authEnabled) snackbar(t('authDisabledConsole'));
    await loadAlbums();
    await loadPage(true);
  } catch (err) {
    if (err instanceof AuthError) return handleSessionExpired();
    state.loadError = true; render();
  }
}

init();
