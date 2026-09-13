const assert = require('assert');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT = path.resolve(__dirname, '../scripts/telegraph-cloud-staged-smoke.cjs');
const PRIMARY_ACCESS_KEY = `tgsk_live_${'a'.repeat(22)}`;
const ISOLATED_ACCESS_KEY = `tgsk_live_${'b'.repeat(22)}`;
const REPLACEMENT_ACCESS_KEY = `tgsk_live_${'c'.repeat(22)}`;
const PRIMARY_SECRET = 'primary-one-time-secret-not-for-terminal-output';
const ISOLATED_SECRET = 'isolated-one-time-secret-not-for-terminal-output';
const REPLACEMENT_SECRET = 'replacement-one-time-secret-not-for-terminal-output';
const PAYLOAD = 'phase6c-staged-smoke-payload';

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function xml(response, status, code) {
  response.writeHead(status, { 'Content-Type': 'application/xml' });
  response.end(`<Error><Code>${code}</Code></Error>`);
}

function startMockPages({ failAfterPut = false } = {}) {
  const observed = new Set();
  const state = { rotated: false, replacementRevoked: false, isolatedDisabled: false, objectDeleted: false };
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    request.resume();

    if (url.pathname === '/api/health') {
      observed.add('health');
      return json(response, 200, { status: 'ok' });
    }
    if (url.pathname === '/api/projects/diagnostics') {
      observed.add(url.searchParams.get('probe') === 'telegram' ? 'telegram-diagnostics' : 'diagnostics');
      return json(response, 200, {
        status: 'ready_for_smoke',
        checks: { telegram_api: url.searchParams.get('probe') === 'telegram' ? 'reachable' : 'not_probed' },
      });
    }
    if (request.method === 'POST' && url.pathname === '/api/projects') {
      const id = observed.has('primary-project') ? 'prj_isolated' : 'prj_primary';
      observed.add(id === 'prj_primary' ? 'primary-project' : 'isolated-project');
      return json(response, 201, { project_id: id });
    }
    if (request.method === 'POST' && /\/s3-credentials$/.test(url.pathname)) {
      if (url.pathname.includes('prj_primary')) {
        observed.add('primary-credential');
        return json(response, 201, {
          credential: { access_key_id: PRIMARY_ACCESS_KEY }, secret_access_key: PRIMARY_SECRET,
        });
      }
      observed.add('isolated-credential');
      return json(response, 201, {
        credential: { access_key_id: ISOLATED_ACCESS_KEY }, secret_access_key: ISOLATED_SECRET,
      });
    }
    if (request.method === 'POST' && /\/s3-credentials\/[^/]+\/rotate$/.test(url.pathname)) {
      observed.add('rotate');
      state.rotated = true;
      return json(response, 201, {
        credential: { access_key_id: REPLACEMENT_ACCESS_KEY }, secret_access_key: REPLACEMENT_SECRET,
      });
    }
    if (request.method === 'DELETE' && /\/s3-credentials\/[^/]+$/.test(url.pathname)) {
      if (url.pathname.includes(REPLACEMENT_ACCESS_KEY)) {
        observed.add('explicit-revoke');
        state.replacementRevoked = true;
      }
      return json(response, 200, { status: 'revoked' });
    }
    if (request.method === 'PATCH' && url.pathname === '/api/projects/prj_isolated') {
      observed.add('disable-project');
      state.isolatedDisabled = true;
      return json(response, 200, { status: 'disabled' });
    }
    if (request.method === 'DELETE' && /^\/api\/projects\/prj_/.test(url.pathname)) {
      observed.add(`delete-${url.pathname.split('/').pop()}`);
      return json(response, 200, { status: 'deleted' });
    }

    if (url.pathname.startsWith('/s3/')) {
      const authorization = request.headers.authorization || '';
      const accessKeyMatch = /Credential=(tgsk_live_[A-Za-z0-9_-]+)\//.exec(authorization);
      assert.ok(accessKeyMatch, 'the staged smoke must use an Authorization header');
      assert.ok(request.headers['x-amz-date'], 'the staged smoke must sign a date');
      assert.ok(request.headers['x-amz-content-sha256'], 'the staged smoke must sign a payload hash');
      const accessKey = accessKeyMatch[1];
      const isList = url.searchParams.get('list-type') === '2';

      if (accessKey === PRIMARY_ACCESS_KEY && state.rotated) {
        observed.add('rotated-rejection');
        return xml(response, 403, 'InvalidAccessKeyId');
      }
      if (accessKey === ISOLATED_ACCESS_KEY) {
        if (state.isolatedDisabled) {
          observed.add('inactive-rejection');
          return xml(response, 403, 'AccessDenied');
        }
        observed.add('cross-project');
        return xml(response, 404, 'NoSuchKey');
      }
      if (accessKey === REPLACEMENT_ACCESS_KEY && state.replacementRevoked) {
        observed.add('revoked-rejection');
        return xml(response, 403, 'InvalidAccessKeyId');
      }
      assert.ok(accessKey === PRIMARY_ACCESS_KEY || accessKey === REPLACEMENT_ACCESS_KEY, 'unexpected credential');

      if (request.method === 'PUT') {
        observed.add('put');
        response.writeHead(200);
        return response.end();
      }
      if (request.method === 'DELETE') {
        observed.add(request.headers['idempotency-key']?.includes('cleanup-delete') ? 'cleanup-delete' : 'delete');
        state.objectDeleted = true;
        response.writeHead(204);
        return response.end();
      }
      if (failAfterPut && observed.has('put') && accessKey === PRIMARY_ACCESS_KEY && !isList) {
        observed.add('forced-get-failure');
        response.writeHead(500);
        return response.end();
      }
      if (state.objectDeleted && !isList) {
        observed.add('post-delete');
        return xml(response, 404, 'NoSuchKey');
      }
      if (isList) {
        observed.add('list');
        response.writeHead(200, { 'Content-Type': 'application/xml' });
        return response.end('<ListBucketResult/>');
      }
      if (request.method === 'HEAD') {
        observed.add('head');
        response.writeHead(200, { 'Content-Length': String(Buffer.byteLength(PAYLOAD)) });
        return response.end();
      }
      if (request.headers.range) {
        observed.add('range');
        response.writeHead(206, { 'Content-Type': 'text/plain' });
        return response.end(PAYLOAD.slice(0, 5));
      }
      observed.add('get');
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      return response.end(PAYLOAD);
    }

    response.writeHead(404);
    return response.end();
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      observed,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function runSmoke(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('Phase 6C staged production smoke utility', function () {
  it('requires explicit confirmation before it can write anything', async function () {
    const result = await runSmoke({ ...process.env });
    assert.strictEqual(result.code, 1);
    assert.strictEqual(result.stdout, '');
    assert.strictEqual(result.stderr, '[phase6c] staged smoke failed; inspect authenticated operator diagnostics and protected logs.\n');
  });

  it('executes the documented control-plane/SigV4 sequence without printing credentials or request material', async function () {
    const { server, observed, baseUrl } = await startMockPages();
    try {
      const result = await runSmoke({
        ...process.env,
        TELEGRAPH_CLOUD_SMOKE_CONFIRM: 'I_UNDERSTAND_THIS_WRITES_TELEGRAM',
        TELEGRAPH_CLOUD_SMOKE_BASE_URL: baseUrl,
        TELEGRAPH_CLOUD_SMOKE_DASHBOARD_USER: 'operator',
        TELEGRAPH_CLOUD_SMOKE_DASHBOARD_PASS: 'dashboard-password',
      });
      assert.strictEqual(result.code, 0, result.stderr);
      assert.ok(result.stdout.includes('[phase6c] passed; credentials were revoked and projects logically deleted'));
      assert.strictEqual(result.stderr, '');
      for (const forbidden of [
        PRIMARY_ACCESS_KEY,
        ISOLATED_ACCESS_KEY,
        REPLACEMENT_ACCESS_KEY,
        PRIMARY_SECRET,
        ISOLATED_SECRET,
        REPLACEMENT_SECRET,
        'dashboard-password',
        PAYLOAD,
        'Authorization:',
        'Signature=',
      ]) {
        assert.ok(!`${result.stdout}${result.stderr}`.includes(forbidden), result.stdout);
      }
      for (const step of [
        'health', 'diagnostics', 'telegram-diagnostics',
        'primary-project', 'isolated-project', 'primary-credential', 'isolated-credential',
        'put', 'get', 'head', 'range', 'list', 'cross-project', 'disable-project', 'inactive-rejection',
        'rotate', 'rotated-rejection', 'delete', 'post-delete', 'explicit-revoke', 'revoked-rejection',
        'delete-prj_primary', 'delete-prj_isolated',
      ]) {
        assert.ok(observed.has(step), `missing staged smoke step: ${step}`);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('attempts a logical object tombstone before known-credential cleanup after a post-PUT failure', async function () {
    const { server, observed, baseUrl } = await startMockPages({ failAfterPut: true });
    try {
      const result = await runSmoke({
        ...process.env,
        TELEGRAPH_CLOUD_SMOKE_CONFIRM: 'I_UNDERSTAND_THIS_WRITES_TELEGRAM',
        TELEGRAPH_CLOUD_SMOKE_BASE_URL: baseUrl,
        TELEGRAPH_CLOUD_SMOKE_DASHBOARD_USER: 'operator',
        TELEGRAPH_CLOUD_SMOKE_DASHBOARD_PASS: 'dashboard-password',
      });
      assert.strictEqual(result.code, 1);
      assert.strictEqual(result.stdout.includes('passed; credentials were revoked'), false);
      assert.strictEqual(result.stderr, '[phase6c] staged smoke failed; inspect authenticated operator diagnostics and protected logs.\n');
      for (const forbidden of [PRIMARY_SECRET, ISOLATED_SECRET, 'dashboard-password', PAYLOAD]) {
        assert.ok(!`${result.stdout}${result.stderr}`.includes(forbidden), result.stdout);
      }
      for (const step of [
        'put', 'forced-get-failure', 'cleanup-delete',
        'delete-prj_primary', 'delete-prj_isolated',
      ]) {
        assert.ok(observed.has(step), `missing failure-cleanup step: ${step}; observed=${[...observed].join(',')}`);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
