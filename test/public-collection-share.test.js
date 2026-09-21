const assert = require('assert');
const { createMockKV, makeContext } = require('./helpers');

describe('public collection JSON publishing', function () {
  let shareModule;
  let route;

  before(async function () {
    shareModule = await import('../functions/cloud/public-collection-share.js');
    route = await import('../functions/p/[share].json.js');
  });

  it('publishes one stable share per collection and revokes it', async function () {
    const kv = createMockKV();
    const index = (await import('../functions/cloud/index-store.js')).createCloudIndexStore(kv);
    const ids = [
      'pub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'pub_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    ];
    const service = shareModule.createPublicCollectionShareService(kv, {
      index,
      createShareId: () => ids.shift(),
      now: () => new Date('2026-09-21T00:00:00.000Z'),
    });

    const first = await service.publish({
      projectId: 'prj_aaaaaaaaaaaaaaaaaaaa',
      collection: 'products',
      origin: 'https://example.com',
    });
    const second = await service.publish({
      projectId: 'prj_aaaaaaaaaaaaaaaaaaaa',
      collection: 'products',
      origin: 'https://example.com',
    });

    assert.strictEqual(first.share_id, second.share_id);
    assert.match(first.url, /\/p\/pub_[A-Za-z0-9_-]{32}\.json$/);

    const status = await service.getStatus({
      projectId: 'prj_aaaaaaaaaaaaaaaaaaaa',
      collection: 'products',
      origin: 'https://example.com',
    });
    assert.strictEqual(status.collection, 'products');

    const revoked = await service.revoke({
      projectId: 'prj_aaaaaaaaaaaaaaaaaaaa',
      collection: 'products',
    });
    assert.strictEqual(revoked.revoked, true);
    await assert.rejects(() => service.resolve(first.share_id), { code: 'public_share_not_found' });
  });

  it('returns null status before a collection is published', async function () {
    const kv = createMockKV();
    const index = (await import('../functions/cloud/index-store.js')).createCloudIndexStore(kv);
    const service = shareModule.createPublicCollectionShareService(kv, { index });
    assert.strictEqual(await service.getStatus({
      projectId: 'prj_aaaaaaaaaaaaaaaaaaaa',
      collection: 'products',
      origin: 'https://example.com',
    }), null);
  });

  it('serves raw arrays and metadata envelopes without exposing record metadata', async function () {
    const share = {
      project_id: 'prj_aaaaaaaaaaaaaaaaaaaa',
      collection: 'products',
      share_id: 'pub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    const service = { resolve: async () => share };
    const projects = { requireActiveProject: async (id) => assert.strictEqual(id, share.project_id) };
    const database = {
      getCollection: async () => ({ name: 'products' }),
      listDocuments: async () => ({
        data: [{
          id: 'rec_1',
          version: 7,
          created_at: '2026-09-21T00:00:00.000Z',
          updated_at: '2026-09-21T00:00:00.000Z',
          data: { name: 'Coffee', price: 2 },
        }],
        limit: 100,
        order: 'id:asc',
        has_more: false,
      }),
    };

    const rawResponse = await route.onRequest(makeContext({
      request: new Request('https://example.com/p/pub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.json?raw=1'),
      params: { share: share.share_id },
      data: { publicCollectionShares: service, projectRegistry: projects, projectDatabase: database },
    }));
    assert.strictEqual(rawResponse.status, 200);
    assert.deepStrictEqual(await rawResponse.json(), [{ name: 'Coffee', price: 2 }]);
    assert.strictEqual(rawResponse.headers.get('Access-Control-Allow-Origin'), '*');

    const envelopeResponse = await route.onRequest(makeContext({
      request: new Request('https://example.com/p/pub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.json'),
      params: { share: share.share_id },
      data: { publicCollectionShares: service, projectRegistry: projects, projectDatabase: database },
    }));
    assert.deepStrictEqual(await envelopeResponse.json(), {
      collection: 'products',
      data: [{ name: 'Coffee', price: 2 }],
      limit: 100,
      order: 'id:asc',
      has_more: false,
    });
  });

  it('rejects mutation methods and supports CORS preflight', async function () {
    const methodResponse = await route.onRequest(makeContext({
      request: new Request('https://example.com/p/pub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.json', { method: 'POST' }),
      params: { share: 'pub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      env: {},
    }));
    assert.strictEqual(methodResponse.status, 405);

    const optionsResponse = await route.onRequest(makeContext({
      request: new Request('https://example.com/p/pub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.json', { method: 'OPTIONS' }),
      params: { share: 'pub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      env: {},
    }));
    assert.strictEqual(optionsResponse.status, 204);
    assert.strictEqual(optionsResponse.headers.get('Access-Control-Allow-Origin'), '*');
  });
});

describe('developer API public collection share management', function () {
  let route;

  before(async function () {
    route = await import('../functions/api/db/[collection]/share.js');
  });

  function context(overrides = {}) {
    const share = {
      project_id: 'prj_aaaaaaaaaaaaaaaaaaaa',
      collection: 'products',
      share_id: 'pub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    };
    const calls = [];
    const shares = {
      getStatus: async () => null,
      publish: async (input) => { calls.push(['publish', input]); return { ...share, url: 'https://api.example/p/pub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.json', raw_url: 'https://api.example/p/pub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.json?raw=1' }; },
      revoke: async (input) => { calls.push(['revoke', input]); return { revoked: true, share_id: share.share_id }; },
    };
    const projectRegistry = { requireActiveProject: async (id) => assert.strictEqual(id, share.project_id) };
    const projectDatabase = { getCollection: async (name) => { assert.strictEqual(name, 'products'); return { name }; } };
    return {
      calls,
      data: {
        databaseAuthentication: { authentication: 'developer_api_key', project_id: share.project_id, key_id: 'key_test' },
        publicCollectionShares: shares,
        projectRegistry,
        projectDatabase,
      },
      request: new Request('https://api.example/api/db/products/share', { method: 'GET' }),
      params: { collection: 'products' },
      ...overrides,
    };
  }

  it('reads status and publishes through developer project authentication', async function () {
    const getResponse = await route.onRequest(context());
    assert.strictEqual(getResponse.status, 200);
    assert.deepStrictEqual(await getResponse.json(), { published: false });

    const publishContext = context({
      request: new Request('https://api.example/api/db/products/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    });
    const publishResponse = await route.onRequest(publishContext);
    assert.strictEqual(publishResponse.status, 201);
    assert.strictEqual(publishContext.calls[0][0], 'publish');
  });

  it('rejects dashboard-only authentication for share management', async function () {
    const result = await route.onRequest(context({
      data: { databaseAuthentication: { authentication: 'dashboard_legacy', user: 'owner' } },
    }));
    assert.strictEqual(result.status, 403);
    assert.deepStrictEqual(await result.json(), { error: 'developer_auth_required' });
  });

  it('supports revoke and rejects invalid mutation bodies', async function () {
    const invalid = await route.onRequest(context({
      request: new Request('https://api.example/api/db/products/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"force":false}',
      }),
    }));
    assert.strictEqual(invalid.status, 400);

    const revokeContext = context({
      data: {
        databaseAuthentication: { authentication: 'developer_api_key', project_id: 'prj_aaaaaaaaaaaaaaaaaaaa' },
        publicCollectionShares: {
          revoke: async () => ({ revoked: true, share_id: 'pub_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }),
        },
        projectRegistry: { requireActiveProject: async () => {} },
        projectDatabase: { getCollection: async () => ({ name: 'products' }) },
      },
      request: new Request('https://api.example/api/db/products/share', { method: 'DELETE' }),
    });
    const revoked = await route.onRequest(revokeContext);
    assert.strictEqual(revoked.status, 200);
    assert.strictEqual((await revoked.json()).revoked, true);
  });
});
\n