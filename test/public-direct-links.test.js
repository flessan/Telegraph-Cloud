const assert = require('assert');

// Public, unauthenticated Drive direct links:
// GET/HEAD /p/:projectId/:bucket/*key served from the same object engine,
// with trash hiding objects and no internal metadata leaked.
describe('Telegraph Cloud public direct-link route', function () {
  let route;
  let CloudNotFoundError;
  let CloudConfigurationError;

  const OBJECT = Object.freeze({
    bucket: 'assets',
    key: 'hello.txt',
    size: 5,
    content_type: 'text/plain',
    etag: 'etag1',
    version: 7,
    updated_at: '2026-09-13T10:00:00.000Z',
  });

  function fakeDrive({ trashed = false, getError = null } = {}) {
    return {
      async headObject(bucket, key) {
        assert.strictEqual(bucket, 'assets');
        assert.strictEqual(key, 'hello.txt');
        return { object: { ...OBJECT, flags: { starred: false, trashed } } };
      },
      async getObject() {
        if (getError) throw getError;
        return {
          status: 200,
          object: OBJECT,
          body: new TextEncoder().encode('hello'),
        };
      },
    };
  }

  function context({ method = 'GET', params, drive }) {
    return {
      request: new Request('http://example.test/p/prj_x/assets/hello.txt', { method }),
      params: params || { id: 'prj_x', bucket: 'assets', key: ['hello.txt'] },
      env: {},
      data: { drive: drive || fakeDrive() },
    };
  }

  before(async function () {
    route = await import('../functions/p/[id]/[bucket]/[[key]].js');
    ({ CloudNotFoundError, CloudConfigurationError } = await import('../functions/cloud/errors.js'));
  });

  describe('catch-all param percent-decoding', function () {
    let decodeRouteSegment;
    before(async function () {
      ({ decodeRouteSegment } = await import('../functions/cloud/object-request-input.js'));
    });

    it('decodes each catch-all segment exactly once', function () {
      assert.strictEqual(decodeRouteSegment(['img', 'my%20pic.png']), 'img/my pic.png');
      assert.strictEqual(decodeRouteSegment(['caf%C3%A9.png']), 'café.png');
    });

    it('is idempotent on already-decoded segments', function () {
      assert.strictEqual(decodeRouteSegment(['img', 'my pic.png']), 'img/my pic.png');
    });

    it('accepts a scalar full key as-is (including real separators)', function () {
      assert.strictEqual(decodeRouteSegment('nested/route.txt'), 'nested/route.txt');
    });

    it('rejects encoded separators within a single segment', function () {
      assert.strictEqual(decodeRouteSegment(['a%2Fb']), null);
      assert.strictEqual(decodeRouteSegment(['a%5Cb']), null);
    });

    it('rejects malformed percent encoding', function () {
      assert.strictEqual(decodeRouteSegment(['%zz']), null);
      assert.strictEqual(decodeRouteSegment(['%2']), null);
    });

    it('decodes keys before they reach the object engine', async function () {
      let seenKey = null;
      const drive = {
        async headObject(bucket, key) { seenKey = key; return { object: { ...OBJECT, flags: { trashed: false } } }; },
        async getObject() { return { status: 200, object: OBJECT, body: new TextEncoder().encode('x') }; },
      };
      const res = await route.onRequest(context({
        drive,
        params: { id: 'prj_x', bucket: 'assets', key: ['img', 'my%20pic.png'] },
      }));
      assert.strictEqual(res.status, 200);
      assert.strictEqual(seenKey, 'img/my pic.png');
    });

    it('maps encoded-separator attacks to a 404', async function () {
      const res = await route.onRequest(context({
        params: { id: 'prj_x', bucket: 'assets', key: ['a%2F..%2Fsecrets'] },
      }));
      assert.strictEqual(res.status, 404);
    });
  });

  it('serves object bytes anonymously with safe headers', async function () {
    const res = await route.onRequest(context({}));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/plain');
    assert.strictEqual(res.headers.get('Cache-Control'), 'public, max-age=300');
    assert.ok(res.headers.get('Content-Security-Policy').includes('sandbox'));
    assert.strictEqual(res.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.strictEqual(res.headers.get('ETag'), '"etag1"');
    // Internal revision ids are not exposed on public responses.
    assert.strictEqual(res.headers.get('X-Telegraph-Cloud-Object-Version'), null);
    assert.strictEqual(await res.text(), 'hello');
  });

  it('supports HEAD without a body', async function () {
    const res = await route.onRequest(context({ method: 'HEAD' }));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('Content-Type'), 'text/plain');
    assert.strictEqual(res.headers.get('Content-Length'), '5');
  });

  it('honors range conditions through the object engine', async function () {
    const drive = fakeDrive();
    drive.getObject = async () => ({
      status: 206,
      object: OBJECT,
      range: { start: 1, end: 2, size: 5, length: 2 },
      body: new TextEncoder().encode('el'),
    });
    const ctx = context({ drive });
    ctx.request = new Request('http://example.test/p/prj_x/assets/hello.txt', {
      headers: { Range: 'bytes=1-2' },
    });
    const res = await route.onRequest(ctx);
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers.get('Content-Range'), 'bytes 1-2/5');
    assert.strictEqual(await res.text(), 'el');
  });

  it('hides trashed objects behind 404 so trashing revokes the link', async function () {
    const res = await route.onRequest(context({ drive: fakeDrive({ trashed: true }) }));
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.deepStrictEqual(body, { error: 'object_not_found' });
  });

  it('maps missing objects to a 404', async function () {
    const err = new CloudNotFoundError('object_not_found', 'No such object.');
    const res = await route.onRequest(context({ drive: fakeDrive({ getError: err }) }));
    assert.strictEqual(res.status, 404);
    assert.deepStrictEqual(await res.json(), { error: 'object_not_found' });
  });

  it('reports an unconfigured object backend honestly (503)', async function () {
    const err = new CloudConfigurationError('telegram_object_unavailable', 'Object storage is not configured.');
    const res = await route.onRequest(context({ drive: fakeDrive({ getError: err }) }));
    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(await res.json(), { error: 'telegram_object_unavailable' });
  });

  it('rejects mutation methods with 405', async function () {
    for (const method of ['PUT', 'POST', 'DELETE', 'PATCH']) {
      const res = await route.onRequest(context({ method }));
      assert.strictEqual(res.status, 405, method);
      assert.strictEqual(res.headers.get('Allow'), 'GET, HEAD');
    }
  });

  it('rejects empty bucket/key paths', async function () {
    const res = await route.onRequest(context({
      params: { id: 'prj_x', bucket: 'assets', key: [] },
    }));
    assert.strictEqual(res.status, 404);
  });

  it('refuses directory traversal-looking keys via the engine validation', async function () {
    // The route itself never treats the key as a filesystem path; the service
    // layer rejects unsafe keys. A bad key therefore surfaces as a 4xx error,
    // never bytes from outside the bucket.
    const drive = {
      async headObject() { throw new CloudNotFoundError('object_not_found', 'No such object.'); },
      async getObject() { throw new Error('must not be reached'); },
    };
    const res = await route.onRequest(context({
      drive,
      params: { id: 'prj_x', bucket: 'assets', key: ['..', '..', 'secrets.txt'] },
    }));
    assert.strictEqual(res.status, 404);
  });
});
