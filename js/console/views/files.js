// Files section: Drive (folder browser), Objects (flat object listing), and
// S3 (SigV4 endpoint + credentials). All three surfaces operate on the same
// object engine — an object written in any surface is the same manifest and
// bytes everywhere.
import { h, clear, esc, formatDate, formatBytes } from '../util.js';
import { api } from '../api.js';
import { pageHead, toast, emptyState } from '../ui.js';
import { ct } from '../i18n.js';
import { subTabs, copyButton } from './common.js';
import { renderDrive } from './drive.js';
import { renderS3 } from './s3.js';
import { renderS3CredentialsPanel } from './s3-credentials.js';

export async function renderFiles(container, projectId, query) {
  const tab = ['drive', 'objects', 's3'].includes(query.get('tab')) ? query.get('tab') : 'drive';

  container.append(pageHead(ct('Files'), ct('Drive, objects, and S3-compatible access to the same object engine. Objects are private and reads require credentials.')));
  container.append(subTabs(projectId, 'files', tab, [
    { tab: 'drive', label: () => ct('Drive') },
    { tab: 'objects', label: () => ct('Objects') },
    { tab: 's3', label: () => ct('S3') },
  ]));

  const body = h('div', {});
  container.append(body);

  if (tab === 'drive') {
    await renderDrive(body, projectId, query);
  } else if (tab === 'objects') {
    renderObjects(body, projectId);
  } else {
    const s3Wrap = h('div', {});
    body.append(s3Wrap);
    await renderS3(s3Wrap, projectId);
    body.append(h('div', { style: { height: '16px' } }));
    await renderS3CredentialsPanel(body, projectId);
  }
}

// ------------------------------------------------------------------ objects
// Flat, object-centric listing: every non-trashed object of a bucket as a full
// key. Uses the bounded flat scan (view=objects), not the folder browser.
function renderObjects(container, projectId) {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  let buckets = [];
  let bucket = null;
  let objects = [];
  let cursor = null;
  let hasMore = false;
  let loading = false;

  const bucketPicker = h('select', { class: 'c-input', style: { width: '220px' }, onchange: (event) => { bucket = event.target.value || null; objects = []; cursor = null; load(); } });
  const tableWrap = h('div', {});

  const header = h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px', flexWrap: 'wrap' } }, [
    h('span', { style: { fontSize: '13px', color: 'var(--c-text-2)' } }, ct('Bucket')),
    bucketPicker,
    h('span', { style: { color: 'var(--c-text-3)', fontSize: '12px' } }, ct('Objects are the storage primitives behind Drive and S3: a flat key, content type, and revision metadata.')),
  ]);
  container.append(header, tableWrap);

  async function load() {
    if (!bucket) {
      clear(tableWrap);
      tableWrap.append(h('div', { class: 'c-card' }, [emptyState({
        icon: 'drive',
        title: ct('No bucket selected'),
        body: ct('Buckets appear here after the first upload in Drive, the object API, or S3.'),
      })]));
      return;
    }
    loading = true;
    clear(tableWrap);
    tableWrap.append(h('div', { class: 'c-loading' }, [h('span', { class: 'c-spinner' }), h('span', {}, ct('Loading objects…'))]));
    try {
      const params = new URLSearchParams({ bucket, view: 'objects', limit: '100' });
      if (cursor) params.set('cursor', cursor);
      const page = await api.get(`${base}/drive/objects?${params}`);
      if (!cursor) objects = [];
      objects = objects.concat(page.objects || []);
      cursor = page.next_cursor || null;
      hasMore = !!page.has_more || !!page.truncated;
    } catch (error) {
      toast(error.message || error.code, { kind: 'error' });
    }
    loading = false;
    renderTable();
  }

  function renderTable() {
    clear(tableWrap);
    if (!objects.length) {
      tableWrap.append(h('div', { class: 'c-card' }, [emptyState({
        icon: 'drive',
        title: ct('No objects'),
        body: ct('This bucket has no objects yet. Upload one in Drive or through the API.'),
      })]));
      return;
    }
    const table = h('table', { class: 'c-table' }, [
      h('thead', {}, h('tr', {}, [
        h('th', {}, ct('Key')), h('th', {}, ct('Size')), h('th', {}, ct('Type')),
        h('th', {}, ct('Version')), h('th', {}, ct('Updated')), h('th', {}, ''),
      ])),
      h('tbody', {}, objects.map((object) => h('tr', {}, [
        h('td', {}, h('code', { style: { wordBreak: 'break-all' } }, object.key)),
        h('td', {}, formatBytes(object.size)),
        h('td', { class: 'c-cell-sub' }, object.content_type || '—'),
        h('td', {}, h('span', { class: 'c-badge' }, ct('v{n}', { n: object.version }))),
        h('td', { class: 'c-cell-sub' }, formatDate(object.updated_at)),
        h('td', {}, copyButton(objectUrl(object), { label: '', message: ct('Object URL copied') })),
      ]))),
    ]);
    tableWrap.append(h('div', { class: 'c-table-wrap' }, table));
    if (hasMore) {
      tableWrap.append(h('div', { class: 'c-pager' }, [
        h('button', { class: 'c-btn outlined sm', disabled: loading, onClick: () => load() }, ct('Load more')),
      ]));
    }
  }

  function objectUrl(object) {
    return `${window.location.origin}${base}/drive/objects/${object.key.split('/').map(encodeURIComponent).join('/')}?bucket=${encodeURIComponent(bucket)}`;
  }

  api.get(`${base}/drive/buckets?limit=100`).then((page) => {
    buckets = (page.data || []).map((entry) => entry.bucket || entry.name).filter(Boolean);
    clear(bucketPicker);
    bucketPicker.append(h('option', { value: '' }, ct('All buckets…')));
    for (const name of buckets) {
      bucketPicker.append(h('option', { value: name }, name));
    }
    if (buckets.length === 1) {
      bucket = buckets[0];
      bucketPicker.value = bucket;
      load();
    } else if (buckets.length > 1) {
      renderTable();
    }
  }).catch(() => renderTable());
}
