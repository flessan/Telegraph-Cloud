// Connect: the developer onboarding center for a project.
//
// Sections: Quick Start · Environment · API · SDK / cURL.
// All examples are generated for this project (TELEGRAPH_URL,
// TELEGRAPH_PROJECT, TELEGRAPH_API_KEY). Issued secrets live in this page's
// memory only — never localStorage, never a URL — and snippets reference the
// environment variable instead of embedding the secret.
import { h } from '../util.js';
import { api } from '../api.js';
import { pageHead, openDialog, toast } from '../ui.js';
import { ct } from '../i18n.js';
import { copyButton, codeBlock, oneTimeSecretDialog, scopeCheckboxes } from './common.js';
import { projectPath } from '../router.js';

function base(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}`;
}

export async function renderConnect(container, projectId) {
  const origin = window.location.origin;
  // Session-only secret memory. Cleared when the page unloads; never
  // written to localStorage, sessionStorage, or any URL.
  const secrets = { apiKey: '', s3AccessKeyId: '', s3SecretAccessKey: '' };

  container.append(pageHead(
    ct('Connect your app'),
    ct('Connection settings for the document API, object storage, and S3. Secrets are shown once when created and never stored by the browser.'),
  ));

  // ------------------------------------------------------------- jump nav
  const sections = [
    ['connect-quickstart', ct('Quick Start')],
    ['connect-environment', ct('Environment')],
    ['connect-api', ct('API')],
    ['connect-sdk', ct('SDK / cURL')],
  ];
  container.append(h('div', { class: 'c-subtabs', role: 'navigation', style: { marginBottom: '14px' } },
    sections.map(([id, label]) => h('button', {
      type: 'button',
      class: 'c-subtab',
      onClick: () => document.getElementById(id)?.scrollIntoView({ block: 'start' }),
    }, label))));

  // ----------------------------------------------------- generated content
  function envText() {
    return [
      `# Telegraph Cloud — ${projectId}`,
      `TELEGRAPH_URL=${origin}`,
      `TELEGRAPH_PROJECT=${projectId}`,
      '# Bearer developer API key (document + object APIs)',
      `TELEGRAPH_API_KEY=${secrets.apiKey || 'tg_live_create_a_key_below'}`,
      '',
      '# S3-compatible object storage (separate credentials)',
      `S3_ENDPOINT=${origin}/s3`,
      'S3_REGION=us-east-1',
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
    // The key always comes from the environment — it is never embedded in a
    // copied shell command.
    return [
      '# Requires the .env above (export TELEGRAPH_URL, TELEGRAPH_API_KEY).',
      '# List documents in a collection (id-ascending, exact-match filters)',
      `curl "${origin}/api/db/users?limit=20" \\`,
      '  -H "Authorization: Bearer $TELEGRAPH_API_KEY"',
      '',
      '# Create a document (schema-validated; returns version 1)',
      `curl -X POST "${origin}/api/db/users" \\`,
      '  -H "Authorization: Bearer $TELEGRAPH_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      `  -d '${JSON.stringify({ name: 'Thio' })}'`,
      '',
      '# Update with optimistic concurrency (409 version_conflict on a stale version)',
      'curl -X PATCH "' + `${origin}/api/db/users/rec_…` + '" \\',
      '  -H "Authorization: Bearer $TELEGRAPH_API_KEY" \\',
      '  -H "Content-Type: application/json" \\',
      "  -d '{\"role\": \"owner\", \"_expected_version\": 1}'",
      '',
      '# Upload an object (same engine as Drive and S3)',
      `curl -X PUT --data-binary @logo.png \\`,
      '  -H "Authorization: Bearer $TELEGRAPH_API_KEY" \\',
      '  -H "Content-Type: image/png" \\',
      `${origin}/api/storage/assets/logo.png`,
    ].join('\n');
  }

  function jsText() {
    return [
      '// Node 18+ (or any fetch runtime). Load values from your environment —',
      '// never hard-code the key in source control.',
      `const TELEGRAPH_URL = process.env.TELEGRAPH_URL ?? '${origin}';`,
      'const TELEGRAPH_API_KEY = process.env.TELEGRAPH_API_KEY;',
      '',
      'async function request(path, options = {}) {',
      '  const res = await fetch(`${TELEGRAPH_URL}${path}`, {',
      '    ...options,',
      '    headers: {',
      '      Authorization: `Bearer ${TELEGRAPH_API_KEY}`,',
      '      ...options.headers,',
      '    },',
      '  });',
      '  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);',
      '  return res.json();',
      '}',
      '',
      '// List documents (id-ascending, exact-match filters)',
      'const page = await request(\'/api/db/users?limit=20\');',
      '',
      '// Create a document (version 1)',
      'const created = await request(\'/api/db/users\', {',
      '  method: \'POST\',',
      '  headers: { \'Content-Type\': \'application/json\' },',
      '  body: JSON.stringify({ name: \'Thio\' }),',
      '});',
      '',
      '// Update with optimistic concurrency',
      'const updated = await request(`/api/db/users/${created.data.id}`, {',
      '  method: \'PATCH\',',
      '  headers: { \'Content-Type\': \'application/json\' },',
      '  body: JSON.stringify({ role: \'owner\', _expected_version: created.data.version }),',
      '});',
    ].join('\n');
  }

  function renderCode(wrap, code, label) {
    wrap.innerHTML = '';
    wrap.append(
      h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } }, [
        h('span', { class: 'c-snippet-label' }, label),
        copyButton(code, { message: ct('{label} copied', { label }) }),
      ]),
      h('pre', {}, [h('code', {}, code)]),
    );
  }

  const envBlock = h('div', { class: 'c-code-block' });
  const jsonBlock = h('div', { class: 'c-code-block' });
  const curlBlock = h('div', { class: 'c-code-block' });
  const jsBlock = h('div', { class: 'c-code-block' });

  function renderBlocks() {
    renderCode(envBlock, envText(), '.env');
    renderCode(jsonBlock, jsonText(), 'JSON config');
    renderCode(curlBlock, curlText(), 'cURL');
    renderCode(jsBlock, jsText(), 'JavaScript');
  }

  // ------------------------------------------------------------ quick start
  const apiKeyStatus = h('span', {});
  const s3Status = h('span', {});

  function renderCredentialStatus() {
    apiKeyStatus.textContent = secrets.apiKey
      ? ct('API key in memory for this session')
      : ct('No API key issued in this session yet');
    s3Status.textContent = secrets.s3AccessKeyId
      ? ct('S3 credentials in memory for this session')
      : ct('No S3 credentials issued in this session yet');
  }

  function section(id, title, subtitle) {
    const el = h('section', { class: 'c-section', id, style: { marginTop: '18px' } });
    el.append(h('div', { class: 'c-section-head' }, [
      h('h2', { class: 'c-section-title' }, title),
      subtitle ? h('span', { style: { color: 'var(--c-text-2)', fontSize: '13px' } }, subtitle) : null,
    ]));
    container.append(el);
    return el;
  }

  const quick = section('connect-quickstart', ct('Quick Start'), ct('Three steps to your first successful request.'));
  quick.append(h('div', { class: 'c-card', style: { padding: '16px 18px' } }, [
    h('ol', { style: { margin: 0, paddingLeft: '20px', display: 'grid', gap: '10px', fontSize: '13.5px' } }, [
      h('li', {}, [
        h('strong', {}, ct('Step 1 — issue credentials')),
        h('div', { style: { marginTop: '6px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
          h('button', { class: 'c-btn outlined sm', onClick: () => issueApiKey() }, ct('Issue API key')),
          h('button', { class: 'c-btn outlined sm', onClick: () => issueS3() }, ct('Issue S3 credentials')),
          apiKeyStatus,
          s3Status,
        ]),
        h('p', { style: { margin: '6px 0 0', color: 'var(--c-text-2)', fontSize: '12.5px' } }, ct('Secrets are shown exactly once and kept only in this page’s memory — never in your browser storage.')),
      ]),
      h('li', {}, [
        h('strong', {}, ct('Step 2 — copy your .env')),
        h('div', { style: { marginTop: '6px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
          copyButton(envText(), { message: ct('{label} copied', { label: '.env' }) }),
          h('button', {
            class: 'c-btn text sm',
            onClick: () => document.getElementById('connect-environment')?.scrollIntoView({ block: 'start' }),
          }, ct('Show Environment')),
        ]),
      ]),
      h('li', {}, [
        h('strong', {}, ct('Step 3 — make a first request')),
        h('div', { style: { marginTop: '6px', display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } }, [
          copyButton(
            `curl "${origin}/api/db/users?limit=20" -H "Authorization: Bearer $TELEGRAPH_API_KEY"`,
            { message: ct('{label} copied', { label: 'cURL' }) },
          ),
          h('button', {
            class: 'c-btn text sm',
            onClick: () => document.getElementById('connect-sdk')?.scrollIntoView({ block: 'start' }),
          }, ct('Show SDK / cURL')),
          h('a', { class: 'c-btn text sm', href: projectPath(projectId, 'api', 'explorer') }, ct('Open the API Explorer')),
        ]),
      ]),
    ]),
  ]));

  // ------------------------------------------------------------ environment
  const environment = section('connect-environment', ct('Environment'), ct('Project-specific values and the ready-to-copy .env file.'));
  environment.append(h('div', { class: 'c-table-wrap' }, h('table', { class: 'c-table' }, [
    h('thead', {}, h('tr', {}, [
      h('th', {}, ct('Variable')), h('th', {}, ct('Value')), h('th', {}, ct('Purpose')),
    ])),
    h('tbody', {}, [
      envRow('TELEGRAPH_URL', origin, ct('Deployment base URL used in every request.')),
      envRow('TELEGRAPH_PROJECT', projectId, ct('Project ID scoping every document, object, and credential.')),
      envRow('TELEGRAPH_API_KEY', 'tg_live_…', ct('Bearer developer key for the document and object APIs. Shown exactly once at creation.')),
      envRow('S3_ENDPOINT', `${origin}/s3`, ct('S3-compatible endpoint (path-style).')),
      envRow('S3_REGION', 'us-east-1', ct('Fixed region for the S3-compatible endpoint.')),
      envRow('S3_ACCESS_KEY_ID', 'tgsk_live_…', ct('Access key ID for the S3-compatible endpoint.')),
      envRow('S3_SECRET_ACCESS_KEY', '••••••', ct('Secret access key for the S3-compatible endpoint. Shown exactly once at creation.')),
    ]),
  ])));
  environment.append(h('div', { style: { marginTop: '12px' } }, [
    h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' } }, [
      h('button', { class: 'c-btn outlined sm', onClick: () => issueApiKey() }, ct('Issue API key')),
      h('button', { class: 'c-btn outlined sm', onClick: () => issueS3() }, ct('Issue S3 credentials')),
      h('span', { style: { color: 'var(--c-text-2)', fontSize: '12.5px' } }, ct('Issued credentials fill the .env below immediately (in memory).')),
    ]),
    envBlock,
  ]));

  function envRow(variable, value, purpose) {
    return h('tr', {}, [
      h('td', {}, h('code', {}, variable)),
      h('td', {}, h('code', { style: { wordBreak: 'break-all' } }, value)),
      h('td', { class: 'c-cell-sub' }, purpose),
    ]);
  }

  // -------------------------------------------------------------------- API
  const apiSection = section('connect-api', ct('API'), ct('Endpoints for this project. Every collection uses the same generic CRUD routes.'));
  apiSection.append(h('div', { class: 'c-table-wrap' }, h('table', { class: 'c-table' }, [
    h('thead', {}, h('tr', {}, [
      h('th', {}, ct('Surface')), h('th', {}, ct('Endpoint')), h('th', {}, ct('Authentication')),
    ])),
    h('tbody', {}, [
      apiRow(ct('Document API'), [
        `GET·POST ${origin}/api/db/{collection}`,
        `GET·PATCH·DELETE ${origin}/api/db/{collection}/{id}`,
        `GET ${origin}/api/db/{collection}/{id}/history`,
      ], 'Bearer · db:read / db:write'),
      apiRow(ct('Object API'), [
        `PUT·GET·HEAD·DELETE ${origin}/api/storage/{bucket}/{key}`,
        `GET ${origin}/api/storage/{bucket}`,
      ], 'Bearer · storage:read / storage:write'),
      apiRow('S3', [
        `${origin}/s3/{bucket}/{key}`,
        `${origin}/s3/{bucket}`,
      ], 'SigV4 · s3:read / s3:write'),
    ]),
  ])));
  apiSection.append(h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', margin: '10px 0 12px' } }, [
    h('a', { class: 'c-btn outlined sm', href: `${origin}/openapi.json`, target: '_blank', rel: 'noopener' }, 'openapi.json'),
    h('a', { class: 'c-btn outlined sm', href: projectPath(projectId, 'api', 'explorer') }, ct('Open the API Explorer')),
    h('a', { class: 'c-btn outlined sm', href: projectPath(projectId, 'api', 'keys') }, ct('API Keys')),
  ]));
  apiSection.append(jsonBlock);
  apiSection.append(h('div', { class: 'c-grid cols-2', style: { marginTop: '14px' } }, [
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

  function apiRow(surface, endpoints, auth) {
    return h('tr', {}, [
      h('td', {}, surface),
      h('td', {}, endpoints.map((line, index) => [
        index > 0 ? h('br') : null,
        h('code', { style: { wordBreak: 'break-all', fontSize: '12px' } }, line),
      ])),
      h('td', {}, h('span', { class: 'c-badge' }, auth)),
    ]);
  }

  // --------------------------------------------------------------- SDK/cURL
  const sdk = section('connect-sdk', ct('SDK / cURL'), ct('Ready-to-run snippets. The key always comes from your environment — never from a URL or the snippet text.'));
  sdk.append(curlBlock);
  sdk.append(h('div', { style: { height: '12px' } }));
  sdk.append(jsBlock);

  // --------------------------------------------- credential creation (kept)
  function issueApiKey() {
    openIssueDialog({
      title: ct('Issue API key for .env'),
      endpoint: 'keys',
      scopes: ['db:read', 'db:write', 'storage:read', 'storage:write'],
      defaultScopes: ['db:read', 'db:write', 'storage:read', 'storage:write'],
      map: (result) => ({ secret: result.api_key, label: ct('API key') }),
      onIssued(result) {
        secrets.apiKey = result.api_key;
        renderCredentialStatus();
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
        renderCredentialStatus();
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

  renderCredentialStatus();
  renderBlocks();
}

// The four section ids are stable anchors used by the jump nav above.
export const CONNECT_SECTIONS = ['connect-quickstart', 'connect-environment', 'connect-api', 'connect-sdk'];
