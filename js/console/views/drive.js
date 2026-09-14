import {
  h, clear, $, $$, formatBytes, formatDate, timeAgo, fileCategory, fileIconHtml,
  iconHtml, baseName, extensionOf, debounce, copyText, linkSnippets, objectUrls,
} from '../util.js';
import { api, driveObjectsUrl, AuthError } from '../api.js';
import {
  pageHead, toast, contextMenu, confirmDialog, emptyState, loadingView,
} from '../ui.js';
import { projectById } from '../store.js';
import { ct } from '../i18n.js';

import { renderMoveDialog, renderNewFolderDialog, bindDriveProject } from './drive-dialogs.js';
import { renderUploadQueue, uploadFiles } from './drive-upload.js';
import { renderInspector } from './drive-inspector.js';

const SORTS = [
  { id: 'name:asc', message: 'Name A–Z' },
  { id: 'name:desc', message: 'Name Z–A' },
  { id: 'updated:desc', message: 'Modified (newest)' },
  { id: 'updated:asc', message: 'Modified (oldest)' },
  { id: 'size:desc', message: 'Size (largest)' },
  { id: 'size:asc', message: 'Size (smallest)' },
];

const FOLDER_MOVE_LIMIT = 500;

function folderIcon() { return iconHtml('folder'); }

function sanitizeSegments(relativePath) {
  return String(relativePath)
    .split('/')
    .map((segment) => segment.normalize('NFC').replace(/[\\/]+/g, '_').replace(/[\x00-\x1f]/g, '').trim())
    .filter(Boolean)
    .join('/');
}

export async function renderDrive(container, projectId, query) {
  const project = projectById(projectId);
  if (!project) { window.location.hash = '#/overview'; return; }
  bindDriveProject(projectId);

  const prefs = JSON.parse(localStorage.getItem('tc.drive') || '{}');
  const view = {
    projectId,
    buckets: [],
    bucket: query.get('bucket') || prefs.bucket || null,
    path: [], // folder segments inside the bucket
    mode: query.get('view') === 'starred' ? 'starred' : query.get('view') === 'trash' ? 'trash' : 'folder',
    search: '',
    folders: [],
    objects: [],
    cursor: null,
    hasMore: false,
    truncated: false,
    loading: false,
    layout: prefs.layout || 'list',
    sort: prefs.sort || 'name:asc',
    selected: new Set(), // entries prefixed o: / f:
    uploads: [],
  };

  function savePrefs() {
    try {
      localStorage.setItem('tc.drive', JSON.stringify({
        bucket: view.bucket, layout: view.layout, sort: view.sort,
      }));
    } catch (_) { /* private mode */ }
  }

  const root = h('div', { class: 'c-drive' });
  container.append(
    pageHead(ct('Drive'), ct('Upload, organize, and preview any file. Drive, the object API, and the S3 endpoint show the same objects.'), [
      h('button', { class: 'c-btn outlined', id: 'c-drive-trash', onClick: () => setMode(view.mode === 'trash' ? 'folder' : 'trash') }, ct('Trash')),
      h('button', { class: 'c-btn outlined', id: 'c-drive-starred', onClick: () => setMode(view.mode === 'starred' ? 'folder' : 'starred') }, ct('Starred')),
    ]),
  );
  container.append(root);

  const toolbar = h('div', { class: 'c-drive-toolbar' });
  const content = h('div', {});
  const bulkBar = h('div', { class: 'c-bulkbar', hidden: true });
  root.append(toolbar, bulkBar, content);

  const queuePanel = renderUploadQueue({
    getTarget: () => ({ projectId, bucket: view.bucket, prefix: currentPrefix() }),
    onUploaded: () => refresh(),
  });
  document.body.append(queuePanel.panel);
  // Queue cleans itself when empty; remove on navigation via cleanup marker.
  container._viewCleanup = () => queuePanel.panel.remove();

  function currentPrefix() {
    return view.path.length ? `${view.path.join('/')}/` : '';
  }

  function sortEntries(entries) {
    const [field, dir] = view.sort.split(':');
    const factor = dir === 'asc' ? 1 : -1;
    return entries.slice().sort((a, b) => {
      let result;
      if (field === 'name') result = a.name.localeCompare(b.name);
      else if (field === 'size') result = (a.size || 0) - (b.size || 0);
      else result = new Date(a.updated_at || 0) - new Date(b.updated_at || 0);
      return result * factor;
    });
  }

  function renderToolbar() {
    clear(toolbar);
    // Bucket tabs
    const bucketTabs = h('div', { class: 'c-bucket-tabs', 'aria-label': ct('Buckets') });
    for (const bucket of view.buckets) {
      bucketTabs.append(h('button', {
        type: 'button',
        class: 'c-bucket-tab',
        ...(bucket.bucket === view.bucket ? { 'aria-pressed': 'true' } : {}),
        onClick: () => selectBucket(bucket.bucket),
      }, [
        h('span', { 'aria-hidden': 'true', html: folderIcon() }),
        h('span', {}, bucket.bucket),
      ]));
    }
    bucketTabs.append(h('button', {
      type: 'button',
      class: 'c-bucket-tab',
      'aria-label': ct('New bucket'),
      title: ct('New bucket'),
      onClick: newBucketDialog,
    }, [h('span', { html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>' }), h('span', {}, ct('New'))]));
    toolbar.append(bucketTabs);

    toolbar.append(h('div', { class: 'c-toolbar-spacer' }));

    if (view.bucket) {
      const searchBox = h('div', { class: 'c-search' }, [
        h('span', { 'aria-hidden': 'true', html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="6.25"/><path d="M16 16l4 4"/></svg>' }),
        h('input', {
          type: 'search', placeholder: ct('Search this bucket…'), 'aria-label': ct('Search objects by key'),
          value: view.search, autocomplete: 'off', spellcheck: 'false',
          oninput: debounce((event) => { view.search = event.target.value; refresh(); }, 300),
        }),
      ]);
      toolbar.append(searchBox);

      toolbar.append(h('button', {
        class: 'c-btn outlined sm c-hide-mobile',
        onClick: () => renderNewFolderDialog({ bucket: view.bucket, prefix: currentPrefix() }).then((created) => {
          if (created) { toast(ct('Folder created'), { kind: 'success' }); refresh(); }
        }),
      }, [h('span', { html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h3.1l1.8 1.8h7.7A2.2 2.2 0 0 1 20.5 10v7.3a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/><path d="M12 11v5M9.5 13.5h5"/></svg>' }), ct('Folder')]));

      toolbar.append(h('button', {
        class: 'c-btn primary sm', id: 'c-upload-btn',
        onClick: (event) => {
          import('../ui.js').then(({ popupMenu }) => {
            popupMenu(event.currentTarget, [
              { title: ct('Upload files'), icon: menuIcon.upload, onClick: () => $('#c-file-input')?.click() },
              {
                title: ct('Upload folder'), icon: menuIcon.folder,
                onClick: () => $('#c-folder-input')?.click(),
              },
            ]);
          });
        },
      }, [h('span', { html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 16V4.5m0 0L7.4 9M12 4.5L16.6 9M5 16.5v2.2A1.8 1.8 0 0 0 6.8 20.5h10.4a1.8 1.8 0 0 0 1.8-1.8v-2.2"/></svg>' }), ct('Upload')]));

      const segmented = h('div', { class: 'c-segmented', role: 'group', 'aria-label': ct('View mode') });
      for (const [mode, icon, label] of [
        ['list', '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8 7h12M8 12h12M8 17h12M4.2 7h.01M4.2 12h.01M4.2 17h.01"/></svg>', ct('List view')],
        ['grid', '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="4" y="4" width="7" height="7" rx="1.4"/><rect x="13" y="4" width="7" height="7" rx="1.4"/><rect x="4" y="13" width="7" height="7" rx="1.4"/><rect x="13" y="13" width="7" height="7" rx="1.4"/></svg>', ct('Grid view')],
      ]) {
        segmented.append(h('button', {
          type: 'button', 'aria-label': label, title: label,
          ...(view.layout === mode ? { 'aria-pressed': 'true' } : {}),
          onClick: () => { view.layout = mode; savePrefs(); renderAll(); },
          html: icon,
        }));
      }
      toolbar.append(segmented);

      const sortSelect = h('select', {
        class: 'c-select', 'aria-label': ct('Sort by'),
        style: { width: 'auto', padding: '7px 10px', fontSize: '12.5px' },
        onchange: (event) => { view.sort = event.target.value; savePrefs(); renderContent(); },
      }, SORTS.map((sort) => h('option', { value: sort.id, ...(view.sort === sort.id ? { selected: true } : {}) }, ct(sort.message))));
      toolbar.append(sortSelect);
    }
  }

  function renderCrumbs() {
    const crumbs = h('nav', { class: 'c-crumbs', 'aria-label': ct('Location') });
    crumbs.append(h('button', {
      type: 'button', class: 'c-crumb',
      ...(view.mode === 'folder' && view.path.length === 0 ? { 'aria-current': 'page' } : {}),
      onClick: () => { view.path = []; setMode('folder'); },
    }, view.bucket || ct('Drive')));
    if (view.mode === 'starred') {
      crumbs.append(sep(), h('span', { class: 'c-crumb', 'aria-current': 'page' }, ct('Starred')));
    } else if (view.mode === 'trash') {
      crumbs.append(sep(), h('span', { class: 'c-crumb', 'aria-current': 'page' }, ct('Trash')));
    } else if (view.search) {
      crumbs.append(sep(), h('span', { class: 'c-crumb', 'aria-current': 'page' }, ct('Search: “{query}”', { query: view.search })));
    } else {
      view.path.forEach((segment, index) => {
        crumbs.append(sep());
        const last = index === view.path.length - 1;
        crumbs.append(h('button', {
          type: 'button', class: 'c-crumb',
          ...(last ? { 'aria-current': 'page' } : {}),
          onClick: () => { view.path = view.path.slice(0, index + 1); refresh(); },
        }, segment));
      });
    }
    return crumbs;
  }

  function sep() { return h('span', { class: 'c-crumb-sep', 'aria-hidden': 'true' }, '/'); }

  function renderBulkBar() {
    const count = view.selected.size;
    bulkBar.hidden = count === 0;
    if (!count) return;
    clear(bulkBar);
    const objects = selectedObjects();
    const folders = selectedFolders();
    bulkBar.append(h('span', {}, ct('{n} selected', { n: count })), h('span', { class: 'c-bulk-spacer' }));
    const actions = h('div', { class: 'c-actions' });
    if (view.mode === 'trash') {
      actions.append(
        bulkAction(ct('Restore'), () => bulkFlag({ trashed: false }), objects),
        bulkAction(ct('Delete permanently'), () => bulkDeleteForever(objects), objects, true),
      );
    } else {
      actions.append(
        bulkAction(ct('Move to trash'), () => bulkFlag({ trashed: true }), objects),
        h('button', { class: 'c-btn sm outlined', disabled: !folders.length && !objects.length, onClick: () => bulkMove(objects, folders) }, ct('Move')),
        h('button', { class: 'c-btn sm outlined', disabled: !objects.length, onClick: () => bulkDownload(objects) }, ct('Download')),
        objects.length === 1 ? h('button', { class: 'c-btn sm outlined', onClick: () => copyDirectLink(objects[0]) }, ct('Copy link')) : null,
      );
    }
    actions.append(h('button', { class: 'c-btn sm text', onClick: () => { view.selected.clear(); renderAll(); } }, ct('Clear')));
    bulkBar.append(actions);
  }

  function bulkAction(label, fn, items, danger = false) {
    return h('button', {
      class: `c-btn sm ${danger ? 'danger' : 'outlined'}`,
      disabled: !items.length,
      onClick: fn,
    }, label);
  }

  function renderContent() {
    clear(content);
    renderBulkBar();
    if (!view.bucket) {
      content.append(emptyState({
        icon: 'folder',
        title: view.buckets.length ? ct('Choose a bucket') : ct('No buckets yet'),
        body: ct('A bucket is the top-level Drive container, exactly like an S3 bucket. Create one to start uploading files.'),
        actions: [h('button', { class: 'c-btn primary', onClick: newBucketDialog }, ct('New bucket'))],
      }));
      return;
    }

    const crumbRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, [
      renderCrumbs(),
      h('span', { class: 'c-toolbar-spacer' }),
      view.truncated ? h('span', { class: 'c-badge', title: ct('Results are bounded for performance') }, ct('Results limited')) : null,
    ]);
    content.append(crumbRow);

    if (view.loading) { content.append(loadingView(ct('Loading objects…'))); return; }

    const folders = sortEntries(view.folders.map((folder) => ({
      ...folder, kind: 'folder', bucket: view.bucket, name: folder.name || baseName(folder.prefix.endsWith('/') ? folder.prefix.slice(0, -1) : folder.prefix),
    })));
    const objects = sortEntries(view.objects).filter((object) => view.mode === 'trash' ? object.flags?.trashed : !object.flags?.trashed || view.mode === 'starred');
    if (!folders.length && !objects.length) {
      const empty = view.mode === 'trash'
        ? { icon: 'folder', title: ct('Trash is empty'), body: ct('Items moved to trash appear here. They can be restored or deleted permanently.') }
        : view.mode === 'starred'
          ? { icon: 'folder', title: ct('No starred items'), body: ct('Star files to pin them here.') }
          : view.search
            ? { icon: 'folder', title: ct('No matching objects'), body: ct('No keys in this bucket match “{query}”. Search covers object keys and file names within the first 1,000 scanned objects.', { query: view.search }) }
            : {
                icon: 'folder',
                title: currentPrefix() ? ct('This folder is empty') : ct('This bucket is empty'),
                body: ct('Drag files here or use Upload. Empty folders and uploaded objects appear immediately.'),
                actions: [
                  h('button', { class: 'c-btn primary', onClick: () => $('#c-file-input').click() }, ct('Upload files')),
                  h('button', { class: 'c-btn outlined', onClick: () => renderNewFolderDialog({ bucket: view.bucket, prefix: currentPrefix() }).then((r) => r && refresh()) }, ct('New folder')),
                ],
              };
      content.append(emptyState(empty));
      return;
    }

    if (view.layout === 'grid') content.append(renderGrid(folders, objects));
    else content.append(renderList(folders, objects));

    if (view.hasMore) {
      content.append(h('div', { class: 'c-pager' }, [
        h('button', { class: 'c-btn outlined sm', onClick: loadMore }, ct('Load more')),
        h('span', {}, ct('Results are paginated by object key')),
      ]));
    }
  }

  function renderGrid(folders, objects) {
    const grid = h('div', { class: 'c-drive-grid', role: 'list' });
    for (const folder of folders) grid.append(folderTile(folder));
    for (const object of objects) grid.append(objectTile(object));
    return grid;
  }

  function renderList(folders, objects) {
    const wrap = h('div', { class: 'c-drive-list' });
    wrap.append(h('div', { class: 'c-drive-row-head', 'aria-hidden': 'true' }, [
      h('div', {}), h('div', {}),
      h('div', {}, ct('Name')),
      h('div', { class: 'c-col-type' }, ct('Type')),
      h('div', { style: { textAlign: 'right' } }, ct('Size')),
      h('div', { class: 'c-col-modified-hide' }, ct('Modified')),
      h('div', {}),
    ]));
    for (const folder of folders) wrap.append(folderRow(folder));
    for (const object of objects) wrap.append(objectRow(object));
    return wrap;
  }

  // ----- rows / tiles -----
  // Encoded token so object keys that legitimately contain ':' stay unique.
  const objectToken = (bucket, key) => `object:${bucket}:${encodeURIComponent(key)}`;
  const folderToken = (bucket, prefix) => `folder:${bucket}:${encodeURIComponent(prefix)}`;
  function selectKey(entry) {
    return entry.kind === 'folder' || entry.prefix
      ? folderToken(entry.bucket || view.bucket, entry.prefix)
      : objectToken(entry.bucket || view.bucket, entry.key);
  }

  function checkboxFor(entry) {
    const key = selectKey(entry);
    return h('input', {
      type: 'checkbox', class: 'c-row-check', 'aria-label': ct('Select {name}', { name: entry.name }),
      ...(view.selected.has(key) ? { checked: true } : {}),
      onclick: (event) => {
        event.stopPropagation();
        if (event.target.checked) view.selected.add(key); else view.selected.delete(key);
        renderBulkBar();
        syncSelectionStyles();
      },
    });
  }

  function syncSelectionStyles() {
    $$('.c-drive-row, .c-tile', content).forEach((el) => {
      const key = el.dataset.key;
      el.classList.toggle('is-selected', view.selected.has(key));
      const cb = el.querySelector('input[type=checkbox]');
      if (cb) cb.checked = view.selected.has(key);
    });
  }

  function openEntry(entry) {
    if (entry.kind === 'folder' || entry.prefix) {
      const name = (entry.name || baseName(entry.prefix.endsWith('/') ? entry.prefix.slice(0, -1) : entry.prefix));
      view.path = entry.prefix.slice(0, -1).split('/');
      view.search = '';
      if (view.mode !== 'folder') view.mode = 'folder';
      view.selected.clear();
      refresh();
    } else {
      openInspector(entry);
    }
  }

  function folderRow(folder) {
    const key = selectKey(folder);
    const row = h('div', {
      class: 'c-drive-row folder',
      role: 'listitem',
      tabindex: '0',
      dataset: { key },
      ...(view.selected.has(key) ? { class: 'c-drive-row folder is-selected' } : {}),
      onclick: (event) => {
        if (event.detail === 1 && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          view.selected.clear(); view.selected.add(key); renderAll();
        }
        if (event.detail === 2) openEntry(folder);
      },
      ondblclick: () => openEntry(folder),
      onkeydown: rowKeydown(folder),
      oncontextmenu: (event) => { event.preventDefault(); folderContextMenu(event, folder); },
    }, [
      checkboxFor(folder),
      h('span', { class: 'c-row-icon c-fileicon folder', html: folderIcon() }),
      h('span', { class: 'c-row-name' }, [h('span', { class: 'c-row-label' }, folder.name)]),
      h('span', { class: 'c-row-meta c-col-type' }, ct('Folder')),
      h('span', { class: 'num' }, '—'),
      h('span', { class: 'c-row-meta c-col-modified-hide' }, folder.created_at ? formatDate(folder.created_at) : '—'),
      h('span', {}),
    ]);
    return row;
  }

  function objectRow(object) {
    const key = selectKey(object);
    const category = fileCategory(object.content_type, object.name);
    const starred = !!object.flags?.starred;
    const trashed = !!object.flags?.trashed;
    const row = h('div', {
      class: `c-drive-row${trashed ? ' is-trashed' : ''}`,
      role: 'listitem',
      tabindex: '0',
      dataset: { key },
      ...(view.selected.has(key) ? { class: `c-drive-row${trashed ? ' is-trashed' : ''} is-selected` } : {}),
      onclick: (event) => {
        if (event.ctrlKey || event.metaKey) {
          toggleSelected(key);
        } else if (event.shiftKey) {
          rangeSelect(key);
        } else if (event.detail === 1) {
          view.selected.clear(); view.selected.add(key); renderAll();
        }
        if (event.detail === 2) openInspector(object);
      },
      onkeydown: rowKeydown(object),
      oncontextmenu: (event) => { event.preventDefault(); objectContextMenu(event, object); },
    }, [
      checkboxFor(object),
      h('span', { class: `c-row-icon c-fileicon ${category}`, html: fileIconHtml(object.content_type, object.name) }),
      h('span', { class: 'c-row-name' }, [
        h('span', { class: 'c-row-label' }, object.name),
        trashed ? h('span', { class: 'c-badge revoked', style: { marginLeft: '8px' } }, ct('Trashed')) : null,
      ]),
      h('span', { class: 'c-row-meta c-col-type' }, typeLabel(object, category)),
      h('span', { class: 'num' }, formatBytes(object.size)),
      h('span', { class: 'c-row-meta c-col-modified-hide' }, timeAgo(object.updated_at)),
      h('span', { style: { display: 'flex', justifyContent: 'flex-end' } }, [
        h('button', {
          class: `c-icon-button c-star-btn${starred ? ' is-on' : ''}`,
          'aria-label': starred ? ct('Remove star') : ct('Star'),
          title: starred ? ct('Remove star') : ct('Star'),
          onclick: (event) => { event.stopPropagation(); toggleStar(object); },
          html: iconHtml(starred ? 'star' : 'starOutline'),
        }),
      ]),
    ]);
    return row;
  }

  function folderTile(folder) {
    const key = selectKey(folder);
    return h('button', {
      type: 'button',
      class: `c-tile c-tile-folder${view.selected.has(key) ? ' is-selected' : ''}`,
      role: 'listitem',
      dataset: { key },
      onclick: () => openEntry(folder),
      oncontextmenu: (event) => { event.preventDefault(); event.stopPropagation(); folderContextMenu(event, folder); },
    }, [
      h('span', { class: 'c-tile-thumb', html: folderIcon() }),
      h('span', { class: 'c-tile-body' }, [
        h('span', { class: 'c-tile-name', title: folder.name }, folder.name),
        h('span', { class: 'c-tile-meta' }, ct('Folder')),
      ]),
    ]);
  }

  function objectTile(object) {
    const key = selectKey(object);
    const category = fileCategory(object.content_type, object.name);
    const starred = !!object.flags?.starred;
    const thumb = category === 'image'
      ? h('img', { loading: 'lazy', alt: '', src: contentUrl(object) })
      : h('span', { class: `c-fileicon ${category}`, html: fileIconHtml(object.content_type, object.name) });
    return h('button', {
      type: 'button',
      class: `c-tile${object.flags?.trashed ? ' is-trashed' : ''}${view.selected.has(key) ? ' is-selected' : ''}`,
      role: 'listitem',
      dataset: { key },
      onclick: (event) => {
        if (event.ctrlKey || event.metaKey) { toggleSelected(key); return; }
        if (event.detail === 1 && !view.selected.size) { /* let dblclick open */ }
        openEntry(object);
      },
      oncontextmenu: (event) => { event.preventDefault(); objectContextMenu(event, object); },
    }, [
      starred ? h('span', { class: 'c-tile-mark', html: iconHtml('star') }) : null,
      h('span', { class: 'c-tile-thumb' }, [thumb]),
      h('span', { class: 'c-tile-body' }, [
        h('span', { class: 'c-tile-name', title: object.name }, object.name),
        h('span', { class: 'c-tile-meta' }, `${typeLabel(object, category)} · ${formatBytes(object.size)}`),
      ]),
    ]);
  }

  function typeLabel(object, category) {
    const fallback = {
      image: ct('image'), video: ct('video'), audio: ct('audio'),
      pdf: 'PDF', archive: ct('archive'), code: ct('text'), text: ct('text'),
    }[category] || ct('file');
    return (extensionOf(object.name) || fallback).toUpperCase();
  }

  function rowKeydown(entry) {
    return (event) => {
      const rows = $$('.c-drive-row', content);
      const index = rows.indexOf(event.currentTarget);
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openEntry(entry); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); rows[Math.min(index + 1, rows.length - 1)]?.focus(); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); rows[Math.max(index - 1, 0)]?.focus(); }
      else if (event.key === 'ArrowRight' && (entry.kind === 'folder')) { event.preventDefault(); openEntry(entry); }
      else if (event.key === 'Delete') { event.preventDefault(); if (view.mode !== 'trash') trashObject(entry); }
      else if ((event.ctrlKey || event.metaKey) && event.key === 'a') { event.preventDefault(); selectAll(); }
    };
  }

  // ----- selection helpers -----
  function toggleSelected(key) {
    if (view.selected.has(key)) view.selected.delete(key); else view.selected.add(key);
    renderAll();
  }
  function rangeSelect(key) {
    const all = $$('.c-drive-row, .c-tile', content).map((el) => el.dataset.key);
    const anchor = [...view.selected].pop();
    const start = all.indexOf(anchor);
    const end = all.indexOf(key);
    if (start === -1 || end === -1) { view.selected.add(key); }
    else {
      for (const k of all.slice(Math.min(start, end), Math.max(start, end) + 1)) view.selected.add(k);
    }
    renderAll();
  }
  function selectAll() {
    $$('.c-drive-row, .c-tile', content).forEach((el) => view.selected.add(el.dataset.key));
    renderAll();
  }
  function selectedObjects() {
    return view.objects.filter((o) => view.selected.has(objectToken(o.bucket, o.key)));
  }
  function selectedFolders() {
    return view.folders.filter((f) => view.selected.has(folderToken(view.bucket, f.prefix)));
  }

  // ----- data loading -----
  async function loadBuckets() {
    const page = await api.get(`/api/projects/${encodeURIComponent(projectId)}/drive/buckets?limit=100`);
    view.buckets = page.data || [];
    if (!view.bucket || !view.buckets.some((b) => b.bucket === view.bucket)) {
      view.bucket = view.buckets[0]?.bucket || null;
      view.path = [];
    }
    savePrefs();
  }

  async function refresh() {
    view.loading = true;
    renderContent();
    const params = new URLSearchParams({ bucket: view.bucket || '', limit: '100' });
    const prefix = view.mode === 'folder' ? currentPrefix() : '';
    if (prefix) params.set('prefix', prefix);
    if (view.mode === 'trash') params.set('view', 'trash');
    if (view.mode === 'starred') params.set('view', 'starred');
    if (view.search) params.set('search', view.search);
    try {
      const page = await api.get(`/api/projects/${encodeURIComponent(projectId)}/drive/objects?${params}`);
      view.folders = page.folders || [];
      view.objects = page.objects || [];
      view.cursor = page.next_cursor || null;
      view.hasMore = !!page.next_cursor;
      view.truncated = !!page.truncated;
    } finally {
      view.loading = false;
    }
    renderAll();
  }

  async function loadMore() {
    if (!view.cursor) return;
    const params = new URLSearchParams({ bucket: view.bucket, prefix: currentPrefix(), limit: '100', cursor: view.cursor });
    const page = await api.get(`/api/projects/${encodeURIComponent(projectId)}/drive/objects?${params}`);
    view.objects = view.objects.concat(page.objects || []);
    view.cursor = page.next_cursor || null;
    view.hasMore = !!page.next_cursor;
    renderAll();
  }

  function renderAll() { renderToolbar(); renderContent(); updateModeButtons(); }
  function updateModeButtons() {
    const trash = $('#c-drive-trash');
    const star = $('#c-drive-starred');
    if (trash) trash.textContent = view.mode === 'trash' ? ct('Back to Drive') : ct('Trash');
    if (star) star.textContent = view.mode === 'starred' ? ct('Back to Drive') : ct('Starred');
  }

  async function selectBucket(name) {
    view.bucket = name; view.path = []; view.selected.clear(); view.search = ''; view.mode = 'folder';
    savePrefs();
    refresh();
  }
  function setMode(mode) {
    view.mode = mode; view.path = []; view.selected.clear(); view.search = '';
    refresh();
  }

  // ----- operations -----
  async function newBucketDialog() {
    const name = await import('./drive-dialogs.js').then((m) => m.renderNewBucketDialog(view.buckets));
    if (!name) return;
    try {
      await api.post(`/api/projects/${encodeURIComponent(projectId)}/drive/buckets`, { name });
      view.bucket = name;
      toast(ct('Bucket “{name}” ready', { name }), { kind: 'success' });
      renderToolbar();
      refresh();
    } catch (error) {
      toast(humanError(error.code, ct('Bucket could not be created')), { kind: 'error' });
    }
  }

  async function toggleStar(object) {
    const next = !object.flags?.starred;
    try {
      await api.patch(`/api/projects/${encodeURIComponent(projectId)}/drive/flags`, {
        bucket: object.bucket, key: object.key, starred: next,
      });
      object.flags = { ...(object.flags || {}), starred: next };
      renderAll();
    } catch (error) { toast(humanError(error.code), { kind: 'error' }); }
  }

  async function setTrash(object, trashed) {
    try {
      await api.patch(`/api/projects/${encodeURIComponent(projectId)}/drive/flags`, {
        bucket: object.bucket, key: object.key, trashed,
      });
      view.selected.clear();
      toast(trashed ? ct('Moved to trash') : ct('Restored'));
      refresh();
    } catch (error) { toast(humanError(error.code), { kind: 'error' }); }
  }
  const trashObject = (object) => setTrash(object, true);

  async function deleteForever(objectsList) {
    const ok = await confirmDialog({
      title: objectsList.length === 1 ? ct('Delete this object permanently?') : ct('Delete {n} objects permanently?', { n: objectsList.length }),
      body: ct('The objects are tombstoned in the object index. This cannot be undone from the console. Telegram journal history is retained by the storage provider.'),
      confirmLabel: ct('Delete permanently'),
      danger: true,
    });
    if (!ok) return;
    let failed = 0;
    for (const object of objectsList) {
      try {
        await api.del(driveObjectsUrl(projectId, { bucket: object.bucket, key: object.key }));
      } catch (_) { failed += 1; }
    }
    toast(failed ? ct('{n} deletions failed', { n: failed }) : ct('Deleted permanently'), failed ? { kind: 'error' } : { kind: 'success' });
    view.selected.clear();
    refresh();
  }

  async function bulkFlag(patch) {
    const objects = selectedObjects();
    if (!objects.length) return;
    try {
      await api.patch(`/api/projects/${encodeURIComponent(projectId)}/drive/flags`, {
        items: objects.map((o) => ({ bucket: o.bucket, key: o.key })).slice(0, 100),
        patch,
      });
      view.selected.clear();
      refresh();
    } catch (error) { toast(humanError(error.code), { kind: 'error' }); }
  }
  async function bulkDeleteForever(objects) { return deleteForever(objects); }
  async function bulkDownload(objects) {
    for (const object of objects.slice(0, 20)) downloadObject(object);
    if (objects.length > 20) toast(ct('Downloading the first 20 selected files'), {});
  }

  function contentUrl(object, { download = false } = {}) {
    return driveObjectsUrl(projectId, {
      bucket: object.bucket, key: object.key,
      query: download ? { download: '1' } : {},
    });
  }

  function downloadObject(object) {
    const a = h('a', { href: contentUrl(object, { download: true }), download: object.name });
    document.body.append(a); a.click(); a.remove();
  }

  function copyDirectLink(object) {
    const origin = window.location.origin;
    const category = fileCategory(object.content_type, object.name);
    // Snippets are generated for consistency with the inspector; the primary
    // shareable URL is the unlisted public direct link.
    linkSnippets({
      origin, projectId, bucket: object.bucket, key: object.key,
      contentType: object.content_type, name: object.name, category,
    });
    const { direct } = objectUrls({ origin, projectId, bucket: object.bucket, key: object.key });
    copyText(direct).then(() => toast(ct('Direct link copied'), { kind: 'success' }));
  }

  async function renameObject(object) {
    const { renderRenameObjectDialog } = await import('./drive-dialogs.js');
    const destKey = await renderRenameObjectDialog(object, currentPrefix());
    if (!destKey) return;
    await moveServer([{ source: object, destKey, destBucket: object.bucket }], { deleteSource: true });
  }

  async function moveServer(items, { deleteSource }) {
    let failed = 0;
    for (const item of items) {
      try {
        await api.post(`/api/projects/${encodeURIComponent(projectId)}/drive/copy`, {
          bucket: item.destBucket,
          sourceBucket: item.source.bucket,
          sourceKey: item.source.key,
          destKey: item.destKey,
          deleteSource,
        });
      } catch (error) {
        failed += 1;
        console.error('move failed', error);
      }
    }
    if (failed) toast(ct('{n} operations failed', { n: failed }), { kind: 'error' });
    else toast(deleteSource ? ct('Moved') : ct('Copied'), { kind: 'success' });
    view.selected.clear();
    refresh();
    return failed === 0;
  }

  async function bulkMove(objects, folders) {
    const target = await renderMoveDialog({
      projectId,
      buckets: view.buckets,
      currentBucket: view.bucket,
      currentPrefix: currentPrefix(),
      sources: [
        ...objects.map((o) => ({ kind: 'object', name: o.name, bucket: o.bucket, key: o.key })),
        ...folders.map((f) => ({ kind: 'folder', name: f.name, bucket: view.bucket, prefix: f.prefix })),
      ],
    });
    if (!target) return;
    const items = [];
    const prefixWithSlash = target.prefix.endsWith('/') ? target.prefix : `${target.prefix}/`;
    for (const object of objects) {
      items.push({ source: object, destBucket: target.bucket, destKey: `${prefixWithSlash}${object.name}` });
    }
    for (const folder of folders) {
      const nested = await listFolderFlat(folder);
      if (!nested) return;
      for (const object of nested) {
        const rel = object.key.slice(folder.prefix.length);
        items.push({ source: object, destBucket: target.bucket, destKey: `${prefixWithSlash}${folder.name}/${rel}` });
      }
      await api.del(`/api/projects/${encodeURIComponent(projectId)}/drive/folders?bucket=${encodeURIComponent(folder.bucket)}&prefix=${encodeURIComponent(folder.prefix)}&force=1`).catch(() => {});
    }
    if (items.length > FOLDER_MOVE_LIMIT) {
      toast(ct('Folders larger than {limit} objects cannot be moved in one operation', { limit: FOLDER_MOVE_LIMIT }), { kind: 'error' });
      return;
    }
    await moveServer(items, { deleteSource: true });
  }

  async function listFolderFlat(folder) {
    const all = [];
    let cursor;
    do {
      const qs = new URLSearchParams({ bucket: folder.bucket, prefix: folder.prefix, limit: '100' });
      if (cursor) qs.set('cursor', cursor);
      const page = await api.get(`/api/projects/${encodeURIComponent(projectId)}/drive/objects?${qs}`);
      all.push(...(page.objects || []));
      cursor = page.next_cursor;
      if (all.length > FOLDER_MOVE_LIMIT) {
        toast(ct('Folder “{name}” exceeds the {limit}-object move limit.', { name: folder.name, limit: FOLDER_MOVE_LIMIT }), { kind: 'error' });
        return null;
      }
    } while (cursor);
    return all;
  }

  // ----- context menus -----
  const menuIcon = {
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v12m0 0l-4.5-4.5M12 16l4.5-4.5M5 19h14"/></svg>',
    link: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>',
    key: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    rename: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    move: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h13l-4-4M17 9l-4 4"/><path d="M20 15H7l4 4"/></svg>',
    star: iconHtml('starOutline'),
    trash: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7"/></svg>',
    restore: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10V5h5"/><path d="M4 5l6 6a8 8 0 1 1-2 7"/></svg>',
    folder: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h3.1l1.8 1.8h7.7A2.2 2.2 0 0 1 20.5 10v7.3a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.2-5.5"/><path d="M20 4v5h-5"/></svg>',
    upload: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 16V4.5m0 0L7.4 9M12 4.5L16.6 9M5 16.5v2.2A1.8 1.8 0 0 0 6.8 20.5h10.4a1.8 1.8 0 0 0 1.8-1.8v-2.2"/></svg>',
  };

  function objectContextMenu(event, object) {
    const isTrashed = !!object.flags?.trashed;
    const items = isTrashed ? [
      { title: ct('Restore'), icon: menuIcon.restore, onClick: () => setTrash(object, false) },
      { title: ct('Delete permanently'), icon: menuIcon.trash, danger: true, onClick: () => deleteForever([object]) },
      'sep',
      { title: ct('Properties'), icon: menuIcon.open, onClick: () => openInspector(object) },
    ] : [
      { title: ct('Open / Preview'), icon: menuIcon.open, onClick: () => openInspector(object) },
      { title: ct('Download'), icon: menuIcon.download, onClick: () => downloadObject(object) },
      'sep',
      { title: object.flags?.starred ? ct('Remove star') : ct('Star'), icon: menuIcon.star, onClick: () => toggleStar(object) },
      { title: ct('Copy direct link'), icon: menuIcon.link, onClick: () => copyDirectLink(object) },
      { title: ct('Copy object key'), icon: menuIcon.key, onClick: async () => {
        if (await copyText(object.key)) toast(ct('Object key copied'), { kind: 'success' });
      } },
      'sep',
      { title: ct('Rename'), icon: menuIcon.rename, onClick: () => renameObject(object) },
      { title: ct('Move to…'), icon: menuIcon.move, onClick: () => bulkMove([object], []) },
      'sep',
      { title: ct('Move to trash'), icon: menuIcon.trash, danger: true, onClick: () => trashObject(object) },
    ];
    contextMenu(event, items, { position: { x: event.clientX, y: event.clientY } });
  }

  function folderContextMenu(event, folder) {
    contextMenu(event, [
      { title: ct('Open'), icon: menuIcon.folder, onClick: () => openEntry(folder) },
      { title: ct('Rename / Move folder'), icon: menuIcon.rename, onClick: () => bulkMove([], [folder]) },
      { title: ct('Copy folder prefix'), icon: menuIcon.key, onClick: async () => {
        if (await copyText(folder.prefix)) toast(ct('Prefix copied'), { kind: 'success' });
      } },
      'sep',
      {
        title: ct('Delete folder'), icon: menuIcon.trash, danger: true,
        onClick: async () => {
          const nested = await listFolderFlat(folder);
          if (nested === null) return;
          if (nested.length) {
            toast(ct('Only empty folders can be deleted. Move or delete its objects first.'), { kind: 'error' });
            return;
          }
          await api.del(`/api/projects/${encodeURIComponent(projectId)}/drive/folders?bucket=${encodeURIComponent(folder.bucket)}&prefix=${encodeURIComponent(folder.prefix)}`);
          refresh();
        },
      },
    ], { position: { x: event.clientX, y: event.clientY } });
  }

  function emptyAreaMenu(event) {
    contextMenu(event, [
      { title: ct('Upload files'), icon: menuIcon.upload, onClick: () => $('#c-file-input').click() },
      { title: ct('New folder'), icon: menuIcon.folder, onClick: () => renderNewFolderDialog({ bucket: view.bucket, prefix: currentPrefix() }).then((r) => r && refresh()) },
      'sep',
      { title: ct('Refresh'), icon: menuIcon.refresh, onClick: refresh },
    ], { position: { x: event.clientX, y: event.clientY } });
  }
  content.addEventListener('contextmenu', (event) => {
    if (event.target.closest('.c-drive-row, .c-tile')) return;
    if (view.bucket && view.mode === 'folder' && !view.search) { event.preventDefault(); emptyAreaMenu(event); }
  });

  function openInspector(object) {
    renderInspector({
      object,
      projectId,
      contentUrl: () => contentUrl(object),
      downloadUrl: () => contentUrl(object, { download: true }),
      onClose: () => {},
      onChanged: refresh,
      onDownload: () => downloadObject(object),
      onCopyLink: () => copyDirectLink(object),
      onStar: () => toggleStar(object),
      onRename: () => renameObject(object),
      onMove: () => bulkMove([object], []),
      onTrash: () => setTrash(object, true),
      onRestore: () => setTrash(object, false),
      onDelete: () => deleteForever([object]),
    });
  }

  // ----- drag & drop -----
  const dropOverlay = h('div', { class: 'c-drop-overlay', hidden: true, 'aria-hidden': 'true' }, [
    h('div', { class: 'c-drop-card' }, [
      h('span', { html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4.5m0 0L7.4 9M12 4.5L16.6 9M5 16.5v2.2A1.8 1.8 0 0 0 6.8 20.5h10.4a1.8 1.8 0 0 0 1.8-1.8v-2.2"/></svg>' }),
      h('strong', {}, ct('Drop files to upload')),
      h('span', {}, ct('They upload to {bucket}{prefix}', {
        bucket: view.bucket || ct('your bucket'),
        prefix: currentPrefix() ? ` / ${currentPrefix()}` : '',
      })),
    ]),
  ]);
  document.body.append(dropOverlay);
  const removeOverlay = () => { dropOverlay.hidden = true; };
  let dragDepth = 0;
  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('dragover', (e) => { if (view.bucket) e.preventDefault(); });
  window.addEventListener('drop', onDrop);
  function onDragEnter(event) {
    if (!event.dataTransfer?.types?.includes('Files') || !view.bucket) return;
    dragDepth += 1; dropOverlay.hidden = false;
  }
  function onDragLeave() {
    dragDepth -= 1;
    if (dragDepth <= 0) { dragDepth = 0; removeOverlay(); }
  }
  async function onDrop(event) {
    dragDepth = 0; removeOverlay();
    if (!view.bucket) return;
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    const collected = await collectDroppedFiles(event.dataTransfer);
    if (collected.length) enqueue(collected);
  }
  const originalCleanup = container._viewCleanup;
  container._viewCleanup = () => {
    originalCleanup?.();
    dropOverlay.remove();
    window.removeEventListener('dragenter', onDragEnter);
    window.removeEventListener('dragleave', onDragLeave);
    window.removeEventListener('drop', onDrop);
  };

  async function collectDroppedFiles(dataTransfer) {
    const items = dataTransfer.items;
    if (items && items.length && items[0]?.webkitGetAsEntry) {
      const entries = [];
      for (const item of items) {
        const entry = item.webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      if (entries.length) {
        const collected = [];
        for (const entry of entries) await walkEntry(entry, '', collected);
        return collected;
      }
    }
    return Array.from(dataTransfer.files || []).map((file) => ({ file, relativePath: file.name }));
  }
  function walkEntry(entry, prefix, collected) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((file) => {
          Object.defineProperty(file, 'relativePath', { value: prefix + file.name, configurable: true });
          collected.push({ file, relativePath: prefix + file.name });
          resolve();
        }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = () => reader.readEntries(async (batch) => {
          if (!batch.length) return resolve();
          for (const child of batch) await walkEntry(child, prefix + entry.name + '/', collected);
          readAll();
        }, () => resolve());
        readAll();
      } else resolve();
    });
  }

  // ----- file input -----
  const fileInput = $('#c-file-input');
  const folderInput = $('#c-folder-input');
  fileInput.addEventListener('change', () => {
    enqueue(Array.from(fileInput.files || []).map((file) => ({ file, relativePath: file.name })));
    fileInput.value = '';
  });
  folderInput.addEventListener('change', () => {
    enqueue(Array.from(folderInput.files || []).map((file) => ({
      file,
      relativePath: sanitizeSegments(file.webkitRelativePath.split('/').slice(1).join('/') || file.name),
    })));
    folderInput.value = '';
  });

  function enqueue(entries) {
    const targetPrefix = currentPrefix();
    const withKeys = entries.map(({ file, relativePath }) => {
      const safe = sanitizeSegments(relativePath || file.name);
      return { file, key: `${targetPrefix}${safe}` };
    }).filter(({ key }) => key);
    uploadFiles({
      projectId,
      bucket: view.bucket,
      entries: withKeys,
      queue: view.uploads,
      panel: queuePanel,
      onSettled: () => refresh(),
    });
  }

  // ----- global keyboard -----
  const keyHandler = (event) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
    if (typing) return;
    if ((event.ctrlKey || event.metaKey) && event.key === 'a') { event.preventDefault(); selectAll(); }
    if (event.key === '/') { event.preventDefault(); toolbar.querySelector('input[type=search]')?.focus(); }
    if (event.key === 'Delete' && view.mode !== 'trash') {
      const objects = selectedObjects();
      if (objects.length) { event.preventDefault(); bulkFlag({ trashed: true }); }
    }
  };
  window.addEventListener('keydown', keyHandler);
  const cleanup2 = container._viewCleanup;
  container._viewCleanup = () => { cleanup2?.(); window.removeEventListener('keydown', keyHandler); };

  // ----- boot -----
  try {
    await loadBuckets();
    renderToolbar();
    if (view.bucket) await refresh();
    else renderAll();
  } catch (error) {
    if (error instanceof AuthError) return;
    clear(content);
    content.append(h('div', { class: 'c-error-state', role: 'alert' }, [
      h('h3', {}, ct('Drive could not be loaded')),
      h('p', {}, humanError(error.code)),
      h('div', { class: 'c-actions' }, [h('button', { class: 'c-btn outlined', onClick: () => location.reload() }, ct('Retry'))]),
    ]));
  }
}

function humanError(code, fallback) {
  const fallbackMessage = fallback || ct('The operation could not be completed.');
  const map = {
    object_too_large: ct('The file exceeds the object size limit for this deployment.'),
    invalid_bucket_name: ct('Bucket names must be 3–63 lowercase letters, numbers, dots, or hyphens, and start/end alphanumerically.'),
    invalid_object_key: ct('The file name contains unsupported characters.'),
    drive_folder_not_empty: ct('That folder still contains objects.'),
    object_not_found: ct('The object no longer exists.'),
    rate_limited: ct('Too many changes — wait a minute and try again.'),
    project_inactive: ct('This project is disabled.'),
    invalid_api_key: ct('Authentication is required.'),
  };
  return map[code] || (code ? `${fallbackMessage} (${code})` : fallbackMessage);
}
