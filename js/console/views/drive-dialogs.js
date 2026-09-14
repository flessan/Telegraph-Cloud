import { h, baseName, esc } from '../util.js';
import { api } from '../api.js';
import { openDialog, toast } from '../ui.js';
import { ct } from '../i18n.js';
import { createLabeledDialog } from './common.js';

const BUCKET_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?$/;
const FOLDER_NAME_PATTERN = /^[^/\\%?#\x00-\x1f]+$/;

export function renderNewBucketDialog(existingBuckets = []) {
  return createLabeledDialog({
    title: ct('New bucket'),
    subtitle: ct('Buckets are the top-level containers shared by Drive, the object API, and S3.'),
    label: ct('Bucket name'),
    placeholder: 'assets',
    hint: ct('3–63 characters; lowercase letters, numbers, dots, and hyphens.'),
    confirmLabel: ct('Create bucket'),
    validate(value) {
      if (!BUCKET_PATTERN.test(value)) return ct('Enter a valid S3-style bucket name.');
      if (existingBuckets.some((b) => b.bucket === value)) return ct('A bucket with this name already exists.');
      return null;
    },
  });
}

export function renderNewFolderDialog({ bucket, prefix }) {
  return createLabeledDialog({
    title: ct('New folder'),
    subtitle: `${bucket} · ${prefix || '/'}`,
    label: ct('Folder name'),
    placeholder: 'designs',
    validate(value) {
      if (!value) return ct('Folder name is required.');
      if (value.includes('/')) return ct('Use one folder name here. Nest by creating folders inside folders.');
      if (!FOLDER_NAME_PATTERN.test(value)) return ct('Folder name contains unsupported characters.');
      return null;
    },
  }).then((name) => {
    if (!name) return null;
    const fullPrefix = `${prefix || ''}${name.trim()}/`;
    return api.post(`/api/projects/${encodeURIComponent(apiProject())}/drive/folders`, { bucket, prefix: fullPrefix })
      .then(() => fullPrefix)
      .catch((error) => { toast(human(error.code), { kind: 'error' }); return null; });
  });
}

// The dialog helpers do not know the project; callers set it via closure. To
// keep this module project-agnostic, renderNewFolderDialog receives a bound
// fetch through a tiny module-level setter used by drive.js.
let apiProjectValue = null;
export function bindDriveProject(projectId) { apiProjectValue = projectId; }
function apiProject() { return apiProjectValue; }

export async function renderRenameObjectDialog(object, currentPrefix) {
  const currentName = object.name || baseName(object.key);
  const name = await createLabeledDialog({
    title: ct('Rename file'),
    subtitle: ct('Renaming copies the object to the new key and removes the original. Object history restarts at the new key.'),
    label: ct('New name'),
    initialValue: currentName,
    validate(value) {
      if (!value) return ct('Name is required.');
      if (value.includes('/')) return ct('Use the move action to change the folder; names cannot contain a slash.');
      if (/[\\%?#\x00-\x1f]/.test(value)) return ct('Name contains unsupported characters.');
      return null;
    },
  });
  if (!name || name === currentName) return null;
  return `${currentPrefix}${name.trim()}`;
}

// Modal folder browser. Resolves with { bucket, prefix } or null.
export function renderMoveDialog({ projectId, buckets, currentBucket, sources }) {
  return new Promise((resolve) => {
    let destBucket = currentBucket || buckets[0]?.bucket || '';
    let destPath = [];
    let listEl;
    let crumbsEl;
    const label = sources.length === 1
      ? ct('Move “{name}”', { name: sources[0].name })
      : ct('Move {n} items', { n: sources.length });

    const destPrefix = () => (destPath.length ? `${destPath.join('/')}/` : '');

    async function load() {
      listEl.innerHTML = `<div class="c-loading"><span class="c-spinner"></span><span>${esc(ct('Loading folders…'))}</span></div>`;
      renderCrumbs();
      const prefix = destPrefix();
      try {
        const qs = new URLSearchParams({ bucket: destBucket, prefix, delimiter: '/', limit: '100' });
        const page = await api.get(`/api/projects/${encodeURIComponent(projectId)}/drive/objects?${qs}`);
        listEl.innerHTML = '';
        const folders = (page.folders || []).filter((folder) => {
          // Hiding the folder being moved into itself or a descendant.
          const movingFolders = sources.filter((s) => s.kind === 'folder').map((s) => s.prefix);
          return !movingFolders.includes(folder.prefix) && !movingFolders.some((p) => folder.prefix.startsWith(p));
        });
        if (!folders.length) {
          listEl.append(h('p', { style: { color: 'var(--c-text-3)', padding: '10px 6px', margin: 0, fontSize: '12.5px' } }, ct('No subfolders here.')));
        }
        for (const folder of folders) {
          listEl.append(h('button', {
            type: 'button', class: 'c-collection-item',
            onClick: () => { destPath = folder.prefix.slice(0, -1).split('/'); load(); },
          }, [
            h('span', { class: 'c-fileicon folder', html: iconFolder(), style: { display: 'inline-grid', width: '20px' } }),
            h('span', {}, folder.name || baseName(folder.prefix.slice(0, -1))),
          ]));
        }
      } catch (error) {
        listEl.innerHTML = '';
        listEl.append(h('p', { style: { color: 'var(--c-danger)' } }, human(error.code)));
      }
    }

    function renderCrumbs() {
      crumbsEl.innerHTML = '';
      crumbsEl.append(h('button', { type: 'button', class: 'c-crumb', onClick: () => { destPath = []; load(); } }, destBucket));
      destPath.forEach((segment, index) => {
        crumbsEl.append(h('span', { class: 'c-crumb-sep' }, '/'));
        crumbsEl.append(h('button', {
          type: 'button',
          class: 'c-crumb',
          onClick: () => { destPath = destPath.slice(0, index + 1); load(); },
        }, segment));
      });
    }

    const bucketSelect = h('select', {
      class: 'c-select',
      onchange: (event) => { destBucket = event.target.value; destPath = []; load(); },
    }, buckets.map((bucket) => h('option', {
      value: bucket.bucket,
      ...(bucket.bucket === destBucket ? { selected: true } : {}),
    }, bucket.bucket)));

    crumbsEl = h('nav', { class: 'c-crumbs', style: { padding: '6px 0' } });
    listEl = h('div', { style: { minHeight: '180px', maxHeight: '42vh', overflowY: 'auto', border: '1px solid var(--c-border)', borderRadius: '10px', padding: '6px' } });

    const newFolder = h('button', {
      type: 'button', class: 'c-btn text sm',
      onClick: async () => {
        const name = await createLabeledDialog({
          title: ct('New folder'), label: ct('Folder name'),
          validate(value) {
            if (!value || value.includes('/') || !FOLDER_NAME_PATTERN.test(value)) return ct('Invalid folder name.');
            return null;
          },
        });
        if (!name) return;
        await api.post(`/api/projects/${encodeURIComponent(projectId)}/drive/folders`, {
          bucket: destBucket,
          prefix: `${destPrefix()}${name.trim()}/`,
        });
        load();
      },
    }, ct('+ New folder'));

    openDialog({
      title: ct('Move to…'),
      subtitle: label,
      size: 'lg',
      body: [
        h('label', { class: 'c-field' }, [h('span', { class: 'c-field-label' }, ct('Bucket')), bucketSelect]),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [crumbsEl, h('span', { style: { flex: '1' } }), newFolder]),
        listEl,
      ],
      actions: [
        { label: ct('Cancel'), variant: 'outlined', onClick: () => resolve(null) },
        {
          label: ct('Move here'),
          variant: 'primary',
          onClick: () => {
            if (!destBucket) { toast(ct('Choose a bucket first'), { kind: 'error' }); return false; }
            resolve({ bucket: destBucket, prefix: destPrefix() });
          },
        },
      ],
      onClose: () => resolve(null),
    });
    load();
  });
}

function iconFolder() {
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h3.1l1.8 1.8h7.7A2.2 2.2 0 0 1 20.5 10v7.3a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/></svg>';
}

export function human(code, fallback) {
  const fallbackMessage = fallback || ct('The operation could not be completed.');
  const map = {
    object_too_large: ct('The file exceeds this deployment’s object size limit.'),
    invalid_bucket_name: ct('Invalid bucket name.'),
    invalid_object_key: ct('The file name contains unsupported characters.'),
    drive_folder_not_empty: ct('That folder still contains objects.'),
    object_not_found: ct('The object no longer exists.'),
    rate_limited: ct('Too many changes — wait a minute and try again.'),
  };
  return map[code] || (code ? `${fallbackMessage} (${code})` : fallbackMessage);
}
