// API Explorer: per-collection request builder for the document API.
// Shows endpoint, method, authentication, parameters, request body, and
// response shape, with copy-ready cURL / JavaScript / Python examples and a
// "Try it" runner. Examples reference the TELEGRAPH_API_KEY environment
// variable — no secret value is ever embedded or stored.
import { h, clear, esc } from '../util.js';
import { api } from '../api.js';
import { toast } from '../ui.js';
import { ct } from '../i18n.js';
import { copyButton, codeBlock } from './common.js';

function dbBase(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}/db`;
}

export async function renderExplorer(container, projectId, query) {
  let collections = [];
  let selected = query.get('collection') || null;
  let collection = null;

  const pickerRow = h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap' } }, [
    h('span', { style: { fontSize: '13px', color: 'var(--c-text-2)' } }, ct('Collection')),
  ]);
  const picker = h('select', { class: 'c-input', style: { width: '260px' } });
  picker.addEventListener('change', () => { selected = picker.value || null; renderEndpoints(); });
  pickerRow.append(picker);
  container.append(pickerRow);

  const wrap = h('div', {});
  container.append(wrap);

  api.get(`${dbBase(projectId)}/collections?maxKeys=1000`).then(async (page) => {
    collections = page.data || [];
    clear(picker);
    picker.append(h('option', { value: '' }, ct('Select a collection…')));
    for (const item of collections) picker.append(h('option', { value: item.name }, item.name));
    if (!selected && collections[0]) selected = collections[0].name;
    picker.value = selected || '';
    renderEndpoints();
  }).catch((error) => {
    clear(wrap);
    wrap.append(h('div', { class: 'c-card c-error-state', role: 'alert' }, [
      h('h3', {}, ct('Explorer could not be loaded')),
      h('p', {}, error.message || error.code),
    ]));
  });

  function currentCollection() {
    collection = collections.find((c) => c.name === selected) || null;
    return collection;
  }

  function sampleDocument(def) {
    if (def?.fields?.length) {
      const sample = {};
      for (const field of def.fields) {
        if (field.default !== undefined) { sample[field.name] = field.default; continue; }
        switch (field.type) {
          case 'number': sample[field.name] = 0; break;
          case 'boolean': sample[field.name] = false; break;
          case 'datetime': sample[field.name] = '2026-09-20T00:00:00.000Z'; break;
          case 'json': sample[field.name] = {}; break;
          case 'file': sample[field.name] = 'assets/example.png'; break;
          case 'select': sample[field.name] = field.options?.[0] || ''; break;
          default: sample[field.name] = 'text';
        }
      }
      return sample;
    }
    return { name: 'example' };
  }

  function renderEndpoints() {
    clear(wrap);
    const def = currentCollection();
    if (!def) {
      wrap.append(h('div', { class: 'c-card' }, [
        h('p', { style: { margin: 0, color: 'var(--c-text-2)' } }, ct('Select a collection to inspect its endpoints. Endpoint paths use the public document API with a Bearer developer key.')),
      ]));
      return;
    }
    const origin = window.location.origin;
    wrap.append(h('p', { style: { margin: '0 0 12px', color: 'var(--c-text-2)', fontSize: '13px' } }, [
      ct('The full surface is also described by '),
      h('a', { href: `${origin}/openapi.json`, target: '_blank', rel: 'noopener', style: { color: 'var(--c-primary)' } }, '/openapi.json'),
      ' · ',
      h('a', { href: `${origin}/api/projects/${encodeURIComponent(projectId)}/openapi.json`, target: '_blank', rel: 'noopener', style: { color: 'var(--c-primary)' } }, ct('project OpenAPI with schema-aware examples')),
      '.',
    ]));
    const name = def.name;
    const sample = sampleDocument(def);
    const sampleJson = JSON.stringify(sample, null, 2);

    const endpoints = [
      {
        method: 'GET',
        path: `/api/db/${name}`,
        summary: ct('List documents'),
        params: [
          ['limit', 'number', ct('Page size (1–100, default 20)')],
          ['cursor', 'string', ct('Opaque pagination cursor from the previous page')],
          ['<field>=<value>', 'string', ct('Exact-match filter on a top-level string field (repeatable)')],
        ],
        body: null,
        response: { data: [{ id: 'rec_…', version: 1, created_at: '…', updated_at: '…', ...sample }], has_more: false, next_cursor: null },
      },
      {
        method: 'POST',
        path: `/api/db/${name}`,
        summary: ct('Create a document'),
        params: [['Idempotency-Key', 'header', ct('Optional; retries of the same key return the original result')]],
        body: sampleJson,
        response: { data: { id: 'rec_…', version: 1, created_at: '…', updated_at: '…', ...sample } },
      },
      {
        method: 'GET',
        path: `/api/db/${name}/{id}`,
        summary: ct('Read one document'),
        params: [['id', 'path', ct('Server-generated record ID')]],
        body: null,
        response: { data: { id: 'rec_…', version: 1, created_at: '…', updated_at: '…', ...sample } },
      },
      {
        method: 'PATCH',
        path: `/api/db/${name}/{id}`,
        summary: ct('Update a document (new revision)'),
        params: [['id', 'path', ct('Server-generated record ID')]],
        body: JSON.stringify({ ...(def.fields?.length ? {} : { role: 'owner' }), _expected_version: 1 }, null, 2),
        response: { data: { id: 'rec_…', version: 2, created_at: '…', updated_at: '…' } },
      },
      {
        method: 'DELETE',
        path: `/api/db/${name}/{id}`,
        summary: ct('Delete a document (versioned tombstone)'),
        params: [['id', 'path', ct('Server-generated record ID')]],
        body: JSON.stringify({ _expected_version: 1 }, null, 2),
        response: { data: { id: 'rec_…', deleted: true, version: 2 } },
      },
    ];

    for (const endpoint of endpoints) {
      wrap.append(endpointCard(endpoint, def, sampleJson));
    }
  }

  function endpointCard(endpoint, def, sampleJson) {
    const origin = window.location.origin;
    const auth = 'Bearer tg_live_…';
    const isRecordLevel = endpoint.path.includes('{id}');
    // Record-level Try-it and snippets use a real ID supplied by the user;
    // snippets fall back to a $RECORD_ID shell/environment placeholder.
    let recordId = '';

    function curlTarget() {
      return origin + endpoint.path.replace('{id}', recordId || '$RECORD_ID');
    }

    function curlText() {
      const target = curlTarget();
      const lines = [endpoint.method === 'GET'
        ? `curl -s ${target}`
        : `curl -s -X ${endpoint.method} ${target}`];
      lines.push('  -H "Authorization: Bearer $TELEGRAPH_API_KEY"');
      if (endpoint.body) {
        lines.push('  -H "Content-Type: application/json"');
        lines.push(`  -d '${endpoint.body}'`);
      }
      return lines.join(' \\\n');
    }

    function jsText() {
      const method = endpoint.method.toLowerCase();
      const url = curlTarget().replace('$RECORD_ID', '${RECORD_ID}');
      const bodyLine = endpoint.body
        ? `  method: '${method}',\n  headers: { 'Authorization': \`Bearer \${process.env.TELEGRAPH_API_KEY}\`, 'Content-Type': 'application/json' },\n  body: JSON.stringify(${endpoint.body}),`
        : `  method: '${method}',\n  headers: { 'Authorization': \`Bearer \${process.env.TELEGRAPH_API_KEY}\` },`;
      return `const res = await fetch('${url}', {\n${bodyLine}\n});\nconst json = await res.json();`;
    }

    function pyText() {
      const url = curlTarget().replace('$RECORD_ID', '${RECORD_ID}');
      const lines = [
        'import os',
        'import requests',
        '',
        `response = requests.${endpoint.method.toLowerCase()}(`,
        `    "${url}",`,
        `    headers={"Authorization": f"Bearer {os.environ['TELEGRAPH_API_KEY']}"},`,
      ];
      if (endpoint.body) {
        lines.push(`    json=${endpoint.body.replace(/\n /g, '').replace(/\n/g, '')},`);
      }
      lines.push(')');
      lines.push('print(response.json())');
      return lines.join('\n');
    }

    const paramsTable = endpoint.params.length
      ? h('table', { class: 'c-table', style: { margin: '10px 0' } }, [
        h('thead', {}, h('tr', {}, [h('th', {}, ct('Parameter')), h('th', {}, ct('Type')), h('th', {}, ct('Description'))])),
        h('tbody', {}, endpoint.params.map(([param, type, description]) => h('tr', {}, [
          h('td', {}, h('code', {}, param)),
          h('td', {}, type),
          h('td', { class: 'c-cell-sub' }, description),
        ]))),
      ])
      : null;

    const codeWrap = h('div', {});
    let activeLang = 'curl';
    function renderCode() {
      clear(codeWrap);
      const texts = { curl: curlText(), javascript: jsText(), python: pyText() };
      const langs = [['curl', ct('cURL')], ['javascript', ct('JavaScript')], ['python', ct('Python')]];
      codeWrap.append(h('div', { class: 'c-subtabs', role: 'tablist', style: { marginBottom: '8px' } },
        langs.map(([key, label]) => h('button', {
          type: 'button',
          class: `c-subtab${key === activeLang ? ' is-active' : ''}`,
          role: 'tab',
          'aria-selected': String(key === activeLang),
          onClick: () => { activeLang = key; renderCode(); },
        }, label))));
      codeWrap.append(codeBlock(texts[activeLang], {}));
    }

    function sectionLabel(text) {
      return h('p', { style: { margin: '10px 0 6px', fontSize: '12px', color: 'var(--c-text-2)', fontWeight: '600' } }, text);
    }

    // Record ID control for record-level endpoints: feeds Try-it and, when
    // filled, the copied snippets.
    const recordIdInput = isRecordLevel
      ? h('input', {
        class: 'c-input', type: 'text', placeholder: 'rec_…', spellcheck: 'false',
        'aria-label': ct('Record ID'), style: { width: '260px', fontFamily: 'var(--c-font-mono, monospace)' },
        oninput: (event) => { recordId = event.target.value.trim(); renderCode(); },
      })
      : null;

    const responseEl = h('pre', { style: { display: 'none' } }, '');

    const tryIt = async () => {
      // Runs against the dashboard-session project route (this browser's
      // console session), never with a developer key from the client.
      if (isRecordLevel && !recordId) {
        toast(ct('Enter a record ID to try this endpoint.'), { kind: 'error' });
        recordIdInput?.focus();
        return;
      }
      tryItBtn.disabled = true;
      try {
        const path = endpoint.path
          .replace('{id}', encodeURIComponent(recordId))
          .replace(/^\/api\/db/, `/api/projects/${encodeURIComponent(projectId)}/db`);
        const init = { method: endpoint.method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
        if (endpoint.body) {
          init.headers['Content-Type'] = 'application/json';
          init.body = endpoint.body;
        }
        const res = await fetch(path, init);
        const text = await res.text();
        let pretty;
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (_) { pretty = text; }
        responseEl.textContent = `${res.status} ${res.statusText}\n\n${pretty}`;
        responseEl.style.display = 'block';
        responseEl.scrollIntoView({ block: 'nearest' });
      } catch (error) {
        toast(error.message || String(error), { kind: 'error' });
      } finally {
        tryItBtn.disabled = false;
      }
    };
    const tryItBtn = h('button', { class: 'c-btn outlined sm', onClick: tryIt }, ct('Try it'));
    renderCode();

    return h('div', { class: 'c-card', style: { padding: '14px 16px', marginBottom: '12px' }, 'data-explorer-endpoint': endpoint.method }, [
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, [
        h('span', { class: 'c-badge', style: { fontFamily: 'monospace', minWidth: '58px', textAlign: 'center' } }, endpoint.method),
        h('code', { style: { fontSize: '13px', wordBreak: 'break-all' } }, endpoint.path),
        h('span', { style: { color: 'var(--c-text-2)', fontSize: '12.5px' } }, endpoint.summary),
      ]),
      paramsTable,
      h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', margin: '8px 0', flexWrap: 'wrap' } }, [
        h('span', { style: { fontSize: '12px', color: 'var(--c-text-2)' } }, ct('Authentication')),
        h('code', {}, auth),
        copyButton(auth),
        ...(isRecordLevel ? [
          h('span', { style: { fontSize: '12px', color: 'var(--c-text-2)', marginLeft: '8px' } }, ct('Record ID')),
          recordIdInput,
        ] : []),
        h('span', { style: { flex: 1 } }),
        tryItBtn,
      ]),
      endpoint.body ? h('div', {}, [
        sectionLabel(ct('Request body')),
        codeBlock(endpoint.body, {}),
      ]) : null,
      h('div', {}, [
        sectionLabel(ct('Response')),
        codeBlock(JSON.stringify(endpoint.response, null, 2), {}),
      ]),
      sectionLabel(ct('Examples')),
      codeWrap,
      responseEl,
    ]);
  }
}
