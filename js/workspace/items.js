// Item model helpers and pure formatters. No workspace state is touched
// here, so this module stays easy to reason about and unit test.
import { getLanguage, t } from '../i18n.js';
import { CATEGORY, categorize, categoryLabelKey } from '../mime.js';

export function uid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function toRecord(item) {
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
/**
 * Semantic category of a staged/synced object. `File.type` is authoritative
 * locally; the filename is only consulted when no MIME type was reported.
 */

export function itemCategory(item) {
  if (!item) return CATEGORY.FILE;
  if (!item._category) item._category = categorize({ mime: item.type, name: item.name });
  return item._category;
}

export function isImage(item) {
  return itemCategory(item) === CATEGORY.IMAGE;
}

export function extOf(name) {
  const parts = String(name || '').split('.');
  return parts.length > 1 ? parts.pop().toUpperCase().slice(0, 5) : 'FILE';
}
/**
 * A short, translated, human-friendly label for an object's kind, e.g.
 * "Image", "PDF document", "Archive". Falls back to "File" for anything
 * unrecognised. Used for the grid card meta line and the list "Type" column.
 */

export function itemTypeLabel(item) {
  if (!item) return t('unknownType');
  return t(categoryLabelKey(itemCategory(item)));
}
/** A slightly richer description used as hover detail for a file node. */

export function itemTypeDetail(item) {
  if (!item) return '';
  return item.type || String(itemTypeLabel(item));
}

export function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return t('bytes', { n });
  if (n < 1024 * 1024) return t('kb', { n: (n / 1024).toFixed(n < 10 * 1024 ? 1 : 0) });
  if (n < 1024 * 1024 * 1024) return t('mb', { n: (n / 1024 / 1024).toFixed(2) });
  return t('gb', { n: (n / 1024 / 1024 / 1024).toFixed(2) });
}

export function formatWhen(ts) {
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

export function statusLabel(status) {
  if (status === 'pending') return t('statusPending');
  if (status === 'pushing') return t('statusPushing');
  if (status === 'synced') return t('statusSynced');
  if (status === 'failed') return t('statusFailed');
  return t('statusLocal');
}

export function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return t('durationSeconds', { n: seconds });
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) {
    return rest ? t('durationMinutesSeconds', { m: minutes, s: rest }) : t('durationMinutes', { n: minutes });
  }
  return t('durationMinutes', { n: minutes });
}

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
