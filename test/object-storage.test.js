const assert = require('assert');
const { createMockKV, installFetchMock, makeContext, muteConsole } = require('./helpers');

async function runPipeline(middlewares, route, context) {
  const handlers = [...middlewares, async () => route.onRequest(context)];
  let position = 0;
  context.next = () => handlers[position++](context);
  return context.next();
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

function fixedClock() {
  return new Date('2026-09-12T12:34:56.000Z');
}

describe('Telegraph Cloud Phase 4 project-scoped object storage', function () {
  let objectStorage;
  let objectTransport;
  let objectHttp;
  let indexModule;
  let projectModule;
  let keyModule;
  let storageMiddleware;
  let storageRoute;
  let restoreConsole;

  before(async function () {
    objectStorage = await import('../functions/cloud/object-storage.js');
    objectTransport = await import('../functions/cloud/telegram-object-storage.js');
    objectHttp = await import('../functions/cloud/object-http.js');
    indexModule = await import('../functions/cloud/index-store.js');
    projectModule = await import('../functions/cloud/project-registry.js');
    keyModule = await import('../functions/cloud/developer-api-keys.js');
    storageMiddleware = await import('../functions/api/storage/_middleware.js');
    storageRoute = await import('../functions/api/storage/[bucket]/[[key]].js');
  });

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    restoreConsole();
  });

  function createTransport({ failPut = null } = {}) {
    let sequence = 0;
    const bytes = new Map();
    const calls = { put: [], event: [], get: [], head: [], delete: [] };
    return {
      calls,
      bytes,
      async putObject({ body, contentType }) {
        calls.put.push({ body: new Uint8Array(body), contentType });
        if (failPut) throw new Error(failPut);
        const fileId = `file${String(++sequence).padStart(16, '0')}`;
        bytes.set(fileId, new Uint8Array(body));
        return { provider: 'telegram-object', fileId, messageId: sequence };
      },
      async appendEvent(event) {
        calls.event.push(structuredClone(event));
        const fileId = `event${String(++sequence).padStart(15, '0')}`;
        return { provider: 'telegram-object-event', fileId, messageId: sequence };
      },
      async getObject(pointer) {
        calls.get.push({ ...pointer });
        return new Response(bytes.get(pointer.fileId));
      },
      async headObject(pointer) {
        calls.head.push({ ...pointer });
        return { available: bytes.has(pointer.fileId) };
      },
      async deleteObject(pointer) {
        calls.delete.push({ ...pointer });
        return { retained_by_provider: true };
      },
    };
  }

  function fixture({ projectId = 'prj_A1b2C3d4', env = {}, index: suppliedIndex, transport: suppliedTransport, clock = fixedClock } = {}) {
    const kv = createMockKV();
    const runtimeEnv = { TELEGRAPH_CLOUD_KV: kv, ...env };
    const index = suppliedIndex || indexModule.createCloudIndexStore(runtimeEnv);
    const transport = suppliedTransport || createTransport();
    let id = 0;
    const storage = objectStorage.createTelegramObjectStorage(runtimeEnv, {
      projectId,
      index,
      transport,
      now: clock,
      createId(prefix) {
        id += 1;
        return `${prefix}${String(id).padStart(22, '0')}`;
      },
    });
    return { kv, env: runtimeEnv, index, transport, storage };
  }

  it('stores bytes through the dedicated adapter, materializes only safe metadata, and reads/heads exact bytes', async function () {
    const { kv, transport, storage } = fixture();
    const put = await storage.putObject('assets', 'nested/readme.txt', {
      body: textBytes('hello object'),
      contentType: 'text/plain; charset=utf-8',
      metadata: { Owner: 'alpha', purpose: 'test' },
    });

    assert.strictEqual(put.status, 201);
    assert.deepStrictEqual(put.object.metadata, { owner: 'alpha', purpose: 'test' });
    assert.strictEqual(put.object.content_type, 'text/plain');
    assert.match(put.object.etag, /^sha256-[A-Za-z0-9_-]{43}-v1$/);
    assert.strictEqual(transport.calls.put.length, 1);
    assert.strictEqual(transport.calls.event.length, 1);
    assert.strictEqual(transport.calls.event[0].schema, 'telegraph-cloud.object-revision.v1');
    assert.strictEqual(transport.calls.event[0].operation, 'put');
    assert.strictEqual(transport.calls.event[0].object.storage.file_id, transport.calls.put[0] && 'file0000000000000001');

    const publicJson = JSON.stringify(put.object);
    assert.ok(!/file_id|message_id|telegram|event/.test(publicJson));
    const manifestPut = kv.operations.put.find((entry) => entry.key.startsWith('tc:v1:object-manifest:'));
    const manifest = JSON.parse(manifestPut.value);
    assert.strictEqual(manifest.state, 'active');
    assert.ok(manifest.storage.file_id);
    assert.ok(manifest.event.file_id);
    assert.ok(!manifestPut.key.includes('nested/readme.txt'), 'arbitrary keys are hashed before becoming KV key segments');

    const get = await storage.getObject('assets', 'nested/readme.txt');
    assert.strictEqual(get.status, 200);
    assert.deepStrictEqual(get.object, put.object);
    assert.strictEqual(await new Response(get.body).text(), 'hello object');

    const beforeHeadDownloads = transport.calls.get.length;
    const head = await storage.headObject('assets', 'nested/readme.txt');
    assert.strictEqual(head.status, 200);
    assert.deepStrictEqual(head.object, put.object);
    assert.strictEqual(transport.calls.get.length, beforeHeadDownloads, 'HEAD never asks the byte transport to download');
    assert.strictEqual(transport.calls.head.length, 1);

    await assert.rejects(
      () => storage.listObjects(),
      (error) => error && error.status === 501 && error.code === 'object_listing_not_available',
    );
  });

  it('overwrites with revision ETags and applies conditional PUT protections before Telegram upload', async function () {
    const { storage, transport } = fixture();
    const first = await storage.putObject('assets', 'item.txt', { body: textBytes('one'), contentType: 'text/plain' });
    const second = await storage.putObject('assets', 'item.txt', {
      body: textBytes('two'),
      contentType: 'text/plain',
      ifMatch: `"${first.object.etag}"`,
    });
    assert.strictEqual(second.status, 200);
    assert.strictEqual(second.object.version, 2);
    assert.notStrictEqual(second.object.etag, first.object.etag);
    assert.strictEqual(await new Response((await storage.getObject('assets', 'item.txt')).body).text(), 'two');

    const before = transport.calls.put.length;
    await assert.rejects(
      () => storage.putObject('assets', 'item.txt', {
        body: textBytes('stale'), contentType: 'text/plain', ifMatch: `"${first.object.etag}"`,
      }),
      (error) => error && error.status === 412 && error.code === 'precondition_failed',
    );
    await assert.rejects(
      () => storage.putObject('assets', 'item.txt', {
        body: textBytes('exists'), contentType: 'text/plain', ifNoneMatch: '*',
      }),
      (error) => error && error.status === 412 && error.code === 'precondition_failed',
    );
    assert.strictEqual(transport.calls.put.length, before, 'stale conditions do not create Telegram byte documents');
  });

  it('supports deterministic conditional GET/HEAD without fetching object bytes for 304 responses', async function () {
    const { storage, transport } = fixture();
    const put = await storage.putObject('assets', 'cached.txt', { body: textBytes('cache') });
    const conditionalGet = await storage.getObject('assets', 'cached.txt', { ifNoneMatch: `W/"${put.object.etag}"` });
    assert.strictEqual(conditionalGet.status, 304);
    assert.strictEqual(conditionalGet.not_modified, true);
    assert.strictEqual(transport.calls.get.length, 0);

    const conditionalHead = await storage.headObject('assets', 'cached.txt', {
      ifModifiedSince: new Date(put.object.updated_at).toUTCString(),
    });
    assert.strictEqual(conditionalHead.status, 304);
    assert.strictEqual(transport.calls.head.length, 0);

    const older = await storage.getObject('assets', 'cached.txt', { ifModifiedSince: 'Thu, 01 Jan 1970 00:00:00 GMT' });
    assert.strictEqual(older.status, 200);
    assert.strictEqual(await new Response(older.body).text(), 'cache');
  });

  it('uses logical tombstones and immutable delete events without promising Telegram physical deletion', async function () {
    const { kv, storage, transport } = fixture();
    const put = await storage.putObject('assets', 'gone.txt', { body: textBytes('gone') });
    const deleted = await storage.deleteObject('assets', 'gone.txt', { ifMatch: `"${put.object.etag}"` });
    assert.strictEqual(deleted.status, 200);
    assert.deepStrictEqual(deleted.deletion, {
      bucket: 'assets', key: 'gone.txt', version: 2, deleted: true, deleted_at: '2026-09-12T12:34:56.000Z',
    });
    assert.strictEqual(transport.calls.event.at(-1).operation, 'delete');
    assert.strictEqual(transport.calls.delete.length, 1);
    assert.ok(!JSON.stringify(deleted).includes('file_id'));

    const manifestEntry = kv.operations.put.filter((entry) => entry.key.startsWith('tc:v1:object-manifest:')).at(-1);
    const tombstone = JSON.parse(manifestEntry.value);
    assert.strictEqual(tombstone.state, 'deleted');
    assert.ok(tombstone.storage.file_id, 'the internal pointer remains only for immutable retention/audit');
    assert.ok(tombstone.event.file_id);
    await assert.rejects(() => storage.getObject('assets', 'gone.txt'), (error) => error && error.code === 'object_not_found');
    await assert.rejects(() => storage.headObject('assets', 'gone.txt'), (error) => error && error.code === 'object_not_found');
    await assert.rejects(() => storage.deleteObject('assets', 'gone.txt'), (error) => error && error.code === 'object_not_found');

    const recreated = await storage.putObject('assets', 'gone.txt', { body: textBytes('new'), ifNoneMatch: '*' });
    assert.strictEqual(recreated.status, 201);
    assert.strictEqual(recreated.object.version, 3);
  });

  it('enforces bucket/key/body/MIME/metadata validation and a configurable bounded body limit', async function () {
    const { storage, transport } = fixture({ env: { TELEGRAPH_CLOUD_MAX_OBJECT_BYTES: '3' } });
    await assert.rejects(
      () => storage.putObject('BadBucket', 'ok.txt', { body: textBytes('x') }),
      (error) => error && error.status === 422 && error.code === 'invalid_bucket_name',
    );
    await assert.rejects(
      () => storage.putObject('assets', '../escape.txt', { body: textBytes('x') }),
      (error) => error && error.status === 422 && error.code === 'invalid_object_key',
    );
    await assert.rejects(
      () => storage.putObject('assets', 'mime.txt', { body: textBytes('x'), contentType: 'not a mime' }),
      (error) => error && error.status === 415 && error.code === 'unsupported_media_type',
    );
    await assert.rejects(
      () => storage.putObject('assets', 'meta.txt', { body: textBytes('x'), metadata: { bad: 'line\nbreak' } }),
      (error) => error && error.status === 400 && error.code === 'invalid_custom_metadata_value',
    );
    await assert.rejects(
      () => storage.putObject('assets', 'large.txt', { body: textBytes('four') }),
      (error) => error && error.status === 413 && error.code === 'object_too_large',
    );
    assert.strictEqual(transport.calls.put.length, 0);
  });

  it('checks declared and streamed HTTP request body limits before handing bytes to the engine', async function () {
    await assert.rejects(
      () => objectHttp.readBoundedObjectBody(new Request('https://example.com/object', {
        method: 'PUT', headers: { 'Content-Length': '4' }, body: 'four',
      }), { maxObjectBytes: 3 }),
      (error) => error && error.status === 413 && error.code === 'object_too_large',
    );
    await assert.rejects(
      () => objectHttp.readBoundedObjectBody(new Request('https://example.com/object', {
        method: 'PUT', headers: { 'Content-Length': 'not-a-number' }, body: 'x',
      }), { maxObjectBytes: 3 }),
      (error) => error && error.status === 400 && error.code === 'invalid_content_length',
    );
    await assert.rejects(
      () => objectHttp.readBoundedObjectBody(new Request('https://example.com/object', {
        method: 'PUT', headers: { 'Content-Length': '2' }, body: 'x',
      }), { maxObjectBytes: 3 }),
      (error) => error && error.status === 400 && error.code === 'invalid_content_length',
    );
    assert.deepStrictEqual(
      objectHttp.customMetadataFromHeaders(new Headers({ 'X-Amz-Meta-Owner': 'alpha' })),
      { owner: 'alpha' },
    );
    assert.throws(
      () => objectHttp.customMetadataFromHeaders(new Headers({ 'X-Amz-Meta-__proto__': 'unsafe' })),
      (error) => error && error.status === 400 && error.code === 'invalid_custom_metadata_name',
    );
  });

  it('isolates the same bucket/key in separate project scopes', async function () {
    const kv = createMockKV();
    const env = { TELEGRAPH_CLOUD_KV: kv };
    const index = indexModule.createCloudIndexStore(env);
    const alphaTransport = createTransport();
    const betaTransport = createTransport();
    let counter = 0;
    const createId = (prefix) => `${prefix}${String(++counter).padStart(22, '0')}`;
    const alpha = objectStorage.createTelegramObjectStorage(env, {
      projectId: 'prj_A1b2C3d4', index, transport: alphaTransport, createId, now: fixedClock,
    });
    const beta = objectStorage.createTelegramObjectStorage(env, {
      projectId: 'prj_Z9y8X7w6', index, transport: betaTransport, createId, now: fixedClock,
    });
    await alpha.putObject('assets', 'same.txt', { body: textBytes('alpha') });
    await beta.putObject('assets', 'same.txt', { body: textBytes('beta') });
    assert.strictEqual(await new Response((await alpha.getObject('assets', 'same.txt')).body).text(), 'alpha');
    assert.strictEqual(await new Response((await beta.getObject('assets', 'same.txt')).body).text(), 'beta');
    assert.ok(kv.operations.put.some((entry) => entry.key.includes(':prj_A1b2C3d4:')));
    assert.ok(kv.operations.put.some((entry) => entry.key.includes(':prj_Z9y8X7w6:')));
  });

  it('keeps a ready outbox recoverable after a manifest KV failure without re-uploading Telegram bytes', async function () {
    const kv = createMockKV();
    const env = { TELEGRAPH_CLOUD_KV: kv };
    const baseIndex = indexModule.createCloudIndexStore(env);
    let failManifest = true;
    const index = {
      ...baseIndex,
      async putJson(namespace, segments, value, options) {
        if (namespace === 'object-manifest' && failManifest) {
          failManifest = false;
          throw new Error('simulated KV outage containing no public detail');
        }
        return baseIndex.putJson(namespace, segments, value, options);
      },
    };
    const transport = createTransport();
    let id = 0;
    const storage = objectStorage.createTelegramObjectStorage(env, {
      projectId: 'prj_A1b2C3d4', index, transport, now: fixedClock,
      createId(prefix) { return `${prefix}${String(++id).padStart(22, '0')}`; },
    });
    const input = { body: textBytes('recover me'), idempotencyKey: 'phase4-recovery-01' };
    await assert.rejects(
      () => storage.putObject('assets', 'recover.txt', input),
      (error) => error && error.status === 503 && error.code === 'object_mutation_pending',
    );
    assert.strictEqual(transport.calls.put.length, 1);
    assert.strictEqual(transport.calls.event.length, 1);
    const ready = kv.operations.put.filter((entry) => entry.key.startsWith('tc:v1:object-outbox:')).at(-1);
    assert.strictEqual(JSON.parse(ready.value).status, 'ready');

    const recovered = await storage.putObject('assets', 'recover.txt', input);
    assert.strictEqual(recovered.status, 201);
    assert.strictEqual(transport.calls.put.length, 1, 'the stored byte pointer was reused during repair');
    assert.strictEqual(transport.calls.event.length, 1, 'the stored immutable event pointer was reused during repair');
    assert.strictEqual(await new Response((await storage.getObject('assets', 'recover.txt')).body).text(), 'recover me');
  });

  it('fails safely when the Telegram byte adapter fails and never reflects an upstream error string', async function () {
    const transport = createTransport({ failPut: 'bot-token-or-upstream-detail-must-not-escape' });
    const { storage } = fixture({ transport });
    await assert.rejects(
      () => storage.putObject('assets', 'failed.txt', { body: textBytes('x') }),
      (error) => error && error.status === 503 && error.code === 'storage_backend_failure'
        && !error.message.includes('bot-token-or-upstream-detail-must-not-escape'),
    );
  });

  it('uses a Telegram-only object transport with no caller headers, paths, or metadata leaked to it', async function () {
    const calls = [];
    const client = {
      validateConfig() { calls.push({ type: 'validate' }); },
      async sendFormData(formData, endpoint) {
        calls.push({ type: 'send', endpoint, formData });
        return { success: true, data: { ok: true, result: { message_id: calls.length, document: { file_id: 'AgACObjectFile_123' } } } };
      },
      async getFilePath(fileId) { calls.push({ type: 'path', fileId }); return 'documents/object.bin'; },
      getFileDownloadUrl(path) { calls.push({ type: 'url', path }); return 'https://telegram.invalid/object'; },
      async fetchDownload(url, request) { calls.push({ type: 'download', url, method: request.method, authorization: request.headers.get('Authorization') }); return new Response('body'); },
    };
    const adapter = objectTransport.createTelegramObjectStorageAdapter({ TG_Chat_ID: '42' }, { client });
    const pointer = await adapter.putObject({ body: textBytes('body'), contentType: 'text/plain' });
    assert.deepStrictEqual(pointer, { provider: 'telegram-object', fileId: 'AgACObjectFile_123', messageId: 2 });
    const upload = calls.find((call) => call.type === 'send');
    assert.strictEqual(upload.endpoint, 'sendDocument');
    assert.strictEqual(upload.formData.get('chat_id'), '42');
    assert.strictEqual(upload.formData.get('document').name, 'telegraph-cloud-object.bin');
    assert.strictEqual(await upload.formData.get('document').text(), 'body');

    await adapter.appendEvent({ schema: 'telegraph-cloud.object-revision.v1', event_id: 'objrev_test' });
    const eventUpload = calls.filter((call) => call.type === 'send').at(-1);
    assert.strictEqual(eventUpload.formData.get('document').name, 'telegraph-cloud-object-event.json');
    assert.ok((await eventUpload.formData.get('document').text()).includes('object-revision'));

    await adapter.getObject(pointer);
    const download = calls.at(-1);
    assert.deepStrictEqual(download, { type: 'download', url: 'https://telegram.invalid/object', method: 'GET', authorization: null });
    const downloadCount = calls.filter((call) => call.type === 'download').length;
    await adapter.headObject(pointer);
    assert.strictEqual(calls.filter((call) => call.type === 'download').length, downloadCount, 'transport HEAD does not download');
    await adapter.deleteObject(pointer);
    assert.strictEqual(calls.filter((call) => call.type === 'send').length, 2, 'delete is logical and never invokes Telegram message deletion');
  });

  it('never lets a generic context service override an authenticated storage project scope', function () {
    const ignoredService = { getObject() { throw new Error('must not be selected'); } };
    assert.throws(
      () => objectHttp.objectStorageForContext({
        env: {},
        data: {
          objectStorage: ignoredService,
          storageAuthentication: { authentication: 'developer_api_key', project_id: 'prj_A1b2C3d4' },
        },
      }),
      (error) => error && error.code === 'cloud_index_unavailable',
    );
  });

  it('derives route project scope exclusively from storage-scoped Bearer keys and shapes safe HTTP responses', async function () {
    const kv = createMockKV();
    const env = {
      TELEGRAPH_CLOUD_KV: kv,
      API_KEY_PEPPER: 'phase-four-route-test-pepper-that-is-at-least-thirty-two-bytes',
      TG_Bot_Token: '123:secret-not-public',
      TG_Chat_ID: '123456',
      disable_telemetry: 'true',
    };
    const index = indexModule.createCloudIndexStore(env);
    let projectCounter = 0;
    const projects = projectModule.createProjectRegistry(env, {
      index, now: fixedClock,
      createId(prefix) { return `${prefix}${String(++projectCounter).padStart(8, '0')}`; },
    });
    const alpha = await projects.createProject({ slug: 'storage-alpha', name: 'Storage Alpha' });
    const beta = await projects.createProject({ slug: 'storage-beta', name: 'Storage Beta' });
    let keyCounter = 0;
    const keys = keyModule.createDeveloperApiKeyService(env, {
      index, projects, now: fixedClock,
      createId(prefix) { return `${prefix}${String(++keyCounter).padStart(22, '0')}`; },
      randomBytes(length) { return new Uint8Array(length).fill(keyCounter + 1); },
    });
    const alphaWrite = await keys.createKey(alpha.project_id, { scopes: ['storage:read', 'storage:write'] });
    const alphaRead = await keys.createKey(alpha.project_id, { scopes: ['storage:read'] });
    const alphaWriteOnly = await keys.createKey(alpha.project_id, { scopes: ['storage:write'] });
    const betaWrite = await keys.createKey(beta.project_id, { scopes: ['storage:read', 'storage:write'] });
    assert.ok(kv.operations.put.some((entry) => entry.key.startsWith('tc:v1:api-key-lookup:h_')), 'every base64url verifier receives a collision-free valid KV segment prefix');
    let telegramSequence = 0;
    const fetchMock = installFetchMock(async (url, init) => {
      assert.notStrictEqual(init.headers?.get?.('Authorization'), `Bearer ${alphaWrite.api_key}`, 'developer Authorization is never forwarded to Telegram');
      if (url.includes('getFile')) {
        return Response.json({ ok: true, result: { file_path: 'documents/object.bin' } });
      }
      if (url.includes('/file/')) return new Response('route-bytes');
      telegramSequence += 1;
      return Response.json({
        ok: true,
        result: { message_id: telegramSequence, document: { file_id: `AgACRouteObject${telegramSequence}` } },
      });
    });

    async function requestFor(key, method, extra = {}) {
      return runPipeline(storageMiddleware.onRequest, storageRoute, makeContext({
        request: new Request(`https://example.com/api/storage/assets/nested/route.txt?project_id=${beta.project_id}`, {
          method,
          headers: { Authorization: `Bearer ${key}`, ...(extra.headers || {}) },
          ...(Object.prototype.hasOwnProperty.call(extra, 'body') ? { body: extra.body } : {}),
        }),
        env,
        params: { bucket: 'assets', key: 'nested/route.txt' },
      }));
    }

    try {
      const put = await requestFor(alphaWrite.api_key, 'PUT', {
        headers: { 'Content-Type': 'text/plain', 'X-Amz-Meta-Owner': 'alpha' }, body: 'route-bytes',
      });
      assert.strictEqual(put.status, 201);
      assert.strictEqual(put.headers.get('ETag').startsWith('"sha256-'), true);
      assert.strictEqual(put.headers.get('Cache-Control'), 'private, no-store');
      const putBody = await put.json();
      assert.strictEqual(putBody.data.key, 'nested/route.txt');
      assert.deepStrictEqual(putBody.data.metadata, { owner: 'alpha' });
      assert.ok(!JSON.stringify(putBody).includes('AgACRouteObject'));
      assert.ok(kv.snapshot(`tc:v1:object-bucket:${alpha.project_id}:assets`));
      assert.strictEqual(kv.snapshot(`tc:v1:object-bucket:${beta.project_id}:assets`), undefined, 'query project hint is ignored');

      const deniedWrite = await requestFor(alphaRead.api_key, 'PUT', { body: 'nope' });
      assert.strictEqual(deniedWrite.status, 403);
      assert.deepStrictEqual(await deniedWrite.json(), { error: 'api_key_scope_forbidden' });
      const deniedRead = await requestFor(alphaWriteOnly.api_key, 'GET');
      assert.strictEqual(deniedRead.status, 403);
      assert.deepStrictEqual(await deniedRead.json(), { error: 'api_key_scope_forbidden' });

      const get = await requestFor(alphaRead.api_key, 'GET');
      assert.strictEqual(get.status, 200);
      assert.strictEqual(get.headers.get('Content-Type'), 'text/plain');
      assert.strictEqual(get.headers.get('Content-Disposition'), 'attachment; filename="download"');
      assert.strictEqual(get.headers.get('X-Content-Type-Options'), 'nosniff');
      assert.strictEqual(get.headers.get('X-Amz-Meta-Owner'), 'alpha');
      assert.strictEqual(await get.text(), 'route-bytes');

      const beforeHead = fetchMock.calls.filter((call) => call.url.includes('/file/')).length;
      const head = await requestFor(alphaRead.api_key, 'HEAD');
      assert.strictEqual(head.status, 200);
      assert.strictEqual(await head.text(), '');
      assert.strictEqual(fetchMock.calls.filter((call) => call.url.includes('/file/')).length, beforeHead);

      const notModified = await requestFor(alphaRead.api_key, 'GET', { headers: { 'If-None-Match': put.headers.get('ETag') } });
      assert.strictEqual(notModified.status, 304);
      assert.strictEqual(fetchMock.calls.filter((call) => call.url.includes('/file/')).length, beforeHead);

      const betaGet = await requestFor(betaWrite.api_key, 'GET');
      assert.strictEqual(betaGet.status, 404);
      assert.deepStrictEqual(await betaGet.json(), { error: 'object_not_found' });

      const ranged = await requestFor(alphaRead.api_key, 'GET', { headers: { Range: 'bytes=0-1' } });
      assert.strictEqual(ranged.status, 416);
      assert.deepStrictEqual(await ranged.json(), { error: 'range_not_supported' });

      const unauthenticated = await runPipeline(storageMiddleware.onRequest, storageRoute, makeContext({
        request: new Request('https://example.com/api/storage/assets/key'),
        env,
        params: { bucket: 'assets', key: 'key' },
      }));
      assert.strictEqual(unauthenticated.status, 401);
      assert.deepStrictEqual(await unauthenticated.json(), { error: 'invalid_api_key' });
      const dashboardCredential = await runPipeline(storageMiddleware.onRequest, storageRoute, makeContext({
        request: new Request('https://example.com/api/storage/assets/key', {
          headers: { Authorization: `Basic ${btoa('admin:secret')}` },
        }),
        env,
        params: { bucket: 'assets', key: 'key' },
      }));
      assert.strictEqual(dashboardCredential.status, 401, 'dashboard Basic credentials never become a storage project scope');
      assert.deepStrictEqual(await dashboardCredential.json(), { error: 'invalid_api_key' });
    } finally {
      fetchMock.restore();
    }
  });
});
