const assert = require('assert');
const { boot, teardown, click, tick } = require('./dom-harness');

// Drive rows open the details drawer on double-click; the harness click helper
// only dispatches a single detail=1 mouse event.
function dblclick(el) {
  const win = el.ownerDocument.defaultView;
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
}

// Boots the real console.html with the real ES module entrypoint against
// scripted API responses, exercising rendering, routing, dialogs, the one-time
// secret flow, and the public direct-link snippets.
const PROJECT = {
  project_id: 'prj_smoke0001',
  name: 'Smoke',
  slug: 'smoke',
  status: 'active',
  created_at: '2026-09-13T10:00:00.000Z',
  updated_at: '2026-09-13T10:00:00.000Z',
};

const OBJECTS = [
  {
    bucket: 'assets', key: 'logo.png', name: 'logo.png', size: 1234,
    content_type: 'image/png', etag: 'etag-logo', version: 1,
    created_at: '2026-09-13T10:01:00.000Z', updated_at: '2026-09-13T10:01:00.000Z',
    flags: { starred: false, trashed: false },
  },
  {
    bucket: 'assets', key: 'notes/readme.txt', name: 'readme.txt', size: 42,
    content_type: 'text/plain', etag: 'etag-readme', version: 3,
    created_at: '2026-09-13T10:02:00.000Z', updated_at: '2026-09-13T10:05:00.000Z',
    flags: { starred: true, trashed: false },
  },
];

function routes() {
  // dom-harness matches the first pattern whose string occurs in the URL, so
  // more specific paths must be listed before generic ones.
  return {
    '/api/manage/session': () => ({ body: { authenticated: true, authEnabled: true, user: 'admin' } }),
    '/api/config': () => ({ body: {} }),
    '/drive/stats': () => ({ body: { buckets: 1, objects: 2, bytes: 1276, starred: 1, trashed: 0, truncated: false } }),
    '/drive/buckets': ({ init }) => {
      if (init.method === 'POST') return { status: 201, body: { created: true, bucket: { bucket: 'assets' } } };
      return { body: { data: [{ bucket: 'assets', created_at: '', updated_at: '' }], has_more: false } };
    },
    '/drive/objects': ({ init }) => {
      if (init.method === 'PUT') return { status: 200, body: { object: OBJECTS[0] } };
      return {
        body: {
          kind: 'drive-list', view: 'all', bucket: 'assets', prefix: '',
          delimiter: '/', limit: 100, order: 'key:asc',
          folders: [{ prefix: 'notes/', name: 'notes', empty: false }],
          objects: OBJECTS, has_more: false,
        },
      };
    },
    '/drive/folders': () => ({ status: 201, body: { created: true } }),
    '/drive/copy': () => ({ status: 200, body: { copied: 1 } }),
    '/drive/flags': () => ({ status: 200, body: { ok: true } }),
    '/db/collections': ({ init }) => {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        return {
          status: 201,
          body: {
            schema: 'telegraph-cloud.collection.v1',
            name: body.name,
            description: body.description || '',
            fields: body.fields || [],
          },
        };
      }
      return { body: { data: [{ name: 'users', record_count: 1 }], truncated: false } };
    },
    '/db/users': () => ({ body: { data: [], has_more: false } }),
    '/keys': ({ init, url }) => {
      if (init.method === 'POST') {
        return {
          status: 201,
          body: {
            api_key: 'tg_live_key_secret_once_only_value_0123456789',
            key: {
              key_id: 'key_one', project_id: PROJECT.project_id, label: 'ci',
              key_prefix: 'tg_live_key_secret…', fingerprint: 'fp1',
              scopes: ['db:read', 'db:write'], status: 'active',
              created_at: '2026-09-13T10:00:00.000Z', updated_at: '2026-09-13T10:00:00.000Z',
            },
          },
        };
      }
      return { body: { data: [], has_more: false } };
    },
    '/s3-credentials': () => ({ body: { data: [], has_more: false } }),
    '/api/projects': ({ url: matchedUrl, init }) => {
      const path = matchedUrl.split('?')[0];
      if (init.method === 'POST' && path.endsWith('/api/projects')) {
        const body = JSON.parse(init.body);
        return { status: 201, body: { ...PROJECT, project_id: 'prj_created001', name: body.name, slug: body.slug } };
      }
      if (path.endsWith('/api/projects')) {
        return { body: { data: [PROJECT], has_more: false } };
      }
      // Single-project lookup/update.
      return { body: PROJECT };
    },
  };
}

async function bootConsole(options = {}) {
  const ctx = await boot({
    page: 'console.html',
    module: 'js/console/main.js',
    language: options.language || 'en',
    routes: routes(),
  });
  await tick(40);
  return ctx;
}

async function goto(win, hash) {
  win.location.hash = hash;
  await tick(60);
}

describe('Cloud console (real page + modules, scripted API)', function () {
  let ctx;

  afterEach(function () {
    if (ctx) { teardown(); ctx = null; }
  });

  it('boots the global overview without page errors', async function () {
    ctx = await bootConsole();
    assert.deepStrictEqual(ctx.errors, []);
    assert.match(ctx.text(), /Telegraph Cloud/);
    assert.match(ctx.text(), /Overview/);
    // Legacy media compatibility link is preserved; the compatibility
    // workspace now lives at /admin-legacy while /admin redirects to /console.
    const legacy = ctx.all('a').find((a) => a.getAttribute('href') === '/admin-legacy.html');
    assert.ok(legacy, 'links to the legacy /admin-legacy workspace');
  });

  it('renders the Drive and opens the inspector with real direct-link snippets', async function () {
    ctx = await bootConsole();
    await goto(ctx.win, `#/project/${PROJECT.project_id}/drive`);
    assert.deepStrictEqual(ctx.errors, []);
    // Both the folder and the file render.
    assert.ok(ctx.text().includes('logo.png'));
    assert.ok(ctx.text().includes('notes'));

    // The drawer opens on double-click of a list row (the default layout).
    const rows = ctx.all('.c-drive-row');
    const logo = rows.find((r) => r.dataset.key.includes('logo.png'));
    assert.ok(logo, 'logo row rendered');
    dblclick(logo);
    await tick(20);

    const drawer = ctx.doc.querySelector('.c-inspector');
    assert.ok(drawer, 'details drawer opens');
    const snippets = Array.from(drawer.querySelectorAll('.c-snippet pre')).map((p) => p.textContent);
    const direct = snippets[0];
    assert.ok(direct.includes(`/p/${PROJECT.project_id}/assets/logo.png`), `direct link: ${direct}`);
    assert.ok(!direct.includes('/s3/'), 'the primary Direct URL is the public /p route');
    // Markdown for an image carries the same public URL.
    assert.ok(snippets.some((s) => s.startsWith('![') && s.includes('/p/')), JSON.stringify(snippets));
    // Authenticated Object API URL remains labeled and distinct.
    const apiSnippet = snippets.find((s) => s.includes('/api/storage/'));
    assert.ok(apiSnippet, 'object API URL snippet present');
    // Internal revision id is not rendered as a header anywhere the user can copy.
    assert.ok(drawer.textContent.includes('ETag'));
  });

  it('copies the public direct link', async function () {
    ctx = await bootConsole();
    await goto(ctx.win, `#/project/${PROJECT.project_id}/drive`);
    const rows = ctx.all('.c-drive-row');
    dblclick(rows.find((r) => r.dataset.key.includes('logo.png')));
    await tick(20);
    const drawer = ctx.doc.querySelector('.c-inspector');
    const firstCopy = drawer.querySelector('.c-snippet button');
    click(firstCopy);
    await tick(10);
    assert.ok(String(ctx.copied()).includes(`/p/${PROJECT.project_id}/assets/logo.png`));
  });

  it('creates a project through the dialog with name and slug', async function () {
    ctx = await bootConsole();
    await goto(ctx.win, '#/projects');
    click(ctx.doc.getElementById('c-new-project'));
    await tick(20);
    const dialog = ctx.doc.querySelector('.c-dialog');
    assert.ok(dialog, 'create dialog opens');
    const inputs = dialog.querySelectorAll('input');
    inputs[0].value = 'Reson Tune';
    inputs[0].dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
    assert.strictEqual(inputs[1].value, 'reson-tune', 'slug auto-fills from name');
    const createBtn = Array.from(dialog.querySelectorAll('button'))
      .find((b) => b.textContent.trim() === 'Create project');
    click(createBtn);
    await tick(40);
    const post = ctx.calls.find((c) => c.method === 'POST' && c.url === '/api/projects');
    assert.ok(post, 'POST /api/projects fired');
    assert.deepStrictEqual(post.body, { name: 'Reson Tune', slug: 'reson-tune' });
  });

  it('shows a new API key secret exactly once and never keeps it after dismiss', async function () {
    ctx = await bootConsole();
    await goto(ctx.win, `#/project/${PROJECT.project_id}/keys`);
    const createBtn = ctx.all('button').find((b) => /Create API key/.test(b.textContent));
    assert.ok(createBtn, 'new-key button exists');
    click(createBtn);
    await tick(20);
    const dialog = ctx.doc.querySelector('.c-dialog');
    assert.ok(dialog, 'key dialog opens');
    const label = dialog.querySelector('input');
    label.value = 'ci';
    label.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
    const submit = Array.from(dialog.querySelectorAll('button'))
      .find((b) => b.textContent.trim() === 'Create key');
    assert.ok(submit, 'create-key submit exists');
    click(submit);
    await tick(40);
    // The one-time secret dialog displays the plaintext exactly once.
    const secretNodes = Array.from(ctx.doc.querySelectorAll('.c-dialog code'))
      .filter((el) => el.textContent.includes('tg_live_key_secret_once_only_value_0123456789'));
    assert.strictEqual(secretNodes.length, 2, 'secret appears in the value and the auth header');
    // The list endpoint fixture never carries a secret; after dismissal the
    // plaintext is removed from the DOM entirely.
    const doneBtn = Array.from(ctx.doc.querySelectorAll('.c-dialog button'))
      .find((b) => /I saved the secret/.test(b.textContent));
    assert.ok(doneBtn, 'one-time dialog requires explicit acknowledgement');
    click(doneBtn);
    await tick(40);
    assert.strictEqual(ctx.doc.querySelectorAll('.c-dialog').length, 0);
    assert.ok(!ctx.text().includes('tg_live_key_secret_once_only_value_0123456789'),
      'secret removed from the DOM after dismissal');
    // The key list re-fetch must not expose the secret either.
    assert.ok(!JSON.stringify(ctx.calls).includes('tg_live_key_secret_once_only'));
  });

  it('renders entirely in Chinese when the language preference is zh', async function () {
    ctx = await bootConsole({ language: 'zh' });
    assert.deepStrictEqual(ctx.errors, []);
    const navText = ctx.doc.getElementById('c-global-nav').textContent;
    for (const zh of ['概览', '项目', '文档']) {
      assert.ok(navText.includes(zh), `nav translated (${zh}): ${navText}`);
    }
    // The English global nav labels must not remain.
    assert.ok(!/(^|\W)(Overview|Documentation|Settings)(\W|$)/.test(navText), navText);
    // Static chrome retranslates too.
    assert.ok(ctx.doc.getElementById('c-legacy-link').textContent.includes('旧版媒体'));
    // Console settings stay reachable through the topbar gear.
    assert.ok(ctx.doc.getElementById('c-console-settings-btn'), 'topbar settings button exists');
  });

  it('follows the canonical IA: three global sections, six project sections', async function () {
    ctx = await bootConsole();
    // Global sidebar is exactly Overview, Projects, Documentation — no
    // global Settings item (preferences live behind the topbar gear).
    const globalLabels = Array.from(ctx.doc.querySelectorAll('#c-global-nav .c-nav-item > span:last-child'))
      .map((el) => el.textContent);
    assert.deepStrictEqual(globalLabels, ['Overview', 'Projects', 'Documentation']);

    // Inside a project the sidebar lists the canonical sections in order.
    await goto(ctx.win, `#/project/${PROJECT.project_id}/files?tab=drive`);
    const projectLabels = Array.from(ctx.doc.querySelectorAll('#c-project-nav .c-nav-item > span:last-child'))
      .map((el) => el.textContent);
    assert.deepStrictEqual(projectLabels, ['Overview', 'Data', 'Files', 'API', 'Connect', 'Settings']);

    // The canonical files route renders the Drive surface.
    assert.ok(ctx.text().includes('logo.png'), 'Drive renders under /files?tab=drive');

    // Legacy deep-link slugs still resolve to the canonical sections.
    await goto(ctx.win, `#/project/${PROJECT.project_id}/drive`);
    assert.ok(ctx.text().includes('logo.png'), 'legacy /drive deep link still works');

    await goto(ctx.win, `#/project/${PROJECT.project_id}/api`);
    assert.ok(ctx.text().includes('Endpoints'), 'canonical /api section renders');
  });

  it('documents the document database honestly (never PostgreSQL) on the DB view', async function () {
    ctx = await bootConsole();
    await goto(ctx.win, `#/project/${PROJECT.project_id}/database`);
    assert.deepStrictEqual(ctx.errors, []);
    assert.ok(ctx.text().includes('users'));
    // Any usage docs reachable from this view reject SQL/Postgres framing.
    assert.ok(!/PostgreSQL database|Postgres database/i.test(ctx.text()));
  });

  it('makes "+" open the New Collection builder and stores explicit metadata', async function () {
    ctx = await bootConsole();
    await goto(ctx.win, `#/project/${PROJECT.project_id}/data`);
    // The Data section's primary action is "+ New collection" — never a
    // record shortcut.
    const plusButton = ctx.all('button').find((b) => /New collection/.test(b.textContent));
    assert.ok(plusButton, '"New collection" primary button exists');
    click(plusButton);
    await tick(20);

    const dialog = ctx.doc.querySelector('.c-dialog');
    assert.ok(dialog, 'New Collection dialog opens');
    assert.ok(ctx.text().includes('Collection name'), 'name field present');
    assert.ok(dialog.querySelector('textarea'), 'description field present');
    const addField = Array.from(dialog.querySelectorAll('button'))
      .find((b) => /Add field/.test(b.textContent));
    assert.ok(addField, 'field builder present');

    // Build one select field with options and a default.
    click(addField);
    await tick(10);
    const fieldName = dialog.querySelector('input[placeholder="field_name"]');
    fieldName.value = 'status';
    fieldName.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
    const typeSelect = dialog.querySelector('select.c-input');
    typeSelect.value = 'select';
    typeSelect.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    await tick(10);
    // Re-rendered row: the options input is now visible and keeps its value.
    const optionsInput = dialog.querySelector('input[placeholder="a, b, c"]');
    assert.ok(optionsInput && !optionsInput.hidden, 'select options input visible');
    optionsInput.value = 'draft, live, archived';
    optionsInput.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
    const defaultInput = dialog.querySelector('input[placeholder="default"]');
    assert.ok(defaultInput && !defaultInput.hidden, 'select default input visible');
    defaultInput.value = 'draft';
    defaultInput.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));

    const nameInput = dialog.querySelector('input[placeholder="products"]');
    nameInput.value = 'products';
    nameInput.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
    dialog.querySelector('textarea').value = 'Product catalog';

    const createBtn = Array.from(dialog.querySelectorAll('button'))
      .find((b) => b.textContent.trim() === 'Create collection');
    click(createBtn);
    await tick(40);

    const post = ctx.calls.find((c) => c.method === 'POST' && c.url.endsWith('/db/collections'));
    assert.ok(post, 'POST /db/collections fired');
    assert.deepStrictEqual(post.body, {
      name: 'products',
      description: 'Product catalog',
      fields: [{
        name: 'status',
        type: 'select',
        required: false,
        options: ['draft', 'live', 'archived'],
        default: 'draft',
      }],
    });
  });

  it('rejects builder mistakes next to the control: select without options', async function () {
    ctx = await bootConsole();
    await goto(ctx.win, `#/project/${PROJECT.project_id}/data`);
    click(ctx.all('button').find((b) => /New collection/.test(b.textContent)));
    await tick(20);
    const dialog = ctx.doc.querySelector('.c-dialog');
    click(Array.from(dialog.querySelectorAll('button')).find((b) => /Add field/.test(b.textContent)));
    await tick(10);
    const typeSelect = dialog.querySelector('select.c-input');
    typeSelect.value = 'select';
    typeSelect.dispatchEvent(new ctx.win.Event('change', { bubbles: true }));
    await tick(10);
    const nameInput = dialog.querySelector('input[placeholder="products"]');
    nameInput.value = 'products';
    nameInput.dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
    click(Array.from(dialog.querySelectorAll('button'))
      .find((b) => b.textContent.trim() === 'Create collection'));
    await tick(40);
    // The controlled hint appears; nothing was sent.
    assert.ok(/Select fields need at least one option/.test(ctx.text()));
    assert.ok(!ctx.calls.some((c) => c.method === 'POST' && c.url.endsWith('/db/collections')));
  });

  it('API Explorer shows method, auth, request body, response, and cURL/JS examples', async function () {
    ctx = await bootConsole();
    await goto(ctx.win, `#/project/${PROJECT.project_id}/api?tab=explorer`);
    assert.deepStrictEqual(ctx.errors, []);

    // The five generic CRUD operations, in order.
    const cards = ctx.all('[data-explorer-endpoint]');
    assert.deepStrictEqual(cards.map((c) => c.getAttribute('data-explorer-endpoint')),
      ['GET', 'POST', 'GET', 'PATCH', 'DELETE']);

    // Every card shows authentication.
    for (const card of cards) {
      assert.ok(card.textContent.includes('Bearer tg_live_…'), 'auth shown');
      assert.ok(card.textContent.includes('Response'), 'response example shown');
    }
    // Request bodies only on POST/PATCH/DELETE.
    const withBody = cards.filter((c) => c.textContent.includes('Request body'));
    assert.strictEqual(withBody.length, 3, 'request body sections on mutating endpoints');

    // cURL visible by default; the JavaScript tab switches the snippet.
    assert.match(ctx.text(), /curl -s/);
    const jsTab = Array.from(cards[0].querySelectorAll('button'))
      .find((b) => b.textContent.trim() === 'JavaScript');
    click(jsTab);
    await tick(10);
    assert.match(cards[0].textContent, /await fetch\(/);

    // Record-level cards carry a record-ID input; Try-it refuses to run
    // without one and performs no request.
    const recordCards = cards.filter((c) => c.getAttribute('data-explorer-endpoint') !== 'GET'
      || c.textContent.includes('Read one document'));
    const idInputs = cards.map((c) => c.querySelector('input[aria-label="Record ID"]')).filter(Boolean);
    assert.strictEqual(idInputs.length, 3);
    const tryIt = Array.from(cards[2].querySelectorAll('button')).find((b) => b.textContent.trim() === 'Try it');
    const callsBefore = ctx.calls.length;
    click(tryIt);
    await tick(20);
    // The guard announces through the aria-live region (asserted there: the
    // toast element is cached per module instance across harness boots).
    assert.ok(/Enter a record ID/.test(ctx.doc.getElementById('c-live').textContent), 'guarded toast');
    assert.strictEqual(ctx.calls.length, callsBefore, 'no request without a record ID');

    // A typed record ID flows into the copied snippets.
    const idCard = cards[2];
    idInputs[0].value = 'rec_test0001';
    idInputs[0].dispatchEvent(new ctx.win.Event('input', { bubbles: true }));
    await tick(10);
    click(Array.from(idCard.querySelectorAll('button')).find((b) => b.textContent.trim() === 'cURL'));
    await tick(10);
    assert.ok(idCard.textContent.includes('rec_test0001'), 'snippet uses the entered ID');

    // The Explorer links the OpenAPI documents.
    assert.ok(ctx.all('a').some((a) => (a.getAttribute('href') || '').endsWith('/openapi.json')));
  });

  it('Connect center: sections, project-specific examples, secrets never persisted', async function () {
    ctx = await bootConsole();
    await goto(ctx.win, `#/project/${PROJECT.project_id}/connect`);
    assert.deepStrictEqual(ctx.errors, []);

    // The four onboarding sections exist.
    for (const id of ['connect-quickstart', 'connect-environment', 'connect-api', 'connect-sdk']) {
      assert.ok(ctx.doc.getElementById(id), `section ${id} present`);
    }

    // Project-specific examples: all three variables with real values.
    const text = ctx.text();
    const origin = ctx.win.location.origin;
    assert.ok(text.includes('TELEGRAPH_URL'), 'TELEGRAPH_URL documented');
    assert.ok(text.includes(`TELEGRAPH_PROJECT=${PROJECT.project_id}`), 'env embeds the project id');
    assert.ok(text.includes(`TELEGRAPH_URL=${origin}`), 'env embeds the origin');
    const pres = Array.from(ctx.doc.querySelectorAll('pre')).map((pre) => pre.textContent);
    assert.ok(pres.some((code) => code.includes('$TELEGRAPH_API_KEY')), 'cURL reads the key from the environment');
    assert.ok(pres.some((code) => code.includes('process.env.TELEGRAPH_API_KEY')), 'JavaScript example reads the key from the environment');
    assert.ok(pres.some((code) => code.includes('telegraph_project')), 'JSON config present');

    // Before issuing: no secret material anywhere.
    const SECRET = 'tg_live_key_secret_once_only_value_0123456789';
    assert.ok(!text.includes(SECRET), 'no secret before issuing');
    assert.ok(!ctx.win.location.hash.includes('tg_live'), 'no secret in the URL');

    // Existing credential creation flow intact: issue → one-time reveal → .env.
    click(ctx.all('button').find((b) => b.textContent.trim() === 'Issue API key'));
    await tick(20);
    let dialog = ctx.doc.querySelector('.c-dialog');
    assert.ok(dialog, 'issue dialog opens');
    click(Array.from(dialog.querySelectorAll('button')).find((b) => b.textContent.trim() === 'Create & reveal'));
    await tick(40);
    dialog = ctx.doc.querySelector('.c-dialog');
    assert.ok(dialog && dialog.textContent.includes(SECRET), 'one-time secret dialog shows the key');
    click(Array.from(dialog.querySelectorAll('button')).find((b) => /I saved the secret/.test(b.textContent)));
    await tick(40);
    // The .env block now carries the key — in memory only.
    const envPre = Array.from(ctx.doc.querySelectorAll('pre')).map((pre) => pre.textContent)
      .find((code) => code.includes(`TELEGRAPH_PROJECT=${PROJECT.project_id}`));
    assert.ok(envPre && envPre.includes(SECRET), '.env updated with the issued key');

    // After issuing: the secret is in the DOM (in-memory page state) but
    // never in localStorage/sessionStorage or any URL.
    for (const storage of [ctx.win.localStorage, ctx.win.sessionStorage]) {
      const values = Array.from({ length: storage.length }, (_, i) => storage.getItem(storage.key(i))).join('\n');
      assert.ok(!values.includes('tg_live'), 'no secret in web storage');
    }
    assert.ok(!ctx.win.location.href.includes('tg_live'), 'no secret in the URL');
  });

  it('creates records only inside the open collection (no implicit collections)', async function () {
    ctx = await bootConsole();
    await goto(ctx.win, `#/project/${PROJECT.project_id}/data?tab=records&collection=users`);
    const newRecord = ctx.all('button').find((b) => /New record/.test(b.textContent));
    assert.ok(newRecord, 'New record button exists');
    click(newRecord);
    await tick(20);

    const dialog = ctx.doc.querySelector('.c-dialog');
    assert.ok(dialog, 'record dialog opens');
    assert.ok(ctx.text().includes('New record · users'), 'dialog is scoped to the open collection');
    const collectionInput = dialog.querySelector('input[aria-label="Collection"]');
    assert.ok(collectionInput, 'collection field rendered');
    assert.strictEqual(collectionInput.disabled, true, 'collection is fixed, not typeable');
    assert.strictEqual(collectionInput.value, 'users');
  });
});
