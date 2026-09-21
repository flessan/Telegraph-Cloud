const assert = require('assert');
const { makeContext } = require('./helpers');

describe('centralized browser CORS', function () {
  let middleware;
  let cors;

  before(async function () {
    middleware = await import('../functions/_middleware.js');
    cors = await import('../functions/utils/cors.js');
  });

  function request(url, init = {}) {
    return new Request(url, init);
  }

  it('allows the deployed Admin Panel origin on the public OpenAPI document', async function () {
    const response = await middleware.onRequest(makeContext({
      request: request('https://telestorage.pages.dev/openapi.json', {
        headers: { Origin: 'https://admin-panel-everywhere.pages.dev' },
      }),
      next: async () => new Response('{}', { status: 200 }),
    }));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('Access-Control-Allow-Origin'), 'https://admin-panel-everywhere.pages.dev');
    assert.match(response.headers.get('Access-Control-Expose-Headers'), /ETag/);
    assert.match(response.headers.get('Vary'), /Origin/);
  });

  it('allows the local Admin Panel development origin', async function () {
    const response = await middleware.onRequest(makeContext({
      request: request('https://telestorage.pages.dev/openapi.json', {
        headers: { Origin: 'http://localhost:3214' },
      }),
      next: async () => new Response('{}', { status: 200 }),
    }));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('Access-Control-Allow-Origin'), 'http://localhost:3214');
  });

  it('does not grant CORS to an unlisted origin', async function () {
    const response = await middleware.onRequest(makeContext({
      request: request('https://telestorage.pages.dev/openapi.json', {
        headers: { Origin: 'https://evil.example' },
      }),
      next: async () => new Response('{}', { status: 200 }),
    }));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('Access-Control-Allow-Origin'), null);
  });

  it('answers an authorized API preflight', async function () {
    const response = await middleware.onRequest(makeContext({
      request: request('https://telestorage.pages.dev/api/db/notes', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://admin-panel-everywhere.pages.dev',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization,content-type',
        },
      }),
    }));
    assert.strictEqual(response.status, 204);
    assert.strictEqual(response.headers.get('Access-Control-Allow-Origin'), 'https://admin-panel-everywhere.pages.dev');
    assert.match(response.headers.get('Access-Control-Allow-Methods'), /GET/);
    assert.match(response.headers.get('Access-Control-Allow-Headers'), /authorization/);
    assert.match(response.headers.get('Vary'), /Access-Control-Request-Headers/);
  });

  it('supports object metadata request headers during preflight', async function () {
    const response = await middleware.onRequest(makeContext({
      request: request('https://telestorage.pages.dev/api/storage/assets/file.txt', {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:3214',
          'Access-Control-Request-Method': 'PUT',
          'Access-Control-Request-Headers': 'authorization,content-type,x-amz-meta-label',
        },
      }),
    }));
    assert.strictEqual(response.status, 204);
    assert.match(response.headers.get('Access-Control-Allow-Headers'), /x-amz-meta-label/);
  });

  it('rejects disallowed preflight origins', async function () {
    const response = await middleware.onRequest(makeContext({
      request: request('https://telestorage.pages.dev/api/db/notes', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example',
          'Access-Control-Request-Method': 'GET',
        },
      }),
    }));
    assert.strictEqual(response.status, 403);
    assert.strictEqual(response.headers.get('Access-Control-Allow-Origin'), null);
  });

  it('rejects unsupported requested headers', async function () {
    const response = await middleware.onRequest(makeContext({
      request: request('https://telestorage.pages.dev/api/db/notes', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://admin-panel-everywhere.pages.dev',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'x-not-allowed',
        },
      }),
    }));
    assert.strictEqual(response.status, 403);
  });

  it('respects TELEGRAPH_CORS_ORIGINS as an explicit allowlist', async function () {
    assert.strictEqual(
      cors.corsAllowedOrigin('https://custom.example', { TELEGRAPH_CORS_ORIGINS: 'https://custom.example, http://localhost:3214' }),
      'https://custom.example',
    );
    assert.strictEqual(
      cors.corsAllowedOrigin('https://admin-panel-everywhere.pages.dev', { TELEGRAPH_CORS_ORIGINS: 'https://custom.example' }),
      null,
    );
  });

  it('leaves non-browser requests unchanged', async function () {
    const response = await middleware.onRequest(makeContext({
      request: request('https://telestorage.pages.dev/api/health'),
      next: async () => new Response('{}', { status: 200 }),
    }));
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('Access-Control-Allow-Origin'), null);
  });

  it('does not attach developer CORS to dashboard project-management routes', async function () {
    const response = await middleware.onRequest(makeContext({
      request: request('https://telestorage.pages.dev/api/projects/example', {
        headers: { Origin: 'https://admin-panel-everywhere.pages.dev' },
      }),
      next: async () => new Response('{}', { status: 200 }),
    }));
    assert.strictEqual(response.headers.get('Access-Control-Allow-Origin'), null);
  });
});
