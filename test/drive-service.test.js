const assert = require('assert');
const { createMockKV, makeContext, muteConsole } = require('./helpers');

function fixedClock() {
  return new Date('2026-09-12T12:34:56.000Z');
}

describe('Telegraph Cloud Drive service', function () {
  let objectStorage;
  let driveState;
  let driveService;
  let projectRegistry;
  let indexModule;
  let restoreConsole;

  before(async function () {
    objectStorage = await import('../functions/cloud/object-storage.js');
    driveState = await import('../functions/cloud/drive-state.js');
    driveService = await import('../functions/cloud/drive-service.js');
    projectRegistry = await import('../functions/cloud/project-registry.js');
    indexModule = await import('../functions/cloud/index-store.js');
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
      async putObject({ body, contentType }) {
        const fileId = `file${String(++sequence).padStart(16, '0')}`;
        bytes.set(fileId, new Uint8Array(body));
        return { provider: 'telegram-object', fileId, messageId: sequence, contentType };
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
    const index = indexModule.createCloudIndexStore(env);
    const transport = createTransport();
    const registry = projectRegistry.createProjectRegistry(env, { index, now: fixedClock });
    const project = await registry.createProject({ slug: 'reson-tune', name: 'ResonTune' });
    let id = 0;
    const storage = objectStorage.createTelegramObjectStorage(env, {
      projectId: project.project_id,
      index,
      transport,
      now: fixedClock,
      createId(prefix) {
        id += 1;
        return `${prefix}${String(id).padStart(22, '0')}`;
      },
    });
    const state = driveState.createDriveStateService(env, { index, now: fixedClock });
    const drive = driveService.createDriveService(env, {
      projectId: project.project_id,
      storage,
      state,
      projects: registry,
    });
    return { kv, env, index, registry, project, storage, state, drive };
  }

  async function put(drive, bucket, key, content, contentType = 'text/plain') {
    const result = await drive.putObject(bucket, key, {
      body: new TextEncoder().encode(content),
      contentType,
    });
    return result.object;
  }

  it('creates and lists bucket markers shared with the object engine', async function () {
    const { drive } = await fixture();
    const created = await drive.createBucket('assets');
    assert.strictEqual(created.created, true);
    assert.strictEqual(created.bucket.bucket, 'assets');
    const again = await drive.createBucket('assets');
    assert.strictEqual(again.created, false);
    const list = await drive.listBuckets();
    assert.deepStrictEqual(list.data.map((b) => b.bucket), ['assets']);
  });

  it('rejects an invalid bucket name', async function () {
    const { drive } = await fixture();
    await assert.rejects(drive.createBucket('UPPER'), (error) => error.code === 'invalid_bucket_name');
  });

  it('lists folders (common prefixes) and explicit empty folders with breadcrumb prefixes', async function () {
    const { drive } = await fixture();
    await put(drive, 'assets', 'logo.png', 'x');
    await put(drive, 'assets', 'covers/front.webp', 'x');
    await drive.createFolder('assets', 'empty/');
    const root = await drive.listObjects({ bucket: 'assets', prefix: '' });
    assert.deepStrictEqual(root.folders.map((f) => f.prefix).sort(), ['covers/', 'empty/']);
    assert.deepStrictEqual(root.objects.map((o) => o.key), ['logo.png']);
    const empty = root.folders.find((f) => f.prefix === 'empty/');
    assert.strictEqual(empty.empty, true);
    const nested = await drive.listObjects({ bucket: 'assets', prefix: 'covers/' });
    assert.deepStrictEqual(nested.objects.map((o) => o.key), ['covers/front.webp']);
  });

  it('stars objects, hides trashed objects, and supports restore plus trash view', async function () {
    const { drive } = await fixture();
    await put(drive, 'assets', 'a.txt', 'a');
    await put(drive, 'assets', 'b.txt', 'b');
    await drive.setFlags('assets', 'a.txt', { starred: true });
    await drive.setFlags('assets', 'b.txt', { trashed: true });

    const root = await drive.listObjects({ bucket: 'assets' });
    assert.deepStrictEqual(root.objects.map((o) => o.key), ['a.txt']);
    assert.strictEqual(root.objects[0].flags.starred, true);

    const trash = await drive.listObjects({ bucket: 'assets', view: 'trash' });
    assert.deepStrictEqual(trash.objects.map((o) => o.key), ['b.txt']);
    assert.strictEqual(trash.view, 'trash');

    const starred = await drive.listObjects({ bucket: 'assets', view: 'starred' });
    assert.deepStrictEqual(starred.objects.map((o) => o.key), ['a.txt']);

    // Restore: clear the trashed flag; the object reappears.
    await drive.setFlags('assets', 'b.txt', { trashed: false });
    const restored = await drive.listObjects({ bucket: 'assets' });
    assert.deepStrictEqual(restored.objects.map((o) => o.key).sort(), ['a.txt', 'b.txt']);
  });

  it('searches keys server-side without exposing a trashed match', async function () {
    const { drive } = await fixture();
    await put(drive, 'assets', 'covers/reson-tune.webp', 'x');
    await put(drive, 'assets', 'logo.png', 'x');
    await drive.setFlags('assets', 'logo.png', { trashed: true });
    const results = await drive.listObjects({ bucket: 'assets', search: 'logo' });
    assert.strictEqual(results.view, 'search');
    assert.deepStrictEqual(results.objects, []);
    const tunes = await drive.listObjects({ bucket: 'assets', search: 'tune' });
    assert.deepStrictEqual(tunes.objects.map((o) => o.key), ['covers/reson-tune.webp']);
  });

  it('refuses to flag a missing object', async function () {
    const { drive } = await fixture();
    await drive.createBucket('assets');
    await assert.rejects(drive.setFlags('assets', 'ghost.txt', { starred: true }), (error) => error.code === 'object_not_found');
  });

  it('moves an object server-side, preserving bytes/content type and migrating flags', async function () {
    const { drive, storage } = await fixture();
    await put(drive, 'assets', 'old-name.txt', 'hello move', 'text/markdown');
    await drive.setFlags('assets', 'old-name.txt', { starred: true });
    const moved = await drive.copyObject({
      bucket: 'assets',
      sourceKey: 'old-name.txt',
      destKey: 'archive/new-name.md',
      deleteSource: true,
    });
    assert.strictEqual(moved.moved, true);
    assert.strictEqual(moved.object.key, 'archive/new-name.md');
    assert.strictEqual(moved.object.content_type, 'text/markdown');

    const read = await storage.getObject('assets', 'archive/new-name.md');
    const bytes = new Uint8Array(await new Response(read.body).arrayBuffer());
    assert.strictEqual(new TextDecoder().decode(bytes), 'hello move');
    await assert.rejects(storage.headObject('assets', 'old-name.txt'), (e) => e.code === 'object_not_found');

    const listing = await drive.listObjects({ bucket: 'assets', prefix: 'archive/' });
    assert.strictEqual(listing.objects[0].flags.starred, true);
  });

  it('copies without deleting the source when deleteSource is false', async function () {
    const { drive } = await fixture();
    await put(drive, 'assets', 'a.txt', 'one');
    await drive.copyObject({ bucket: 'assets', sourceKey: 'a.txt', destKey: 'b.txt' });
    const root = await drive.listObjects({ bucket: 'assets' });
    assert.deepStrictEqual(root.objects.map((o) => o.key).sort(), ['a.txt', 'b.txt']);
  });

  it('bulk trashes selections within the bounded cap', async function () {
    const { drive } = await fixture();
    await put(drive, 'assets', 'a.txt', 'a');
    await put(drive, 'assets', 'b.txt', 'b');
    const result = await drive.bulkSetFlags(
      [{ bucket: 'assets', key: 'a.txt' }, { bucket: 'assets', key: 'b.txt' }],
      { trashed: true },
    );
    assert.strictEqual(result.data.length, 2);
    const trash = await drive.listObjects({ bucket: 'assets', view: 'trash' });
    assert.strictEqual(trash.objects.length, 2);
    await assert.rejects(
      drive.bulkSetFlags(Array.from({ length: 101 }, (_, i) => ({ bucket: 'assets', key: `${i}.txt` })), { trashed: true }),
      (e) => e.code === 'invalid_drive_bulk',
    );
  });

  it('deletes an object for good and clears its drive flags', async function () {
    const { drive, state, project } = await fixture();
    await put(drive, 'assets', 'a.txt', 'a');
    await drive.setFlags('assets', 'a.txt', { starred: true, trashed: true });
    await drive.deleteObject('assets', 'a.txt');
    const flags = await state.getFlags(project.project_id, 'assets', 'a.txt');
    assert.strictEqual(flags, null);
  });

  it('refuses to remove a non-empty folder without force', async function () {
    const { drive } = await fixture();
    await put(drive, 'assets', 'folder/a.txt', 'a');
    await assert.rejects(
      drive.deleteFolder('assets', 'folder/'),
      (error) => error.code === 'drive_folder_not_empty',
    );
    const forced = await drive.deleteFolder('assets', 'folder/', { force: true });
    assert.strictEqual(forced.deleted, true);
  });

  it('reports bounded, truthful storage stats', async function () {
    const { drive } = await fixture();
    await put(drive, 'assets', 'a.txt', 'aaa');
    await put(drive, 'assets', 'b.txt', 'bb');
    await drive.setFlags('assets', 'a.txt', { starred: true });
    const stats = await drive.stats();
    assert.strictEqual(stats.buckets, 1);
    assert.strictEqual(stats.objects, 2);
    assert.strictEqual(stats.bytes, 5);
    assert.strictEqual(stats.starred, 1);
    assert.strictEqual(stats.truncated, false);
  });

  it('fails closed for a disabled or missing project', async function () {
    const { registry, project, drive } = await fixture();
    await registry.updateProject(project.project_id, { status: 'disabled' });
    await assert.rejects(drive.listObjects({ bucket: 'assets' }), (error) => error.code === 'project_inactive');
  });
});
