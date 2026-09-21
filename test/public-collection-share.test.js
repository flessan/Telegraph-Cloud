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
