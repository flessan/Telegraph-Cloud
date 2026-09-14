import { h, timeAgo, copyText } from '../util.js';
import { api } from '../api.js';
import { pageHead, openDialog, toast, confirmDialog, emptyState, popupMenu } from '../ui.js';
import { ct } from '../i18n.js';
import { badge, copyButton, scopeCheckboxes, oneTimeSecretDialog } from './common.js';
import { navigate, projectPath } from '../router.js';

function scopeDescriptions() {
  return {
    'db:read': ct('Read document collections and records.'),
    'db:write': ct('Create, patch, and delete documents.'),
    'storage:read': ct('Get and list objects through the object API.'),
    'storage:write': ct('Upload, overwrite, and delete objects.'),
  };
}

function base(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

export async function renderApiKeys(container, projectId) {
  container.append(pageHead(ct('API keys'), ct('Bearer keys for the Telegraph document and object APIs. S3 clients use separate S3 credentials.'), [
    h('button', { class: 'c-btn outlined', onClick: () => navigate(projectPath(projectId, 'connect')) }, ct('Connect your app')),
    h('button', { class: 'c-btn primary', onClick: () => createDialog() }, ct('Create API key')),
  ]));

  const body = h('div');
  container.append(body);
  await load();

  async function load() {
    body.innerHTML = '';
    let keys = [];
    try {
      let cursor;
      do {
        const qs = new URLSearchParams({ limit: '100' });
        if (cursor) qs.set('cursor', cursor);
        const page = await api.get(`${base(projectId)}/keys?${qs}`);
        keys = keys.concat(page.data || []);
        cursor = page.next_cursor;
      } while (cursor);
    } catch (error) {
      body.append(h('div', { class: 'c-card c-error-state', role: 'alert' }, [
        h('h3', {}, ct('API keys could not be loaded')),
        h('p', {}, error.message || error.code),
      ]));
      return;
    }

    if (!keys.length) {
      body.append(h('div', { class: 'c-card' }, [emptyState({
        icon: 'key',
        title: ct('No API keys'),
        body: ct('Create a scoped Bearer key to call the document database and object API from your application.'),
        actions: [h('button', { class: 'c-btn primary', onClick: () => createDialog() }, ct('Create API key'))],
      })]));
      return;
    }

    body.append(h('div', { class: 'c-table-wrap' }, [
      h('table', { class: 'c-table' }, [
        h('thead', {}, h('tr', {}, [
          h('th', {}, ct('Label')), h('th', {}, ct('Key prefix')), h('th', {}, ct('Scopes')),
          h('th', {}, ct('Status')), h('th', {}, ct('Created')), h('th', {}, ''),
        ])),
        h('tbody', {}, keys.map((key) => h('tr', {}, [
          h('td', { class: 'c-cell-main' }, key.label || '—'),
          h('td', {}, h('code', {}, key.key_prefix)),
          h('td', {}, h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
            key.scopes.map((scope) => h('span', { class: 'c-badge' }, scope)))),
          h('td', {}, badge(key.status, key.status === 'active' ? 'active' : 'revoked')),
          h('td', { class: 'c-cell-sub' }, timeAgo(key.created_at)),
          h('td', {}, rowMenu(key)),
        ]))),
      ]),
    ]));
  }

  function rowMenu(key) {
    const btn = h('button', {
      class: 'c-icon-button', 'aria-label': ct('Key actions'),
      onClick: (event) => {
        const items = [
          {
            title: ct('Copy key prefix'),
            icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
            onClick: async () => {
              await copyText(key.key_prefix);
              toast(ct('Key prefix copied'), { kind: 'success' });
            },
          },
        ];
        if (key.status === 'active') {
          items.push({
            title: ct('Rotate key'),
            icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.2-5.5"/><path d="M20 4v5h-5"/></svg>',
            onClick: () => rotateDialog(key),
          });
          items.push({
            title: ct('Revoke key'),
            danger: true,
            icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
            onClick: () => revokeDialog(key),
          });
        }
        popupMenu(event.currentTarget, items);
      },
    }, [h('span', { html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>' })]);
    return btn;
  }

  function createDialog() {
    const labelInput = h('input', { class: 'c-input', type: 'text', placeholder: 'web-app production', maxlength: '64' });
    const scopes = scopeCheckboxes(['db:read', 'db:write', 'storage:read', 'storage:write'], scopeDescriptions(), ['db:read', 'db:write']);
    const errorEl = h('span', { class: 'c-field-error', role: 'alert' });
    openDialog({
      title: ct('Create API key'),
      subtitle: ct('The plaintext key is shown once after creation.'),
      body: [
        h('label', { class: 'c-field' }, [h('span', { class: 'c-field-label' }, ct('Label')), labelInput, h('span', { class: 'c-field-hint' }, ct('What uses this key?'))]),
        h('span', { class: 'c-field-label', style: { display: 'block', margin: '4px 0' } }, ct('Scopes')),
        scopes.group,
        errorEl,
      ],
      actions: [
        { label: ct('Cancel'), variant: 'outlined' },
        {
          label: ct('Create key'), variant: 'primary', keepOpen: true,
          onClick: async (close) => {
            errorEl.textContent = '';
            const scopeList = scopes.value();
            if (!scopeList.length) { errorEl.textContent = ct('Select at least one scope.'); return false; }
            try {
              const result = await api.post(`${base(projectId)}/keys`, { label: labelInput.value.trim(), scopes: scopeList });
              close();
              await oneTimeSecretDialog({
                title: ct('API key created'),
                subtitle: result.key.label || ct('API key'),
                secret: result.api_key,
                fields: [
                  { label: ct('Key ID'), value: result.key.key_id },
                  { label: ct('Authorization header'), value: `Authorization: Bearer ${result.api_key}` },
                ],
                warning: ct('This is the only time the full key is shown. It is not stored in your browser or recoverable later; rotate the key to get a new secret.'),
              });
              load();
            } catch (error) {
              errorEl.textContent = error.message || error.code;
              return false;
            }
          },
        },
      ],
    });
    setTimeout(() => labelInput.focus(), 40);
  }

  async function rotateDialog(key) {
    const ok = await confirmDialog({
      title: ct('Rotate “{name}”?', { name: key.label || key.key_id }),
      body: ct('A new key is issued with the same label and scopes, and the current key is revoked immediately. Copy the new secret — it is shown once.'),
      confirmLabel: ct('Rotate key'),
    });
    if (!ok) return;
    try {
      const result = await api.post(`${base(projectId)}/keys/${encodeURIComponent(key.key_id)}/rotate`, {
        label: key.label, scopes: key.scopes,
      });
      await oneTimeSecretDialog({
        title: ct('New API key'),
        subtitle: result.key.label || ct('Rotated key'),
        secret: result.api_key,
        fields: [{ label: ct('Key ID'), value: result.key.key_id }],
        warning: ct('The previous key was revoked. Save the new secret now.'),
      });
      load();
    } catch (error) {
      toast(error.message || error.code, { kind: 'error' });
    }
  }

  async function revokeDialog(key) {
    const ok = await confirmDialog({
      title: ct('Revoke this API key?'),
      body: ct('Any client using {prefix} immediately loses access. This cannot be undone; create or rotate a key instead to continue access.', { prefix: key.key_prefix }),
      confirmLabel: ct('Revoke key'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`${base(projectId)}/keys/${encodeURIComponent(key.key_id)}`);
      toast(ct('API key revoked'));
      load();
    } catch (error) {
      toast(error.message || error.code, { kind: 'error' });
    }
  }
}
