// Data section: Collections, Records, and Schema for the project's document
// database. A collection is a first-class resource: it is created explicitly
// with an optional schema before records are added. Schema-less (legacy)
// collections remain fully readable; a schema can be defined on them later.
import { h, clear, esc, formatDate } from '../util.js';
import { api } from '../api.js';
import { pageHead, openDialog, toast, confirmDialog, emptyState } from '../ui.js';
import { ct } from '../i18n.js';
import { subTabs, copyButton, codeBlock } from './common.js';
import { navigate, projectPath } from '../router.js';

const FIELD_TYPES = ['text', 'number', 'boolean', 'datetime', 'json', 'file', 'select'];

function dbBase(projectId) {
  return `/api/projects/${encodeURIComponent(projectId)}/db`;
}

// "+" always means "New collection" in the Data section.
function plusIcon() {
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
}

function newCollectionButton(onOpen) {
  return h('button', { class: 'c-btn primary', onClick: onOpen }, [
    h('span', { 'aria-hidden': 'true', html: plusIcon() }),
    ct('New collection'),
  ]);
}

export async function renderData(container, projectId, query) {
  const tab = ['collections', 'records', 'schema'].includes(query.get('tab')) ? query.get('tab') : 'collections';

  let collections = [];
  let selected = query.get('collection') || null;

  // "+" is the single creation affordance of the Data section and always
  // means "New collection". Collections are first-class resources: they are
  // created explicitly with name, description, and typed fields — never as a
  // side effect of writing a record.
  container.append(pageHead(ct('Data'), ct('Collections, versioned JSON records, and schemas. Backed by the Telegram/KV journal — a document API, not PostgreSQL.'), [
    newCollectionButton(() => collectionDialog()),
  ]));
  container.append(subTabs(projectId, 'data', tab, [
    { tab: 'collections', label: () => ct('Collections') },
    { tab: 'records', label: () => ct('Records') },
    { tab: 'schema', label: () => ct('Schema') },
  ]));

  const body = h('div', {});
  container.append(body);

  async function loadCollections(prefer) {
    body.innerHTML = `<div class="c-loading"><span class="c-spinner"></span><span>${esc(ct('Loading collections…'))}</span></div>`;
    const page = await api.get(`${dbBase(projectId)}/collections?maxKeys=5000`);
    collections = page.data || [];
    if (page.truncated) toast(ct('Collection list truncated for a very large database'), {});
    if ((!selected || !collections.some((c) => c.name === selected)) && prefer) selected = prefer;
    if (!selected && collections[0]) selected = collections[0].name;
    renderTab();
  }

  function selectedCollection() {
    return collections.find((c) => c.name === selected) || null;
  }

  function renderTab() {
    clear(body);
    if (tab === 'collections') renderCollectionsTab(body);
    else if (tab === 'records') renderRecordsTab(body);
    else renderSchemaTab(body);
  }

  // ------------------------------------------------------------ collections
  function renderCollectionsTab(wrap) {
    wrap.append(h('p', { style: { margin: '0 0 12px', color: 'var(--c-text-2)', fontSize: '13px' } }, ct('Collections hold versioned JSON documents. Create a collection first, then add records.')));

    if (!collections.length) {
      wrap.append(h('div', { class: 'c-card' }, [emptyState({
        icon: 'db',
        title: ct('No collections yet'),
        body: ct('Create a collection to start adding records. A collection defines its schema and gets its own REST endpoints.'),
        actions: [newCollectionButton(() => collectionDialog())]
      })]));
      return;
    }

    const table = h('table', { class: 'c-table' }, [
      h('thead', {}, h('tr', {}, [
        h('th', {}, ct('Name')), h('th', {}, ct('Description')), h('th', {}, ct('Fields')),
        h('th', {}, ct('Records')), h('th', {}, ct('Schema')), h('th', {}, ''),
      ])),
      h('tbody', {}, collections.map((collection) => {
        const hasSchema = Array.isArray(collection.fields) && collection.fields.length > 0;
        return h('tr', { class: 'is-clickable', onClick: () => selectCollection(collection.name, 'records') }, [
          h('td', {}, [
            h('span', { class: 'c-fileicon code', html: dbIcon(), style: { width: '20px', display: 'inline-grid', marginRight: '8px', verticalAlign: 'middle' } }),
            h('code', {}, collection.name),
          ]),
          h('td', { class: 'c-cell-sub' }, collection.description || '—'),
          h('td', {}, String(collection.fields?.length || 0)),
          h('td', {}, collection.record_count_truncated ? ct('{n}+', { n: collection.record_count }) : String(collection.record_count || 0)),
          h('td', {}, hasSchema
            ? h('span', { class: 'c-badge active' }, ct('Defined'))
            : h('span', { class: 'c-badge' }, ct('Schema-less'))),
          h('td', {}, [
            h('button', { class: 'c-btn text sm', 'aria-label': ct('Open records'), title: ct('Open records'), onClick: (event) => { event.stopPropagation(); selectCollection(collection.name, 'records'); } }, ct('Records')),
            h('button', { class: 'c-btn text sm', 'aria-label': ct('Open schema'), title: ct('Open schema'), onClick: (event) => { event.stopPropagation(); selectCollection(collection.name, 'schema'); } }, ct('Schema')),
            h('button', { class: 'c-btn text sm', 'aria-label': ct('Delete collection'), title: ct('Delete collection'), onClick: (event) => { event.stopPropagation(); deleteCollection(collection.name); } }, ct('Delete')),
          ]),
        ]);
      })),
    ]);
    wrap.append(h('div', { class: 'c-table-wrap' }, table));
  }

  function selectCollection(name, targetTab) {
    selected = name;
    const hash = `${projectPath(projectId, 'data', targetTab)}&collection=${encodeURIComponent(name)}`;
    navigate(hash);
  }

  async function deleteCollection(name) {
    const ok = await confirmDialog({
      title: ct('Delete collection?'),
      body: ct('Collection {name} can only be deleted while it has no records. Records are deleted individually; deletion is versioned.', { name }),
      confirmLabel: ct('Delete collection'),
      danger: true,
    });
    if (!ok) return;
    try {
      await api.del(`${dbBase(projectId)}/collections/${encodeURIComponent(name)}`);
      toast(ct('Collection deleted'), { kind: 'success' });
      if (selected === name) selected = null;
      await loadCollections();
    } catch (error) {
      toast(error.code === 'collection_not_empty'
        ? ct('This collection still has records. Delete the records first.')
        : (error.message || error.code), { kind: 'error' });
    }
  }

  // --------------------------------------------------------------- records
  let records = [];
  let cursor = null;
  let hasMore = false;
  let filters = [];
  let recordsLoading = false;

  function recordCollectionPicker() {
    const picker = h('select', { class: 'c-input', style: { width: '240px' }, onchange: (event) => selectCollection(event.target.value, 'records') });
    for (const collection of collections) {
      picker.append(h('option', { value: collection.name, ...(collection.name === selected ? { selected: true } : {}) }, collection.name));
    }
    return h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '12px' } }, [
      h('span', { style: { fontSize: '13px', color: 'var(--c-text-2)' } }, ct('Collection')),
      picker,
    ]);
  }

  function renderRecordsTab(wrap) {
    if (!collections.length) {
      wrap.append(h('div', { class: 'c-card' }, [emptyState({
        icon: 'db',
        title: ct('Select a collection'),
        body: ct('Create a collection first, then add records and expose it through the document API.'),
        actions: [newCollectionButton(() => collectionDialog())]
      })]));
      return;
    }
    wrap.append(recordCollectionPicker());

    const filterBar = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '12px' } });
    const filterWrap = h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', flex: '1' } });
    renderFilters(filterWrap, () => renderRecordsTab(wrap));
    filterBar.append(filterWrap);
    filterBar.append(h('button', {
      class: 'c-btn outlined sm',
      onClick: () => { filters.push({ field: '', value: '' }); renderRecordsTab(wrap); },
    }, ct('+ Filter')));
    filterBar.append(h('button', { class: 'c-btn primary sm', onClick: () => recordDialog(null) }, ct('New record')));

    wrap.append(
      h('div', { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px', gap: '12px', flexWrap: 'wrap' } }, [
        h('h2', { style: { margin: 0, fontSize: '16px' } }, selected || ''),
        h('span', { style: { color: 'var(--c-text-3)', fontSize: '12px' } }, ct('Ordered by id · filters are exact matches on top-level string fields')),
      ]),
      filterBar,
      h('div', { 'data-records-body': '' }),
    );
    loadRecords(wrap, false);
  }

  function queryString(cursorValue) {
    const params = new URLSearchParams({ limit: '50' });
    for (const filter of filters) {
      if (filter.field && filter.value !== '') params.set(filter.field, filter.value);
    }
    if (cursorValue) params.set('cursor', cursorValue);
    return params.toString();
  }

  async function loadRecords(wrap, append) {
    if (!selected) return;
    recordsLoading = true;
    const body = wrap.querySelector('[data-records-body]');
    if (!append) {
      clear(body);
      body.append(h('div', { class: 'c-loading' }, [h('span', { class: 'c-spinner' }), h('span', {}, ct('Loading records…'))]));
    }
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
    }
    renderRecords(wrap);
  }

  function renderFilters(filterWrap, rerender) {
    clear(filterWrap);
    filters.forEach((filter, index) => {
      const fieldInput = h('input', { class: 'c-input', type: 'text', placeholder: ct('field'), value: filter.field, style: { width: '130px' }, oninput: (e) => { filter.field = e.target.value; } });
      const valueInput = h('input', { class: 'c-input', type: 'text', placeholder: ct('equals…'), value: filter.value, style: { width: '170px' }, oninput: (e) => { filter.value = e.target.value; } });
      filterWrap.append(h('div', { style: { display: 'flex', gap: '4px', alignItems: 'center' } }, [
        fieldInput, h('span', { 'aria-hidden': 'true' }, '='), valueInput,
        h('button', { class: 'c-icon-button', 'aria-label': ct('Remove filter'), onClick: () => { filters.splice(index, 1); loadRecords(wrapOf(filterWrap), false); } }, [
          h('span', { html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' }),
        ]),
      ]));
    });
    if (!filters.length) {
      filterWrap.append(h('button', { class: 'c-btn text sm', onClick: rerender }, ct('Add filter')));
      filterWrap.append(h('button', { class: 'c-btn sm', onClick: () => loadRecords(wrapOf(filterWrap), false) }, ct('Apply')));
    } else {
      filterWrap.append(h('button', { class: 'c-btn primary sm', onClick: () => loadRecords(wrapOf(filterWrap), false) }, ct('Apply')));
    }
  }

  // The records body's parent is the tab body; resolve it from any child.
  function wrapOf(node) {
    let el = node;
    while (el && !el.querySelector?.('[data-records-body]')) el = el.parentElement;
    return el || body;
  }

  function renderRecords(wrap) {
    const bar = wrap.querySelector('[data-records-body]');
    clear(bar);
    recordsLoading = false;
    if (!records.length) {
      bar.append(h('div', { class: 'c-card' }, [emptyState({
        icon: 'db',
        title: filters.length ? ct('No matching records') : ct('No records'),
        body: filters.length ? ct('No documents match these exact-match filters.') : ct('Add the first JSON document to this collection.'),
      })]));
      return;
    }
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
    bar.append(h('div', { class: 'c-table-wrap' }, table));
    if (hasMore) {
      bar.append(h('div', { class: 'c-pager' }, [
        h('button', { class: 'c-btn outlined sm', disabled: recordsLoading, onClick: () => loadRecords(wrap, true) }, ct('Load more')),
      ]));
    }
  }

  // ---------------------------------------------------------------- schema
  function renderSchemaTab(wrap) {
    if (!collections.length) {
      wrap.append(h('div', { class: 'c-card' }, [emptyState({
        icon: 'db',
        title: ct('Select a collection'),
        body: ct('Create a collection first, then define its schema.'),
        actions: [newCollectionButton(() => collectionDialog())]
      })]));
      return;
    }
    wrap.append(recordCollectionPicker());
    const collection = selectedCollection();
    if (!collection) {
      wrap.append(h('div', { class: 'c-card' }, [emptyState({
        icon: 'db',
        title: ct('Select a collection'),
        body: ct('Choose a collection to view or edit its schema.'),
      })]));
      return;
    }

    const hasSchema = Array.isArray(collection.fields) && collection.fields.length > 0;
    const card = h('div', { class: 'c-card', style: { padding: '16px 18px' } }, [
      h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '10px' } }, [
        h('div', {}, [
          h('h2', { style: { margin: 0, fontSize: '16px' } }, [h('code', {}, collection.name)]),
          collection.description
            ? h('p', { style: { margin: '4px 0 0', color: 'var(--c-text-2)', fontSize: '13px' } }, collection.description)
            : null,
        ]),
        h('button', { class: 'c-btn outlined', onClick: () => renderSchemaEditor(wrap, collection) },
          hasSchema ? ct('Edit schema') : ct('Define schema')),
      ]),
    ]);
    wrap.append(card);

    if (!hasSchema) {
      wrap.append(h('div', { class: 'c-card', style: { padding: '14px 16px' } }, [emptyState({
        icon: 'db',
        title: ct('Schema-less collection'),
        body: ct('This collection accepts arbitrary JSON documents and remains fully readable. Define a schema to validate future writes: required fields, types, defaults, and select options.'),
        actions: [h('button', { class: 'c-btn primary', onClick: () => renderSchemaEditor(wrap, collection) }, ct('Define schema'))],
      })]));
      return;
    }

    const fieldsTable = h('table', { class: 'c-table' }, [
      h('thead', {}, h('tr', {}, [
        h('th', {}, ct('Field')), h('th', {}, ct('Type')), h('th', {}, ct('Required')), h('th', {}, ct('Default')), h('th', {}, ct('Options')),
      ])),
      h('tbody', {}, collection.fields.map((field) => h('tr', {}, [
        h('td', {}, h('code', {}, field.name)),
        h('td', {}, h('span', { class: 'c-badge' }, field.type)),
        h('td', {}, field.required ? ct('Yes') : ct('No')),
        h('td', {}, field.default !== undefined ? h('code', {}, JSON.stringify(field.default)) : '—'),
        h('td', { class: 'c-cell-sub' }, Array.isArray(field.options) ? field.options.join(', ') : '—'),
      ]))),
    ]);
    wrap.append(h('div', { class: 'c-table-wrap' }, fieldsTable));
    wrap.append(schemaEffectNote(hasSchema));
  }

  function schemaEffectNote() {
    return h('div', { class: 'c-alert', style: { marginTop: '12px' } }, [
      h('p', {}, ct('The schema is authoritative for future record writes: required fields, field types, defaults, and select values are enforced, and fields outside the schema are rejected. Existing records are never rewritten.')),
    ]);
  }

  function renderSchemaEditor(wrap, collection) {
    const fields = (collection?.fields || []).map((f) => ({
      name: f.name,
      type: f.type,
      required: !!f.required,
      default: f.default !== undefined ? String(f.default) : '',
      options: Array.isArray(f.options) ? f.options.join(', ') : '',
    }));
    const fieldsWrap = h('div', { style: { display: 'grid', gap: '8px' } });

    function renderFields() {
      clear(fieldsWrap);
      fields.forEach((field, index) => {
        const name = h('input', { class: 'c-input', type: 'text', value: field.name, placeholder: 'field_name', oninput: (e) => { field.name = e.target.value.trim(); } });
        const type = h('select', { class: 'c-input', onchange: (e) => { field.type = e.target.value; renderFields(); } },
          FIELD_TYPES.map((value) => h('option', { value, ...(value === field.type ? { selected: true } : {}) }, value)));
        const required = h('input', { type: 'checkbox', checked: field.required, onchange: (e) => { field.required = e.target.checked; } });
        const defaultInput = h('input', {
          class: 'c-input', type: 'text', placeholder: ct('default'), value: field.default,
          oninput: (e) => { field.default = e.target.value; },
        });
        const optionsInput = h('input', {
          class: 'c-input', type: 'text', placeholder: 'a, b, c', value: field.options,
          ...(field.type !== 'select' ? { hidden: '' } : {}),
          oninput: (e) => { field.options = e.target.value; },
        });
        fieldsWrap.append(h('div', { class: 'c-card', style: { padding: '10px', display: 'grid', gridTemplateColumns: '1fr 130px 1fr 130px auto', gap: '8px', alignItems: 'center' } }, [
          name, type, defaultInput, optionsInput,
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
            h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px' } }, [required, ct('Required')]),
            h('button', { class: 'c-icon-button', 'aria-label': ct('Remove field'), onClick: () => { fields.splice(index, 1); renderFields(); } }, [
              h('span', { html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>' }),
            ]),
          ]),
        ]));
      });
    }
    renderFields();

    const descriptionInput = h('input', { class: 'c-input', type: 'text', value: collection?.description || '', placeholder: ct('Optional description') });
    const errorEl = h('span', { class: 'c-field-error', role: 'alert' });

    const save = async (close) => {
      errorEl.textContent = '';
      const cleaned = cleanSchemaFields(fields);
      if (cleaned.error) { errorEl.textContent = cleaned.error; return false; }
      try {
        await api.patch(`${dbBase(projectId)}/collections/${encodeURIComponent(collection.name)}`, {
          description: descriptionInput.value.trim(),
          fields: cleaned.fields,
        });
        toast(ct('Schema saved'), { kind: 'success' });
        close();
        await loadCollections(collection.name);
      } catch (error) {
        errorEl.textContent = error.message || error.code;
        return false;
      }
    };

    openDialog({
      title: collection && (collection.fields?.length || 0) ? ct('Edit schema · {name}', { name: collection.name }) : ct('Define schema · {name}', { name: collection.name }),
      subtitle: ct('Schema changes apply to future writes. Existing records are never modified.'),
      size: 'lg',
      body: [
        h('label', { class: 'c-field' }, [h('span', { class: 'c-field-label' }, ct('Description')), descriptionInput]),
        h('div', {}, [
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' } }, [
            h('strong', {}, ct('Fields')),
            h('button', { class: 'c-btn outlined sm', onClick: () => { fields.push({ name: 'field_' + (fields.length + 1), type: 'text', required: false, default: '', options: '' }); renderFields(); } }, ct('+ Add field')),
          ]),
          fieldsWrap,
          h('span', { class: 'c-field-hint' }, ct('select options are comma-separated. Reserved keys (id, version, created_at, …) cannot be field names.')),
        ]),
        errorEl,
      ],
      actions: [
        { label: ct('Cancel'), variant: 'outlined' },
        { label: ct('Save schema'), variant: 'primary', onClick: save, keepOpen: true },
      ],
    });
  }

  // Returns { value } or { error } when the typed default does not match
  // the field type. `options` is the parsed option list of a select field.
  function validateDefault(field, options = []) {
    if (field.type === 'number') {
      const n = Number(field.default);
      return Number.isFinite(n) ? { value: n } : { error: ct('Default for a number field must be a number.') };
    }
    if (field.type === 'boolean') {
      if (field.default.trim() === 'true') return { value: true };
      if (field.default.trim() === 'false') return { value: false };
      return { error: ct('Default for a boolean field must be true or false.') };
    }
    if (field.type === 'json') {
      try { return { value: JSON.parse(field.default) }; }
      catch (_) { return { error: ct('Default for a json field must be valid JSON.') }; }
    }
    if (field.type === 'select') {
      return options.includes(field.default.trim())
        ? { value: field.default.trim() }
        : { error: ct('Default for a select field must be one of the listed options.') };
    }
    return { value: field.default };
  }

  // Shared by the create-collection and edit-schema dialogs: normalize the
  // field-builder rows into schema entries. Client-side checks mirror
  // normalizeSchemaFields on the server so mistakes surface next to the
  // control that caused them instead of as a raw API error.
  function cleanSchemaFields(rows) {
    const clean = [];
    const seen = new Set();
    for (const field of rows) {
      const name = (field.name || '').trim();
      if (!name) continue;
      if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        return { error: ct('Field names start with a lowercase letter and contain only letters, numbers, or underscore.') };
      }
      if (seen.has(name)) return { error: ct('Field names must be unique.') };
      seen.add(name);
      const entry = { name, type: field.type, required: !!field.required };
      const options = (field.options || '').split(',').map((option) => option.trim()).filter(Boolean);
      if (field.type === 'select') {
        if (!options.length) return { error: ct('Select fields need at least one option.') };
        entry.options = options;
      }
      if ((field.default || '') !== '') {
        const result = validateDefault(field, options);
        if (result.error) return { error: result.error };
        entry.default = result.value;
      }
      clean.push(entry);
    }
    return { fields: clean };
  }

  // ------------------------------------------------- create collection
  function collectionDialog() {
    let fields = [];
    const nameInput = h('input', { class: 'c-input', type: 'text', placeholder: 'products', pattern: '[a-z][a-z0-9_-]*' });
    const descriptionInput = h('textarea', { class: 'c-input', rows: 2, placeholder: ct('Optional description') });
    const fieldsWrap = h('div', { style: { display: 'grid', gap: '8px' } });
    const preview = h('div', {});

    function renderApiPreview() {
      clear(preview);
      const name = nameInput.value.trim() || 'products';
      preview.append(h('div', { style: { marginBottom: '4px', fontSize: '12px', color: 'var(--c-text-2)' } }, ct('REST endpoints after creation:')));
      preview.append(codeBlock(apiPreviewText(name), {}));
    }

    function apiPreviewText(name) {
      return [
        `GET    /api/db/${name}`,
        `POST   /api/db/${name}`,
        `GET    /api/db/${name}/:id`,
        `PATCH  /api/db/${name}/:id`,
        `DELETE /api/db/${name}/:id`,
      ].join('\n');
    }

    function renderFields() {
      clear(fieldsWrap);
      fields.forEach((field, index) => {
        const name = h('input', { class: 'c-input', type: 'text', value: field.name, placeholder: 'field_name', oninput: (e) => { field.name = e.target.value.trim(); } });
        const type = h('select', { class: 'c-input', onchange: (e) => { field.type = e.target.value; renderFields(); } },
          FIELD_TYPES.map((value) => h('option', { value, ...(value === field.type ? { selected: true } : {}) }, value)));
        const required = h('input', { type: 'checkbox', checked: field.required, onchange: (e) => { field.required = e.target.checked; } });
        const defaultInput = h('input', {
          class: 'c-input', type: 'text', placeholder: ct('default'), value: field.default || '',
          oninput: (e) => { field.default = e.target.value; },
        });
        const optionsInput = h('input', {
          class: 'c-input', type: 'text', placeholder: 'a, b, c', value: field.options || '',
          ...(field.type !== 'select' ? { hidden: '' } : {}),
          oninput: (e) => { field.options = e.target.value; },
        });
        fieldsWrap.append(h('div', { class: 'c-card', style: { padding: '10px', display: 'grid', gridTemplateColumns: '1fr 130px 1fr 130px auto', gap: '8px', alignItems: 'center' } }, [
          name, type, defaultInput, optionsInput,
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center' } }, [
            h('label', { style: { display: 'flex', gap: '6px', alignItems: 'center', fontSize: '12px' } }, [required, ct('Required')]),
            h('button', { class: 'c-icon-button', 'aria-label': ct('Remove field'), onClick: () => { fields.splice(index, 1); renderFields(); } }, [
              h('span', { html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>' }),
            ]),
          ]),
        ]));
      });
      if (!fields.length) {
        fieldsWrap.append(h('p', { style: { margin: 0, color: 'var(--c-text-3)', fontSize: '12.5px' } }, ct('No fields yet — records will accept arbitrary JSON until a schema is added.')));
      }
    }
    renderFields();
    nameInput.addEventListener('input', renderApiPreview);
    renderApiPreview();

    const errorEl = h('span', { class: 'c-field-error', role: 'alert' });
    const save = async (close) => {
      errorEl.textContent = '';
      const name = nameInput.value.trim();
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
        errorEl.textContent = ct('Collection names start with a lowercase letter and contain only letters, numbers, underscore, or hyphen.');
        return false;
      }
      const cleaned = cleanSchemaFields(fields);
      if (cleaned.error) { errorEl.textContent = cleaned.error; return false; }
      try {
        await api.post(dbBase(projectId) + '/collections', {
          name,
          description: descriptionInput.value.trim(),
          fields: cleaned.fields,
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
            h('button', { class: 'c-btn outlined sm', onClick: () => { fields.push({ name: 'field_' + (fields.length + 1), type: 'text', required: false, default: '', options: '' }); renderFields(); } }, ct('+ Add field')),
          ]),
          fieldsWrap,
          h('span', { class: 'c-field-hint' }, ct('select options are comma-separated. Reserved keys (id, version, created_at, …) cannot be field names.')),
        ]),
        preview,
        errorEl,
      ],
      actions: [
        { label: ct('Cancel'), variant: 'outlined' },
        { label: ct('Create collection'), variant: 'primary', onClick: save, keepOpen: true },
      ],
    });
    setTimeout(() => nameInput.focus(), 40);
  }

  // -------------------------------------------------------- records CRUD
  function recordDialog(existing) {
    // Records live inside a collection that already exists. The collection is
    // chosen by opening it (Collections tab or the picker above the records
    // table) — it is never typed into the record form, and a record write
    // never creates a collection as a side effect. "+" in the Data section
    // creates collections explicitly.
    const dataDoc = existing ? existing.data : { name: 'example' };
    const collectionInput = h('input', {
      class: 'c-input', type: 'text', value: selected || '',
      disabled: true,
      'aria-label': ct('Collection'),
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
      const coll = selected;
      if (!coll || !/^[a-z][a-z0-9_-]*$/.test(coll)) {
        errorEl.textContent = ct('Open a collection first — records are created inside an existing collection.');
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
        else if (error.code === 'schema_validation_failed') errorEl.textContent = error.message || ct('The document does not match the collection schema.');
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
        loadRecords(wrap, false);
      } catch (error) {
        toast(error.code === 'version_conflict' ? ct('Version conflict — reload and retry.') : error.message, { kind: 'error' });
      }
    };

    openDialog({
      title: existing ? ct('Record · {collection}', { collection: selected }) : ct('New record · {collection}', { collection: selected }),
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

  loadCollections(query.get('collection'));
}

function dbIcon() {
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6M4.5 11.5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6"/></svg>';
}
