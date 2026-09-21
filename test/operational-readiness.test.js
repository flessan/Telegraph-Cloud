const assert = require('assert');
const { createMockKV, installFetchMock, makeContext, muteConsole } = require('./helpers');

function basicHeaders() {
  return { Authorization: `Basic ${Buffer.from('operator:dashboard-password').toString('base64')}` };
}

async function runPipeline(middlewares, route, context) {
  const handlers = [...middlewares, async () => route.onRequest(context)];
  let position = 0;
  context.next = () => handlers[position++](context);
  return context.next();
}

describe('Phase 6C public health and authenticated operator readiness', function () {
  let readiness;
  let healthRoute;
  let diagnosticsRoute;
  let projectMiddleware;
  let restoreConsole;
  let fetchMock;

  const secrets = Object.freeze({
    basicUser: 'operator',
    basicPass: 'dashboard-password',
    botToken: '123456:telegram-secret-token',
    chatId: '-1001234567890',
    apiPepper: 'api-key-pepper-that-is-at-least-thirty-two-utf8-bytes-long',
    s3Pepper: 's3-credential-pepper-that-is-at-least-thirty-two-bytes',
    endpoint: 's3.example.test',
  });

  before(async function () {
    readiness = await import('../functions/cloud/operational-readiness.js');
    healthRoute = await import('../functions/api/health.js');
    diagnosticsRoute = await import('../functions/api/projects/diagnostics.js');
    projectMiddleware = await import('../functions/api/projects/_middleware.js');
  });

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    if (fetchMock) {
      fetchMock.restore();
      fetchMock = null;
    }
    restoreConsole();
  });

  function configuredEnv({ kv = createMockKV(), overrides = {} } = {}) {
    return {
      BASIC_USER: secrets.basicUser,
      BASIC_PASS: secrets.basicPass,
      TG_Bot_Token: secrets.botToken,
      TG_Chat_ID: secrets.chatId,
      API_KEY_PEPPER: secrets.apiPepper,
      TELEGRAPH_CLOUD_S3_CREDENTIAL_PEPPER: secrets.s3Pepper,
      TELEGRAPH_CLOUD_S3_ENDPOINT_HOST: secrets.endpoint,
      TELEGRAPH_CLOUD_KV: kv,
      img_url: createMockKV(),
      ...overrides,
    };
  }

  it('keeps public health minimal and independent of Cloud secrets', async function () {
    const degraded = await healthRoute.onRequestGet(makeContext({ env: {} }));
    assert.strictEqual(degraded.status, 200);
    assert.strictEqual(degraded.headers.get('Cache-Control'), 'no-store');
    assert.strictEqual(degraded.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.deepStrictEqual(await degraded.json(), { status: 'degraded' });

    const cloudKv = createMockKV();
    const env = configuredEnv({ kv: cloudKv });
    const healthy = await healthRoute.onRequestGet(makeContext({ env }));
    const body = await healthy.text();
    assert.strictEqual(healthy.status, 200);
    assert.strictEqual(body, '{"status":"ok"}');
    for (const value of Object.values(secrets)) assert.ok(!body.includes(value), body);
    assert.deepStrictEqual(cloudKv.operations.get, []);
    assert.deepStrictEqual(cloudKv.operations.put, []);
    assert.deepStrictEqual(cloudKv.operations.delete, []);
    assert.deepStrictEqual(cloudKv.operations.list, []);
  });

  it('returns only bounded non-secret configuration/readiness states and makes a read-only KV probe', async function () {
    const kv = createMockKV();
    const env = configuredEnv({ kv });
    const report = await readiness.getOperatorReadiness(env);

    assert.deepStrictEqual(report, {
      status: 'ready_for_smoke',
      checks: {
        dashboard_auth: 'configured',
        legacy_storage: 'configured',
        cloud_kv: 'readable',
        telegram_configuration: 'configured',
        telegram_api: 'not_probed',
        telegram_api_reason: 'not_probed',
        api_key_verifier: 'configured',
        s3_credential_verifier: 'configured',
        s3_endpoint: 'configured',
        cloud_object_engine: 'ready_for_smoke',
        s3_adapter: 'ready_for_smoke',
      },
    });
    assert.deepStrictEqual(kv.operations.get, ['tc:v1:operator-readiness:probe']);
    assert.strictEqual(kv.operations.put.length, 0);
    assert.strictEqual(kv.operations.delete.length, 0);
    assert.strictEqual(kv.operations.list.length, 0);

    const serialized = JSON.stringify(report);
    for (const value of Object.values(secrets)) assert.ok(!serialized.includes(value), serialized);
  });

  it('degrades safely when Cloud KV or a required S3 setting is unavailable', async function () {
    const kv = createMockKV();
    kv.get = async () => { throw new Error('KV namespace id and provider detail must not escape'); };
    const report = await readiness.getOperatorReadiness(configuredEnv({
      kv,
      overrides: { TELEGRAPH_CLOUD_S3_ENDPOINT_HOST: 'https://not-a-host.example.test' },
    }));

    assert.strictEqual(report.status, 'degraded');
    assert.strictEqual(report.checks.cloud_kv, 'unreachable');
    assert.strictEqual(report.checks.cloud_object_engine, 'not_ready');
    assert.strictEqual(report.checks.s3_endpoint, 'missing_or_invalid');
    assert.strictEqual(JSON.stringify(report).includes('namespace id'), false);
    assert.strictEqual(kv.operations.put.length, 0);
  });

  it('uses an opt-in, no-detail Telegram getMe probe and does not retain the returned Telegram record', async function () {
    const env = configuredEnv();
    fetchMock = installFetchMock(async (input, init) => {
      if (String(input).endsWith('/getMe')) {
        assert.strictEqual(String(input), `https://api.telegram.org/bot${secrets.botToken}/getMe`);
        assert.deepStrictEqual(init, { method: 'GET' });
        return Response.json({ ok: true, result: { id: 998877, username: 'must-not-appear' } });
      }
      assert.strictEqual(
        String(input),
        `https://api.telegram.org/bot${secrets.botToken}/getChat?chat_id=${encodeURIComponent(secrets.chatId)}`,
      );
      assert.deepStrictEqual(init, { method: 'GET' });
      return Response.json({ ok: true, result: { id: secrets.chatId } });
    });

    const report = await readiness.getOperatorReadiness(env, { probeTelegram: true });
    assert.strictEqual(fetchMock.calls.length, 1);
    assert.strictEqual(report.status, 'ready_for_smoke');
    assert.strictEqual(report.checks.telegram_api, 'reachable');
    assert.strictEqual(report.checks.telegram_api_reason, 'ok');
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(secrets.botToken), serialized);
    assert.ok(!serialized.includes('998877'), serialized);
    assert.ok(!serialized.includes('must-not-appear'), serialized);
  });

  it('maps a failed Telegram probe to a safe degraded enum without provider detail', async function () {
    const env = configuredEnv();
    fetchMock = installFetchMock(async () => Response.json({
      ok: false,
      description: `chat ${secrets.chatId} denied token ${secrets.botToken}`,
    }, { status: 403 }));

    const report = await readiness.getOperatorReadiness(env, { probeTelegram: true });
    assert.strictEqual(report.status, 'degraded');
    assert.strictEqual(report.checks.telegram_api, 'unreachable');
    assert.strictEqual(report.checks.telegram_api_reason, 'forbidden');
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(secrets.botToken), serialized);
    assert.ok(!serialized.includes(secrets.chatId), serialized);
    assert.ok(!serialized.includes('denied'), serialized);
  });

  it('requires dashboard authentication for diagnostics, validates the optional probe selector, and emits only an allowlisted signal', async function () {
    const env = configuredEnv();
    const unauthenticated = await runPipeline(projectMiddleware.onRequest, diagnosticsRoute, makeContext({
      env,
      request: new Request('https://example.test/api/projects/diagnostics'),
    }));
    assert.strictEqual(unauthenticated.status, 401);
    assert.deepStrictEqual(await unauthenticated.json(), { error: 'unauthenticated' });

    const tags = [];
    const authenticated = await runPipeline(projectMiddleware.onRequest, diagnosticsRoute, makeContext({
      env,
      data: { sentry: { setTag(key, value) { tags.push([key, value]); } } },
      request: new Request('https://example.test/api/projects/diagnostics', { headers: basicHeaders() }),
    }));
    assert.strictEqual(authenticated.status, 200);
    const body = await authenticated.text();
    assert.ok(!body.includes(secrets.basicPass), body);
    assert.ok(!body.includes(secrets.botToken), body);
    assert.deepStrictEqual(tags, [['telegraph_cloud.signal', 'operator_readiness:ready_for_smoke']]);

    const invalid = await diagnosticsRoute.onRequest(makeContext({
      env,
      request: new Request('https://example.test/api/projects/diagnostics?probe=telegram&probe=other'),
    }));
    assert.strictEqual(invalid.status, 400);
    assert.deepStrictEqual(await invalid.json(), { error: 'invalid_diagnostic_probe' });

    const wrongMethod = await diagnosticsRoute.onRequest(makeContext({
      env,
      request: new Request('https://example.test/api/projects/diagnostics', { method: 'POST' }),
    }));
    assert.strictEqual(wrongMethod.status, 405);
    assert.strictEqual(wrongMethod.headers.get('Allow'), 'GET');
  });
});
