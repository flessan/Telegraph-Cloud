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
    const url = origin + endpoint.path.replace('{id}', '{id}');
    const auth = 'Bearer tg_live_…';

    function curlText() {
      const lines = [`curl -s ${url.replace('{id}', 'rec_…')}`];
      if (endpoint.method !== 'GET') lines[0] = `curl -s -X ${endpoint.method} ${url.replace('{id}', 'rec_…')}`;
      lines.push(`  -H "Authorization: Bearer $TELEGRAPH_API_KEY"`);
      if (endpoint.body) {
        lines.push(`  -H "Content-Type: application/json"`);
        lines.push(`  -d '${endpoint.body}'`);
      }
      if (endpoint.method === 'GET' && endpoint.path.includes('limit')) {
        lines.splice(1, 0, `  "${url.replace('{id}', 'rec_…')}?limit=20"`);
        lines[0] = 'curl -s';
      }
      return lines.join(' \\\n');
    }

    function jsText() {
      const method = endpoint.method.toLowerCase();
      const bodyLine = endpoint.body ? `  method: '${method}',\n  headers: { 'Authorization': \`Bearer \${process.env.TELEGRAPH_API_KEY}\`, 'Content-Type': 'application/json' },\n  body: JSON.stringify(${endpoint.body}),` : `  headers: { 'Authorization': \`Bearer \${process.env.TELEGRAPH_API_KEY}\` },`;
      return `const res = await fetch('${url.replace('{id}', 'rec_…')}', {\n${bodyLine}\n});\nconst json = await res.json();`;
    }

    function pyText() {
      const method = endpoint.method;
      const lines = [
        `import os`,
        `import requests`,
        ``,
        `response = requests.${method.toLowerCase()}(`,
        `    "${url.replace('{id}', 'rec_…')}",`,
        `    auth=("", os.environ["TELEGRAPH_API_KEY"]),`,
      ];
      if (endpoint.body) {
        lines.push(`    json=${endpoint.body.replace(/\n /g, '').replace(/\n/g, '')},`);
      }
      lines.push(`)`);
      lines.push(`print(response.json())`);
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
    renderCode();

    const responseEl = h('pre', { style: { display: 'none' } }, '');

    const tryIt = async () => {
      // Runs against the dashboard-session project route (this browser's
      // console session), never with a developer key from the client.
      tryItBtn.disabled = true;
      try {
        const path = endpoint.path
          .replace('{id}', 'rec_…')
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

    return h('div', { class: 'c-card', style: { padding: '14px 16px', marginBottom: '12px' } }, [
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
        h('span', { style: { flex: 1 } }),
        tryItBtn,
      ]),
      codeWrap,
      responseEl,
    ]);
  }
}
