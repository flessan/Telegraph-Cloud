import {
  h, clear, formatBytes, formatDate, fileCategory, fileIconHtml, iconHtml,
  linkSnippets, isNode,
} from '../util.js';
import { ct } from '../i18n.js';
import { copyButton } from './common.js';

const TEXT_PREVIEW_LIMIT = 1024 * 1024;

let activeInspector = null;

export function closeInspector() {
  if (activeInspector?._escClose) {
    document.removeEventListener('keydown', activeInspector._escClose);
  }
  activeInspector?.remove();
  activeInspector = null;
}

export function renderInspector(opts) {
  closeInspector();
  const {
    object, projectId, contentUrl, onDownload, onCopyLink, onStar,
    onRename, onMove, onTrash, onRestore, onDelete,
  } = opts;
  const category = fileCategory(object.content_type, object.name);
  const origin = window.location.origin;
  const snippets = linkSnippets({
    origin,
    projectId,
    bucket: object.bucket,
    key: object.key,
    contentType: object.content_type,
    name: object.name,
    category,
  });

  const drawer = h('aside', { class: 'c-inspector open', role: 'dialog', 'aria-modal': 'false', 'aria-label': ct('File details') });
  activeInspector = drawer;
  document.body.append(drawer);

  const head = h('div', { class: 'c-inspector-head' }, [
    h('h2', { class: 'c-inspector-title', style: { overflow: 'hidden', textOverflow: 'ellipsis' } }, object.name),
    h('div', { style: { display: 'flex', gap: '4px' } }, [
      actionIcon(onStar, object.flags?.starred ? ct('Remove star') : ct('Star'), iconHtml(object.flags?.starred ? 'star' : 'starOutline'), object.flags?.starred),
      actionIcon(() => { closeInspector(); }, ct('Close'), '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'),
    ]),
  ]);

  const body = h('div', { class: 'c-inspector-body' });
  drawer.append(head, body);

  const preview = h('div', { class: 'c-inspector-preview' }, [
    h('div', { class: 'c-loading' }, [h('span', { class: 'c-spinner' }), h('span', {}, ct('Preparing preview…'))]),
  ]);
  const actions = h('div', { class: 'c-inspector-actions' }, [
    h('button', { class: 'c-btn primary sm', onClick: onDownload }, ct('Download')),
    h('button', { class: 'c-btn outlined sm', onClick: onRename }, ct('Rename')),
    h('button', { class: 'c-btn outlined sm', onClick: onMove }, ct('Move')),
    object.flags?.trashed
      ? h('button', { class: 'c-btn outlined sm', onClick: onRestore }, ct('Restore'))
      : h('button', { class: 'c-btn outlined sm', onClick: onTrash }, ct('Move to trash')),
    h('button', {
      class: 'c-btn sm',
      style: { color: 'var(--c-danger)' },
      onClick: () => { closeInspector(); onDelete?.(); },
    }, object.flags?.trashed ? ct('Delete permanently') : ct('Delete')),
  ]);

  const metaRows = [
    [ct('Type'), categoryLabel(category)],
    [ct('Size'), formatBytes(object.size)],
    [ct('Content type'), object.content_type],
    ['ETag', object.etag],
    [ct('Version'), String(object.version)],
    [ct('Created'), formatDate(object.created_at)],
    [ct('Updated'), formatDate(object.updated_at)],
    [ct('Bucket'), object.bucket],
  ];
  const meta = h('dl', { class: 'c-meta-list' });
  for (const [term, value] of metaRows) {
    meta.append(h('dt', {}, term), h('dd', {}, isNode(value) ? value : h('code', {}, String(value))));
  }
  meta.append(h('dt', {}, ct('Object key')));
  meta.append(h('dd', {}, h('span', { class: 'c-copy-cell' }, [
    h('code', {}, object.key),
    copyButton(object.key, { label: '', message: ct('Object key copied') }),
  ])));
  const customMeta = Object.entries(object.metadata || {});
  if (customMeta.length) {
    meta.append(h('dt', {}, ct('Metadata')));
    meta.append(h('dd', {}, h('div', {}, customMeta.map(([key, value]) => h('div', {}, [h('code', {}, key), ' = ', h('code', {}, value)])))));
  }

  // Access model: one unlisted public direct link (trashing the object
  // revokes it), plus authenticated Object API / S3 URLs for clients.
  const access = h('div', { class: 'c-alert' }, [
    h('p', {}, [
      h('strong', {}, ct('Direct link · ')),
      ct('Anyone with this unlisted link can read the file. Moving the object to trash immediately revokes it; overwriting the key keeps the same link.'),
    ]),
    h('p', {}, ct('The Object API URL requires a Bearer API key with storage scopes; the S3 endpoint requires SigV4 credentials. Presigned URLs and per-file passwords are not available.')),
  ]);

  const snippetSection = h('div', { class: 'c-share-row', style: { gap: '8px' } });
  for (const snippet of snippets) {
    const label = snippetLabel(snippet.label);
    snippetSection.append(h('div', { class: 'c-snippet' }, [
      h('div', { class: 'c-snippet-head' }, [
        h('span', { class: 'c-snippet-label' }, label),
        copyButton(snippet.text, { message: ct('{label} copied', { label }) }),
      ]),
      h('pre', {}, snippet.text),
    ]));
  }

  body.append(preview, actions, access, meta, h('h3', { class: 'c-card-title', style: { margin: '16px 0 8px' } }, ct('Direct links & markup')), snippetSection);

  loadPreview(preview, category, object, contentUrl);

  function escClose(event) { if (event.key === 'Escape') { closeInspector(); event.stopPropagation(); } }
  drawer._escClose = escClose;
  document.addEventListener('keydown', escClose);
  setTimeout(() => drawer.querySelector('button')?.focus(), 40);
}

function actionIcon(onClick, label, iconHtmlValue, active = false) {
  return h('button', {
    type: 'button',
    class: `c-icon-button c-star-btn${active ? ' is-on' : ''}`,
    'aria-label': label,
    title: label,
    onClick,
    html: iconHtmlValue,
  });
}

function snippetLabel(label) {
  switch (label) {
    case 'Direct URL': return ct('Direct URL');
    case 'Markdown': return ct('Markdown');
    case 'HTML': return ct('HTML');
    case 'BBCode': return ct('BBCode');
    case 'CSS': return ct('CSS');
    case 'Object API URL': return ct('Object API URL');
    default: return label;
  }
}

function categoryLabel(category) {
  return {
    image: ct('Image'), video: ct('Video'), audio: ct('Audio'), pdf: ct('PDF document'),
    text: ct('Text'), code: ct('Code / data'), archive: ct('Archive'), unknown: ct('Generic file'),
    folder: ct('Folder'),
  }[category] || ct('File');
}

async function loadPreview(container, category, object, contentUrl) {
  clear(container);
  const url = contentUrl();
  try {
    if (category === 'image') {
      container.append(h('img', { src: url, alt: object.name, loading: 'lazy' }));
      return;
    }
    if (category === 'video') {
      container.append(h('video', { controls: true, preload: 'metadata', src: url }));
      return;
    }
    if (category === 'audio') {
      container.append(h('div', { style: { padding: '16px', textAlign: 'center' } }, [
        h('div', { class: `c-fileicon ${category}`, style: { marginBottom: '10px' }, html: fileIconHtml(object.content_type, object.name) }),
        h('audio', { controls: true, preload: 'metadata', src: url }),
      ]));
      return;
    }
    if (category === 'pdf') {
      container.append(h('iframe', { src: url, title: object.name, sandbox: '' }));
      return;
    }
    if (category === 'text' || category === 'code') {
      if (object.size > TEXT_PREVIEW_LIMIT) {
        container.append(previewFallback(object, category, ct('Text preview is limited to 1 MiB. Download to view the whole file.')));
        return;
      }
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const buffer = await res.arrayBuffer();
      const text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
      container.append(h('pre', { style: { width: '100%', maxHeight: '300px', overflow: 'auto', margin: 0, padding: '12px', fontSize: '11.5px', whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, text.replace(/\u0000/g, '')));
      return;
    }
    container.append(previewFallback(object, category, ct('This file type cannot be previewed in the browser.')));
  } catch (error) {
    clear(container);
    container.append(previewFallback(object, category, ct('Preview is unavailable. Download the file to view it.')));
  }
}

function previewFallback(object, category, note) {
  return h('div', { style: { textAlign: 'center', padding: '24px 16px' } }, [
    h('div', { class: `c-fileicon ${category}`, style: { marginBottom: '10px' }, html: fileIconHtml(object.content_type, object.name) }),
    h('p', { style: { margin: 0, fontSize: '12px', color: 'var(--c-text-3)', maxWidth: '240px' } }, note),
  ]);
}
