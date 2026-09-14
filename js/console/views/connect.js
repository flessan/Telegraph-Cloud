import { h } from '../util.js';
import { api } from '../api.js';
import { pageHead, openDialog, toast } from '../ui.js';
import { ct } from '../i18n.js';
import { copyButton, oneTimeSecretDialog, scopeCheckboxes } from './common.js';

function base(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

export async function renderConnect(container, projectId) {
  const origin = window.location.origin;
  const secrets = { apiKey: '', s3AccessKeyId: '', s3SecretAccessKey: '' };

  container.append(pageHead(ct('Connect your app'), ct('Connection settings for the document API, object storage, and S3. Secrets are shown once when created and never stored by the browser.')));

  const envBlock = h('div', { class: 'c-code-block', style: { marginTop: '14px' } });
  const jsonBlock = h('div', { class: 'c-code-block', style: { marginTop: '12px' } });
  const curlBlock = h('div', { class: 'c-code-block', style: { marginTop: '12px' } });

  function envText() {
    return [
      `# Telegraph Cloud — ${projectId}`,
      `TELEGRAPH_URL=${origin}`,
      `TELEGRAPH_PROJECT=${projectId}`,
      `# Bearer developer API key (document + object APIs)`,
      `TELEGRAPH_API_KEY=${secrets.apiKey || 'tg_live_create_a_key_below'}`,
      '',
      `# S3-compatible object storage (separate credentials)`,
      `S3_ENDPOINT=${origin}/s3`,
      `S3_REGION=us-east-1`,
      `S3_ACCESS_KEY_ID=${secrets.s3AccessKeyId || 'tgsk_live_create_credentials_below'}`,
      `S3_SECRET_ACCESS_KEY=${secrets.s3SecretAccessKey || 'create_credentials_below'}`,
    ].join('\n');
  }

  function jsonText() {
    return JSON.stringify({
      telegraph_url: origin,
      telegraph_project: projectId,
      telegraph_api_key: secrets.apiKey || null,
      database_endpoint: `${origin}/api/db`,
      storage_endpoint: `${origin}/api/storage`,
      s3: {
        endpoint: `${origin}/s3`,
        region: 'us-east-1',
        access_key_id: secrets.s3AccessKeyId || null,
        secret_access_key: secrets.s3SecretAccessKey || null,
      },
    }, null, 2);
  }

  function curlText() {
    const auth = secrets.apiKey ? secrets.apiKey : 'tg_live_…';
    return [
      `# List documents in a collection`,
      `curl ${origin}/api/db/users?limit=20 \\`,
      `  -H "Authorization: Bearer ${auth}"`,
      '',
      `# Upload an object (same engine as Drive/S3)`,
      `curl -X PUT --data-binary @logo.png \\`,
      `  -H "Authorization: Bearer ${auth}" \\`,
      `  -H "Content-Type: image/png" \\`,
      `${origin}/api/storage/assets/logo.png`,
    ].join('\n');
  }

  function renderBlocks() {
    renderCode(envBlock, envText(), '.env');
    renderCode(jsonBlock, jsonText(), 'JSON');
    renderCode(curlBlock, curlText(), 'curl');
  }

  function renderCode(wrap, code, label) {
    wrap.innerHTML = '';
    wrap.append(h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } }, [
      h('span', { class: 'c-snippet-label' }, label),
      copyButton(code, { message: ct('{label} copied', { label }) }),
    ]), h('pre', {}, [h('code', {}, code)]));
  }

  function issueApiKey() {
    openIssueDialog({
      title: ct('Issue API key for .env'),
      endpoint: 'keys',
      scopes: ['db:read', 'db:write', 'storage:read', 'storage:write'],
      defaultScopes: ['db:read', 'db:write', 'storage:read', 'storage:write'],
      map: (result) => ({ secret: result.api_key, label: ct('API key') }),
      onIssued(result) {
        secrets.apiKey = result.api_key;
        renderBlocks();
      },
    });
  }

  function issueS3() {
    openIssueDialog({
      title: ct('Issue S3 credentials for .env'),
      endpoint: 's3-credentials',
      scopes: ['s3:read', 's3:write'],
      defaultScopes: ['s3:read', 's3:write'],
      map: (result) => ({ secret: result.secret_access_key, label: ct('S3 secret access key') }),
      onIssued(result) {
        secrets.s3AccessKeyId = result.credential.access_key_id;
        secrets.s3SecretAccessKey = result.secret_access_key;
        renderBlocks();
      },
    });
  }

  function openIssueDialog({ title, endpoint, scopes, defaultScopes, map, onIssued }) {
    const labelInput = h('input', { class: 'c-input', type: 'text', placeholder: '.env setup', value: '.env setup' });
    const scopeUi = scopeCheckboxes(scopes, {}, defaultScopes);
    const errorEl = h('span', { class: 'c-field-error', role: 'alert' });
    openDialog({
      title,
      subtitle: ct('A new credential is created so the secret can be shown exactly once. Existing credentials are not changed.'),
      body: [
        h('label', { class: 'c-field' }, [h('span', { class: 'c-field-label' }, ct('Label')), labelInput]),
        h('span', { class: 'c-field-label', style: { display: 'block', margin: '4px 0' } }, ct('Scopes')),
        scopeUi.group,
        errorEl,
      ],
      actions: [
        { label: ct('Cancel'), variant: 'outlined' },
        {
          label: ct('Create & reveal'), variant: 'primary', keepOpen: true,
          onClick: async (close) => {
            errorEl.textContent = '';
            const chosen = scopeUi.value();
            if (!chosen.length) { errorEl.textContent = ct('Select at least one scope.'); return false; }
            try {
              const result = await api.post(`${base(projectId)}/${endpoint}`, { label: labelInput.value.trim(), scopes: chosen });
              close();
              const mapped = map(result);
              await oneTimeSecretDialog({
                title: ct('Credential created'),
                subtitle: labelInput.value.trim(),
                secret: mapped.secret,
                fields: endpoint === 's3-credentials'
                  ? [{ label: ct('Access key ID'), value: result.credential.access_key_id }, { label: ct('Region'), value: 'us-east-1' }]
                  : [{ label: ct('Key ID'), value: result.key.key_id }],
                warning: ct('Saved into this page’s .env in memory only. Copy .env before navigating away; the secret is never shown again and is not stored in your browser.'),
              });
              onIssued(result);
              toast(ct('.env updated with new credential'), { kind: 'success' });
            } catch (error) {
              errorEl.textContent = error.message || error.code;
              return false;
            }
          },
        },
      ],
    });
  }

  container.append(h('div', { class: 'c-card', style: { marginBottom: '14px' } }, [
    h('h2', { class: 'c-card-title' }, ct('Credentials in this file')),
    h('p', { class: 'c-card-sub' }, ct('Secrets cannot be retrieved after creation — they are stored only as one-way verifiers. Issue new credentials to populate the .env, or rotate/revoke them in their sections.')),
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
      h('button', { class: 'c-btn outlined sm', onClick: issueApiKey }, ct('Issue API key')),
      h('button', { class: 'c-btn outlined sm', onClick: issueS3 }, ct('Issue S3 credentials')),
    ]),
  ]));

  renderBlocks();
  container.append(envBlock, jsonBlock, curlBlock);

  container.append(h('div', { class: 'c-grid cols-2', style: { marginTop: '14px' } }, [
    h('div', { class: 'c-card' }, [
      h('h2', { class: 'c-card-title' }, ct('Telegraph Database')),
      h('p', { class: 'c-card-sub' }, ct('A document API backed by Telegram/KV. Collections hold versioned JSON documents with optimistic versions.')),
      h('ul', { style: { fontSize: '13px', color: 'var(--c-text-2)', margin: '0', paddingLeft: '18px' } }, [
        h('li', {}, ct('It is NOT PostgreSQL or Postgres.')),
        h('li', {}, ct('No PostgreSQL wire protocol — no psql.')),
        h('li', {}, ct('No Prisma/Drizzle Postgres compatibility.')),
        h('li', {}, ct('Ordering is id-ascending; filters are exact string matches on indexed fields.')),
      ]),
    ]),
    h('div', { class: 'c-card' }, [
      h('h2', { class: 'c-card-title' }, ct('Object storage & S3')),
      h('p', { class: 'c-card-sub' }, ct('Drive, the object API, and S3 expose one object engine. Uploads from any surface are visible on the others.')),
      h('ul', { style: { fontSize: '13px', color: 'var(--c-text-2)', margin: '0', paddingLeft: '18px' } }, [
        h('li', {}, ct('Object API: Get/Head/Put/Delete/List with a Bearer key.')),
        h('li', {}, ct('S3: Get/Head/Put/Delete/ListObjectsV2 with SigV4, path-style.')),
        h('li', {}, ct('No multipart or presigned URLs yet.')),
        h('li', {}, ct('Objects are private; reads require credentials.')),
      ]),
    ]),
  ]));
}
