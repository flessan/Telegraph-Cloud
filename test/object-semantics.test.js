const assert = require('assert');
const { createMockKV, muteConsole } = require('./helpers');

function textBytes(value) {
  return new TextEncoder().encode(value);
}

function fixedClock(value = '2026-09-13T00:00:00.000Z') {
  return () => new Date(value);
}

describe('Telegraph Cloud Phase 5 object listing, ranges, and revisions', function () {
  let objectStorage;
  let objectHttp;
  let indexModule;
  let restoreConsole;

  before(async function () {
    objectStorage = await import('../functions/cloud/object-storage.js');
    objectHttp = await import('../functions/cloud/object-http.js');
    indexModule = await import('../functions/cloud/index-store.js');
  });

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    restoreConsole();
  });

  function createTransport({ rangeMode = 'supported' } = {}) {
    let sequence = 0;
    const bytes = new Map();
    const calls = { put: [], event: [], get: [], head: [], delete: [] };
    return {
      calls,
      bytes,
      async putObject({ body, contentType }) {
        calls.put.push({ body: new Uint8Array(body), contentType });
        const fileId = `file${String(++sequence).padStart(16, '0')}`;
        bytes.set(fileId, new Uint8Array(body));
        return { provider: 'telegram-object', fileId, messageId: sequence };
      },
      async appendEvent(event) {
        calls.event.push(structuredClone(event));
        const fileId = `event${String(++sequence).padStart(15, '0')}`;
        return { provider: 'telegram-object-event', fileId, messageId: sequence };
      },
      async getObject(pointer, { range = null } = {}) {
        calls.get.push({ ...pointer, ...(range ? { range: { ...range } } : {}) });
        const body = bytes.get(pointer.fileId);
        if (!range || rangeMode === 'ignored') return new Response(body);
        const partial = body.slice(range.start, range.end + 1);
        return new Response(partial, {
          status: 206,
          headers: {
            'Content-Range': `bytes ${range.start}-${range.end}/${range.size}`,
            'Content-Length': String(partial.byteLength),
          },
        });
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

  function fixture({
    projectId = 'prj_A1b2C3d4',
    env = {},
    index: suppliedIndex,
    transport: suppliedTransport,
    now = fixedClock(),
  } = {}) {
    const kv = createMockKV();
    const runtimeEnv = {
      TELEGRAPH_CLOUD_KV: kv,
      API_KEY_PEPPER: 'phase-five-test-pepper-that-is-at-least-thirty-two-bytes-long',
      ...env,
    };
    const index = suppliedIndex || indexModule.createCloudIndexStore(runtimeEnv);
    const transport = suppliedTransport || createTransport();
    let id = 0;
    const storage = objectStorage.createTelegramObjectStorage(runtimeEnv, {
      projectId,
      index,
      transport,
      now,
      createId(prefix) {
        id += 1;
        return `${prefix}${String(id).padStart(22, '0')}`;
      },
    });
    return { kv, env: runtimeEnv, index, transport, storage };
  }

  async function putMany(storage, keys) {
    for (const key of keys) {
      await storage.putObject('assets', key, {
        body: textBytes(`body:${key}`),
        contentType: 'text/plain',
        metadata: { owner: 'phase-five' },
      });
    }
  }

  it('lists an empty bucket, then returns public current metadata in deterministic key order with opaque cursor pagination', async function () {
    const { storage, transport } = fixture();
    const empty = await storage.listObjects('assets');
    assert.deepStrictEqual(empty.objects, []);
    assert.strictEqual(empty.has_more, false);
    assert.strictEqual(empty.next_cursor, undefined);

    await putMany(storage, ['z.txt', 'images/posts/one.txt', 'a.txt', 'images/avatar.png']);
    const first = await storage.listObjects('assets', { limit: 2 });
    assert.deepStrictEqual(first.objects.map((object) => object.key), ['a.txt', 'images/avatar.png']);
    assert.strictEqual(first.limit, 2);
    assert.strictEqual(first.order, 'key:asc');
    assert.strictEqual(first.has_more, true);
    assert.match(first.next_cursor, /^[A-Za-z0-9_-]+$/);
    assert.ok(!first.next_cursor.includes('images'), 'the external continuation is opaque');
    assert.deepStrictEqual(first.objects[0].metadata, { owner: 'phase-five' });
    assert.ok(!/file_id|message_id|revision_id|telegram|objkey/.test(JSON.stringify(first.objects)));

    const second = await storage.listObjects('assets', { limit: 2, cursor: first.next_cursor });
    assert.deepStrictEqual(second.objects.map((object) => object.key), ['images/posts/one.txt', 'z.txt']);
    assert.strictEqual(second.has_more, false);
    assert.strictEqual(transport.calls.get.length, 0, 'listing never downloads Telegram object bytes');
  });

  it('implements literal prefix selection and slash delimiter common-prefix grouping without directories', async function () {
    const { storage } = fixture();
    await putMany(storage, [
      'images/banner.webp',
      'images/avatars/alice.png',
      'images/avatars/bob.png',
      'images/posts/first.png',
      'notes/readme.txt',
    ]);

    const prefixed = await storage.listObjects('assets', { prefix: 'images/' });
    assert.deepStrictEqual(prefixed.objects.map((object) => object.key), [
      'images/avatars/alice.png',
      'images/avatars/bob.png',
      'images/banner.webp',
      'images/posts/first.png',
    ]);

    const grouped = await storage.listObjects('assets', { prefix: 'images/', delimiter: '/', limit: 10 });
    assert.deepStrictEqual(grouped.objects.map((object) => object.key), ['images/banner.webp']);
    assert.deepStrictEqual(grouped.common_prefixes, ['images/avatars/', 'images/posts/']);
    assert.strictEqual(grouped.has_more, false);

    const firstGroup = await storage.listObjects('assets', { prefix: 'images/', delimiter: '/', limit: 1 });
    const nextGroup = await storage.listObjects('assets', {
      prefix: 'images/', delimiter: '/', limit: 1, cursor: firstGroup.next_cursor,
    });
    assert.deepStrictEqual(firstGroup.common_prefixes, ['images/avatars/']);
    assert.deepStrictEqual(nextGroup.common_prefixes, []);
    // The second logical item is the direct banner object, not a duplicate
    // avatars prefix across the continuation boundary.
    assert.deepStrictEqual(nextGroup.objects.map((object) => object.key), ['images/banner.webp']);
  });

  it('signs cursors to the project and exact list selection and rejects tampering or oversized controls', async function () {
    const alpha = fixture();
    await putMany(alpha.storage, ['a.txt', 'b.txt', 'c.txt']);
    const page = await alpha.storage.listObjects('assets', { limit: 1 });
    assert.strictEqual(page.has_more, true);

    const replacement = `${page.next_cursor.slice(0, -1)}${page.next_cursor.endsWith('A') ? 'B' : 'A'}`;
    await assert.rejects(
      () => alpha.storage.listObjects('assets', { limit: 1, cursor: replacement }),
      (error) => error && error.status === 400 && error.code === 'invalid_cursor',
    );
    await assert.rejects(
      () => alpha.storage.listObjects('assets', { prefix: 'a', limit: 1, cursor: page.next_cursor }),
      (error) => error && error.status === 400 && error.code === 'invalid_cursor',
    );
    await assert.rejects(
      () => alpha.storage.listObjects('assets', { delimiter: '/', limit: 1, cursor: page.next_cursor }),
      (error) => error && error.status === 400 && error.code === 'invalid_cursor',
    );

    const beta = fixture({ projectId: 'prj_Z9y8X7w6', env: { TELEGRAPH_CLOUD_KV: alpha.kv } });
    await assert.rejects(
      () => beta.storage.listObjects('assets', { limit: 1, cursor: page.next_cursor }),
      (error) => error && error.status === 400 && error.code === 'invalid_cursor',
    );
    await assert.rejects(
      () => alpha.storage.listObjects('assets', { limit: 101 }),
      (error) => error && error.status === 400 && error.code === 'invalid_object_list_limit',
    );
    await assert.rejects(
      () => alpha.storage.listObjects('assets', { delimiter: '.' }),
      (error) => error && error.status === 400 && error.code === 'invalid_object_delimiter',
    );
    assert.throws(
      () => objectStorage.parseObjectListQuery(new URLSearchParams('limit=2&limit=3'), alpha.env),
      (error) => error && error.status === 400 && error.code === 'invalid_object_list_query',
    );
  });

  it('applies bounded environment-configured default and maximum list limits', async function () {
    const { storage } = fixture({
      env: {
        TELEGRAPH_CLOUD_DEFAULT_OBJECT_LIST_LIMIT: '2',
        TELEGRAPH_CLOUD_MAX_OBJECT_LIST_LIMIT: '3',
      },
    });
    await putMany(storage, ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
    const defaultPage = await storage.listObjects('assets');
    assert.strictEqual(defaultPage.limit, 2);
    assert.deepStrictEqual(defaultPage.objects.map((object) => object.key), ['a.txt', 'b.txt']);
    assert.strictEqual(defaultPage.has_more, true);
    assert.strictEqual((await storage.listObjects('assets', { limit: 3 })).objects.length, 3);
    await assert.rejects(
      () => storage.listObjects('assets', { limit: 4 }),
      (error) => error && error.status === 400 && error.code === 'invalid_object_list_limit',
    );
  });

  it('keeps list entries isolated by project, hides tombstones, and carries forward logical versions on recreation', async function () {
    const kv = createMockKV();
    const env = {
      TELEGRAPH_CLOUD_KV: kv,
      API_KEY_PEPPER: 'phase-five-shared-pepper-that-is-at-least-thirty-two-bytes',
    };
    const index = indexModule.createCloudIndexStore(env);
    const alphaTransport = createTransport();
    const betaTransport = createTransport();
    let id = 0;
    const createId = (prefix) => `${prefix}${String(++id).padStart(22, '0')}`;
    const alpha = objectStorage.createTelegramObjectStorage(env, {
      projectId: 'prj_A1b2C3d4', index, transport: alphaTransport, createId, now: fixedClock(),
    });
    const beta = objectStorage.createTelegramObjectStorage(env, {
      projectId: 'prj_Z9y8X7w6', index, transport: betaTransport, createId, now: fixedClock(),
    });
    const alphaFirst = await alpha.putObject('assets', 'shared.txt', { body: textBytes('alpha') });
    await beta.putObject('assets', 'shared.txt', { body: textBytes('beta') });
    assert.deepStrictEqual((await alpha.listObjects('assets')).objects.map((object) => object.key), ['shared.txt']);
    assert.deepStrictEqual((await beta.listObjects('assets')).objects.map((object) => object.key), ['shared.txt']);

    const deleted = await alpha.deleteObject('assets', 'shared.txt', {
      ifMatch: `"${alphaFirst.object.etag}"`, idempotencyKey: 'phase-five-delete-001',
    });
    assert.strictEqual(deleted.deletion.version, 2);
    assert.deepStrictEqual((await alpha.listObjects('assets')).objects, []);
    assert.deepStrictEqual((await beta.listObjects('assets')).objects.map((object) => object.key), ['shared.txt']);

    const recreated = await alpha.putObject('assets', 'shared.txt', {
      body: textBytes('alpha-recreated'), ifNoneMatch: '*', idempotencyKey: 'phase-five-recreate-001',
    });
    assert.strictEqual(recreated.status, 201);
    assert.strictEqual(recreated.object.version, 3);
    assert.deepStrictEqual((await alpha.listObjects('assets')).objects.map((object) => object.version), [3]);
  });

  it('uses a chunked ordered index for maximum-length object keys without oversized KV key names', async function () {
    const { storage, kv } = fixture();
    const longKey = `reports/${'x'.repeat(1016)}`;
    assert.strictEqual(new TextEncoder().encode(longKey).byteLength, 1024);
    await storage.putObject('assets', longKey, { body: textBytes('long') });
    const page = await storage.listObjects('assets', { prefix: 'reports/', limit: 10 });
    assert.deepStrictEqual(page.objects.map((object) => object.key), [longKey]);
    const listKeys = kv.operations.put
      .filter((entry) => entry.key.startsWith('tc:v1:object-list:'))
      .map((entry) => entry.key);
    assert.ok(listKeys.length > 2, 'long keys create only actual chunk branch markers plus one leaf');
    assert.ok(listKeys.every((key) => new TextEncoder().encode(key).byteLength <= 512));
  });

  it('keeps a maximum-length literal-prefix continuation bounded without serializing prefix state at every tree level', async function () {
    const { storage, kv } = fixture();
    const sharedPrefix = 'x'.repeat(1023);
    await putMany(storage, [`${sharedPrefix}a`, `${sharedPrefix}b`, `${sharedPrefix}c`]);
    const first = await storage.listObjects('assets', { prefix: sharedPrefix, limit: 1 });
    assert.deepStrictEqual(first.objects.map((object) => object.key), [`${sharedPrefix}a`]);
    assert.strictEqual(first.has_more, true);
    const cursorWrite = kv.operations.put.filter((entry) => entry.key.startsWith('tc:v1:object-list-cursor:')).at(-1);
    assert.ok(cursorWrite);
    assert.ok(new TextEncoder().encode(cursorWrite.value).byteLength < 64 * 1024);
    const second = await storage.listObjects('assets', { prefix: sharedPrefix, limit: 1, cursor: first.next_cursor });
    assert.deepStrictEqual(second.objects.map((object) => object.key), [`${sharedPrefix}b`]);
  });

  it('replays a ready mutation to repair a failed list-index materialization without duplicate Telegram writes', async function () {
    const kv = createMockKV();
    const env = {
      TELEGRAPH_CLOUD_KV: kv,
      API_KEY_PEPPER: 'phase-five-recovery-pepper-that-is-at-least-thirty-two-bytes',
    };
    const baseIndex = indexModule.createCloudIndexStore(env);
    let failLeaf = true;
    const index = {
      ...baseIndex,
      async putJson(namespace, segments, value, options) {
        if (namespace === 'object-list' && value?.kind === 'terminal' && failLeaf) {
          failLeaf = false;
          throw new Error('simulated list leaf outage');
        }
        return baseIndex.putJson(namespace, segments, value, options);
      },
    };
    const transport = createTransport();
    let id = 0;
    const storage = objectStorage.createTelegramObjectStorage(env, {
      projectId: 'prj_A1b2C3d4', index, transport, now: fixedClock(),
      createId(prefix) { return `${prefix}${String(++id).padStart(22, '0')}`; },
    });
    const input = { body: textBytes('recover'), idempotencyKey: 'phase-five-index-recovery-001' };
    await assert.rejects(
      () => storage.putObject('assets', 'recover.txt', input),
      (error) => error && error.status === 503 && error.code === 'object_mutation_pending',
    );
    assert.strictEqual(transport.calls.put.length, 1);
    assert.strictEqual(transport.calls.event.length, 1);
    assert.deepStrictEqual((await storage.listObjects('assets')).objects, [], 'no half-materialized list entry becomes public');

    await storage.putObject('assets', 'recover.txt', input);
    assert.strictEqual(transport.calls.put.length, 1);
    assert.strictEqual(transport.calls.event.length, 1);
    assert.deepStrictEqual((await storage.listObjects('assets')).objects.map((object) => object.key), ['recover.txt']);
  });

  it('hides a tombstone even when a failed leaf removal leaves a stale index candidate for recovery', async function () {
    const kv = createMockKV();
    const env = {
      TELEGRAPH_CLOUD_KV: kv,
      API_KEY_PEPPER: 'phase-five-tombstone-pepper-that-is-at-least-thirty-two-bytes',
    };
    const baseIndex = indexModule.createCloudIndexStore(env);
    let failRemoval = false;
    const index = {
      ...baseIndex,
      async remove(namespace, ...segments) {
        if (namespace === 'object-list' && failRemoval) {
          failRemoval = false;
          throw new Error('simulated list leaf removal outage');
        }
        return baseIndex.remove(namespace, ...segments);
      },
    };
    const transport = createTransport();
    let id = 0;
    const storage = objectStorage.createTelegramObjectStorage(env, {
      projectId: 'prj_A1b2C3d4', index, transport, now: fixedClock(),
      createId(prefix) { return `${prefix}${String(++id).padStart(22, '0')}`; },
    });
    const created = await storage.putObject('assets', 'stale-leaf.txt', { body: textBytes('active') });
    failRemoval = true;
    const deleteInput = { ifMatch: `"${created.object.etag}"`, idempotencyKey: 'phase-five-stale-leaf-delete' };
    await assert.rejects(
      () => storage.deleteObject('assets', 'stale-leaf.txt', deleteInput),
      (error) => error && error.status === 503 && error.code === 'object_mutation_pending',
    );
    assert.deepStrictEqual((await storage.listObjects('assets')).objects, [], 'stale index leaves never resurrect a tombstone');
    await storage.deleteObject('assets', 'stale-leaf.txt', deleteInput);
    assert.strictEqual(transport.calls.delete.length, 1, 'logical deletion never physically removes Telegram history');
  });

  it('returns exact single byte ranges and rejects invalid, unsatisfiable, and upstream-ignored ranges safely', async function () {
    const { storage, transport } = fixture();
    await storage.putObject('assets', 'range.txt', { body: textBytes('0123456789'), contentType: 'text/plain' });

    for (const [header, expected, contentRange] of [
      ['bytes=0-2', '012', 'bytes 0-2/10'],
      ['bytes=3-6', '3456', 'bytes 3-6/10'],
      ['bytes=8-', '89', 'bytes 8-9/10'],
      ['bytes=-3', '789', 'bytes 7-9/10'],
      ['bytes=0-9', '0123456789', 'bytes 0-9/10'],
    ]) {
      const result = await storage.getObject('assets', 'range.txt', { range: header });
      assert.strictEqual(result.status, 206);
      assert.strictEqual(await new Response(result.body).text(), expected);
      assert.strictEqual(`bytes ${result.range.start}-${result.range.end}/${result.range.size}`, contentRange);
    }
    assert.strictEqual(transport.calls.get.at(-1).range.start, 0);
    const normal = await storage.getObject('assets', 'range.txt');
    assert.strictEqual(normal.status, 200);
    assert.strictEqual(await new Response(normal.body).text(), '0123456789');

    for (const header of [
      'bytes=10-11', 'bytes=7-2', 'bytes=0-1,3-4', 'items=0-1', 'bytes=-0',
      `bytes=0-${'1'.repeat(300)}`,
    ]) {
      await assert.rejects(
        () => storage.getObject('assets', 'range.txt', { range: header }),
        (error) => error && error.status === 416 && error.code === 'range_not_satisfiable'
          && error.details?.object_size === 10,
      );
    }
    const rangedHead = await storage.headObject('assets', 'range.txt', { range: 'bytes=2-4' });
    assert.strictEqual(rangedHead.status, 206);
    assert.deepStrictEqual(rangedHead.range, { start: 2, end: 4, size: 10, length: 3 });

    const ignored = fixture({ transport: createTransport({ rangeMode: 'ignored' }) });
    await ignored.storage.putObject('assets', 'ignored.txt', { body: textBytes('body') });
    await assert.rejects(
      () => ignored.storage.getObject('assets', 'ignored.txt', { range: 'bytes=0-1' }),
      (error) => error && error.status === 502 && error.code === 'storage_range_unavailable',
    );
  });

  it('evaluates standard conditional precedence before byte range retrieval and supports write If-Unmodified-Since', async function () {
    const clock = fixedClock('2026-09-13T10:00:00.000Z');
    const { storage, transport } = fixture({ now: clock });
    const put = await storage.putObject('assets', 'conditional.txt', { body: textBytes('conditional') });
    const staleDate = 'Sun, 13 Sep 2026 09:00:00 GMT';
    const freshDate = 'Sun, 13 Sep 2026 11:00:00 GMT';

    const downloadsBefore = transport.calls.get.length;
    const etag304 = await storage.getObject('assets', 'conditional.txt', {
      ifNoneMatch: `W/"${put.object.etag}"`, range: 'bytes=0-2',
    });
    assert.strictEqual(etag304.status, 304);
    const date304 = await storage.getObject('assets', 'conditional.txt', {
      ifModifiedSince: freshDate, range: 'bytes=0-2',
    });
    assert.strictEqual(date304.status, 304);
    assert.strictEqual(transport.calls.get.length, downloadsBefore, '304 is decided before Telegram byte retrieval');

    await assert.rejects(
      () => storage.getObject('assets', 'conditional.txt', { ifMatch: '"sha256-not-current-v1"', range: 'bytes=0-2' }),
      (error) => error && error.status === 412 && error.code === 'precondition_failed',
    );
    await assert.rejects(
      () => storage.getObject('assets', 'conditional.txt', { ifUnmodifiedSince: staleDate, range: 'bytes=0-2' }),
      (error) => error && error.status === 412 && error.code === 'precondition_failed',
    );

    const strongMatchWins = await storage.getObject('assets', 'conditional.txt', {
      ifMatch: `"${put.object.etag}"`, ifUnmodifiedSince: staleDate, range: 'bytes=0-2',
    });
    assert.strictEqual(strongMatchWins.status, 206, 'If-Match takes precedence over If-Unmodified-Since');
    const noneMatchWins = await storage.getObject('assets', 'conditional.txt', {
      ifNoneMatch: '"sha256-not-current-v1"', ifModifiedSince: freshDate, range: 'bytes=0-2',
    });
    assert.strictEqual(noneMatchWins.status, 206, 'If-None-Match takes precedence over If-Modified-Since');

    const writesBefore = transport.calls.put.length;
    await assert.rejects(
      () => storage.putObject('assets', 'conditional.txt', {
        body: textBytes('stale'), ifUnmodifiedSince: staleDate,
      }),
      (error) => error && error.status === 412 && error.code === 'precondition_failed',
    );
    assert.strictEqual(transport.calls.put.length, writesBefore, 'failed write preconditions do not upload a Telegram byte document');
    const eventsBeforeDelete = transport.calls.event.length;
    await assert.rejects(
      () => storage.deleteObject('assets', 'conditional.txt', { ifUnmodifiedSince: staleDate }),
      (error) => error && error.status === 412 && error.code === 'precondition_failed',
    );
    assert.strictEqual(transport.calls.event.length, eventsBeforeDelete, 'failed DELETE conditions do not append a Telegram tombstone event');
  });

  it('renders correct HTTP range and metadata headers while preserving private cache semantics', async function () {
    const { storage } = fixture();
    const put = await storage.putObject('assets', 'headers.txt', {
      body: textBytes('headers'), contentType: 'text/plain', metadata: { owner: 'phase-five' },
    });
    const partial = await storage.getObject('assets', 'headers.txt', { range: 'bytes=1-3' });
    const response = objectHttp.objectReadResponse(partial);
    assert.strictEqual(response.status, 206);
    assert.strictEqual(response.headers.get('Cache-Control'), 'private, no-store');
    assert.strictEqual(response.headers.get('ETag'), `"${put.object.etag}"`);
    assert.strictEqual(response.headers.get('Content-Type'), 'text/plain');
    assert.strictEqual(response.headers.get('Content-Length'), '3');
    assert.strictEqual(response.headers.get('Content-Range'), 'bytes 1-3/7');
    assert.strictEqual(response.headers.get('Accept-Ranges'), 'bytes');
    assert.strictEqual(response.headers.get('X-Amz-Meta-Owner'), 'phase-five');
    assert.strictEqual(await response.text(), 'ead');
  });
});
