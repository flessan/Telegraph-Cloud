import { h, timeAgo, formatDate, copyText } from '../util.js';
import { api } from '../api.js';
import { pageHead, openDialog, toast, confirmDialog, emptyState, popupMenu } from '../ui.js';
import { ct } from '../i18n.js';
import { badge, scopeCheckboxes, oneTimeSecretDialog } from './common.js';
import { navigate, projectPath } from '../router.js';

function scopeDescriptions() {
  return {
    's3:read': ct('List and download objects with SigV4.'),
    's3:write': ct('Upload and delete objects with SigV4.'),
  };
}

function base(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

export async function renderS3Credentials(container, projectId) {
  container.append(pageHead(ct('S3 credentials'), ct('Access key pairs for AWS Signature Version 4 (S3). These are separate from Bearer API keys and never access the document API.'), [
    h('button', { class: 'c-btn outlined', onClick: () => navigate(projectPath(projectId, 's3')) }, ct('S3 endpoint')),
    h('button', { class: 'c-btn primary', onClick: createDialog }, ct('Create credentials')),
  ]));

  const body = h('div');
  container.append(body);
  await load();

  async function load() {
    body.innerHTML = '';
    let credentials = [];
    try {
      let cursor;
      do {
        const qs = new URLSearchParams({ limit: '100' });
        if (cursor) qs.set('cursor', cursor);
        const page = await api.get(`${base(projectId)}/s3-credentials?${qs}`);
        credentials = credentials.concat(page.data || []);
        cursor = page.next_cursor;
      } while (cursor);
    } catch (error) {
      body.append(h('div', { class: 'c-card c-error-state', role: 'alert' }, [
        h('h3', {}, ct('Credentials could not be loaded')),
        h('p', {}, error.message || error.code),
      ]));
      return;
    }

    if (!credentials.length) {
      body.append(h('div', { class: 'c-card' }, [emptyState({
        icon: 'key',
        title: ct('No S3 credentials'),
        body: ct('Create an access key ID and secret access key for SigV4 clients such as the AWS CLI, SDKs with a custom endpoint, or rclone.'),
        actions: [h('button', { class: 'c-btn primary', onClick: createDialog }, ct('Create credentials'))],
      })]));
      return;
    }

    body.append(h('div', { class: 'c-table-wrap' }, [
      h('table', { class: 'c-table' }, [
        h('thead', {}, h('tr', {}, [
          h('th', {}, ct('Name')), h('th', {}, ct('Access key ID')), h('th', {}, ct('Scopes')),
          h('th', {}, ct('Status')), h('th', {}, ct('Created')), h('th', {}, ct('Last used')), h('th', {}, ''),
        ])),
        h('tbody', {}, credentials.map((credential) => h('tr', {}, [
          h('td', { class: 'c-cell-main' }, credential.label || '—'),
          h('td', {}, h('code', {}, credential.access_key_id)),
          h('td', {}, h('div', { style: { display: 'flex', gap: '4px', flexWrap: 'wrap' } },
            credential.scopes.map((scope) => h('span', { class: 'c-badge' }, scope)))),
          h('td', {}, badge(credential.status, credential.status === 'active' ? 'active' : 'revoked')),
          h('td', { class: 'c-cell-sub' }, formatDate(credential.created_at)),
          h('td', { class: 'c-cell-sub' }, credential.last_used_at ? timeAgo(credential.last_used_at) : ct('Never')),
          h('td', {}, rowMenu(credential)),
        ]))),
      ]),
    ]));
  }

  function rowMenu(credential) {
    return h('button', {
      class: 'c-icon-button', 'aria-label': ct('Credential actions'),
      onClick: (event) => {
        const items = [
          {
            title: ct('Copy access key ID'),
            icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
            onClick: async () => {
              await copyText(credential.access_key_id);
              toast(ct('Access key ID copied'), { kind: 'success' });
            },
          },
        ];
        if (credential.status === 'active') {
          items.push({
            title: ct('Rotate credentials'),
            icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.2-5.5"/><path d="M20 4v5h-5"/></svg>',
            onClick: () => rotateDialog(credential),
          });
          items.push({
            title: ct('Revoke credentials'),
            danger: true,
            icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
            onClick: () => revokeDialog(credential),
          });
        }
        popupMenu(event.currentTarget, items);
      },
    }, [h('span', { html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>' })]);
  }

  function createDialog() {
    const labelInput = h('input', { class: 'c-input', type: 'text', placeholder: 'media-pipeline', maxlength: '64' });
    const scopes = scopeCheckboxes(['s3:read', 's3:write'], scopeDescriptions(), ['s3:read', 's3:write']);
    const errorEl = h('span', { class: 'c-field-error', role: 'alert' });
    openDialog({
      title: ct('Create S3 credentials'),
      subtitle: ct('Step 1 of 2 — name and scopes. The secret appears exactly once next.'),
      body: [
        h('label', { class: 'c-field' }, [h('span', { class: 'c-field-label' }, ct('Name')), labelInput]),
        h('span', { class: 'c-field-label', style: { display: 'block', margin: '4px 0' } }, ct('Scopes')),
        scopes.group,
        errorEl,
      ],
      actions: [
        { label: ct('Cancel'), variant: 'outlined' },
        {
          label: ct('Create'), variant: 'primary', keepOpen: true,
          onClick: async (close) => {
            errorEl.textContent = '';
            const scopeList = scopes.value();
            if (!scopeList.length) { errorEl.textContent = ct('Select at least one scope.'); return false; }
            try {
              const result = await api.post(`${base(projectId)}/s3-credentials`, {
                label: labelInput.value.trim(), scopes: scopeList,
              });
              close();
              await oneTimeSecretDialog({
                title: ct('Save your S3 secret'),
                subtitle: result.credential.label || ct('S3 credentials'),
                secret: result.secret_access_key,
                fields: [
                  { label: ct('Access key ID'), value: result.credential.access_key_id },
                  { label: ct('Region'), value: 'us-east-1' },
                  { label: ct('Endpoint'), value: `${window.location.origin}/s3` },
                ],
                warning: ct('The secret access key is shown exactly once and is not recoverable. Store it now. It is never written to browser storage or included in a URL.'),
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

  async function rotateDialog(credential) {
    const ok = await confirmDialog({
      title: ct('Rotate “{name}”?', { name: credential.label || credential.access_key_id }),
      body: ct('A new access key ID and secret are issued, and the current credentials are revoked immediately. Configure your clients with the new values after copying the one-time secret.'),
      confirmLabel: ct('Rotate credentials'),
    });
    if (!ok) return;
    try {
      const result = await api.post(
        `${base(projectId)}/s3-credentials/${encodeURIComponent(credential.access_key_id)}/rotate`,
        { label: credential.label, scopes: credential.scopes },
      );
      await oneTimeSecretDialog({
        title: ct('New S3 credentials'),
        subtitle: result.credential.label || ct('Rotated credentials'),
        secret: result.secret_access_key,
        fields: [{ label: ct('Access key ID'), value: result.credential.access_key_id }],
        warning: ct('The previous credentials were revoked. Save the new secret now.'),
      });
      load();
    } catch (error) {
      toast(error.message || error.code, { kind: 'error' });
    }
  }

  async function revokeDialog(credential) {
    const ok = await confirmDialog({
      title: ct('Revoke these S3 credentials?'),
      body: ct('{accessKeyId} immediately stops signing requests successfully. This cannot be undone.', { accessKeyId: credential.access_key_id }),
      confirmLabel: ct('Revoke credentials'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`${base(projectId)}/s3-credentials/${encodeURIComponent(credential.access_key_id)}`);
      toast(ct('S3 credentials revoked'));
      load();
    } catch (error) {
      toast(error.message || error.code, { kind: 'error' });
    }
  }
}
