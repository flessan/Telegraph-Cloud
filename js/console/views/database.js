import { h, clear, esc, formatDate } from '../util.js';
import { api } from '../api.js';
import { pageHead, openDialog, toast, confirmDialog, emptyState } from '../ui.js';
import { ct } from '../i18n.js';
import { copyButton, codeBlock } from './common.js';

function dbBase(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}/db`;
}

export async function renderDatabase(container, projectId, query) {
  let collections = [];
  let selected = query.get('collection') || null;
  let records = [];
  let cursor = null;
  let hasMore = false;
  let filters = [];
  let loading = false;

  container.append(pageHead(ct('Database'), ct('Telegraph Database is a document database backed by the Telegram/KV journal. Versioned JSON documents, no PostgreSQL wire protocol.'), [
    h('button', { class: 'c-btn outlined', onClick: () => connectExampleDialog(projectId) }, ct('API explorer')),
  ]));

  const layout = h('div', { class: 'c-db-layout' });
  const sidebar = h('div', { class: 'c-card', style: { padding: '12px' } });
  const detail = h('div', {});
  layout.append(sidebar, detail);
  container.append(layout);

  async function loadCollections(prefer) {
    sidebar.innerHTML = `<div class="c-loading"><span class="c-spinner"></span><span>${esc(ct('Loading collections…'))}</span></div>`;
    const page = await api.get(`${dbBase(projectId)}/collections?maxKeys=5000`);
    collections = page.data || [];
    if (page.truncated) toast(ct('Collection list truncated for a very large database'), {});
    renderCollections();
    if ((!selected || !collections.some((c) => c.name === selected)) && prefer) selected = prefer;
    if (!selected && collections[0]) selected = collections[0].name;
    if (selected) loadRecords(); else renderDetailEmpty();
  }

  function renderCollections() {
    clear(sidebar);
    sidebar.append(h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '2px 4px 8px' } }, [
      h('strong', { style: { fontSize: '13px' } }, ct('Collections')),
      h('button', { class: 'c-icon-button', title: ct('New collection'), 'aria-label': ct('New collection'), onClick: () => collectionDialog() }, [
        h('span', { html: '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>' }),
      ]),
    ]));
    const list = h('div', { class: 'c-collection-list', role: 'list' });
    if (!collections.length) {
      list.append(h('p', { style: { color: 'var(--c-text-3)', fontSize: '12.5px', padding: '8px 10px', margin: 0 } }, ct('No collections yet. Create one to start adding records.')));
    }
    for (const collection of collections) {
      list.append(h('button', {
        type: 'button',
        class: 'c-collection-item',
        role: 'listitem',
        ...(collection.name === selected ? { 'aria-current': 'true' } : {}),
        onClick: () => { selected = collection.name; filters = []; renderCollections(); loadRecords(); },
      }, [
        h('span', { class: 'c-fileicon code', html: dbIcon(), style: { width: '20px', display: 'inline-grid' } }),
        h('span', {}, collection.name),
        h('span', { class: 'c-coll-count' }, collection.record_count_truncated ? ct('{n}+', { n: collection.record_count }) : String(collection.record_count)),
      ]));
    }
    sidebar.append(list);
  }

  function renderDetailEmpty() {
    clear(detail);
    detail.append(h('div', { class: 'c-card' }, [
      emptyState({
        icon: 'db',
        title: ct('Select a collection'),
        body: ct('Create a collection first, then add records and expose it through the document API.'),
        actions: [h('button', { class: 'c-btn primary', onClick: () => collectionDialog() }, ct('New collection'))],
      }),
    ]));
  }

  function queryString(cursorValue) {
    const params = new URLSearchParams({ limit: '50' });
    for (const filter of filters) {
      if (filter.field && filter.value !== '') params.set(filter.field, filter.value);
    }
    if (cursorValue) params.set('cursor', cursorValue);
    return params.toString();
  }

  async function loadRecords(append = false) {
    if (!selected) return;
    loading = true;
    if (!append) renderRecordsShell();
    const body = detail.querySelector('[data-records-body]');
    body.append(h('div', { class: 'c-loading' }, [h('span', { class: 'c-spinner' }), h('span', {}, ct('Loading records…'))]));
    try {
      const page = await api.get(`${dbBase(projectId)}/${encodeURIComponent(selected)}?${queryString(append ? cursor : null)}`);
      if (!append) records = [];
      records = records.concat(page.data || []);
      cursor = page.next_cursor || null;
      hasMore = !!page.has_more;
    } catch (error) {
      toast(error.code === 'invalid_query_filter'
        ? ct('Invalid filter: only indexed top-level string-equality fields are supported.')
        : error.message, { kind: 'error' });
      filters = filters.filter((f) => f.field);
    } finally {
      loading = false;
      renderRecords();
    }
  }

  function renderRecordsShell() {
    clear(detail);
    const filterBar = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '12px' } });
    const filterWrap = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', flex: '1' } });
    renderFilters(filterWrap);
    filterBar.append(filterWrap);
    filterBar.append(h('button', {
      class: 'c-btn outlined sm',
      onClick: () => { filters.push({ field: '', value: '' }); renderRecordsShell(); },
    }, ct('+ Filter')));
    filterBar.append(h('button', { class: 'c-btn primary sm', onClick: () => recordDialog(null) }, ct('New record')));

    detail.append(
      h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px', gap: '12px', flexWrap: 'wrap' } }, [
        h('h2', { style: { margin: 0, fontSize: '16px' } }, selected || ''),
        h('span', { style: { color: 'var(--c-text-3)', fontSize: '12px' } }, ct('Ordered by id · filters are exact matches on top-level string fields')),
      ]),
      filterBar,
      h('div', { 'data-records-body': '' }),
    );
  }

  function renderFilters(wrap) {
    clear(wrap);
    filters.forEach((filter, index) => {
      const fieldInput = h('input', { class: 'c-input', type: 'text', placeholder: ct('field'), value: filter.field, style: { width: '130px' }, oninput: (e) => { filter.field = e.target.value; } });
      const valueInput = h('input', { class: 'c-input', type: 'text', placeholder: ct('equals…'), value: filter.value, style: { width: '170px' }, oninput: (e) => { filter.value = e.target.value; } });
      const group = h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, [
        fieldInput, h('span', { 'aria-hidden': 'true' }, '='), valueInput,
        h('button', { class: 'c-icon-button', 'aria-label': ct('Remove filter'), onClick: () => { filters.splice(index, 1); loadRecords(); } }, [
          h('span', { html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' }),
        ]),
      ]);
      wrap.append(group);
    });
    if (!filters.length) {
      wrap.append(h('button', { class: 'c-btn text sm', onClick: () => { filters.push({ field: '', value: '' }); renderRecordsShell(); } }, ct('Add filter')));
      wrap.append(h('button', { class: 'c-btn sm', onClick: () => loadRecords() }, ct('Apply')));
    } else {
      wrap.append(h('button', { class: 'c-btn primary sm', onClick: () => loadRecords() }, ct('Apply')));
    }
  }

  function renderRecords() {
    renderRecordsShell();
    const body = detail.querySelector('[data-records-body]');
    clear(body);
    if (!records.length) {
      body.append(h('div', { class: 'c-card' }, [emptyState({
        icon: 'db',
        title: filters.length ? ct('No matching records') : ct('No records'),
        body: filters.length ? ct('No documents match these exact-match filters.') : ct('Add the first JSON document to this collection.'),
      })]));
      return;
    }
    const wrap = h('div', { class: 'c-table-wrap' });
    const table = h('table', { class: 'c-table' }, [
      h('thead', {}, h('tr', {}, [
        h('th', {}, ct('ID')), h('th', {}, ct('Document')), h('th', {}, ct('Version')), h('th', {}, ct('Updated')), h('th', {}, ''),
      ])),
      h('tbody', {}, records.map((record) => h('tr', {
        class: 'is-clickable',
        onClick: () => recordDialog(record),
      }, [
        h('td', {}, h('code', {}, String(record.id))),
        h('td', { class: 'c-record-cell' }, h('code', {}, JSON.stringify(record.data))),
        h('td', {}, h('span', { class: 'c-badge' }, ct('v{n}', { n: record.version }))),
        h('td', { class: 'c-cell-sub' }, formatDate(record.updated_at)),
        h('td', {}, copyButton(`${window.location.origin}${dbBase(projectId)}/${encodeURIComponent(selected)}/${encodeURIComponent(record.id)}`, { label: '', message: ct('API URL copied') })),
      ]))),
    ]);
    wrap.append(table);
    body.append(wrap);
    if (hasMore) {
      body.append(h('div', { class: 'c-pager' }, [
        h('button', { class: 'c-btn outlined sm', disabled: loading, onClick: () => loadRecords(true) }, ct('Load more')),
      ]));
    }
  }

  function collectionDialog() {
    let fields = [
      { name: 'name', type: 'text', required: true },
      { name: 'description', type: 'text', required: false },
    ];
    const nameInput = h('input', { class: 'c-input', type: 'text', placeholder: 'products', pattern: '[a-z][a-z0-9_-]*' });
    const descriptionInput = h('textarea', { class: 'c-input', rows: 3, placeholder: ct('Optional description') });
    const fieldsWrap = h('div', { style: { display: 'grid', gap: '8px' } });

    function renderFields() {
      clear(fieldsWrap);
      fields.forEach((field, index) => {
        const name = h('input', { class: 'c-input', type: 'text', value: field.name, placeholder: 'field_name', oninput: (e) => { field.name = e.target.value.trim(); } });
        const type = h('select', { class: 'c-input', value: field.type, onchange: (e) => { field.type = e.target.value; } }, [
          ...['text', 'number', 'boolean', 'datetime', 'json', 'file', 'select'].map((value) => h('option', { value, ...(value === field.type ? { selected: true } : {}) }, value)),
        ]);
        const required = h('input', { type: 'checkbox', checked: field.required, onchange: (e) => { field.required = e.target.checked; } });
        fieldsWrap.append(h('div', { class: 'c-card', style: { padding: '10px', display: 'grid', gridTemplateColumns: '1fr 150px auto auto', gap: '8px', alignItems: 'center' } }, [
          name, type,
          h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px' } }, [required, ct('Required')]),
          h('button', { class: 'c-icon-button', 'aria-label': ct('Remove field'), onClick: () => { fields.splice(index, 1); renderFields(); } }, [
            h('span', { html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>' }),
          ]),
        ]));
      });
    }
    renderFields();

    const errorEl = h('span', { class: 'c-field-error', role: 'alert' });
    const save = async (close) => {
      errorEl.textContent = '';
      const name = nameInput.value.trim();
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
        errorEl.textContent = ct('Collection names start with a lowercase letter and contain only letters, numbers, underscore, or hyphen.');
        return false;
      }
      const cleanFields = fields.filter((field) => field.name).map((field) => ({
        name: field.name,
        type: field.type,
        required: !!field.required,
      }));
      try {
        await api.post(dbBase(projectId) + '/collections', {
          name,
          description: descriptionInput.value.trim(),
          fields: cleanFields,
        });
        toast(ct('Collection created'), { kind: 'success' });
        close();
        selected = name;
        await loadCollections(name);
      } catch (error) {
        errorEl.textContent = error.code === 'collection_exists' ? ct('A collection with this name already exists.') : (error.message || error.code);
        return false;
      }
    };

    openDialog({
      title: ct('New collection'),
      subtitle: ct('Define the collection before adding records.'),
      size: 'lg',
      body: [
        h('label', { class: 'c-field' }, [h('span', { class: 'c-field-label' }, ct('Collection name')), nameInput]),
        h('label', { class: 'c-field' }, [h('span', { class: 'c-field-label' }, ct('Description')), descriptionInput]),
        h('div', {}, [
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } }, [
            h('strong', {}, ct('Fields')),
            h('button', { class: 'c-btn outlined sm', onClick: () => { fields.push({ name: 'field_' + (fields.length + 1), type: 'text', required: false }); renderFields(); } }, ct('+ Add field')),
          ]),
          fieldsWrap,
        ]),
        errorEl,
      ],
      actions: [
        { label: ct('Cancel'), variant: 'outlined' },
        { label: ct('Create collection'), variant: 'primary', onClick: save, keepOpen: true },
      ],
    });
    setTimeout(() => nameInput.focus(), 40);
  }

  function recordDialog(existing) {
    const collectionName = existing ? selected : null;
    let workingCollection = collectionName;
    const dataDoc = existing ? existing.data : { name: 'example' };
    const collectionInput = h('input', {
      class: 'c-input', type: 'text', value: workingCollection || '',
      ...(existing ? { disabled: true } : {}),
      placeholder: 'users',
      pattern: '[a-z][a-z0-9_-]*',
      oninput: (e) => { workingCollection = e.target.value.trim(); },
    });
    const editor = h('textarea', { class: 'c-json-editor', spellcheck: 'false', id: 'c-json-editor' }, JSON.stringify(dataDoc, null, 2));
    const errorEl = h('span', { class: 'c-field-error', role: 'alert' });
    const metaEl = h('div', { class: 'c-alert', hidden: !existing });

    function refreshMeta(record, history) {
      metaEl.hidden = !record;
      metaEl.innerHTML = '';
      if (!record) return;
      metaEl.append(h('p', {}, [
        h('strong', {}, ct('ID ')), h('code', {}, String(record.id)),
        ' · ', h('strong', {}, ct('Version ')), String(record.version),
        ' · ', h('strong', {}, ct('Updated ')), formatDate(record.updated_at),
      ]));
      if (history?.length) {
        metaEl.append(h('p', { style: { marginTop: '6px' } }, history.map((v) => ct('v{version} {operation}{deleted}', {
          version: v.version,
          operation: v.operation,
          deleted: v.deleted ? ct(' (deleted)') : '',
        })).join(' · ')));
      }
    }
    if (existing) {
      api.get(`${dbBase(projectId)}/${encodeURIComponent(selected)}/${encodeURIComponent(existing.id)}/history`).then((page) => {
        refreshMeta(existing, page.data || []);
      }).catch(() => refreshMeta(existing, []));
    }

    const save = async (close) => {
      errorEl.textContent = '';
      let parsed;
      try {
        parsed = JSON.parse(editor.value);
      } catch (_) {
        errorEl.textContent = ct('Invalid JSON.');
        return false;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errorEl.textContent = ct('Documents must be JSON objects.');
        return false;
      }
      const coll = workingCollection;
      if (!coll || !/^[a-z][a-z0-9_-]*$/.test(coll)) {
        errorEl.textContent = ct('Collection names start with a lowercase letter and contain only letters, numbers, underscore, or hyphen.');
        return false;
      }
      try {
        if (existing) {
          await api.patch(`${dbBase(projectId)}/${encodeURIComponent(coll)}/${encodeURIComponent(existing.id)}`, {
            ...parsed,
            _expected_version: existing.version,
          });
          toast(ct('Record updated'), { kind: 'success' });
        } else {
          await api.post(`${dbBase(projectId)}/${encodeURIComponent(coll)}`, parsed);
          toast(ct('Record created'), { kind: 'success' });
          selected = coll;
        }
        close();
        loadCollections(coll);
      } catch (error) {
        if (error.code === 'version_conflict') errorEl.textContent = ct('The record changed on the server (version conflict). Reload and try again.');
        else errorEl.textContent = error.message || error.code;
        return false;
      }
    };

    const remove = async () => {
      const ok = await confirmDialog({
        title: ct('Delete record?'),
        body: ct('Record {id} will receive a new deleted revision. Deletion uses the document journal and is versioned, not a physical purge.', { id: existing.id }),
        confirmLabel: ct('Delete record'),
        danger: true,
      });
      if (!ok) return false;
      try {
        await api.del(`${dbBase(projectId)}/${encodeURIComponent(selected)}/${encodeURIComponent(existing.id)}`, {
          _expected_version: existing.version,
        });
        toast(ct('Record deleted'));
        loadRecords();
      } catch (error) {
        toast(error.code === 'version_conflict' ? ct('Version conflict — reload and retry.') : error.message, { kind: 'error' });
      }
    };

    openDialog({
      title: existing ? ct('Record · {collection}', { collection: selected }) : ct('New record'),
      size: 'lg',
      body: [
        h('label', { class: 'c-field' }, [h('span', { class: 'c-field-label' }, ct('Collection')), collectionInput]),
        h('label', { class: 'c-field' }, [
          h('span', { class: 'c-field-label' }, ct('Document (JSON)')),
          editor,
          h('span', { class: 'c-field-hint' }, ct('Reserved keys (id, version, created_at, _expected_version, …) are managed by the database.')),
          errorEl,
        ]),
        metaEl,
      ],
      actions: [
        ...(existing ? [{ label: ct('Delete'), variant: 'danger', onClick: remove, keepOpen: true }] : []),
        { label: ct('Cancel'), variant: 'outlined' },
        { label: existing ? ct('Save new revision') : ct('Create record'), variant: 'primary', onClick: save, keepOpen: true },
      ],
    });
    setTimeout(() => editor.focus(), 40);
    editor.addEventListener('keydown', (event) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        const start = editor.selectionStart;
        editor.value = `${editor.value.slice(0, start)}  ${editor.value.slice(editor.selectionEnd)}`;
        editor.selectionStart = editor.selectionEnd = start + 2;
      }
    });
  }

  function connectExampleDialog() {
    const origin = window.location.origin;
    openDialog({
      title: ct('Document API explorer'),
      subtitle: ct('Telegraph Database — a versioned document API. It is not PostgreSQL.'),
      size: 'lg',
      body: [
        h('div', { class: 'c-alert' }, [
          h('p', {}, ct('There is no Postgres wire protocol, no psql, and no Prisma/Drizzle PostgreSQL compatibility. Use the HTTP document API with a Bearer API key.')),
        ]),
        snippetBlock(ct('List records'), `curl ${origin}/api/db/users?limit=20 \\\n  -H "Authorization: Bearer $TELEGRAPH_API_KEY"`),
        snippetBlock(ct('Create a record'), `curl -X POST ${origin}/api/db/users \\\n  -H "Authorization: Bearer $TELEGRAPH_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"name":"Thio","role":"admin"}'`),
        snippetBlock(ct('Update (optimistic version)'), `curl -X PATCH ${origin}/api/db/users/rec_… \\\n  -H "Authorization: Bearer $TELEGRAPH_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"role":"owner","_expected_version":1}'`),
      ],
      actions: [{ label: ct('Close'), variant: 'primary' }],
    });
  }

  loadCollections(query.get('collection'));
}

function dbIcon() {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6M4.5 11.5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6"/></svg>';
}

function snippetBlock(label, code) {
  return h('div', { style: { marginBottom: '12px' } }, [
    h('div', { class: 'c-snippet-head' }, [h('span', { class: 'c-snippet-label' }, label)]),
    codeBlock(code),
  ]);
}
