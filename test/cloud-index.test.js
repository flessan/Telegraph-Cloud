const assert = require('assert');
const { createMockKV } = require('./helpers');

function rejects(action, code) {
  assert.throws(action, (error) => error && error.code === code, `expected ${code}`);
}

describe('Telegraph Cloud materialized index foundation', function () {
  let index;

  before(async function () {
    index = await import('../functions/cloud/index-store.js');
  });

  it('requires a separate TELEGRAPH_CLOUD_KV binding without falling back to legacy img_url', function () {
    rejects(() => index.requireCloudIndexBinding({ img_url: createMockKV() }), 'cloud_index_unavailable');
    const kv = createMockKV();
    assert.strictEqual(index.requireCloudIndexBinding({ TELEGRAPH_CLOUD_KV: kv }), kv);
  });

  it('creates namespaced, validated index keys', function () {
    assert.strictEqual(
      index.cloudIndexKey('records', 'prj_A1b2C3d4', 'users', 'usr_123'),
      'tc:v1:records:prj_A1b2C3d4:users:usr_123',
    );
    rejects(() => index.cloudIndexKey('records', '../escape'), 'invalid_index_key');
    rejects(() => index.cloudIndexKey('Records', 'usr_123'), 'invalid_index_key');
    rejects(() => index.cloudIndexKey('records', 'usr:123'), 'invalid_index_key');
  });

  it('keeps JSON index persistence behind a binding-neutral interface', async function () {
    const kv = createMockKV();
    const store = index.createCloudIndexStore({ TELEGRAPH_CLOUD_KV: kv });
    const record = { revision: 1, journal: { eventId: 'evt_123' } };

    await store.putJson('records', ['prj_A1b2C3d4', 'users', 'usr_123'], record);
    assert.strictEqual(kv.operations.put.length, 1);
    assert.strictEqual(kv.operations.put[0].key, 'tc:v1:records:prj_A1b2C3d4:users:usr_123');
    assert.deepStrictEqual(
      await store.getJson('records', 'prj_A1b2C3d4', 'users', 'usr_123'),
      record,
    );

    const page = await store.list('records', { prefixSegments: ['prj_A1b2C3d4'] });
    assert.strictEqual(kv.operations.list[0].prefix, 'tc:v1:records:prj_A1b2C3d4:');
    assert.strictEqual(page.keys.length, 1);

    await store.remove('records', 'prj_A1b2C3d4', 'users', 'usr_123');
    assert.strictEqual(await store.getJson('records', 'prj_A1b2C3d4', 'users', 'usr_123'), null);
  });

  it('does not accept malformed persisted index values as valid Cloud state', async function () {
    const kv = createMockKV({
      'tc:v1:records:prj_A1b2C3d4:users:usr_123': { value: '{broken json', metadata: {} },
    });
    const store = index.createCloudIndexStore({ TELEGRAPH_CLOUD_KV: kv });
    await assert.rejects(
      () => store.getJson('records', 'prj_A1b2C3d4', 'users', 'usr_123'),
      (error) => error && error.code === 'cloud_index_invalid_json',
    );
  });
});
