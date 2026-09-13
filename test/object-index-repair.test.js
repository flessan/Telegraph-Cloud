const assert = require('assert');
const { createMockKV, makeContext, muteConsole } = require('./helpers');

function textBytes(value) {
  return new TextEncoder().encode(value);
}

function fixedClock(value = '2026-09-13T04:00:00.000Z') {
  return () => new Date(value);
}

function terminalLeafKeys(kv) {
  return kv.operations.put
    .map((entry) => entry.key)
    .filter((key) => key.startsWith('tc:v1:object-list:') && /:objkey_[A-Za-z0-9_-]{43}$/.test(key));
}

async function runPipeline(middlewares, route, context) {
  const handlers = [...middlewares, async () => route.onRequest(context)];
  let position = 0;
  context.next = () => handlers[position++](context);
  return context.next();
}

describe('Telegraph Cloud Phase 5.1 operator object-index repair', function () {
  let objectStorage;
  let repairModule;
  let indexModule;
  let projectModule;
  let keyModule;
  let projectMiddleware;
  let repairRoute;
  let restoreConsole;

  before(async function () {
    objectStorage = await import('../functions/cloud/object-storage.js');
    repairModule = await import('../functions/cloud/object-index-repair.js');
    indexModule = await import('../functions/cloud/index-store.js');
    projectModule = await import('../functions/cloud/project-registry.js');
    keyModule = await import('../functions/cloud/developer-api-keys.js');
    projectMiddleware = await import('../functions/api/projects/_middleware.js');
    repairRoute = await import('../functions/api/projects/[id]/storage/index-repair.js');
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
        return { provider: 'telegram-object-event', fileId: `event${String(++sequence).padStart(15, '0')}`, messageId: sequence };
      },
      async getObject(pointer) { return new Response(bytes.get(pointer.fileId)); },
      async headObject() { return { available: true }; },
      async deleteObject() { return { retained_by_provider: true }; },
    };
  }

  function fixture({
    kv = createMockKV(),
    projectId = 'prj_A1b2C3d4',
    env = {},
    index: suppliedIndex,
  } = {}) {
    const runtimeEnv = {
      TELEGRAPH_CLOUD_KV: kv,
      API_KEY_PEPPER: 'phase-five-one-repair-pepper-that-is-at-least-thirty-two-bytes',
      ...env,
    };
    const index = suppliedIndex || indexModule.createCloudIndexStore(runtimeEnv);
    let id = 0;
    const createId = (prefix) => `${prefix}${String(++id).padStart(22, '0')}`;
    const storage = objectStorage.createTelegramObjectStorage(runtimeEnv, {
      projectId,
      index,
      transport: createTransport(),
      now: fixedClock(),
      createId,
    });
    const repair = repairModule.createObjectIndexRepairService(runtimeEnv, {
      projectId,
      index,
      now: fixedClock(),
    });
    return { kv, env: runtimeEnv, index, storage, repair };
  }

  async function put(storage, key) {
    return storage.putObject('assets', key, {
      body: textBytes(`object:${key}`),
      contentType: 'text/plain',
      metadata: { owner: 'repair-test' },
    });
  }

  function onlyLeaf(kv) {
    const leaves = terminalLeafKeys(kv);
    assert.strictEqual(leaves.length, 1, 'fixture should have exactly one terminal list leaf');
    return leaves[0];
  }

  it('detects a missing current-manifest leaf, keeps dry-run mutation-free, repairs it, and is idempotent on repeat', async function () {
    const { kv, storage, repair } = fixture();
    await put(storage, 'missing.txt');
    const leaf = onlyLeaf(kv);
    await kv.delete(leaf);
    const beforeDryRun = { puts: kv.operations.put.length, deletes: kv.operations.delete.length };

    const dryRun = await repair.run({ mode: 'dry_run', batch_size: 10 });
    assert.strictEqual(dryRun.complete, true);
    assert.deepStrictEqual(dryRun.progress, {
      scanned: 1, repaired: 0, removed: 0, stale: 1, skipped: 0, errors: 0,
    });
    assert.strictEqual(kv.operations.put.length, beforeDryRun.puts, 'dry-run creates no checkpoint or index mutation');
    assert.strictEqual(kv.operations.delete.length, beforeDryRun.deletes, 'dry-run never removes a leaf');
    assert.deepStrictEqual((await storage.listObjects('assets')).objects, []);

    const applied = await repair.run({ mode: 'apply', batch_size: 10 });
    assert.strictEqual(applied.status, 'completed');
    assert.strictEqual(applied.progress.repaired, 1);
    assert.strictEqual(applied.progress.stale, 1);
    assert.deepStrictEqual((await storage.listObjects('assets')).objects.map((object) => object.key), ['missing.txt']);

    const repeated = await repair.run({ mode: 'apply', batch_size: 10 });
    assert.deepStrictEqual(repeated.progress, {
      scanned: 1, repaired: 0, removed: 0, stale: 0, skipped: 1, errors: 0,
    });
  });

  it('rebuilds a missing deterministic branch needed to reach an otherwise correct long-key leaf', async function () {
    const { kv, storage, repair } = fixture();
    const key = `long/${'a'.repeat(80)}.txt`;
    await put(storage, key);
    const branch = kv.operations.put
      .map((entry) => entry.key)
      .find((entry) => entry.startsWith('tc:v1:object-list:') && !/:objkey_[A-Za-z0-9_-]{43}$/.test(entry));
    assert.ok(branch, 'a long key should have a deterministic shared branch marker');
    await kv.delete(branch);
    assert.deepStrictEqual((await storage.listObjects('assets')).objects, [], 'the terminal cannot be reached without its branch');

    const result = await repair.run({ mode: 'apply', batch_size: 10 });
    assert.deepStrictEqual(result.progress, {
      scanned: 1, repaired: 1, removed: 0, stale: 1, skipped: 0, errors: 0,
    });
    assert.deepStrictEqual((await storage.listObjects('assets')).objects.map((object) => object.key), [key]);
  });

  it('rebuilds a stale terminal leaf from the authoritative active manifest without reading object bytes', async function () {
    const { kv, storage, repair } = fixture();
    await put(storage, 'stale.txt');
    const leaf = onlyLeaf(kv);
    await kv.put(leaf, JSON.stringify({ schema: 'wrong', pointer: 'must-not-escape' }));

    const result = await repair.run({ mode: 'apply', batch_size: 10 });
    assert.strictEqual(result.progress.scanned, 1);
    assert.strictEqual(result.progress.stale, 1);
    assert.strictEqual(result.progress.repaired, 1);
    assert.strictEqual(result.progress.errors, 0);
    const rebuilt = JSON.parse(kv.snapshot(leaf).value);
    assert.deepStrictEqual(Object.keys(rebuilt).sort(), ['bucket', 'key_hash', 'kind', 'node_id', 'project_id', 'schema']);
    assert.ok(!JSON.stringify(result).match(/file_id|message_id|pointer|objkey|telegram/i));
  });

  it('detects and safely removes a stale leaf for an authoritative tombstone', async function () {
    const { kv, storage, repair } = fixture();
    const created = await put(storage, 'deleted.txt');
    const leaf = onlyLeaf(kv);
    const retainedLeaf = kv.snapshot(leaf).value;
    await storage.deleteObject('assets', 'deleted.txt', { ifMatch: `"${created.object.etag}"` });
    assert.strictEqual(kv.snapshot(leaf), undefined);
    await kv.put(leaf, retainedLeaf);

    const result = await repair.run({ mode: 'apply', batch_size: 10 });
    assert.strictEqual(result.progress.scanned, 1);
    assert.strictEqual(result.progress.stale, 1);
    assert.strictEqual(result.progress.removed, 1);
    assert.strictEqual(result.progress.repaired, 0);
    assert.strictEqual(kv.snapshot(leaf), undefined);
    assert.deepStrictEqual((await storage.listObjects('assets')).objects, []);
  });

  it('skips an already-correct index leaf and scans/resumes bounded pages with encrypted opaque checkpoints', async function () {
    const { kv, storage, repair } = fixture();
    await put(storage, 'a.txt');
    await put(storage, 'b.txt');
    await put(storage, 'c.txt');
    const leaves = terminalLeafKeys(kv);
    assert.strictEqual(leaves.length, 3);
    for (const leaf of leaves) await kv.delete(leaf);

    const mutationBefore = { puts: kv.operations.put.length, deletes: kv.operations.delete.length };
    const first = await repair.run({ mode: 'dry_run', batch_size: 1 });
    assert.strictEqual(first.complete, false);
    assert.strictEqual(first.status, 'in_progress');
    assert.strictEqual(first.batch.scanned, 1);
    assert.match(first.checkpoint, /^[A-Za-z0-9_-]+$/);
    const encoded = first.checkpoint.replace(/-/g, '+').replace(/_/g, '/');
    const checkpointEnvelope = JSON.parse(atob(`${encoded}${'='.repeat((4 - encoded.length % 4) % 4)}`));
    assert.deepStrictEqual(Object.keys(checkpointEnvelope).sort(), ['d', 'i', 'v'], 'checkpoint state is encrypted, not a readable KV cursor');
    assert.strictEqual(kv.operations.put.length, mutationBefore.puts, 'dry-run checkpoint is self-contained and not a KV write');
    assert.strictEqual(kv.operations.delete.length, mutationBefore.deletes);

    const second = await repair.run({ checkpoint: first.checkpoint });
    assert.strictEqual(second.complete, false);
    const third = await repair.run({ checkpoint: second.checkpoint });
    assert.strictEqual(third.complete, true);
    assert.strictEqual(third.status, 'completed');
    assert.deepStrictEqual(third.progress, {
      scanned: 3, repaired: 0, removed: 0, stale: 3, skipped: 0, errors: 0,
    });
    assert.deepStrictEqual((await storage.listObjects('assets')).objects, []);

    await assert.rejects(
      () => repair.run({ checkpoint: first.checkpoint, mode: 'apply' }),
      (error) => error && error.status === 400 && error.code === 'invalid_object_index_repair_request',
    );
    const tampered = `${first.checkpoint.slice(0, -1)}${first.checkpoint.endsWith('A') ? 'B' : 'A'}`;
    await assert.rejects(
      () => repair.run({ checkpoint: tampered }),
      (error) => error && error.status === 400 && error.code === 'invalid_object_index_repair_checkpoint',
    );

    const alreadyCorrect = fixture();
    await put(alreadyCorrect.storage, 'correct.txt');
    const correct = await alreadyCorrect.repair.run({ mode: 'apply', batch_size: 10 });
    assert.deepStrictEqual(correct.progress, {
      scanned: 1, repaired: 0, removed: 0, stale: 0, skipped: 1, errors: 0,
    });
  });

  it('rejects oversized repair batches and expired continuation checkpoints before scanning another page', async function () {
    const { env, index, storage, repair } = fixture();
    await put(storage, 'expiry-a.txt');
    await put(storage, 'expiry-b.txt');
    await assert.rejects(
      () => repair.run({ mode: 'dry_run', batch_size: 51 }),
      (error) => error && error.status === 400 && error.code === 'invalid_object_index_repair_request',
    );
    const first = await repair.run({ mode: 'dry_run', batch_size: 1 });
    assert.strictEqual(first.complete, false);
    const expired = repairModule.createObjectIndexRepairService(env, {
      projectId: 'prj_A1b2C3d4',
      index,
      now: fixedClock('2026-09-14T04:00:01.000Z'),
    });
    await assert.rejects(
      () => expired.run({ checkpoint: first.checkpoint }),
      (error) => error && error.status === 400 && error.code === 'invalid_object_index_repair_checkpoint',
    );
  });

  it('keeps repair scope project-bound and does not let a checkpoint cross into another project', async function () {
    const kv = createMockKV();
    const alpha = fixture({ kv, projectId: 'prj_A1b2C3d4' });
    const beta = fixture({ kv, projectId: 'prj_Z9y8X7w6' });
    await put(alpha.storage, 'a.txt');
    await put(alpha.storage, 'b.txt');
    await put(beta.storage, 'beta.txt');
    const alphaLeaves = terminalLeafKeys(kv).filter((key) => key.includes(':prj_A1b2C3d4:'));
    await kv.delete(alphaLeaves[0]);

    const alphaFirst = await alpha.repair.run({ mode: 'apply', batch_size: 1 });
    assert.strictEqual(alphaFirst.complete, false);
    await assert.rejects(
      () => beta.repair.run({ checkpoint: alphaFirst.checkpoint }),
      (error) => error && error.status === 400 && error.code === 'invalid_object_index_repair_checkpoint',
    );
    const betaResult = await beta.repair.run({ mode: 'apply', batch_size: 10 });
    assert.deepStrictEqual(betaResult.progress, {
      scanned: 1, repaired: 0, removed: 0, stale: 0, skipped: 1, errors: 0,
    });
    assert.deepStrictEqual((await beta.storage.listObjects('assets')).objects.map((object) => object.key), ['beta.txt']);
  });

  it('continues past a corrupt manifest, repairs an unrelated record, and reports attention rather than false success', async function () {
    const { kv, index, storage, repair } = fixture();
    await put(storage, 'healthy.txt');
    await kv.delete(onlyLeaf(kv));
    await kv.put(
      index.key('object-manifest', 'prj_A1b2C3d4', 'assets', `objkey_${'A'.repeat(43)}`),
      JSON.stringify({ schema: 'corrupt' }),
    );

    const result = await repair.run({ mode: 'apply', batch_size: 10 });
    assert.strictEqual(result.complete, true);
    assert.strictEqual(result.status, 'completed_with_errors');
    assert.strictEqual(result.progress.scanned, 2);
    assert.strictEqual(result.progress.repaired, 1);
    assert.strictEqual(result.progress.errors, 1);
    assert.ok(result.progress.skipped >= 1);
    assert.deepStrictEqual((await storage.listObjects('assets')).objects.map((object) => object.key), ['healthy.txt']);
    assert.ok(!/objkey|file_id|message_id|telegram|revision/i.test(JSON.stringify(result)));
  });

  it('returns a retryable failure on transient KV list failure without advancing a repair checkpoint', async function () {
    const kv = createMockKV();
    const env = {
      TELEGRAPH_CLOUD_KV: kv,
      API_KEY_PEPPER: 'phase-five-one-retry-pepper-that-is-at-least-thirty-two-bytes',
    };
    const baseIndex = indexModule.createCloudIndexStore(env);
    let failList = true;
    // Repair is intentionally leaf/manifest-scoped: it needs no public-list
    // traversal/cursor helpers or raw KV key builder from the shared store.
    const retryingIndex = {
      getJson: baseIndex.getJson,
      putJson: baseIndex.putJson,
      remove: baseIndex.remove,
      async list(...args) {
        if (failList) {
          failList = false;
          throw new Error('transient KV list failure');
        }
        return baseIndex.list(...args);
      },
    };
    const setup = fixture({ kv, env, index: baseIndex });
    await put(setup.storage, 'retry.txt');
    const repair = repairModule.createObjectIndexRepairService(env, {
      projectId: 'prj_A1b2C3d4', index: retryingIndex, now: fixedClock(),
    });
    await assert.rejects(
      () => repair.run({ mode: 'apply', batch_size: 10 }),
      (error) => error && error.status === 503 && error.code === 'object_index_repair_unavailable',
    );
    const retried = await repair.run({ mode: 'apply', batch_size: 10 });
    assert.strictEqual(retried.status, 'completed');
    assert.strictEqual(retried.progress.skipped, 1);
  });

  it('returns a retryable failure if a deterministic leaf write fails, then safely repairs on retry', async function () {
    const kv = createMockKV();
    const setup = fixture({ kv });
    await put(setup.storage, 'write-retry.txt');
    await kv.delete(onlyLeaf(kv));
    let failPut = true;
    const retryingIndex = {
      getJson: setup.index.getJson,
      remove: setup.index.remove,
      list: setup.index.list,
      async putJson(...args) {
        if (failPut && args[0] === 'object-list') {
          failPut = false;
          throw new Error('transient KV write failure');
        }
        return setup.index.putJson(...args);
      },
    };
    const repair = repairModule.createObjectIndexRepairService(setup.env, {
      projectId: 'prj_A1b2C3d4', index: retryingIndex, now: fixedClock(),
    });
    await assert.rejects(
      () => repair.run({ mode: 'apply', batch_size: 10 }),
      (error) => error && error.status === 503 && error.code === 'object_list_index_unavailable',
    );
    const retried = await repair.run({ mode: 'apply', batch_size: 10 });
    assert.deepStrictEqual(retried.progress, {
      scanned: 1, repaired: 1, removed: 0, stale: 1, skipped: 0, errors: 0,
    });
    assert.deepStrictEqual((await setup.storage.listObjects('assets')).objects.map((object) => object.key), ['write-retry.txt']);
  });

  it('exposes the maintenance route only through dashboard authentication and returns no internal pointers', async function () {
    const kv = createMockKV();
    const env = {
      TELEGRAPH_CLOUD_KV: kv,
      API_KEY_PEPPER: 'phase-five-one-route-pepper-that-is-at-least-thirty-two-bytes',
      BASIC_USER: 'admin',
      BASIC_PASS: 'secret',
    };
    const index = indexModule.createCloudIndexStore(env);
    let projectCounter = 0;
    let keyCounter = 0;
    const projects = projectModule.createProjectRegistry(env, {
      index,
      now: fixedClock(),
      createId(prefix) { return `${prefix}${String(++projectCounter).padStart(8, '0')}`; },
    });
    const project = await projects.createProject({ slug: 'repair-route', name: 'Repair route' });
    const keys = keyModule.createDeveloperApiKeyService(env, {
      index,
      projects,
      now: fixedClock(),
      createId(prefix) { return `${prefix}${String(++keyCounter).padStart(22, '0')}`; },
      randomBytes(length) { return new Uint8Array(length).fill(7); },
    });
    const developerKey = await keys.createKey(project.project_id, { label: 'storage reader', scopes: ['storage:read'] });

    const dashboardResponse = await runPipeline(projectMiddleware.onRequest, repairRoute, makeContext({
      request: new Request(`https://example.com/api/projects/${project.project_id}/storage/index-repair`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa('admin:secret')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: 'dry_run', batch_size: 10 }),
      }),
      env,
      params: { id: project.project_id },
    }));
    assert.strictEqual(dashboardResponse.status, 200);
    const dashboardBody = await dashboardResponse.json();
    assert.deepStrictEqual(dashboardBody.progress, {
      scanned: 0, repaired: 0, removed: 0, stale: 0, skipped: 0, errors: 0,
    });
    assert.ok(!/file_id|message_id|telegram|revision|objkey|pointer/i.test(JSON.stringify(dashboardBody)));

    const developerResponse = await runPipeline(projectMiddleware.onRequest, repairRoute, makeContext({
      request: new Request(`https://example.com/api/projects/${project.project_id}/storage/index-repair`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${developerKey.api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode: 'dry_run', batch_size: 10 }),
      }),
      env,
      params: { id: project.project_id },
    }));
    assert.strictEqual(developerResponse.status, 401);
    assert.deepStrictEqual(await developerResponse.json(), { error: 'unauthenticated' });

    const wrongMethod = await runPipeline(projectMiddleware.onRequest, repairRoute, makeContext({
      request: new Request(`https://example.com/api/projects/${project.project_id}/storage/index-repair`, {
        headers: { Authorization: `Basic ${btoa('admin:secret')}` },
      }),
      env,
      params: { id: project.project_id },
    }));
    assert.strictEqual(wrongMethod.status, 405);
    assert.strictEqual(wrongMethod.headers.get('Allow'), 'POST');
  });
});
