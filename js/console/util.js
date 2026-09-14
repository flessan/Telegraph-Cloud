// Shared console utilities: DOM construction, formatting, MIME-aware file
// classification, icons, and direct-link snippet generation.

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = String(value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'selected') {
      if (value) el.setAttribute(key, '');
      el[key] = !!value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
  appendChildren(el, children);
  return el;
}

// Duck-typed node check: works in browsers and in minimal DOM test harnesses
// that do not expose the Node constructor globally.
export function isNode(value) {
  return !!value && typeof value === 'object' && Number.isInteger(value.nodeType) && value.nodeType > 0;
}

export function appendChildren(el, children) {
  const list = Array.isArray(children) ? children : [children];
  for (const child of list) {
    if (child === null || child === undefined || child === false) continue;
    el.append(isNode(child) ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / (1024 ** exponent);
  const digits = exponent === 0 ? 0 : scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[exponent]}`;
}

export function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export function formatDateShort(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function timeAgo(value, now = Date.now()) {
  if (!value) return '—';
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) return '—';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return formatDateShort(value);
}

const EXT_CATEGORY = {
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp', 'ico', 'tiff', 'tif', 'heic', 'heif'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi', 'm4v', 'ogv'],
  audio: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'wma', 'opus'],
  pdf: ['pdf'],
  text: ['txt', 'log', 'md', 'markdown', 'csv', 'rtf'],
  code: ['json', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'html', 'htm', 'css', 'xml', 'yml', 'yaml', 'toml', 'ini', 'sh', 'sql', 'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'php', 'env'],
  archive: ['zip', 'tar', 'gz', 'tgz', 'bz2', '7z', 'rar', 'xz'],
};

export function fileCategory(contentType, name = '') {
  const mime = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('text/')) return 'text';
  if (['application/json', 'application/xml', 'application/javascript'].includes(mime)) return 'code';
  if (['application/zip', 'application/x-tar', 'application/gzip', 'application/x-7z-compressed', 'application/x-rar-compressed'].includes(mime)) return 'archive';
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  for (const [category, exts] of Object.entries(EXT_CATEGORY)) {
    if (exts.includes(ext)) return category;
  }
  return 'unknown';
}

export function extensionOf(name) {
  const i = String(name || '').lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function baseName(key) {
  const parts = String(key || '').split('/');
  return parts[parts.length - 1] || key;
}

// Previewable through the browser directly (sandboxed by the proxy's CSP).
export function previewKind(category) {
  if (['image', 'video', 'audio', 'pdf', 'text', 'code'].includes(category)) return category;
  return 'unsupported';
}

const ICONS = {
  folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h3.1l1.8 1.8h7.7A2.2 2.2 0 0 1 20.5 10v7.3a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/></svg>',
  image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M3.8 16.5l4.4-4.2 3.1 3 2.4-2.3 6.3 5.3"/></svg>',
  video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/></svg>',
  audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6l10-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h1.5a1.5 1.5 0 0 1 0 3H9zM9 13v6"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6M9 9h1"/></svg>',
  code: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 9l-4 3 4 3M16 9l4 3-4 3M13.5 6l-3 12"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M10 8h1M10 12h1M10 16h1M13 8h1M13 12h1M13 16h1"/></svg>',
  unknown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  star: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8 6.9 19.5l1-5.7-4.1-4 5.7-.8z"/></svg>',
  starOutline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M12 3.8l2.5 5.2 5.7.8-4.1 4 1 5.7L12 16.8 6.9 19.5l1-5.7-4.1-4 5.7-.8z"/></svg>',
};

export function iconHtml(name) {
  return ICONS[name] || ICONS.unknown;
}

export function fileIconHtml(contentType, name) {
  return ICONS[fileCategory(contentType, name)] || ICONS.unknown;
}

// Direct-link snippets. Markup is generated from the real category: never an
// <img> tag for a non-image object.
export function encodeKeyForUrl(key) {
  return String(key).split('/').map(encodeURIComponent).join('/');
}

export function objectUrls({ origin, projectId, bucket, key }) {
  const keyPath = encodeKeyForUrl(key);
  // Public, unlisted direct link served by functions/p (GET/HEAD only; the
  // link stops resolving once the object is trashed).
  const direct = `${origin}/p/${encodeURIComponent(projectId)}/${encodeURIComponent(bucket)}/${keyPath}`;
  // Authenticated developer surfaces (Bearer key / SigV4 signature).
  const s3 = `${origin}/s3/${encodeURIComponent(bucket)}/${keyPath}`;
  const api = `${origin}/api/storage/${encodeURIComponent(bucket)}/${keyPath}`;
  return { direct, s3, api };
}

export function linkSnippets({ origin, projectId, bucket, key, contentType, name, category }) {
  const { direct, api } = objectUrls({ origin, projectId, bucket, key });
  const url = direct;
  const safeAlt = esc(baseName(name || key).replace(/[<>"]/g, ''));
  const snippets = [
    { id: 'url', label: 'Direct URL', text: url },
  ];
  if (category === 'image') {
    snippets.push({ id: 'md', label: 'Markdown', text: `![${safeAlt}](${url})` });
    snippets.push({ id: 'html', label: 'HTML', text: `<img src="${url}" alt="${safeAlt}">` });
    snippets.push({ id: 'bbcode', label: 'BBCode', text: `[img]${url}[/img]` });
    snippets.push({ id: 'css', label: 'CSS', text: `background-image: url("${url}");` });
  } else if (category === 'audio') {
    snippets.push({ id: 'html', label: 'HTML', text: `<audio controls src="${url}"></audio>` });
    snippets.push({ id: 'md', label: 'Markdown', text: `[${safeAlt}](${url})` });
  } else if (category === 'video') {
    snippets.push({ id: 'html', label: 'HTML', text: `<video controls src="${url}"></video>` });
    snippets.push({ id: 'md', label: 'Markdown', text: `[${safeAlt}](${url})` });
  } else {
    snippets.push({ id: 'md', label: 'Markdown', text: `[${safeAlt}](${url})` });
    snippets.push({ id: 'html', label: 'HTML', text: `<a href="${url}">${safeAlt}</a>` });
  }
  snippets.push({ id: 'api', label: 'Object API URL', text: api });
  return snippets;
}

export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall through to legacy path */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

export function initials(name) {
  const cleaned = String(name || '?').trim();
  return (cleaned.slice(0, 1) || 'P').toUpperCase();
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}
