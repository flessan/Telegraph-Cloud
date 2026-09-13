const assert = require('assert');
const { JSDOM } = require('jsdom');
const { createMockKV, installFetchMock, makeContext, muteConsole } = require('./helpers');
const { signS3Request } = require('./s3-signing');

const PROJECT_ALPHA = 'prj_A1b2C3d4';
const PROJECT_BETA = 'prj_B2c3D4e5';
const S3_REQUEST_ID = 'S3TESTREQUESTID000000000000000001';
const S3_NOW = Date.parse('2026-09-13T08:00:00.000Z');
const PEPPER = 'phase-six-a-test-pepper-that-is-at-least-thirty-two-bytes-long';

function textBytes(value) {
  return new TextEncoder().encode(value);
}

function fixedClock() {
  return new Date('2026-09-13T08:00:00.000Z');
}

function parseXml(xml) {
  const window = new JSDOM('').window;
  const document = new window.DOMParser().parseFromString(xml, 'application/xml');
  assert.strictEqual(document.getElementsByTagName('parsererror').length, 0, `well-formed XML expected: ${xml}`);
  return document;
}

function xmlValues(document, name) {
  return Array.from(document.getElementsByTagName(name)).map((element) => element.textContent);
}

async function runPipeline(middlewares, route, context) {
  const handlers = [...middlewares, async () => route.onRequest(context)];
  let position = 0;
  context.next = () => handlers[position++](context);
  return context.next();
}

describe('Telegraph Cloud Phase 6B S3 protocol compatibility', function () {
  let objectStorage;
  let indexModule;
  let protocol;
  let auth;
  let projectModule;
  let credentialModule;
  let s3Middleware;
  let s3Route;
  let restoreConsole;

  before(async function () {
    objectStorage = await import('../functions/cloud/object-storage.js');
    indexModule = await import('../functions/cloud/index-store.js');
    protocol = await import('../functions/cloud/s3-protocol.js');
    auth = await import('../functions/cloud/s3-auth.js');
    projectModule = await import('../functions/cloud/project-registry.js');
    credentialModule = await import('../functions/cloud/s3-credentials.js');
    s3Middleware = await import('../functions/s3/_middleware.js');
    s3Route = await import('../functions/s3/[[path]].js');
  });

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    restoreConsole();
  });

  function createTransport() {
    let sequence = 0;
    const bytes = new Map();
    const calls = { put: [], event: [], get: [], head: [], delete: [] };
    return {
      bytes,
      calls,
      async putObject({ body, contentType }) {
        calls.put.push({ body: new Uint8Array(body), contentType });
        const fileId = `file${String(++sequence).padStart(16, '0')}`;
        bytes.set(fileId, new Uint8Array(body));
        return { provider: 'telegram-object', fileId, messageId: sequence };
      },
      async appendEvent(event) {
        calls.event.push(structuredClone(event));
        return {
          provider: 'telegram-object-event',
          fileId: `event${String(++sequence).padStart(15, '0')}`,
          messageId: sequence,
        };
      },
      async getObject(pointer, { range = null } = {}) {
        calls.get.push({ ...pointer, ...(range ? { range: { ...range } } : {}) });
        const value = bytes.get(pointer.fileId);
        if (!range) return new Response(value);
        const partial = value.slice(range.start, range.end + 1);
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

  function fixture({ projectId = PROJECT_ALPHA, env = {}, kv = createMockKV(), transport = createTransport() } = {}) {
    const runtimeEnv = {
      TELEGRAPH_CLOUD_KV: kv,
      API_KEY_PEPPER: PEPPER,
      TELEGRAPH_CLOUD_S3_CREDENTIAL_PEPPER: PEPPER,
      ...env,
    };
    const index = indexModule.createCloudIndexStore(runtimeEnv);
    let id = 0;
    const storage = objectStorage.createTelegramObjectStorage(runtimeEnv, {
      projectId,
      index,
      transport,
      now: fixedClock,
      createId(prefix) {
        id += 1;
        return `${prefix}${String(id).padStart(22, '0')}`;
      },
    });
    const adapter = protocol.createS3ProtocolAdapter({
      storage,
      projectId,
      env: runtimeEnv,
      requestId: S3_REQUEST_ID,
      now: () => S3_NOW,
    });
    return { kv, env: runtimeEnv, index, transport, storage, adapter, projectId };
  }

  async function put(storage, key, body = `body:${key}`, metadata = { owner: 'phase-six' }) {
    return storage.putObject('assets', key, {
      body: textBytes(body),
      contentType: 'text/plain; charset=utf-8',
      metadata,
    });
  }

  async function s3Error(call, resource = '/assets/item.txt') {
    try {
      return await call();
    } catch (error) {
      return protocol.s3ErrorResponse(error, { requestId: S3_REQUEST_ID, resource });
    }
  }

  it('retires the Phase 6A Basic/session test-project bridge before any S3 routing', async function () {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(auth, 'S3_TEST_PROJECT_ID_ENV'), false);
    await assert.rejects(
      () => auth.authenticateS3Request(new Request('https://example.com/s3/assets', {
        headers: { Authorization: 'Basic YWRtaW46c2VjcmV0' },
      }), {}),
      (error) => error?.s3Code === 'AuthorizationHeaderMalformed',
    );
    await assert.rejects(
      () => auth.authenticateS3Request(new Request('https://example.com/s3/assets', {
        headers: { Authorization: 'Bearer tg_live_not_an_s3_credential' },
      }), {}),
      (error) => error?.s3Code === 'AuthorizationHeaderMalformed',
    );
  });

  it('maps PUT, GET, HEAD, conditions, safe metadata, ranges, and logical deletion through the object facade', async function () {
    const { adapter, storage, transport } = fixture();
    assert.strictEqual(await storage.bucketExists('assets'), false);

    const putResponse = await adapter.putObject('assets', 'docs/readme.txt', new Request('https://example.com/s3/assets/docs/readme.txt', {
      method: 'PUT',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Amz-Meta-Owner': 's3-user',
      },
      body: 'hello S3',
    }));
    assert.strictEqual(putResponse.status, 200);
    assert.match(putResponse.headers.get('ETag'), /^"sha256-[A-Za-z0-9_-]{43}-v1"$/);
    assert.strictEqual(putResponse.headers.get('x-amz-request-id'), S3_REQUEST_ID);
    assert.strictEqual(await storage.bucketExists('assets'), true, 'the existing engine materializes marker-backed buckets on first PUT');

    const getResponse = await adapter.getObject('assets', 'docs/readme.txt', new Request('https://example.com/s3/assets/docs/readme.txt'));
    assert.strictEqual(getResponse.status, 200);
    assert.strictEqual(getResponse.headers.get('Content-Type'), 'text/plain');
    assert.strictEqual(getResponse.headers.get('X-Amz-Meta-Owner'), 's3-user');
    assert.strictEqual(getResponse.headers.get('Content-Disposition'), 'attachment; filename="download"');
    assert.strictEqual(getResponse.headers.get('X-Telegraph-Cloud-Object-Version'), null);
    assert.strictEqual(await getResponse.text(), 'hello S3');

    const range = await adapter.getObject('assets', 'docs/readme.txt', new Request('https://example.com/s3/assets/docs/readme.txt', {
      headers: { Range: 'bytes=0-4' },
    }));
    assert.strictEqual(range.status, 206);
    assert.strictEqual(range.headers.get('Content-Range'), 'bytes 0-4/8');
    assert.strictEqual(range.headers.get('Content-Length'), '5');
    assert.strictEqual(await range.text(), 'hello');
    assert.deepStrictEqual(transport.calls.get.at(-1).range, { start: 0, end: 4, length: 5, size: 8 });

    const head = await adapter.headObject('assets', 'docs/readme.txt', new Request('https://example.com/s3/assets/docs/readme.txt', { method: 'HEAD' }));
    assert.strictEqual(head.status, 200);
    assert.strictEqual(head.headers.get('Content-Length'), '8');
    assert.strictEqual(await head.text(), '');

    const notModified = await adapter.getObject('assets', 'docs/readme.txt', new Request('https://example.com/s3/assets/docs/readme.txt', {
      headers: { 'If-None-Match': putResponse.headers.get('ETag') },
    }));
    assert.strictEqual(notModified.status, 304);
    assert.strictEqual(await notModified.text(), '');

    const stalePut = await s3Error(() => adapter.putObject('assets', 'docs/readme.txt', new Request('https://example.com/s3/assets/docs/readme.txt', {
      method: 'PUT',
      headers: { 'If-Unmodified-Since': 'Thu, 01 Jan 1970 00:00:00 GMT' },
      body: 'must not replace',
    })));
    assert.strictEqual(stalePut.status, 412);
    const staleXml = await stalePut.text();
    assert.deepStrictEqual(xmlValues(parseXml(staleXml), 'Code'), ['PreconditionFailed']);

    const removed = await adapter.deleteObject('assets', 'docs/readme.txt', new Request('https://example.com/s3/assets/docs/readme.txt', { method: 'DELETE' }));
    assert.strictEqual(removed.status, 204);
    assert.strictEqual(await removed.text(), '');
    assert.strictEqual(await storage.bucketExists('assets'), true, 'logical deletion retains the bucket marker');
    const afterDelete = await s3Error(() => adapter.getObject('assets', 'docs/readme.txt', new Request('https://example.com/s3/assets/docs/readme.txt')));
    assert.strictEqual(afterDelete.status, 404);
    assert.deepStrictEqual(xmlValues(parseXml(await afterDelete.text()), 'Code'), ['NoSuchKey']);
  });

  it('renders deterministic, parser-valid escaped ListObjectsV2 XML and encrypted continuation tokens', async function () {
    const escapedKey = 'reports/<tag>&"quote\'.txt';
    const data = fixture();
    await put(data.storage, 'a.txt');
    await put(data.storage, escapedKey, 'dangerous XML name');
    await put(data.storage, 'z.txt');
    const first = await data.adapter.listObjectsV2('assets', new Request('https://example.com/s3/assets?list-type=2&max-keys=2'));
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.headers.get('Content-Type'), 'application/xml; charset=utf-8');
    const firstText = await first.text();
    assert.ok(firstText.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
    assert.ok(firstText.includes('&lt;tag&gt;&amp;&quot;quote&apos;'), 'all XML-sensitive object-key characters are escaped');
    assert.ok(!/file_id|message_id|revision_id|objkey|telegram-object/.test(firstText));
    const firstDocument = parseXml(firstText);
    assert.deepStrictEqual(xmlValues(firstDocument, 'Key'), ['a.txt', escapedKey]);
    assert.match(xmlValues(firstDocument, 'ETag')[0], /^"sha256-[A-Za-z0-9_-]{43}-v1"$/);
    assert.deepStrictEqual(xmlValues(firstDocument, 'KeyCount'), ['2']);
    const [token] = xmlValues(firstDocument, 'NextContinuationToken');
    assert.ok(token);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.ok(!token.includes('objcur') && !token.includes('assets') && !token.includes('reports'), 'the outer token does not reveal the internal cursor or selection');

    const second = await data.adapter.listObjectsV2('assets', new Request(`https://example.com/s3/assets?list-type=2&max-keys=2&continuation-token=${encodeURIComponent(token)}`));
    const secondDocument = parseXml(await second.text());
    assert.deepStrictEqual(xmlValues(secondDocument, 'Key'), ['z.txt']);
    assert.deepStrictEqual(xmlValues(secondDocument, 'IsTruncated'), ['false']);

    const tampered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const tamperedResponse = await s3Error(() => data.adapter.listObjectsV2('assets', new Request(`https://example.com/s3/assets?list-type=2&continuation-token=${tampered}`)), '/assets');
    assert.strictEqual(tamperedResponse.status, 400);
    assert.deepStrictEqual(xmlValues(parseXml(await tamperedResponse.text()), 'Code'), ['InvalidArgument']);
  });

  it('supports bounded prefix/delimiter/max-keys/start-after traversal and binds continuation selection', async function () {
    const data = fixture();
    await put(data.storage, 'images/a.txt');
    await put(data.storage, 'images/nested/one.txt');
    await put(data.storage, 'images/nested/two.txt');
    await put(data.storage, 'images/z.txt');

    const grouped = await data.adapter.listObjectsV2('assets', new Request('https://example.com/s3/assets?list-type=2&prefix=images%2F&delimiter=%2F&max-keys=2'));
    const groupedDocument = parseXml(await grouped.text());
    assert.deepStrictEqual(xmlValues(groupedDocument, 'Key'), ['images/a.txt']);
    assert.deepStrictEqual(xmlValues(groupedDocument, 'CommonPrefixes'), ['images/nested/']);
    assert.deepStrictEqual(xmlValues(groupedDocument, 'KeyCount'), ['2']);
    const [groupedToken] = xmlValues(groupedDocument, 'NextContinuationToken');
    assert.ok(groupedToken);

    const changedPrefix = await s3Error(() => data.adapter.listObjectsV2('assets', new Request(`https://example.com/s3/assets?list-type=2&prefix=other%2F&delimiter=%2F&max-keys=2&continuation-token=${encodeURIComponent(groupedToken)}`)), '/assets');
    assert.strictEqual(changedPrefix.status, 400);
    assert.deepStrictEqual(xmlValues(parseXml(await changedPrefix.text()), 'Code'), ['InvalidArgument']);

    const start = await data.adapter.listObjectsV2('assets', new Request('https://example.com/s3/assets?list-type=2&prefix=images%2F&max-keys=1&start-after=images%2Fa.txt'));
    const startDocument = parseXml(await start.text());
    // StartAfter advances through a small bounded number of filtered engine
    // pages before responding, so common selections return the first visible
    // key without storing unreturned items in an outer continuation token.
    assert.deepStrictEqual(xmlValues(startDocument, 'Key'), ['images/nested/one.txt']);
    assert.deepStrictEqual(xmlValues(startDocument, 'KeyCount'), ['1']);
    assert.deepStrictEqual(xmlValues(startDocument, 'IsTruncated'), ['true']);
    const [startToken] = xmlValues(startDocument, 'NextContinuationToken');
    const afterStart = await data.adapter.listObjectsV2('assets', new Request(`https://example.com/s3/assets?list-type=2&continuation-token=${encodeURIComponent(startToken)}`));
    assert.deepStrictEqual(xmlValues(parseXml(await afterStart.text()), 'Key'), ['images/nested/two.txt']);

    // The index is UTF-8-byte ordered. Astral Unicode must not be compared as
    // JavaScript UTF-16 code units when applying the StartAfter lower bound.
    const bmpKey = 'unicode/\uE000.txt';
    const astralKey = 'unicode/😀.txt';
    await put(data.storage, bmpKey);
    await put(data.storage, astralKey);
    const unicodeStart = await data.adapter.listObjectsV2('assets', new Request(`https://example.com/s3/assets?list-type=2&prefix=${encodeURIComponent('unicode/')}&max-keys=1&start-after=${encodeURIComponent(bmpKey)}`));
    assert.deepStrictEqual(xmlValues(parseXml(await unicodeStart.text()), 'Key'), [astralKey]);
  });

  it('returns S3 XML errors without internal state and rejects unsupported protocol shapes safely', async function () {
    const data = fixture({ env: { TELEGRAPH_CLOUD_MAX_OBJECT_BYTES: '3' } });
    const missingBucket = await s3Error(() => data.adapter.listObjectsV2('missing-bucket', new Request('https://example.com/s3/missing-bucket?list-type=2')), '/missing-bucket');
    assert.strictEqual(missingBucket.status, 404);
    let document = parseXml(await missingBucket.text());
    assert.deepStrictEqual(xmlValues(document, 'Code'), ['NoSuchBucket']);
    assert.deepStrictEqual(xmlValues(document, 'Resource'), ['/missing-bucket']);
    assert.deepStrictEqual(xmlValues(document, 'RequestId'), [S3_REQUEST_ID]);

    const tooLarge = await s3Error(() => data.adapter.putObject('assets', 'large.txt', new Request('https://example.com/s3/assets/large.txt', {
      method: 'PUT', body: 'four', headers: { 'Content-Type': 'text/plain' },
    })));
    assert.strictEqual(tooLarge.status, 413);
    document = parseXml(await tooLarge.text());
    assert.deepStrictEqual(xmlValues(document, 'Code'), ['EntityTooLarge']);

    const unsupportedHeader = await s3Error(() => data.adapter.putObject('assets', 'copy.txt', new Request('https://example.com/s3/assets/copy.txt', {
      method: 'PUT', body: 'ok', headers: { 'X-Amz-Acl': 'public-read' },
    })));
    assert.strictEqual(unsupportedHeader.status, 400);
    assert.deepStrictEqual(xmlValues(parseXml(await unsupportedHeader.text()), 'Code'), ['InvalidRequest']);

    await put(data.storage, 'range.txt', 'abc');
    const invalidRange = await s3Error(() => data.adapter.getObject('assets', 'range.txt', new Request('https://example.com/s3/assets/range.txt', {
      headers: { Range: 'bytes=99-100' },
    })));
    assert.strictEqual(invalidRange.status, 416);
    assert.strictEqual(invalidRange.headers.get('Content-Range'), 'bytes */3');
    assert.deepStrictEqual(xmlValues(parseXml(await invalidRange.text()), 'Code'), ['InvalidRange']);

    const rawFailure = protocol.s3ErrorResponse(new Error('https://api.telegram.org/botsecret-token/internal-pointer'), {
      requestId: S3_REQUEST_ID,
      resource: '/assets/range.txt',
    });
    const rawFailureText = await rawFailure.text();
    assert.strictEqual(rawFailure.status, 500);
    assert.ok(!rawFailureText.includes('secret-token') && !rawFailureText.includes('internal-pointer'), 'unexpected errors never serialize raw provider diagnostics');
    assert.deepStrictEqual(xmlValues(parseXml(rawFailureText), 'Code'), ['InternalError']);

    const root = await s3Error(() => protocol.dispatchS3Request({
      request: new Request('https://example.com/s3/', { method: 'GET' }),
      target: protocol.s3TargetFromPath(undefined),
      adapter: data.adapter,
    }), '');
    assert.strictEqual(root.status, 400);
    assert.deepStrictEqual(xmlValues(parseXml(await root.text()), 'Code'), ['InvalidRequest']);
    const raw = await s3Error(() => protocol.dispatchS3Request({
      request: new Request('https://example.com/s3/assets', { method: 'DELETE' }),
      target: protocol.s3TargetFromPath('assets'),
      adapter: data.adapter,
    }), '/assets');
    assert.strictEqual(raw.status, 405);
    assert.strictEqual(raw.headers.get('Allow'), 'GET');
    assert.deepStrictEqual(xmlValues(parseXml(await raw.text()), 'Code'), ['MethodNotAllowed']);
  });

  it('keeps continuation state and object visibility project-bound even when the KV namespace is shared', async function () {
    const kv = createMockKV();
    const alpha = fixture({ kv, projectId: PROJECT_ALPHA });
    const beta = fixture({ kv, projectId: PROJECT_BETA });
    await put(alpha.storage, 'a.txt');
    await put(alpha.storage, 'b.txt');
    await put(beta.storage, 'a.txt', 'beta bytes');
    await put(beta.storage, 'b.txt', 'beta more');

    const alphaPage = await alpha.adapter.listObjectsV2('assets', new Request('https://example.com/s3/assets?list-type=2&max-keys=1'));
    const alphaToken = xmlValues(parseXml(await alphaPage.text()), 'NextContinuationToken')[0];
    const crossProject = await s3Error(() => beta.adapter.listObjectsV2('assets', new Request(`https://example.com/s3/assets?list-type=2&max-keys=1&continuation-token=${encodeURIComponent(alphaToken)}`)), '/assets');
    assert.strictEqual(crossProject.status, 400);
    assert.deepStrictEqual(xmlValues(parseXml(await crossProject.text()), 'Code'), ['InvalidArgument']);

    const betaRead = await beta.adapter.getObject('assets', 'a.txt', new Request('https://example.com/s3/assets/a.txt'));
    assert.strictEqual(await betaRead.text(), 'beta bytes');
  });

  it('applies the documented local mutation guard as an S3 SlowDown XML response', async function () {
    const projectId = 'prj_RateLimit123';
    let response;
    for (let index = 0; index <= 20; index += 1) {
      response = await s3Middleware.s3MutationRateLimit(makeContext({
        request: new Request('https://example.com/s3/assets/key.txt', { method: 'PUT' }),
        data: {
          s3RequestId: S3_REQUEST_ID,
          s3Authentication: { projectId },
        },
        params: { path: ['assets', 'key.txt'] },
        next: async () => new Response('next'),
      }));
    }
    assert.strictEqual(response.status, 429);
    assert.match(response.headers.get('Retry-After'), /^\d+$/);
    assert.deepStrictEqual(xmlValues(parseXml(await response.text()), 'Code'), ['SlowDown']);
  });

  it('mounts the Pages route behind verified SigV4 credential middleware without accepting a query project selector', async function () {
    const kv = createMockKV();
    const env = {
      TELEGRAPH_CLOUD_KV: kv,
      API_KEY_PEPPER: PEPPER,
      TELEGRAPH_CLOUD_S3_CREDENTIAL_PEPPER: PEPPER,
      TELEGRAPH_CLOUD_S3_ENDPOINT_HOST: 'example.com',
      TG_Bot_Token: '123456:route-test-token',
      TG_Chat_ID: '-100123',
    };
    const index = indexModule.createCloudIndexStore(env);
    const projects = projectModule.createProjectRegistry(env, {
      index,
      now: fixedClock,
      createId(prefix) { return `${prefix}A1b2C3d4`; },
    });
    const project = await projects.createProject({ slug: 's3-route', name: 'S3 route' });
    assert.strictEqual(project.project_id, PROJECT_ALPHA);
    let seed = 0;
    const credentials = credentialModule.createS3CredentialService(env, {
      index,
      projects,
      now: fixedClock,
      randomBytes(length) {
        const bytes = new Uint8Array(length);
        for (let offset = 0; offset < length; offset += 1) bytes[offset] = (seed + offset) & 0xff;
        seed += 31;
        return bytes;
      },
    });
    const fullAccess = await credentials.createCredential(PROJECT_ALPHA, { label: 'route test' });
    const readOnly = await credentials.createCredential(PROJECT_ALPHA, { scopes: ['s3:read'] });
    let sequence = 0;
    const fetchMock = installFetchMock(async (url, init) => {
      const authorization = init.headers?.get?.('Authorization');
      assert.ok(!String(authorization).includes(fullAccess.secret_access_key), 'S3 secrets never reach Telegram');
      assert.ok(!String(authorization).includes(fullAccess.credential.access_key_id), 'S3 access-key identifiers never reach Telegram');
      const value = String(url);
      if (value.includes('/sendDocument')) {
        sequence += 1;
        return Response.json({
          ok: true,
          result: { message_id: sequence, document: { file_id: `RouteFile${String(sequence).padStart(16, '0')}` } },
        });
      }
      if (value.includes('/getFile')) {
        return Response.json({ ok: true, result: { file_path: 'documents/route-object.bin' } });
      }
      if (value.includes('/file/')) return new Response('route bytes');
      throw new Error(`Unexpected fetch ${value}`);
    });
    const currentAmzDate = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const contextFor = (url, method, body, credential = fullAccess, extraHeaders = {}) => {
      const signedHeaders = {
        ...(body === undefined ? {} : { 'Content-Type': 'text/plain' }),
        ...extraHeaders,
      };
      return makeContext({
        request: signS3Request({
          url,
          method,
          accessKeyId: credential.credential.access_key_id,
          secretAccessKey: credential.secret_access_key,
          ...(body === undefined ? {} : { body }),
          ...(Object.keys(signedHeaders).length === 0 ? {} : { headers: signedHeaders }),
          amzDate: currentAmzDate(),
        }),
        env,
        // These deliberately conflicting decoded params demonstrate the route
        // reparses the signed received path, not route/user project data.
        params: { path: ['other-bucket', 'other-key'] },
        data: { projectRegistry: projects, s3Credentials: credentials },
      });
    };

    try {
      const denied = await runPipeline(s3Middleware.onRequest, s3Route, makeContext({
        request: new Request('https://example.com/s3/assets?list-type=2'),
        env,
        params: { path: ['assets'] },
        data: { projectRegistry: projects, s3Credentials: credentials },
      }));
      assert.strictEqual(denied.status, 403);
      assert.deepStrictEqual(xmlValues(parseXml(await denied.text()), 'Code'), ['AccessDenied']);

      const readOnlyWrite = await runPipeline(s3Middleware.onRequest, s3Route, contextFor(
        'https://example.com/s3/assets/blocked.txt', 'PUT', 'never stored', readOnly,
      ));
      assert.strictEqual(readOnlyWrite.status, 403);
      assert.deepStrictEqual(xmlValues(parseXml(await readOnlyWrite.text()), 'Code'), ['AccessDenied']);

      const write = await runPipeline(s3Middleware.onRequest, s3Route, contextFor(
        'https://example.com/s3/assets/route.txt', 'PUT', 'route bytes', fullAccess,
        { 'Idempotency-Key': 's3-route-idempotency-0001' },
      ));
      assert.strictEqual(write.status, 200);
      assert.match(write.headers.get('x-amz-request-id'), /^[0-9A-F]{32}$/);
      assert.ok(kv.snapshot(`tc:v1:object-bucket:${PROJECT_ALPHA}:assets`));
      const telegramWritesAfterInitialPut = fetchMock.calls.filter((call) => String(call.url).includes('/sendDocument')).length;
      assert.ok(telegramWritesAfterInitialPut > 0, 'the initial put stores its immutable Telegram body/event records');
      const retriedWrite = await runPipeline(s3Middleware.onRequest, s3Route, contextFor(
        'https://example.com/s3/assets/route.txt', 'PUT', 'route bytes', fullAccess,
        { 'Idempotency-Key': 's3-route-idempotency-0001' },
      ));
      assert.strictEqual(retriedWrite.status, 200);
      assert.strictEqual(fetchMock.calls.filter((call) => String(call.url).includes('/sendDocument')).length, telegramWritesAfterInitialPut,
        'the signed Idempotency-Key reaches the existing object engine rather than duplicating Telegram bytes');

      const attemptedSelector = await runPipeline(s3Middleware.onRequest, s3Route, contextFor(
        `https://example.com/s3/assets/other.txt?project_id=${PROJECT_BETA}`,
        'PUT', 'never stored',
      ));
      assert.strictEqual(attemptedSelector.status, 400);
      assert.deepStrictEqual(xmlValues(parseXml(await attemptedSelector.text()), 'Code'), ['InvalidRequest']);
      assert.strictEqual(kv.snapshot(`tc:v1:object-bucket:${PROJECT_BETA}:assets`), undefined, 'query project_id cannot select or override credential scope');

      const listed = await runPipeline(s3Middleware.onRequest, s3Route, contextFor(
        'https://example.com/s3/assets?list-type=2&max-keys=1', 'GET', undefined,
      ));
      assert.strictEqual(listed.status, 200);
      assert.deepStrictEqual(xmlValues(parseXml(await listed.text()), 'Key'), ['route.txt']);

      const fetched = await runPipeline(s3Middleware.onRequest, s3Route, contextFor(
        'https://example.com/s3/assets/route.txt', 'GET', undefined, readOnly,
      ));
      assert.strictEqual(fetched.status, 200);
      assert.strictEqual(await fetched.text(), 'route bytes');

      const headed = await runPipeline(s3Middleware.onRequest, s3Route, contextFor(
        'https://example.com/s3/assets/route.txt', 'HEAD', undefined, readOnly,
      ));
      assert.strictEqual(headed.status, 200);
      assert.strictEqual(headed.headers.get('Content-Length'), String('route bytes'.length));

      const deleted = await runPipeline(s3Middleware.onRequest, s3Route, contextFor(
        'https://example.com/s3/assets/route.txt', 'DELETE', undefined,
      ));
      assert.strictEqual(deleted.status, 204);
    } finally {
      fetchMock.restore();
    }
  });

});
