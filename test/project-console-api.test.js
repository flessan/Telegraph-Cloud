const assert = require('assert');
const { createMockKV, makeContext, muteConsole } = require('./helpers');

function fixedClock() {
  return new Date('2026-09-12T12:34:56.000Z');
}

function createJournal() {
  const entries = [];
  return {
    entries,
    validateConfig() {},
    async appendJson(payload) {
      entries.push(JSON.parse(JSON.stringify(payload)));
      return { provider: 'telegram-journal', fileId: `journal_${entries.length}`, messageId: entries.length };
    },
  };
}

describe('Telegraph Cloud project console APIs', function () {
  let modules;
  let restoreConsole;

  before(async function () {
    modules = {
      index: await import('../functions/cloud/index-store.js'),
      project: await import('../functions/cloud/project-registry.js'),
      db: await import('../functions/cloud/document-database.js'),
      object: await import('../functions/cloud/object-storage.js'),
      driveState: await import('../functions/cloud/drive-state.js'),
      drive: await import('../functions/cloud/drive-service.js'),
      collectionsRoute: await import('../functions/api/projects/[id]/db/collections.js'),
      collectionRoute: await import('../functions/api/projects/[id]/db/[collection]/index.js'),
      recordRoute: await import('../functions/api/projects/[id]/db/[collection]/[record].js'),
      historyRoute: await import('../functions/api/projects/[id]/db/[collection]/[record]/history.js'),
      projectsMiddleware: await import('../functions/api/projects/_middleware.js'),
      driveBucketsRoute: await import('../functions/api/projects/[id]/drive/buckets/index.js'),
      driveObjectsRoute: await import('../functions/api/projects/[id]/drive/objects/[[key]].js'),
      driveFlagsRoute: await import('../functions/api/projects/[id]/drive/flags.js'),
      driveFoldersRoute: await import('../functions/api/projects/[id]/drive/folders.js'),
      driveStatsRoute: await import('../functions/api/projects/[id]/drive/stats.js'),
      driveCopyRoute: await import('../functions/api/projects/[id]/drive/copy.js'),
    };
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
    return {
      async putObject({ body }) {
        const fileId = `file${String(++sequence).padStart(16, '0')}`;
        bytes.set(fileId, new Uint8Array(body));
        return { provider: 'telegram-object', fileId, messageId: sequence };
      },
      async appendEvent() {
        const fileId = `event${String(++sequence).padStart(15, '0')}`;
        return { provider: 'telegram-object-event', fileId, messageId: sequence };
      },
      async getObject(pointer) {
        return new Response(bytes.get(pointer.fileId));
      },
      async headObject() {
        return { available: true };
      },
      async deleteObject() {
        return { retained_by_provider: true };
      },
    };
  }

  async function fixture() {
    const kv = createMockKV();
    const env = { TELEGRAPH_CLOUD_KV: kv };
    const index = modules.index.createCloudIndexStore(env);
    const journal = createJournal();
    const projects = modules.project.createProjectRegistry(env, { index, now: fixedClock });
    const project = await projects.createProject({ slug: 'portfolio', name: 'Portfolio' });
    let id = 0;
    const database = modules.db.createTelegramDocumentDatabase(env, {
      index,
      journal,
      createId(prefix) {
        id += 1;
        return `${prefix}${String(id).padStart(22, '0')}`;
      },
      now: fixedClock,
    });
    let oid = 1000;
    const storage = modules.object.createTelegramObjectStorage(env, {
      projectId: project.project_id,
      index,
      transport: createTransport(),
      now: fixedClock,
      createId(prefix) {
        oid += 1;
        return `${prefix}${String(oid).padStart(22, '0')}`;
      },
    });
    const state = modules.driveState.createDriveStateService(env, { index, now: fixedClock });
    const drive = modules.drive.createDriveService(env, {
      projectId: project.project_id, storage, state, projects,
    });
    return { kv, env, index, projects, project, database, storage, drive };
  }

  // Run the route through the same error boundary the real Pages middleware
  // chain applies, so Cloud errors become their documented status codes.
  function call(route, context) {
    return modules.projectsMiddleware.projectErrorHandling({
      ...context,
      next: () => route.onRequest(context),
    });
  }
  function callGet(route, context) {
    return modules.projectsMiddleware.projectErrorHandling({
      ...context,
      next: () => route.onRequestGet(context),
    });
  }

  function jsonRequest(method, body) {
    return new Request('https://console.example/api', {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }

  describe('project-scoped document database', function () {
    it('lists collections with bounded counts and supports record CRUD with version preconditions', async function () {
      const { env, project, database } = await fixture();
      const ctx = (route, { collection, record, request }) => makeContext({
        request,
        env,
        params: { id: project.project_id, ...(collection ? { collection } : {}), ...(record ? { record } : {}) },
        data: { projectDatabase: database },
      });

      let res = await call(modules.collectionsRoute, ctx(null, { request: new Request('https://x/api') }));
      let body = await res.json();
      assert.deepStrictEqual(body.data, []);

      const postUser = await call(modules.collectionRoute, ctx(null, {
        collection: 'users',
        request: jsonRequest('POST', { name: 'Thio', role: 'admin' }),
      }));
      assert.strictEqual(postUser.status, 201);
      const createdBody = await postUser.json();
      assert.strictEqual(createdBody.version, 1);
      assert.ok(createdBody.data.id);
      assert.strictEqual(createdBody.data.name, 'Thio');
      const createdId = createdBody.data.id;

      await call(modules.collectionRoute, ctx(null, {
        collection: 'users',
        request: jsonRequest('POST', { name: 'Mina', role: 'editor' }),
      }));
      await call(modules.collectionRoute, ctx(null, {
        collection: 'tracks',
        request: jsonRequest('POST', { title: 'Aurora' }),
      }));

      res = await call(modules.collectionsRoute, ctx(null, { request: new Request('https://x/api') }));
      body = await res.json();
      assert.deepStrictEqual(body.data.map((c) => c.name), ['tracks', 'users']);
      const users = body.data.find((c) => c.name === 'users');
      assert.strictEqual(users.record_count, 2);
      assert.strictEqual(users.record_count_truncated, undefined);

      const list = await call(modules.collectionRoute, ctx(null, {
        collection: 'users',
        request: new Request('https://x/api?limit=20'),
      }));
      const listed = await list.json();
      assert.strictEqual(listed.data.length, 2);
      assert.strictEqual(listed.order, 'id:asc');

      // PATCH requires expected version; wrong version conflicts.
      const badPatch = await call(modules.recordRoute, ctx(null, {
        collection: 'users',
        record: createdId,
        request: jsonRequest('PATCH', { role: 'owner', _expected_version: 99 }),
      }));
      assert.strictEqual(badPatch.status, 409);
      assert.strictEqual((await badPatch.json()).error, 'version_conflict');

      const patch = await call(modules.recordRoute, ctx(null, {
        collection: 'users',
        record: createdId,
        request: jsonRequest('PATCH', { role: 'owner', _expected_version: 1 }),
      }));
      assert.strictEqual(patch.status, 200);
      const patchedBody = await patch.json();
      assert.strictEqual(patchedBody.version, 2);
      assert.strictEqual(patchedBody.data.role, 'owner');

      const history = await callGet(modules.historyRoute, ctx(null, {
        collection: 'users',
        record: createdId,
        request: new Request('https://x/api'),
      }));
      const historyBody = await history.json();
      assert.strictEqual(historyBody.data.length, 2);
      assert.strictEqual(historyBody.data[0].version, 1);

      const del = await call(modules.recordRoute, ctx(null, {
        collection: 'users',
        record: createdId,
        request: jsonRequest('DELETE', { _expected_version: 2 }),
      }));
      assert.strictEqual(del.status, 200);
    });
  });

  describe('project drive routes', function () {
    function driveContext(fixtureRef, { url, method = 'GET', body, contentType, params = {}, data = {} } = {}) {
      const headers = {};
      if (contentType) headers['Content-Type'] = contentType;
      const request = new Request(url, {
        method,
        headers,
        ...(body ? { body } : {}),
      });
      return makeContext({
        request,
        env: fixtureRef.env,
        params: { id: fixtureRef.project.project_id, ...params },
        data: { drive: fixtureRef.drive, ...data },
      });
    }

    it('creates buckets, uploads objects, lists, and serves proxied bytes', async function () {
      const fixtureRef = await fixture();
      const create = await call(modules.driveBucketsRoute, driveContext(fixtureRef, {
        url: 'https://x/api', method: 'POST', body: JSON.stringify({ name: 'assets' }), contentType: 'application/json',
      }));
      assert.strictEqual(create.status, 201);

      const upload = await call(modules.driveObjectsRoute, driveContext(fixtureRef, {
        url: 'https://x/api?bucket=assets',
        method: 'PUT',
        params: { key: ['covers', 'front.webp'] },
        body: new TextEncoder().encode('WEBPBYTES'),
        contentType: 'image/webp',
      }));
      assert.strictEqual(upload.status, 200);
      const uploaded = await upload.json();
      assert.strictEqual(uploaded.object.key, 'covers/front.webp');
      assert.strictEqual(uploaded.object.content_type, 'image/webp');

      const list = await call(modules.driveObjectsRoute, driveContext(fixtureRef, {
        url: 'https://x/api?bucket=assets&prefix=covers%2F',
      }));
      const listed = await list.json();
      assert.deepStrictEqual(listed.objects.map((o) => o.key), ['covers/front.webp']);

      const content = await call(modules.driveObjectsRoute, driveContext(fixtureRef, {
        url: 'https://x/api?bucket=assets',
        params: { key: ['covers', 'front.webp'] },
      }));
      assert.strictEqual(content.status, 200);
      assert.strictEqual(content.headers.get('X-Content-Type-Options'), 'nosniff');
      assert.ok(content.headers.get('Content-Security-Policy').includes('sandbox'));
      assert.ok(content.headers.get('Content-Disposition').includes('front.webp'));
      const bytes = new Uint8Array(await content.arrayBuffer());
      assert.strictEqual(new TextDecoder().decode(bytes), 'WEBPBYTES');

      const meta = await call(modules.driveObjectsRoute, driveContext(fixtureRef, {
        url: 'https://x/api?bucket=assets&meta=1',
        params: { key: ['covers', 'front.webp'] },
      }));
      const metaBody = await meta.json();
      assert.strictEqual(metaBody.object.version, 1);
      // Internal Telegram pointers never appear in console metadata.
      for (const secret of ['storage', 'event', 'revision_id', 'key_hash', 'pointer', 'file_id']) {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(metaBody.object, secret), false, `leaks ${secret}`);
      }
    });

    it('patches star/trash flags and exposes them via trash view', async function () {
      const fixtureRef = await fixture();
      await fixtureRef.drive.putObject('assets', 'a.txt', { body: new TextEncoder().encode('a'), contentType: 'text/plain' });

      const flagged = await call(modules.driveFlagsRoute, driveContext(fixtureRef, {
        url: 'https://x/api', method: 'PATCH', body: JSON.stringify({ bucket: 'assets', key: 'a.txt', trashed: true }), contentType: 'application/json',
      }));
      assert.strictEqual(flagged.status, 200);
      assert.strictEqual((await flagged.json()).trashed, true);

      const trash = await call(modules.driveObjectsRoute, driveContext(fixtureRef, {
        url: 'https://x/api?bucket=assets&view=trash',
      }));
      assert.deepStrictEqual((await trash.json()).objects.map((o) => o.key), ['a.txt']);
    });

    it('creates and deletes empty folders', async function () {
      const fixtureRef = await fixture();
      const created = await call(modules.driveFoldersRoute, driveContext(fixtureRef, {
        url: 'https://x/api', method: 'POST', body: JSON.stringify({ bucket: 'assets', prefix: 'drafts/' }), contentType: 'application/json',
      }));
      assert.strictEqual(created.status, 201);
      const removed = await call(modules.driveFoldersRoute, driveContext(fixtureRef, {
        url: 'https://x/api?bucket=assets&prefix=drafts%2F', method: 'DELETE',
      }));
      assert.strictEqual(removed.status, 200);
    });

    it('moves an object through the copy endpoint and reports stats', async function () {
      const fixtureRef = await fixture();
      await fixtureRef.drive.putObject('assets', 'old.txt', { body: new TextEncoder().encode('xy'), contentType: 'text/plain' });
      const moved = await call(modules.driveCopyRoute, driveContext(fixtureRef, {
        url: 'https://x/api', method: 'POST',
        body: JSON.stringify({ bucket: 'assets', sourceKey: 'old.txt', destKey: 'new.txt', deleteSource: true }),
        contentType: 'application/json',
      }));
      assert.strictEqual(moved.status, 200);
      assert.strictEqual((await moved.json()).object.key, 'new.txt');

      const stats = await callGet(modules.driveStatsRoute, driveContext(fixtureRef, { url: 'https://x/api' }));
      const statsBody = await stats.json();
      assert.strictEqual(statsBody.objects, 1);
      assert.strictEqual(statsBody.bytes, 2);
      assert.strictEqual(statsBody.truncated, false);
    });
  });
});
