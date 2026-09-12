const assert = require('assert');
const { createMockKV, installFetchMock, makeContext, muteConsole } = require('./helpers');

function fixedClock() {
  return new Date('2026-09-12T12:34:56.000Z');
}

function basicHeaders() {
  return { Authorization: `Basic ${btoa('admin:secret')}` };
}

async function runPipeline(middlewares, route, context) {
  const handlers = [...middlewares, async () => route.onRequest(context)];
  let position = 0;
  context.next = () => handlers[position++](context);
  return context.next();
}

describe('Telegraph Cloud Phase 3 projects and developer API keys', function () {
  let projectModule;
  let keyModule;
  let databaseModule;
  let indexModule;
  let databaseMiddleware;
  let projectMiddleware;
  let projectIndexRoute;
  let projectRoute;
  let keysRoute;
  let keyRoute;
  let rotateRoute;
  let collectionRoute;
  let recordRoute;
  let documentHttp;
  let restoreConsole;

  before(async function () {
    projectModule = await import('../functions/cloud/project-registry.js');
    keyModule = await import('../functions/cloud/developer-api-keys.js');
    databaseModule = await import('../functions/cloud/document-database.js');
    indexModule = await import('../functions/cloud/index-store.js');
    databaseMiddleware = await import('../functions/api/db/_middleware.js');
    projectMiddleware = await import('../functions/api/projects/_middleware.js');
    projectIndexRoute = await import('../functions/api/projects/index.js');
    projectRoute = await import('../functions/api/projects/[id].js');
    keysRoute = await import('../functions/api/projects/[id]/keys/index.js');
    keyRoute = await import('../functions/api/projects/[id]/keys/[keyId].js');
    rotateRoute = await import('../functions/api/projects/[id]/keys/[keyId]/rotate.js');
    collectionRoute = await import('../functions/api/db/[collection]/index.js');
    recordRoute = await import('../functions/api/db/[collection]/[id].js');
    documentHttp = await import('../functions/cloud/document-http.js');
  });

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    restoreConsole();
  });

  function fixtures({ basic = false } = {}) {
    const kv = createMockKV();
    const env = {
      TELEGRAPH_CLOUD_KV: kv,
      API_KEY_PEPPER: 'phase-3-test-pepper-that-is-at-least-thirty-two-bytes-long',
      ...(basic ? { BASIC_USER: 'admin', BASIC_PASS: 'secret' } : {}),
    };
    const index = indexModule.createCloudIndexStore(env);
    let projectNumber = 0;
    let keyNumber = 0;
    let randomSeed = 0;
    const projects = projectModule.createProjectRegistry(env, {
      index,
      now: fixedClock,
      createId(prefix) {
        projectNumber += 1;
        return `${prefix}${String(projectNumber).padStart(8, '0')}`;
      },
    });
    const keys = keyModule.createDeveloperApiKeyService(env, {
      index,
      projects,
      now: fixedClock,
      createId(prefix) {
        keyNumber += 1;
        return `${prefix}${String(keyNumber).padStart(22, '0')}`;
      },
      randomBytes(length) {
        const bytes = new Uint8Array(length);
        for (let index = 0; index < bytes.length; index += 1) bytes[index] = (randomSeed + index) & 0xff;
        randomSeed += 47;
        return bytes;
      },
    });
    return { kv, env, index, projects, keys };
  }

  it('stores a dashboard-created project registry in Cloud KV with opaque IDs and safe lifecycle metadata', async function () {
    const { kv, projects } = fixtures();
    const created = await projects.createProject({ slug: 'team-alpha', name: 'Team Alpha' });

    assert.deepStrictEqual(created, {
      project_id: 'prj_00000001',
      slug: 'team-alpha',
      name: 'Team Alpha',
      status: 'active',
      created_at: '2026-09-12T12:34:56.000Z',
      updated_at: '2026-09-12T12:34:56.000Z',
    });
    const stored = JSON.parse(kv.snapshot(`tc:v1:project:${created.project_id}`).value);
    assert.deepStrictEqual(stored, { ...created, schema: 'telegraph-cloud.project.v1', created_via: 'dashboard' });
    assert.deepStrictEqual(JSON.parse(kv.snapshot('tc:v1:project-slug:team-alpha').value), {
      schema: 'telegraph-cloud.project-slug.v1',
      slug: 'team-alpha',
      project_id: created.project_id,
    });
    assert.ok(!Object.prototype.hasOwnProperty.call(created, 'created_by'));

    await assert.rejects(
      () => projects.createProject({ slug: 'team-alpha', name: 'Duplicate' }),
      (error) => error && error.status === 409 && error.code === 'project_slug_taken',
    );
    await assert.rejects(
      () => projects.createProject({ slug: '../unsafe', name: 'Unsafe' }),
      (error) => error && error.status === 400 && error.code === 'invalid_project_slug',
    );
    await assert.rejects(
      () => projects.createProject({ slug: 'extra', name: 'Extra', project_id: 'prj_client' }),
      (error) => error && error.status === 400 && error.code === 'invalid_project_payload',
    );

    assert.deepStrictEqual((await projects.listProjects()).data, [created]);
    const disabled = await projects.updateProject(created.project_id, { name: 'Team A', status: 'disabled' });
    assert.strictEqual(disabled.name, 'Team A');
    assert.strictEqual(disabled.status, 'disabled');
    await assert.rejects(
      () => projects.requireActiveProject(created.project_id),
      (error) => error && error.status === 403 && error.code === 'project_inactive',
    );

    const deleted = await projects.deleteProject(created.project_id);
    assert.strictEqual(deleted.status, 'deleted');
    assert.ok(deleted.deleted_at);
    assert.strictEqual(kv.snapshot('tc:v1:project-slug:team-alpha'), undefined);
    await assert.rejects(
      () => projects.getProject(created.project_id),
      (error) => error && error.status === 404 && error.code === 'project_not_found',
    );
  });

  it('creates HMAC-verifiable tg_live keys once, retains only safe metadata, and enforces revoke/rotation/project boundaries', async function () {
    const { kv, projects, keys } = fixtures();
    const alpha = await projects.createProject({ slug: 'alpha', name: 'Alpha' });
    const beta = await projects.createProject({ slug: 'beta', name: 'Beta' });
    const created = await keys.createKey(alpha.project_id, { label: 'CI deploy', scopes: ['db:write', 'db:read'] });
    const secretPart = created.api_key.split('_').pop();

    assert.match(created.api_key, /^tg_live_key_[A-Za-z0-9_-]{22}_[A-Za-z0-9_-]{43}$/);
    assert.deepStrictEqual(created.key.scopes, ['db:read', 'db:write']);
    assert.match(created.key.key_prefix, /^tg_live_key_[A-Za-z0-9_-]{22}…$/);
    assert.match(created.key.fingerprint, /^[A-Za-z0-9_-]{12}$/);
    assert.ok(!JSON.stringify(created.key).includes(created.api_key));

    const stored = JSON.parse(kv.snapshot(`tc:v1:api-key:${created.key.key_id}`).value);
    assert.strictEqual(stored.api_key, undefined);
    assert.strictEqual(stored.secret, undefined);
    assert.match(stored.verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(!stored.verifier.includes(secretPart));
    const allPersistedWrites = kv.operations.put.map((entry) => entry.value).join('\n');
    assert.ok(!allPersistedWrites.includes(created.api_key));
    assert.ok(!allPersistedWrites.includes(secretPart));
    assert.ok(!kv.operations.put.map((entry) => entry.key).join('\n').includes(secretPart));

    assert.deepStrictEqual(await keys.authenticate(created.api_key), {
      authentication: 'developer_api_key',
      project_id: alpha.project_id,
      key_id: created.key.key_id,
      scopes: ['db:read', 'db:write'],
    });
    const listed = await keys.listKeys(alpha.project_id);
    assert.deepStrictEqual(listed.data, [created.key]);
    assert.ok(!JSON.stringify(listed).includes(created.api_key));
    const pagedKey = await keys.createKey(alpha.project_id, { label: 'pagination key' });
    const firstPage = await keys.listKeys(alpha.project_id, { limit: 1 });
    assert.strictEqual(firstPage.data.length, 1);
    assert.strictEqual(firstPage.has_more, true);
    assert.ok(firstPage.next_cursor);
    const secondPage = await keys.listKeys(alpha.project_id, { limit: 1, cursor: firstPage.next_cursor });
    assert.strictEqual(secondPage.data.length, 1);
    assert.notStrictEqual(secondPage.data[0].key_id, firstPage.data[0].key_id);
    assert.ok([created.key.key_id, pagedKey.key.key_id].includes(secondPage.data[0].key_id));

    await assert.rejects(
      () => keys.authenticate(`${created.api_key.slice(0, -1)}x`),
      (error) => error && error.status === 401 && error.code === 'invalid_api_key',
    );
    await assert.rejects(
      () => keys.revokeKey(beta.project_id, created.key.key_id),
      (error) => error && error.status === 404 && error.code === 'api_key_not_found',
    );

    const replacement = await keys.rotateKey(alpha.project_id, created.key.key_id, { label: 'CI rotated' });
    assert.match(replacement.api_key, /^tg_live_key_/);
    assert.notStrictEqual(replacement.api_key, created.api_key);
    assert.strictEqual(replacement.key.rotated_from, created.key.key_id);
    await assert.rejects(
      () => keys.authenticate(created.api_key),
      (error) => error && error.status === 401 && error.code === 'invalid_api_key',
    );
    assert.strictEqual((await keys.authenticate(replacement.api_key)).project_id, alpha.project_id);

    const revoked = await keys.revokeKey(alpha.project_id, replacement.key.key_id);
    assert.strictEqual(revoked.status, 'revoked');
    await assert.rejects(
      () => keys.authenticate(replacement.api_key),
      (error) => error && error.status === 401 && error.code === 'invalid_api_key',
    );

    const inactiveKey = await keys.createKey(alpha.project_id, { label: 'after revoke' });
    await projects.updateProject(alpha.project_id, { status: 'disabled' });
    await assert.rejects(
      () => keys.authenticate(inactiveKey.api_key),
      (error) => error && error.status === 403 && error.code === 'project_inactive',
    );
  });

  it('keeps dashboard key listing and revocation available for recovery while pepper-dependent operations fail closed', async function () {
    const { env, index, projects, keys } = fixtures();
    const project = await projects.createProject({ slug: 'recovery', name: 'Recovery' });
    const created = await keys.createKey(project.project_id, { label: 'recoverable key' });
    const withoutPepper = keyModule.createDeveloperApiKeyService(
      { ...env, API_KEY_PEPPER: undefined },
      { index, projects },
    );

    assert.strictEqual((await withoutPepper.listKeys(project.project_id)).data[0].key_id, created.key.key_id);
    assert.strictEqual((await withoutPepper.revokeKey(project.project_id, created.key.key_id)).status, 'revoked');
    await assert.rejects(
      () => withoutPepper.authenticate(created.api_key),
      (error) => error && error.status === 503 && error.code === 'api_key_pepper_unavailable',
    );
    await assert.rejects(
      () => withoutPepper.createKey(project.project_id, { label: 'must fail' }),
      (error) => error && error.status === 503 && error.code === 'api_key_pepper_unavailable',
    );
  });

  it('keeps same-named collections, records, journal revisions, outboxes, and legacy data isolated by trusted project scope', async function () {
    const { kv, env, index } = fixtures();
    const entries = [];
    let messageId = 0;
    const journal = {
      validateConfig() {},
      async appendJson(payload) {
        entries.push(JSON.parse(JSON.stringify(payload)));
        messageId += 1;
        return { provider: 'telegram-journal', fileId: `AgACProjectJournal${messageId}`, messageId };
      },
    };
    function database(projectId, suffix) {
      let number = 0;
      return databaseModule.createTelegramDocumentDatabase(env, {
        index,
        journal,
        projectId,
        now: fixedClock,
        createId(prefix) {
          number += 1;
          return `${prefix}${suffix}${String(number).padStart(21, '0')}`;
        },
      });
    }

    const alphaId = 'prj_aaaaaaaa';
    const betaId = 'prj_bbbbbbbb';
    const alpha = database(alphaId, 'a');
    const beta = database(betaId, 'b');
    const legacy = database(null, 'l');
    const alphaCreated = await alpha.createDocument('users', { owner: 'alpha' }, { idempotencyKey: 'scope-alpha-001' });
    const betaCreated = await beta.createDocument('users', { owner: 'beta' }, { idempotencyKey: 'scope-beta-001' });
    const legacyCreated = await legacy.createDocument('users', { owner: 'legacy' }, { idempotencyKey: 'scope-legacy-001' });

    assert.notStrictEqual(alphaCreated.body.data.id, betaCreated.body.data.id);
    assert.strictEqual(alphaCreated.body.project_id, undefined, 'project scope is internal metadata, not a record response field');
    assert.strictEqual((await alpha.listDocuments('users')).data[0].data.owner, 'alpha');
    assert.strictEqual((await beta.listDocuments('users')).data[0].data.owner, 'beta');
    assert.strictEqual((await legacy.listDocuments('users')).data[0].data.owner, 'legacy');
    await assert.rejects(
      () => alpha.getDocument('users', betaCreated.body.data.id),
      (error) => error && error.status === 404 && error.code === 'record_not_found',
    );

    assert.ok(kv.snapshot(`tc:v1:db-record:${alphaId}:users:${alphaCreated.body.data.id}`));
    assert.ok(kv.snapshot(`tc:v1:db-record:${betaId}:users:${betaCreated.body.data.id}`));
    assert.ok(kv.snapshot(`tc:v1:db-record:users:${legacyCreated.body.data.id}`));
    assert.strictEqual(kv.snapshot(`tc:v1:db-record:users:${alphaCreated.body.data.id}`), undefined);
    assert.strictEqual(entries[0].project_id, alphaId);
    assert.strictEqual(entries[1].project_id, betaId);
    assert.strictEqual(entries[2].project_id, undefined);
    const current = JSON.parse(kv.snapshot(`tc:v1:db-record:${alphaId}:users:${alphaCreated.body.data.id}`).value);
    assert.strictEqual(current.project_id, alphaId);
  });

  it('mounts dashboard-only project/key management routes and reveals a key only from create or rotation responses', async function () {
    const { env, projects, keys } = fixtures({ basic: true });
    const supplied = { projectRegistry: projects, developerApiKeys: keys };
    const createProjectContext = makeContext({
      request: new Request('https://example.com/api/projects', {
        method: 'POST',
        headers: { ...basicHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: 'route-alpha', name: 'Route Alpha' }),
      }),
      env,
      data: { ...supplied },
    });
    const createdResponse = await runPipeline(projectMiddleware.onRequest, projectIndexRoute, createProjectContext);
    assert.strictEqual(createdResponse.status, 201);
    assert.strictEqual(createdResponse.headers.get('Cache-Control'), 'no-store');
    const project = await createdResponse.json();
    assert.strictEqual(createdResponse.headers.get('Location'), `/api/projects/${project.project_id}`);

    const getResponse = await runPipeline(projectMiddleware.onRequest, projectRoute, makeContext({
      request: new Request(`https://example.com/api/projects/${project.project_id}`, { headers: basicHeaders() }),
      env,
      params: { id: project.project_id },
      data: { ...supplied },
    }));
    assert.deepStrictEqual(await getResponse.json(), project);

    const createKeyResponse = await runPipeline(projectMiddleware.onRequest, keysRoute, makeContext({
      request: new Request(`https://example.com/api/projects/${project.project_id}/keys`, {
        method: 'POST',
        headers: { ...basicHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Route key', scopes: ['db:read'] }),
      }),
      env,
      params: { id: project.project_id },
      data: { ...supplied },
    }));
    assert.strictEqual(createKeyResponse.status, 201);
    const createdKey = await createKeyResponse.json();
    assert.match(createdKey.api_key, /^tg_live_key_/);

    const listKeyResponse = await runPipeline(projectMiddleware.onRequest, keysRoute, makeContext({
      request: new Request(`https://example.com/api/projects/${project.project_id}/keys`, { headers: basicHeaders() }),
      env,
      params: { id: project.project_id },
      data: { ...supplied },
    }));
    const listed = await listKeyResponse.json();
    assert.ok(!JSON.stringify(listed).includes(createdKey.api_key));
    assert.deepStrictEqual(listed.data.map((key) => key.key_id), [createdKey.key.key_id]);

    const rotatedResponse = await runPipeline(projectMiddleware.onRequest, rotateRoute, makeContext({
      request: new Request(`https://example.com/api/projects/${project.project_id}/keys/${createdKey.key.key_id}/rotate`, {
        method: 'POST',
        headers: { ...basicHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
      env,
      params: { id: project.project_id, keyId: createdKey.key.key_id },
      data: { ...supplied },
    }));
    assert.strictEqual(rotatedResponse.status, 201);
    const rotated = await rotatedResponse.json();
    assert.match(rotated.api_key, /^tg_live_key_/);

    const revokedResponse = await runPipeline(projectMiddleware.onRequest, keyRoute, makeContext({
      request: new Request(`https://example.com/api/projects/${project.project_id}/keys/${rotated.key.key_id}`, {
        method: 'DELETE', headers: basicHeaders(),
      }),
      env,
      params: { id: project.project_id, keyId: rotated.key.key_id },
      data: { ...supplied },
    }));
    assert.strictEqual(revokedResponse.status, 200);
    assert.strictEqual((await revokedResponse.json()).status, 'revoked');

    // A valid developer credential is intentionally not a dashboard session.
    const bearerOnly = await runPipeline(projectMiddleware.onRequest, projectIndexRoute, makeContext({
      request: new Request('https://example.com/api/projects', {
        headers: { Authorization: `Bearer ${createdKey.api_key}` },
      }),
      env,
      data: { ...supplied },
    }));
    assert.strictEqual(bearerOnly.status, 401);
    assert.deepStrictEqual(await bearerOnly.json(), { error: 'unauthenticated' });
  });

  it('derives /api/db project scope from a Bearer key, ignores client project hints, preserves dashboard legacy data, and enforces scopes', async function () {
    const { kv, env, projects, keys } = fixtures({ basic: true });
    env.TG_Bot_Token = 'phase3-test-bot-token';
    env.TG_Chat_ID = '123456';
    const alpha = await projects.createProject({ slug: 'db-alpha', name: 'DB Alpha' });
    const beta = await projects.createProject({ slug: 'db-beta', name: 'DB Beta' });
    const alphaKey = await keys.createKey(alpha.project_id, { label: 'alpha writer' });
    const betaKey = await keys.createKey(beta.project_id, { label: 'beta writer' });
    const readOnly = await keys.createKey(alpha.project_id, { label: 'read only', scopes: ['db:read'] });
    const journalPayloads = [];
    let messageId = 0;
    const fetchMock = installFetchMock(async (_url, init) => {
      assert.strictEqual(init.headers, undefined, 'developer Authorization must not be forwarded to Telegram');
      const file = init.body.get('document');
      journalPayloads.push(JSON.parse(await file.text()));
      messageId += 1;
      return new Response(JSON.stringify({
        ok: true,
        result: { message_id: messageId, document: { file_id: `AgACRouteProject${messageId}` } },
      }), { headers: { 'Content-Type': 'application/json' } });
    });

    try {
      const alphaPost = await runPipeline(databaseMiddleware.onRequest, collectionRoute, makeContext({
        request: new Request(`https://example.com/api/db/users?project_id=${beta.project_id}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${alphaKey.api_key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner: 'alpha' }),
        }),
        env,
        params: { collection: 'users' },
      }));
      assert.strictEqual(alphaPost.status, 201);
      const alphaRecord = await alphaPost.json();
      assert.ok(kv.snapshot(`tc:v1:db-record:${alpha.project_id}:users:${alphaRecord.data.id}`));
      assert.strictEqual(kv.snapshot(`tc:v1:db-record:${beta.project_id}:users:${alphaRecord.data.id}`), undefined);
      assert.strictEqual(journalPayloads[0].project_id, alpha.project_id);

      const betaGetAlphaPath = await runPipeline(databaseMiddleware.onRequest, recordRoute, makeContext({
        request: new Request(`https://example.com/api/db/users/${alphaRecord.data.id}`,
          { headers: { Authorization: `Bearer ${betaKey.api_key}` } }),
        env,
        params: { collection: 'users', id: alphaRecord.data.id },
      }));
      assert.strictEqual(betaGetAlphaPath.status, 404);
      assert.deepStrictEqual(await betaGetAlphaPath.json(), { error: 'record_not_found' });

      const betaPost = await runPipeline(databaseMiddleware.onRequest, collectionRoute, makeContext({
        request: new Request('https://example.com/api/db/users', {
          method: 'POST',
          headers: { Authorization: `Bearer ${betaKey.api_key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner: 'beta' }),
        }),
        env,
        params: { collection: 'users' },
      }));
      assert.strictEqual(betaPost.status, 201);

      const legacyPost = await runPipeline(databaseMiddleware.onRequest, collectionRoute, makeContext({
        request: new Request('https://example.com/api/db/users', {
          method: 'POST',
          headers: { ...basicHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner: 'legacy' }),
        }),
        env,
        params: { collection: 'users' },
      }));
      assert.strictEqual(legacyPost.status, 201);
      const legacyRecord = await legacyPost.json();
      assert.ok(kv.snapshot(`tc:v1:db-record:users:${legacyRecord.data.id}`));

      const alphaList = await runPipeline(databaseMiddleware.onRequest, collectionRoute, makeContext({
        request: new Request('https://example.com/api/db/users', { headers: { Authorization: `Bearer ${alphaKey.api_key}` } }),
        env,
        params: { collection: 'users' },
      }));
      assert.deepStrictEqual((await alphaList.json()).data.map((record) => record.data.owner), ['alpha']);

      const readOnlyList = await runPipeline(databaseMiddleware.onRequest, collectionRoute, makeContext({
        request: new Request('https://example.com/api/db/users', { headers: { Authorization: `Bearer ${readOnly.api_key}` } }),
        env,
        params: { collection: 'users' },
      }));
      assert.strictEqual(readOnlyList.status, 200);
      assert.deepStrictEqual((await readOnlyList.json()).data.map((record) => record.data.owner), ['alpha']);

      const forbiddenWrite = await runPipeline(databaseMiddleware.onRequest, collectionRoute, makeContext({
        request: new Request('https://example.com/api/db/users', {
          method: 'POST',
          headers: { Authorization: `Bearer ${readOnly.api_key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ owner: 'not-written' }),
        }),
        env,
        params: { collection: 'users' },
      }));
      assert.strictEqual(forbiddenWrite.status, 403);
      assert.deepStrictEqual(await forbiddenWrite.json(), { error: 'api_key_scope_forbidden' });

      await projects.updateProject(alpha.project_id, { status: 'disabled' });
      const inactiveProject = await runPipeline(databaseMiddleware.onRequest, collectionRoute, makeContext({
        request: new Request('https://example.com/api/db/users', { headers: { Authorization: `Bearer ${alphaKey.api_key}` } }),
        env,
        params: { collection: 'users' },
      }));
      assert.strictEqual(inactiveProject.status, 403);
      assert.deepStrictEqual(await inactiveProject.json(), { error: 'project_inactive' });

      const malformedBearer = await runPipeline(databaseMiddleware.onRequest, collectionRoute, makeContext({
        request: new Request('https://example.com/api/db/users?api_key=not-accepted', {
          headers: { Authorization: 'Bearer not-a-key' },
        }),
        env,
        params: { collection: 'users' },
      }));
      assert.strictEqual(malformedBearer.status, 401);
      assert.deepStrictEqual(await malformedBearer.json(), { error: 'invalid_api_key' });
    } finally {
      fetchMock.restore();
    }
  });

  it('never lets a generic context provider override an authenticated developer project scope', function () {
    const ignoredProvider = { getDocument() { throw new Error('must not be called'); } };
    assert.throws(
      () => documentHttp.documentDatabaseForContext({
        env: {},
        data: {
          documentDatabase: ignoredProvider,
          databaseAuthentication: { authentication: 'developer_api_key', project_id: 'prj_trusted01' },
        },
      }),
      (error) => error && error.code === 'cloud_index_unavailable',
    );
  });

});
