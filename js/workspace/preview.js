// Read-only text/code preview surface. Content always goes through
// textContent, so an untrusted file cannot inject markup into the page.
import { t } from '../i18n.js';
import { CATEGORY } from '../mime.js';
import { TEXT_PREVIEW_MAX } from './constants.js';
import { itemCategory } from './items.js';

let textPreviewSeq = 0;
// Set once by the workspace module: decides whether an in-flight preview
// load may still commit its result.
let previewCurrent = () => true;

export function setPreviewGuard(fn) {
  previewCurrent = fn;
}

/** Reads a local Blob/File as UTF-8 text; resolves null when it cannot. */
export function readFileText(blob) {
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
export function isTextPreviewable(item) {
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
export function previewTextSurface(item) {
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
    if (textPreviewSeq !== token || !previewCurrent(item)) return;
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
