const assert = require('assert');
const { createMockKV, muteConsole } = require('./helpers');

function fixedClock() {
  return new Date('2026-09-21T09:00:00.000Z');
}

const ISSUER = 'https://cloud.example';
const PROJECT_ID = 'prj_jwt00000000000000000';
const KEY_ID = 'key_jwt0000000000000000';
const SCOPES = ['db:read', 'db:write', 'storage:read', 'storage:write'];

// Signs an arbitrary compact JWT with the stored current private key — the
// white-box helper used to produce tokens the honest issuer would never emit
// (wrong audience, foreign claims).
async function forgeToken(kv, { kid, header, claims }) {
  const pointer = JSON.parse(kv.snapshot('tc:v1:jwt-signing-key:current').value);
  const kidValue = kid || pointer.kid;
  const record = JSON.parse(kv.snapshot(`tc:v1:jwt-signing-key:${kidValue}`).value);
  assert(record.private_jwk && record.private_jwk.d, 'forge helper needs the private key');
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { ...record.private_jwk, key_ops: ['sign'], ext: true },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const encoder = new TextEncoder();
  const signingInput = `${b64urlJson(header || { alg: 'ES256', typ: 'JWT', kid: kidValue })}.${b64urlJson(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${b64urlBytes(new Uint8Array(signature))}`;
}

function b64urlBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('Telegraph Cloud JWT authentication and JWKS', function () {
  let modules;
  let restoreConsole;

  before(async function () {
    modules = {
      jwt: await import('../functions/cloud/jwt-auth.js'),
      developerAuth: await import('../functions/cloud/developer-auth.js'),
      developerKeys: await import('../functions/cloud/developer-api-keys.js'),
      projectRegistry: await import('../functions/cloud/project-registry.js'),
      indexStore: await import('../functions/cloud/index-store.js'),
      dbMiddleware: await import('../functions/api/db/_middleware.js'),
      tokenRoute: await import('../functions/api/auth/token.js'),
      rotateRoute: await import('../functions/api/auth/keys/rotate.js'),
      jwksRoute: await import('../functions/.well-known/jwks.json.js'),
    };
  });

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    restoreConsole();
  });

  function createEnvironment({ clock = fixedClock } = {}) {
    const kv = createMockKV();
    const env = { TELEGRAPH_CLOUD_KV: kv, API_KEY_PEPPER: 'jwt-phase-test-pepper-that-is-at-least-32-bytes' };
    const index = modules.indexStore.createCloudIndexStore(env);
    const makeJwt = (clockFn) => {
      let kidCounter = 0;
      return modules.jwt.createJwtAuthService(env, {
        index,
        now: clockFn,
        createId() { kidCounter += 1; return `kid_${String(kidCounter).padStart(6, '0')}`; },
      });
    };
    const jwt = makeJwt(clock);
    let projectCounter = 0;
    const projects = modules.projectRegistry.createProjectRegistry(env, {
      index,
      now: clock,
      createId(prefix) { projectCounter += 1; return `${prefix}${String(projectCounter).padStart(8, '0')}`; },
    });
    let keyCounter = 0;
    const developerApiKeys = modules.developerKeys.createDeveloperApiKeyService(env, {
      index,
      projects,
      now: clock,
      createId(prefix) { keyCounter += 1; return `${prefix}${String(keyCounter).padStart(22, '0')}`; },
    });
    return { kv, env, index, jwt, makeJwt, projects, developerApiKeys };
  }

  function authContext({ env, token, method = 'GET', jwtAuth = null }) {
    return {
      request: new Request(`https://cloud.example/api/db/users`, {
        method,
        headers: { Authorization: `Bearer ${token}` },
      }),
      env,
      data: jwtAuth ? { jwtAuth } : {},
      next: () => new Response('ok', { status: 200 }),
    };
  }

  const AUTHENTICATION = {
    authentication: 'developer_api_key',
    project_id: PROJECT_ID,
    key_id: KEY_ID,
    scopes: SCOPES,
  };

  // ------------------------------------------------------------- valid JWT
  it('issues and verifies a valid JWT with all required claims and scopes', async function () {
    const { jwt } = createEnvironment();
    const issued = await jwt.issueToken({
      project_id: PROJECT_ID, key_id: KEY_ID, scopes: SCOPES, issuer: ISSUER,
    });
    assert.strictEqual(issued.token_type, 'Bearer');
    assert.strictEqual(issued.expires_in, 900, 'short expiration by default');
    assert.strictEqual(issued.scope, SCOPES.join(' '));

    const claims = decodeClaims(issued.access_token);
    assert.strictEqual(claims.iss, ISSUER, 'issuer');
    assert.strictEqual(claims.aud, 'telegraph-api', 'audience');
    assert.strictEqual(claims.sub, KEY_ID, 'subject is the issuing key id');
    assert.strictEqual(claims.project, PROJECT_ID, 'project scope');
    assert.deepStrictEqual(claims.scopes, SCOPES, 'scopes');
    assert.ok(Number.isSafeInteger(claims.exp) && claims.exp === claims.iat + 900, 'short exp');
    assert.ok(typeof claims.jti === 'string' && claims.jti, 'token id');

    const authentication = await jwt.verifyToken(issued.access_token, { issuer: ISSUER });
    assert.strictEqual(authentication.authentication, 'jwt');
    assert.strictEqual(authentication.project_id, PROJECT_ID);
    assert.strictEqual(authentication.key_id, KEY_ID);
    assert.deepStrictEqual([...authentication.scopes], SCOPES);
  });

  it('authenticates a valid JWT through the shared developer middleware and serves the project scope', async function () {
    const { env, jwt, makeJwt, projects, developerApiKeys } = createEnvironment();
    // The middleware must accept a JWT whose subject references a REAL key id.
    const project = await projects.createProject({ slug: 'jwt-middleware', name: 'JWT Middleware' });
    const created = await developerApiKeys.createKey(project.project_id, {
      label: 'jwt-source',
      scopes: SCOPES,
    });
    const realKeyId = created.key.key_id;

    const issued = await jwt.issueToken({
      project_id: project.project_id, key_id: realKeyId, scopes: SCOPES, issuer: ISSUER,
    });
    const context = authContext({ env, token: issued.access_token, jwtAuth: makeJwt(fixedClock) });
    const response = await modules.dbMiddleware.databaseAuthentication(context);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(context.data.databaseAuthentication.authentication, 'jwt');
    assert.strictEqual(context.data.databaseAuthentication.project_id, project.project_id);
    assert.strictEqual(context.data.databaseAuthentication.key_id, realKeyId);
    assert.deepStrictEqual([...context.data.databaseAuthentication.scopes], SCOPES);
  });

  it('exchanges an API key for a token through POST /api/auth/token (existing keys keep working)', async function () {
    const { env, jwt, projects, developerApiKeys } = createEnvironment();
    const project = await projects.createProject({ slug: 'jwt-exchange', name: 'JWT Exchange' });
    const created = await developerApiKeys.createKey(project.project_id, {
      label: 'ci',
      scopes: ['db:read', 'db:write'],
    });
    const apiKey = created.api_key;

    const request = new Request('https://cloud.example/api/auth/token', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const response = await modules.tokenRoute.onRequestPost({
      request, env, data: { developerApiKeys, jwtAuth: jwt },
    });
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.token_type, 'Bearer');
    assert.strictEqual(body.expires_in, 900);
    assert.strictEqual(body.scope, 'db:read db:write');
    assert.match(body.access_token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    // The exchanged token verifies against the same deployment.
    const authentication = await jwt.verifyToken(body.access_token, { issuer: ISSUER });
    assert.strictEqual(authentication.project_id, project.project_id);
    assert.strictEqual(authentication.key_id, created.key.key_id);
    assert.strictEqual(authentication.authentication, 'jwt');

    // Existing API keys keep authenticating directly (regression).
    const keyAuth = await developerApiKeys.authenticate(apiKey);
    assert.strictEqual(keyAuth.authentication, 'developer_api_key');
    assert.strictEqual(keyAuth.project_id, project.project_id);
  });

  // ---------------------------------------------------------- expired JWT
  it('rejects an expired JWT with token_expired (401)', async function () {
    let clock = fixedClock();
    const { jwt } = createEnvironment({ clock: () => clock });
    const issued = await jwt.issueToken({
      project_id: PROJECT_ID, key_id: KEY_ID, scopes: SCOPES, issuer: ISSUER,
    });

    clock = new Date(fixedClock().getTime() + 901 * 1000);
    await assert.rejects(
      () => jwt.verifyToken(issued.access_token, { issuer: ISSUER }),
      (error) => error.code === 'token_expired' && error.status === 401,
    );

    // Through the middleware with an equally moved clock: 401 token_expired.
    const { env: env2, makeJwt } = createEnvironment({ clock: () => clock });
    const jwt2 = makeJwt(() => clock);
    const issued2 = await jwt2.issueToken({
      project_id: PROJECT_ID, key_id: KEY_ID, scopes: SCOPES, issuer: ISSUER,
    });
    clock = new Date(fixedClock().getTime() + 3601 * 1000);
    const context = authContext({ env: env2, token: issued2.access_token, jwtAuth: jwt2 });
    await assert.rejects(
      () => modules.dbMiddleware.databaseAuthentication(context),
      (error) => error.code === 'token_expired' && error.status === 401,
    );
  });

  // ---------------------------------------------------------- wrong issuer
  it('rejects a JWT whose issuer is not this deployment', async function () {
    const { jwt } = createEnvironment();
    const issued = await jwt.issueToken({
      project_id: PROJECT_ID, key_id: KEY_ID, scopes: SCOPES, issuer: 'https://evil.example',
    });
    await assert.rejects(
      () => jwt.verifyToken(issued.access_token, { issuer: ISSUER }),
      (error) => error.code === 'invalid_token' && error.status === 401,
    );
  });

  // -------------------------------------------------------- wrong audience
  it('rejects a JWT with a foreign audience even when correctly signed', async function () {
    const { kv, jwt } = createEnvironment();
    // Force key generation, then forge a validly-signed token for another API.
    await jwt.issueToken({ project_id: PROJECT_ID, key_id: KEY_ID, scopes: SCOPES, issuer: ISSUER });
    const token = await forgeToken(kv, {
      claims: {
        iss: ISSUER,
        aud: 'some-other-api',
        sub: KEY_ID,
        project: PROJECT_ID,
        scopes: SCOPES,
        iat: toUnix(fixedClock()),
        exp: toUnix(fixedClock()) + 600,
        jti: 'jti_wrong_audience',
      },
    });
    await assert.rejects(
      () => jwt.verifyToken(token, { issuer: ISSUER }),
      (error) => error.code === 'invalid_token' && error.status === 401,
    );
  });

  // ----------------------------------------------------- invalid signature
  it('rejects tampered payloads and foreign signatures', async function () {
    const { jwt } = createEnvironment();
    const issued = await jwt.issueToken({
      project_id: PROJECT_ID, key_id: KEY_ID, scopes: SCOPES, issuer: ISSUER,
    });

    // 1. Tampered payload (claims edited, signature kept).
    const [head, , sig] = issued.access_token.split('.');
    const otherClaims = b64urlJson({ iss: ISSUER, aud: 'telegraph-api', sub: KEY_ID, project: 'prj_other', scopes: SCOPES, iat: 1, exp: 2e9, jti: 'x' });
    await assert.rejects(
      () => jwt.verifyToken(`${head}.${otherClaims}.${sig}`, { issuer: ISSUER }),
      (error) => error.code === 'invalid_token' && error.status === 401,
      'a signature must not verify against edited claims',
    );

    // 2. Correctly formed token signed by an entirely different key but
    //    claiming the deployed kid.
    const { kv } = createEnvironment();
    const foreign = await forgeWithForeignKey(kv, {
      kid: (await jwt.publicJwks()).keys[0].kid,
      claims: { iss: ISSUER, aud: 'telegraph-api', sub: KEY_ID, project: PROJECT_ID, scopes: SCOPES, iat: toUnix(fixedClock()), exp: toUnix(fixedClock()) + 600, jti: 'foreign' },
    });
    await assert.rejects(
      () => jwt.verifyToken(foreign, { issuer: ISSUER }),
      (error) => error.code === 'invalid_token' && error.status === 401,
    );

    // 3. Unknown kid.
    const { jwt: other } = createEnvironment();
    const stranger = await other.issueToken({
      project_id: PROJECT_ID, key_id: KEY_ID, scopes: SCOPES, issuer: ISSUER,
    });
    await assert.rejects(
      () => jwt.verifyToken(stranger.access_token, { issuer: ISSUER }),
      (error) => error.code === 'invalid_token' && error.status === 401,
      'a token from another deployment (unknown kid) is rejected',
    );
  });

  // --------------------------------------------------------- invalid scope
  it('enforces middleware scope checks against the token scopes (403)', async function () {
    const { env, jwt } = createEnvironment();
    const issued = await jwt.issueToken({
      project_id: PROJECT_ID, key_id: KEY_ID, scopes: ['db:read'], issuer: ISSUER,
    });
    // GET with db:read passes.
    const readContext = authContext({ env, token: issued.access_token, method: 'GET', jwtAuth: jwt });
    const response = await modules.dbMiddleware.databaseAuthentication(readContext);
    assert.strictEqual(response.status, 200);
    // POST requires db:write — the middleware calls with the required scope.
    const writeContext = authContext({ env, token: issued.access_token, method: 'POST', jwtAuth: jwt });
    await assert.rejects(
      () => modules.developerAuth.authenticateDeveloperBearer(writeContext, { scope: 'db:write' }),
      (error) => error.code === 'api_key_scope_forbidden' && error.status === 403,
    );
  });

  // ------------------------------------------------------------ JWKS output
  it('publishes public keys only through the JWKS (no private material)', async function () {
    const { env, jwt } = createEnvironment();
    await jwt.issueToken({ project_id: PROJECT_ID, key_id: KEY_ID, scopes: SCOPES, issuer: ISSUER });
    const jwks = await jwt.publicJwks();
    assert.ok(Array.isArray(jwks.keys) && jwks.keys.length === 1);
    const [jwk] = jwks.keys;
    assert.strictEqual(jwk.kty, 'EC');
    assert.strictEqual(jwk.crv, 'P-256');
    assert.match(jwk.x, /^[A-Za-z0-9_-]+$/);
    assert.match(jwk.y, /^[A-Za-z0-9_-]+$/);
    assert.match(jwk.kid, /^kid_\d{6}$/);
    assert.strictEqual(jwk.alg, 'ES256');
    assert.strictEqual(jwk.use, 'sig');
    assert.deepStrictEqual(jwk.key_ops, ['verify']);
    assert.ok(!('d' in jwk), 'private scalar must never be published');

    // The HTTP route serves the same document publicly and cacheably.
    const response = await modules.jwksRoute.onRequestGet({ env });
    assert.strictEqual(response.status, 200);
    assert.match(response.headers.get('Cache-Control'), /public/);
    const body = await response.json();
    assert.deepStrictEqual(body, jwks);
    assert.ok(!JSON.stringify(body).includes('"d"'), 'route output contains no private members');
  });

  // ------------------------------------------------------------ key rotation
  it('rotates signing keys: old tokens verify, new tokens use the new kid, private material is purged', async function () {
    const { jwt, kv } = createEnvironment();
    const before = await jwt.issueToken({
      project_id: PROJECT_ID, key_id: KEY_ID, scopes: SCOPES, issuer: ISSUER,
    });
    const oldKid = decodeHeader(before.access_token).kid;

    const result = await jwt.rotateSigningKeys();
    assert.strictEqual(result.rotated, true);
    assert.notStrictEqual(result.current_kid, oldKid);
    assert.strictEqual(result.retired_kid, oldKid);
    assert.ok(!JSON.stringify(result).includes('private_jwk'), 'rotation response carries no key material');

    // 1. Outstanding tokens keep verifying against the retired public key.
    const oldAuth = await jwt.verifyToken(before.access_token, { issuer: ISSUER });
    assert.strictEqual(oldAuth.project_id, PROJECT_ID);

    // 2. New tokens are signed by the new kid.
    const after = await jwt.issueToken({
      project_id: PROJECT_ID, key_id: KEY_ID, scopes: SCOPES, issuer: ISSUER,
    });
    const newKid = decodeHeader(after.access_token).kid;
    assert.strictEqual(newKid, result.current_kid);
    assert.notStrictEqual(newKid, oldKid);

    // 3. The retired record no longer holds private material.
    const retiredRecord = JSON.parse(kv.snapshot(`tc:v1:jwt-signing-key:${oldKid}`).value);
    assert.strictEqual(retiredRecord.status, 'retired');
    assert.strictEqual(retiredRecord.private_jwk, null, 'private key purged on rotation');
    const currentRecord = JSON.parse(kv.snapshot(`tc:v1:jwt-signing-key:${newKid}`).value);
    assert.ok(currentRecord.private_jwk && currentRecord.private_jwk.d, 'current key keeps its private key in KV only');

    // 4. JWKS publishes both kids for the rotation window.
    const jwks = await jwt.publicJwks();
    assert.deepStrictEqual(jwks.keys.map((k) => k.kid).sort(), [oldKid, newKid].sort());
    assert.ok(jwks.keys.every((k) => !('d' in k)));

    // 5. A token signed by the purged private key of an unknown kid fails.
    const { jwt: stranger } = createEnvironment();
    const strangerToken = await stranger.issueToken({
      project_id: PROJECT_ID, key_id: KEY_ID, scopes: SCOPES, issuer: ISSUER,
    });
    await assert.rejects(
      () => jwt.verifyToken(strangerToken.access_token, { issuer: ISSUER }),
      (error) => error.code === 'invalid_token' && error.status === 401,
    );

    // 6. Rotation through the dashboard-gated route.
    const request = new Request('https://cloud.example/api/auth/keys/rotate', { method: 'POST' });
    const response = await modules.rotateRoute.onRequestPost({ request, env: {} });
    assert.strictEqual(response.status, 503, 'fails closed without dashboard credentials configured');
  });
});

function decodeClaims(token) {
  const segment = token.split('.')[1];
  let normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function toUnix(date) {
  return Math.floor(date.getTime() / 1000);
}

function b64urlJson(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeHeader(token) {
  return JSON.parse(atobToUtf8(token.split('.')[0]));
}

function atobToUtf8(segment) {
  let normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  return atob(normalized);
}

async function forgeWithForeignKey(_kv, { kid, claims }) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const encoder = new TextEncoder();
  function b64url(value) {
    const bytes = value instanceof Uint8Array ? value : encoder.encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  const signingInput = `${b64url({ alg: 'ES256', typ: 'JWT', kid })}.${b64url(claims)}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    pair.privateKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${b64url(new Uint8Array(signature))}`;
}
