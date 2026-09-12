const assert = require('assert');
const { createMockKV, makeContext, muteConsole } = require('./helpers');

const baseMetadata = {
  TimeStamp: 1710000000000,
  ListType: 'None',
  Label: 'None',
  liked: false,
  fileName: 'cat.png',
  fileSize: 123,
};

describe('manage API functions', function () {
  let restoreConsole;

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    restoreConsole();
  });

  it('marks a record as blocked while preserving other metadata', async function () {
    const { onRequest } = await import('../functions/api/manage/block/[id].js');
    const img_url = createMockKV({ 'cat.png': baseMetadata });

    const res = await onRequest(makeContext({
      env: { img_url },
      params: { id: 'cat.png' },
    }));

    assert.strictEqual(res.status, 200);
    const metadata = JSON.parse(await res.text());
    assert.strictEqual(metadata.ListType, 'Block');
    assert.strictEqual(metadata.fileName, 'cat.png');
    assert.deepStrictEqual(img_url.snapshot('cat.png').metadata, metadata);
  });

  it('marks a record as whitelisted while preserving other metadata', async function () {
    const { onRequest } = await import('../functions/api/manage/white/[id].js');
    const img_url = createMockKV({ 'cat.png': baseMetadata });

    const res = await onRequest(makeContext({
      env: { img_url },
      params: { id: 'cat.png' },
    }));

    assert.strictEqual(res.status, 200);
    const metadata = JSON.parse(await res.text());
    assert.strictEqual(metadata.ListType, 'White');
    assert.strictEqual(metadata.fileSize, 123);
    assert.deepStrictEqual(img_url.snapshot('cat.png').metadata, metadata);
  });

  it('deletes a KV record and returns the deleted id', async function () {
    const { onRequest } = await import('../functions/api/manage/delete/[id].js');
    const img_url = createMockKV({ 'cat.png': baseMetadata });

    const res = await onRequest(makeContext({
      env: { img_url },
      params: { id: 'cat.png' },
    }));

    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), '"cat.png"');
    assert.deepStrictEqual(img_url.operations.delete, ['cat.png']);
    assert.strictEqual(img_url.snapshot('cat.png'), undefined);
  });

  it('removes the short link mapping when deleting a record', async function () {
    const { onRequest } = await import('../functions/api/manage/delete/[id].js');
    const img_url = createMockKV({
      'cat.png': { ...baseMetadata, shortId: 'AbC123' },
      'short:AbC123': { value: 'cat.png', metadata: { target: 'cat.png' } },
    });

    const res = await onRequest(makeContext({
      env: { img_url },
      params: { id: 'cat.png' },
    }));

    assert.strictEqual(res.status, 200);
    assert.strictEqual(img_url.snapshot('cat.png'), undefined);
    assert.strictEqual(img_url.snapshot('short:AbC123'), undefined);
  });

  it('hides internal bookkeeping keys from list results', async function () {
    const { onRequest } = await import('../functions/api/manage/list.js');
    const img_url = createMockKV({
      'cat.png': baseMetadata,
      'r2-1234abcd.png': baseMetadata,
      'short:AbC123': { value: 'cat.png', metadata: { target: 'cat.png' } },
      'moderation:live-models': { value: '[]', metadata: null },
    });

    const res = await onRequest(makeContext({
      request: new Request('https://example.com/api/manage/list'),
      env: { img_url },
    }));

    assert.strictEqual(res.status, 200);
    const data = JSON.parse(await res.text());
    assert.deepStrictEqual(data.keys.map(key => key.name), ['cat.png', 'r2-1234abcd.png']);
  });

  it('toggles the liked flag on an existing record', async function () {
    const { onRequest } = await import('../functions/api/manage/toggleLike/[id].js');
    const img_url = createMockKV({ 'cat.png': baseMetadata });

    const res = await onRequest(makeContext({
      env: { img_url },
      params: { id: 'cat.png' },
    }));

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(await res.text()), {
      success: true,
      liked: true,
    });
    assert.strictEqual(img_url.snapshot('cat.png').metadata.liked, true);
  });

  it('updates the display filename from the newName query parameter', async function () {
    const { onRequest } = await import('../functions/api/manage/editName/[id].js');
    const img_url = createMockKV({ 'cat.png': baseMetadata });

    const res = await onRequest(makeContext({
      request: new Request('https://example.com/api/manage/editName/cat.png?newName=kitten.png'),
      env: { img_url },
      params: { id: 'cat.png' },
    }));

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(await res.text()), {
      success: true,
      fileName: 'kitten.png',
    });
    assert.strictEqual(img_url.snapshot('cat.png').metadata.fileName, 'kitten.png');
  });

  it('returns 404 when toggling liked on a missing record', async function () {
    const { onRequest } = await import('../functions/api/manage/toggleLike/[id].js');
    const img_url = createMockKV();

    const res = await onRequest(makeContext({
      env: { img_url },
      params: { id: 'missing.png' },
    }));

    assert.strictEqual(res.status, 404);
    assert.strictEqual(await res.text(), 'Image metadata not found for ID: missing.png');
  });

  it('reports whether dashboard basic auth is configured', async function () {
    const { onRequest } = await import('../functions/api/manage/check.js');

    const disabled = await onRequest(makeContext({ env: {} }));
    assert.strictEqual(disabled.status, 200);
    assert.strictEqual(await disabled.text(), 'Not using basic auth.');

    const enabled = await onRequest(makeContext({ env: { BASIC_USER: 'admin' } }));
    assert.strictEqual(enabled.status, 200);
    assert.strictEqual(await enabled.text(), 'true');
  });
});

describe('manage API authentication middleware', function () {
  let restoreConsole;

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    restoreConsole();
  });

  async function getAuthentication() {
    const mod = await import('../functions/api/manage/_middleware.js');
    return mod.onRequest[1];
  }

  it('returns a stable safe JSON error instead of exception details or a stack trace', async function () {
    const { errorHandling } = await import('../functions/api/manage/_middleware.js');
    const secret = 'telegram-token-must-not-be-exposed';
    const res = await errorHandling(makeContext({
      request: new Request('https://example.com/api/manage/list'),
      next: async () => {
        const error = new Error(`upstream failed for ${secret}`);
        error.stack = `Error: ${secret}\n    at private-handler`;
        throw error;
      },
    }));

    assert.strictEqual(res.status, 500);
    assert.strictEqual(res.headers.get('Content-Type'), 'application/json');
    assert.strictEqual(res.headers.get('Cache-Control'), 'no-store');
    const body = await res.text();
    assert.deepStrictEqual(JSON.parse(body), { error: 'internal_error' });
    assert.ok(!body.includes(secret));
    assert.ok(!body.includes('private-handler'));
  });

  it('blocks dashboard API requests with a 401 JSON response (no native Basic challenge)', async function () {
    const authentication = await getAuthentication();
    const img_url = createMockKV();

    const res = await authentication(makeContext({
      env: { img_url, BASIC_USER: 'admin', BASIC_PASS: 'secret' },
      request: new Request('https://example.com/api/manage/list'),
    }));

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.headers.get('Content-Type'), 'application/json');
    // No WWW-Authenticate so the browser never shows its native dialog.
    assert.strictEqual(res.headers.get('WWW-Authenticate'), null);
    const body = JSON.parse(await res.text());
    assert.strictEqual(body.error, 'unauthenticated');
  });

  it('allows dashboard requests with valid basic auth credentials (migration fallback)', async function () {
    const authentication = await getAuthentication();
    const img_url = createMockKV();
    const headers = new Headers({
      Authorization: `Basic ${btoa('admin:secret')}`,
    });

    const res = await authentication(makeContext({
      env: { img_url, BASIC_USER: 'admin', BASIC_PASS: 'secret' },
      request: new Request('https://example.com/api/manage/list', { headers }),
      next: async () => new Response('ok'),
    }));

    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'ok');
  });

  it('permits unauthenticated requests to the login/logout/session endpoints', async function () {
    const authentication = await getAuthentication();
    const img_url = createMockKV();

    for (const path of ['/api/manage/login', '/api/manage/logout', '/api/manage/session']) {
      const res = await authentication(makeContext({
        env: { img_url, BASIC_USER: 'admin', BASIC_PASS: 'secret' },
        request: new Request(`https://example.com${path}`),
        next: async () => new Response('open'),
      }));
      assert.strictEqual(res.status, 200, `${path} should be public`);
      assert.strictEqual(await res.text(), 'open');
    }
  });

  it('redirects unauthenticated browser navigation (non-API) to the GUI login', async function () {
    const authentication = await getAuthentication();
    const img_url = createMockKV();

    const res = await authentication(makeContext({
      env: { img_url, BASIC_USER: 'admin', BASIC_PASS: 'secret' },
      request: new Request('https://example.com/admin?view=albums', {
        headers: { Accept: 'text/html' },
      }),
    }));

    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.get('Location'), 'https://example.com/login?next=%2Fadmin%3Fview%3Dalbums');
    assert.strictEqual(res.headers.get('WWW-Authenticate'), null);
  });

  it('returns the dashboard disabled message when KV is not bound', async function () {
    const authentication = await getAuthentication();

    const res = await authentication(makeContext({
      env: { BASIC_USER: 'admin', BASIC_PASS: 'secret' },
      request: new Request('https://example.com/api/manage/list'),
    }));

    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'Dashboard is disabled. Please bind a KV namespace to use this feature.');
  });
});
