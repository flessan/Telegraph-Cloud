const assert = require('assert');
const { createMockKV, makeContext, muteConsole } = require('./helpers');
const { canonicalQuery, cloneWithBody, signS3Request } = require('./s3-signing');

const S3_PEPPER = 'phase-six-b-s3-credential-pepper-that-is-at-least-thirty-two-bytes-long';
const ENDPOINT = 's3.example.test';
const AMZ_DATE = '20260913T080000Z';
const NOW = Date.parse('2026-09-13T08:00:00.000Z');

function fixedClock() {
  return new Date('2026-09-13T08:00:00.000Z');
}

function basicHeaders() {
  return { Authorization: `Basic ${Buffer.from('admin:secret').toString('base64')}` };
}

async function runPipeline(middlewares, route, context) {
  const handlers = [...middlewares, async () => route.onRequest(context)];
  let position = 0;
  context.next = () => handlers[position++](context);
  return context.next();
}

function withHeader(request, name, value, { body } = {}) {
  const headers = new Headers(request.headers);
  headers.set(name, value);
  return new Request(request.url, {
    method: request.method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

function mutateSignature(request, body) {
  const current = request.headers.get('authorization');
  const replacement = `${current.slice(0, -1)}${current.endsWith('a') ? 'b' : 'a'}`;
  return withHeader(request, 'authorization', replacement, body === undefined ? {} : { body });
}

describe('Telegraph Cloud Phase 6B S3 credentials and SigV4 verification', function () {
  let indexModule;
  let projectModule;
  let credentialModule;
  let sigv4;
  let s3Auth;
  let protocol;
  let projectMiddleware;
  let credentialIndexRoute;
  let credentialRoute;
  let credentialRotateRoute;
  let restoreConsole;

  before(async function () {
    indexModule = await import('../functions/cloud/index-store.js');
    projectModule = await import('../functions/cloud/project-registry.js');
    credentialModule = await import('../functions/cloud/s3-credentials.js');
    sigv4 = await import('../functions/cloud/s3-sigv4.js');
    s3Auth = await import('../functions/cloud/s3-auth.js');
    protocol = await import('../functions/cloud/s3-protocol.js');
    projectMiddleware = await import('../functions/api/projects/_middleware.js');
    credentialIndexRoute = await import('../functions/api/projects/[id]/s3-credentials/index.js');
    credentialRoute = await import('../functions/api/projects/[id]/s3-credentials/[accessKeyId].js');
    credentialRotateRoute = await import('../functions/api/projects/[id]/s3-credentials/[accessKeyId]/rotate.js');
  });

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    restoreConsole();
  });

  function fixture({ dashboard = false } = {}) {
    const kv = createMockKV();
    const env = {
      TELEGRAPH_CLOUD_KV: kv,
      TELEGRAPH_CLOUD_S3_CREDENTIAL_PEPPER: S3_PEPPER,
      TELEGRAPH_CLOUD_S3_ENDPOINT_HOST: ENDPOINT,
      ...(dashboard ? { BASIC_USER: 'admin', BASIC_PASS: 'secret' } : {}),
    };
    const index = indexModule.createCloudIndexStore(env);
    let projectNumber = 0;
    let randomSeed = 0;
    const projects = projectModule.createProjectRegistry(env, {
      index,
      now: fixedClock,
      createId(prefix) {
        projectNumber += 1;
        return `${prefix}${String(projectNumber).padStart(8, '0')}`;
      },
    });
    const credentials = credentialModule.createS3CredentialService(env, {
      index,
      projects,
      now: fixedClock,
      randomBytes(length) {
        const bytes = new Uint8Array(length);
        for (let offset = 0; offset < length; offset += 1) bytes[offset] = (randomSeed + offset) & 0xff;
        randomSeed += 37;
        return bytes;
      },
    });
    return { kv, env, index, projects, credentials };
  }

  async function initializedFixture(options) {
    const data = fixture(options);
    data.alpha = await data.projects.createProject({ slug: 'alpha', name: 'Alpha' });
    data.beta = await data.projects.createProject({ slug: 'beta', name: 'Beta' });
    return data;
  }

  async function authenticate(data, request) {
    return s3Auth.authenticateS3Request(request, data.env, {
      credentials: data.credentials,
      projects: data.projects,
      now: () => NOW,
    });
  }

  function signed(data, credential, { url = `https://${ENDPOINT}/s3/assets/object.txt`, method = 'GET', body, headers, amzDate = AMZ_DATE, region, service } = {}) {
    return signS3Request({
      url,
      method,
      accessKeyId: credential.credential.access_key_id,
      secretAccessKey: credential.secret_access_key,
      ...(body === undefined ? {} : { body }),
      ...(headers === undefined ? {} : { headers }),
      amzDate,
      ...(region === undefined ? {} : { region }),
      ...(service === undefined ? {} : { service }),
    });
  }

  it('stores only opaque S3 access-key metadata/verifier, supports direct bounded lookup, lifecycle, project isolation, and one-time secret output', async function () {
    const data = await initializedFixture();
    const created = await data.credentials.createCredential(data.alpha.project_id, {
      label: 'deploy bot',
      scopes: ['s3:write', 's3:read'],
    });
    assert.match(created.credential.access_key_id, /^tgsk_live_[A-Za-z0-9_-]{22}$/);
    assert.match(created.secret_access_key, /^[A-Za-z0-9_-]{43}$/);
    assert.deepStrictEqual(created.credential.scopes, ['s3:read', 's3:write']);
    assert.strictEqual(JSON.stringify(created.credential).includes(created.secret_access_key), false);

    const stored = JSON.parse(data.kv.snapshot(`tc:v1:s3-credential:${created.credential.access_key_id}`).value);
    assert.strictEqual(stored.secret_access_key, undefined);
    assert.strictEqual(stored.secret, undefined);
    assert.match(stored.verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(stored.fingerprint, stored.verifier.slice(0, 12));
    const persisted = data.kv.operations.put.map((entry) => `${entry.key}\n${entry.value}`).join('\n');
    assert.strictEqual(persisted.includes(created.secret_access_key), false, 'plaintext secret never reaches KV writes');
    assert.ok(data.kv.snapshot(`tc:v1:project-s3-credential:${data.alpha.project_id}:${created.credential.access_key_id}`));

    const listsBeforeLookup = data.kv.operations.list.length;
    const resolved = await data.credentials.resolveSigningCredential(created.credential.access_key_id);
    assert.strictEqual(data.kv.operations.list.length, listsBeforeLookup, 'SigV4 lookup does not scan a credential registry');
    assert.deepStrictEqual({
      accessKeyId: resolved.accessKeyId,
      projectId: resolved.projectId,
      scopes: [...resolved.scopes],
      secretAccessKey: resolved.secretAccessKey,
    }, {
      accessKeyId: created.credential.access_key_id,
      projectId: data.alpha.project_id,
      scopes: ['s3:read', 's3:write'],
      secretAccessKey: created.secret_access_key,
    });

    const credentialKey = `tc:v1:s3-credential:${created.credential.access_key_id}`;
    const tampered = { ...stored, project_id: data.beta.project_id };
    await data.kv.put(credentialKey, JSON.stringify(tampered));
    await assert.rejects(
      () => data.credentials.resolveSigningCredential(created.credential.access_key_id),
      (error) => error?.status === 503 && error.code === 'cloud_s3_credential_invalid_record',
      'authorization-relevant metadata is bound by the persisted verifier',
    );
    await assert.rejects(
      () => authenticate(data, signed(data, created)),
      (error) => error?.s3Code === 'InvalidAccessKeyId',
      'the public S3 surface maps an invalid verifier to a safe non-oracular denial',
    );
    await data.kv.put(credentialKey, JSON.stringify(stored));

    await data.credentials.markUsed(created.credential.access_key_id);
    const listed = await data.credentials.listCredentials(data.alpha.project_id);
    assert.strictEqual(listed.data.length, 1);
    assert.strictEqual(listed.data[0].last_used_at, '2026-09-13T08:00:00.000Z');
    assert.strictEqual(JSON.stringify(listed).includes(created.secret_access_key), false, 'list responses are never a second secret reveal');

    const second = await data.credentials.createCredential(data.alpha.project_id, { label: 'page two' });
    const firstPage = await data.credentials.listCredentials(data.alpha.project_id, { limit: 1 });
    assert.strictEqual(firstPage.data.length, 1);
    assert.strictEqual(firstPage.has_more, true);
    assert.ok(firstPage.next_cursor);
    const secondPage = await data.credentials.listCredentials(data.alpha.project_id, { limit: 1, cursor: firstPage.next_cursor });
    assert.strictEqual(secondPage.data.length, 1);
    assert.notStrictEqual(secondPage.data[0].access_key_id, firstPage.data[0].access_key_id);
    assert.ok([created.credential.access_key_id, second.credential.access_key_id].includes(secondPage.data[0].access_key_id));
    const tamperedCursor = `${firstPage.next_cursor.slice(0, -1)}${firstPage.next_cursor.endsWith('a') ? 'b' : 'a'}`;
    await assert.rejects(
      () => data.credentials.listCredentials(data.alpha.project_id, { limit: 1, cursor: tamperedCursor }),
      (error) => error?.status === 400 && error.code === 'invalid_s3_credential_cursor',
    );
    await assert.rejects(
      () => data.credentials.listCredentials(data.beta.project_id, { limit: 1, cursor: firstPage.next_cursor }),
      (error) => error?.status === 400 && error.code === 'invalid_s3_credential_cursor',
      'opaque list cursors are authenticated and project-bound',
    );

    // The outer HMAC wrapper has its own bounded wire ceiling rather than
    // accidentally rejecting an otherwise valid near-limit inner KV cursor
    // after base64url expansion.
    const innerCursor = 'c'.repeat(900);
    let listInvocation = 0;
    let continuedWith;
    const cursorIndex = {
      key: (...args) => data.index.key(...args),
      getJson: (...args) => data.index.getJson(...args),
      putJson: (...args) => data.index.putJson(...args),
      remove: (...args) => data.index.remove(...args),
      async list(_namespace, options) {
        listInvocation += 1;
        if (listInvocation === 1) {
          assert.strictEqual(options.cursor, undefined);
          return { keys: [], list_complete: false, cursor: innerCursor };
        }
        continuedWith = options.cursor;
        return { keys: [], list_complete: true, cursor: undefined };
      },
    };
    const cursorCredentials = credentialModule.createS3CredentialService(data.env, {
      index: cursorIndex,
      projects: data.projects,
      now: fixedClock,
    });
    const longCursorPage = await cursorCredentials.listCredentials(data.alpha.project_id, { limit: 1 });
    assert.ok(Buffer.byteLength(longCursorPage.next_cursor) > 1024);
    assert.ok(Buffer.byteLength(longCursorPage.next_cursor) <= 2048);
    await cursorCredentials.listCredentials(data.alpha.project_id, { limit: 1, cursor: longCursorPage.next_cursor });
    assert.strictEqual(continuedWith, innerCursor);

    await assert.rejects(
      () => data.credentials.revokeCredential(data.beta.project_id, created.credential.access_key_id),
      (error) => error?.status === 404 && error.code === 's3_credential_not_found',
    );
    const replacement = await data.credentials.rotateCredential(data.alpha.project_id, created.credential.access_key_id, { label: 'rotated bot' });
    assert.notStrictEqual(replacement.credential.access_key_id, created.credential.access_key_id);
    assert.notStrictEqual(replacement.secret_access_key, created.secret_access_key);
    assert.strictEqual(replacement.credential.rotated_from, created.credential.access_key_id);
    assert.strictEqual(await data.credentials.resolveSigningCredential(created.credential.access_key_id), null, 'rotation revokes the old signing identity');
    assert.strictEqual((await data.credentials.resolveSigningCredential(replacement.credential.access_key_id)).projectId, data.alpha.project_id);

    const revoked = await data.credentials.revokeCredential(data.alpha.project_id, replacement.credential.access_key_id);
    assert.strictEqual(revoked.status, 'revoked');
    assert.strictEqual(await data.credentials.resolveSigningCredential(replacement.credential.access_key_id), null);
    await assert.rejects(
      () => authenticate(data, signed(data, replacement)),
      (error) => error?.s3Code === 'InvalidAccessKeyId',
      'a revoked credential cannot reach signature verification or project routing',
    );
  });

  it('fails closed without the dedicated S3 pepper while retaining safe bounded metadata listing where possible', async function () {
    const data = await initializedFixture();
    const created = await data.credentials.createCredential(data.alpha.project_id);
    const noPepperEnv = { ...data.env };
    delete noPepperEnv.TELEGRAPH_CLOUD_S3_CREDENTIAL_PEPPER;
    const noPepperCredentials = credentialModule.createS3CredentialService(noPepperEnv, {
      index: data.index,
      projects: data.projects,
      now: fixedClock,
    });

    await assert.rejects(
      () => noPepperCredentials.createCredential(data.alpha.project_id),
      (error) => error?.status === 503 && error.code === 's3_credential_pepper_unavailable',
    );
    await assert.rejects(
      () => noPepperCredentials.rotateCredential(data.alpha.project_id, created.credential.access_key_id),
      (error) => error?.status === 503 && error.code === 's3_credential_pepper_unavailable',
    );
    await assert.rejects(
      () => s3Auth.authenticateS3Request(signed(data, created), noPepperEnv, {
        credentials: noPepperCredentials,
        projects: data.projects,
        now: () => NOW,
      }),
      (error) => error?.status === 503,
      'a fresh Worker/auth service cannot derive or verify a signing secret without its pepper',
    );
    const listed = await noPepperCredentials.listCredentials(data.alpha.project_id);
    assert.strictEqual(listed.data.length, 1, 'safe one-page metadata listing does not reveal or derive a secret');
    assert.strictEqual(JSON.stringify(listed).includes(created.secret_access_key), false);
  });

  it('exposes create/list/revoke/rotate only through dashboard-authenticated project routes', async function () {
    const data = await initializedFixture({ dashboard: true });
    const routeData = { projectRegistry: data.projects, s3Credentials: data.credentials };
    const contextFor = ({ url, method, body, headers = basicHeaders(), params, route }) => makeContext({
      request: new Request(url, {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env: data.env,
      params,
      data: { ...routeData },
      next: async () => route.onRequest(),
    });
    const base = `https://dashboard.example.test/api/projects/${data.alpha.project_id}/s3-credentials`;

    const createdResponse = await runPipeline(projectMiddleware.onRequest, credentialIndexRoute, contextFor({
      url: base,
      method: 'POST',
      body: { label: 'dashboard credential', scopes: ['s3:read'] },
      params: { id: data.alpha.project_id },
      route: credentialIndexRoute,
    }));
    assert.strictEqual(createdResponse.status, 201);
    const created = await createdResponse.json();
    assert.match(created.secret_access_key, /^[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(created.credential.scopes[0], 's3:read');
    assert.strictEqual(createdResponse.headers.get('Cache-Control'), 'no-store');

    const listedResponse = await runPipeline(projectMiddleware.onRequest, credentialIndexRoute, contextFor({
      url: `${base}?limit=10`,
      method: 'GET',
      params: { id: data.alpha.project_id },
      route: credentialIndexRoute,
    }));
    assert.strictEqual(listedResponse.status, 200);
    const listed = await listedResponse.json();
    assert.strictEqual(listed.data.length, 1);
    assert.strictEqual(JSON.stringify(listed).includes(created.secret_access_key), false);

    const rotatedResponse = await runPipeline(projectMiddleware.onRequest, credentialRotateRoute, contextFor({
      url: `${base}/${encodeURIComponent(created.credential.access_key_id)}/rotate`,
      method: 'POST',
      body: { label: 'rotated dashboard credential' },
      params: { id: data.alpha.project_id, accessKeyId: created.credential.access_key_id },
      route: credentialRotateRoute,
    }));
    assert.strictEqual(rotatedResponse.status, 201);
    const replacement = await rotatedResponse.json();
    assert.match(replacement.secret_access_key, /^[A-Za-z0-9_-]{43}$/);

    const revokedResponse = await runPipeline(projectMiddleware.onRequest, credentialRoute, contextFor({
      url: `${base}/${encodeURIComponent(replacement.credential.access_key_id)}`,
      method: 'DELETE',
      params: { id: data.alpha.project_id, accessKeyId: replacement.credential.access_key_id },
      route: credentialRoute,
    }));
    assert.strictEqual(revokedResponse.status, 200);
    assert.strictEqual((await revokedResponse.json()).status, 'revoked');

    const developerAttempt = await runPipeline(projectMiddleware.onRequest, credentialIndexRoute, contextFor({
      url: base,
      method: 'GET',
      headers: { Authorization: 'Bearer tg_live_key_not_dashboard_auth' },
      params: { id: data.alpha.project_id },
      route: credentialIndexRoute,
    }));
    assert.strictEqual(developerAttempt.status, 401);
    const s3Attempt = await runPipeline(projectMiddleware.onRequest, credentialIndexRoute, contextFor({
      url: base,
      method: 'GET',
      headers: { Authorization: 'AWS4-HMAC-SHA256 Credential=tgsk_live_aaaaaaaaaaaaaaaaaaaaaa/20260913/us-east-1/s3/aws4_request, SignedHeaders=host, Signature=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      params: { id: data.alpha.project_id },
      route: credentialIndexRoute,
    }));
    assert.strictEqual(s3Attempt.status, 401);
  });

  it('matches the published S3 HMAC fixture and authenticates strict raw URI/query/header canonicalization with native Web Crypto verification', async function () {
    const official = signS3Request({
      url: 'https://examplebucket.s3.amazonaws.com/test.txt',
      method: 'GET',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      headers: { Range: 'bytes=0-9' },
      amzDate: '20130524T000000Z',
    });
    assert.strictEqual(official.headers.get('authorization'), 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
    await sigv4.verifyS3SigV4Request(official, {
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      env: { TELEGRAPH_CLOUD_S3_ENDPOINT_HOST: 'examplebucket.s3.amazonaws.com' },
      now: () => Date.parse('2013-05-24T00:00:00.000Z'),
    });

    const data = await initializedFixture();
    const credential = await data.credentials.createCredential(data.alpha.project_id, { scopes: ['s3:read', 's3:write'] });
    const url = `https://${ENDPOINT}/s3/assets/repeated//plus%2B%20snow%E2%98%83?z=&a=two&a=one&literal+plus=%2B&unicode=%E2%98%83`;
    assert.strictEqual(canonicalQuery(url), 'a=one&a=two&literal%2Bplus=%2B&unicode=%E2%98%83&z=');
    assert.strictEqual(sigv4.canonicalS3Query(sigv4.parseS3RawQuery(new Request(url))), canonicalQuery(url));
    const encodedQuery = `https://${ENDPOINT}/s3/assets/object.txt?equals==&encoded%26name=value%3Dpart&literal+plus=%2B`;
    assert.strictEqual(sigv4.canonicalS3Query(encodedQuery), 'encoded%26name=value%3Dpart&equals=%3D&literal%2Bplus=%2B');
    assert.strictEqual(sigv4.canonicalS3Uri(new URL(url)), '/s3/assets/repeated//plus%2B%20snow%E2%98%83');
    const encodedPath = `https://${ENDPOINT}/s3/assets/space%20plus+%26equals%3D`;
    assert.strictEqual(sigv4.canonicalS3Uri(encodedPath), '/s3/assets/space%20plus+%26equals%3D');
    assert.deepStrictEqual(protocol.s3TargetFromRequest(new Request(encodedPath)), {
      bucket: 'assets', key: 'space plus+&equals=', hasKey: true,
    });
    assert.strictEqual(protocol.safeS3Resource(protocol.s3TargetFromRequest(new Request(`https://${ENDPOINT}/s3/assets/empty//segment`))), null,
      'empty object-key path segments remain invalid even though the signed URI retains repeated slashes');
    const request = signed(data, credential, { url });
    const authenticated = await authenticate(data, request);
    assert.deepStrictEqual({
      authentication: authenticated.authentication,
      projectId: authenticated.projectId,
      scopes: [...authenticated.scopes],
    }, {
      authentication: 's3_sigv4',
      projectId: data.alpha.project_id,
      scopes: ['s3:read', 's3:write'],
    });
    await authenticate(data, signed(data, credential, {
      method: 'PUT',
      body: new Uint8Array([0x00, 0x01, 0x20, 0x2b, 0xff]),
      headers: { 'Content-Type': 'application/octet-stream' },
    }));

    let nativeVerifyCalls = 0;
    const nativeSubtle = globalThis.crypto.subtle;
    const cryptoApi = {
      subtle: {
        digest: nativeSubtle.digest.bind(nativeSubtle),
        importKey: nativeSubtle.importKey.bind(nativeSubtle),
        sign: nativeSubtle.sign.bind(nativeSubtle),
        verify(...args) {
          nativeVerifyCalls += 1;
          return nativeSubtle.verify(...args);
        },
      },
    };
    await sigv4.verifyS3SigV4Request(request, {
      accessKeyId: credential.credential.access_key_id,
      secretAccessKey: credential.secret_access_key,
      env: data.env,
      cryptoApi,
      now: () => NOW,
    });
    assert.ok(nativeVerifyCalls > 0, 'the final signature comparison delegates to Web Crypto subtle.verify');

    const whitespaceHeaderRequest = signed(data, credential, {
      headers: { 'X-Canonical-Test': ' alpha\t beta   gamma ' },
    });
    await authenticate(data, whitespaceHeaderRequest);
    const coalescedHeaders = new Headers(whitespaceHeaderRequest.headers);
    coalescedHeaders.append('x-canonical-test', 'second-value');
    const coalescedSignedHeader = new Request(whitespaceHeaderRequest.url, { headers: coalescedHeaders });
    await assert.rejects(() => authenticate(data, coalescedSignedHeader), (error) => error?.s3Code === 'AuthorizationHeaderMalformed');

    const trailingPath = `https://${ENDPOINT}/s3/assets/trailing/`;
    assert.strictEqual(sigv4.canonicalS3Uri(trailingPath), '/s3/assets/trailing/');
    await authenticate(data, signed(data, credential, { url: trailingPath }));
  });

  it('fails closed for one-byte payload/header/query/signature tampering, skew, unsignable controls, and malformed authorization', async function () {
    const data = await initializedFixture();
    const credential = await data.credentials.createCredential(data.alpha.project_id);
    const bodyRequest = signed(data, credential, {
      method: 'PUT',
      body: 'exact-body',
      headers: { 'Content-Type': 'text/plain' },
    });
    await assert.rejects(
      () => authenticate(data, cloneWithBody(bodyRequest, 'exact-bodx')),
      (error) => error?.s3Code === 'XAmzContentSHA256Mismatch',
      'a one-byte received-body mutation must fail before object storage can read it',
    );
    await assert.rejects(
      () => authenticate(data, mutateSignature(bodyRequest, 'exact-body')),
      (error) => error?.s3Code === 'SignatureDoesNotMatch',
    );
    await assert.rejects(
      () => authenticate(data, withHeader(bodyRequest, 'Content-Type', 'application/octet-stream', { body: 'exact-body' })),
      (error) => error?.s3Code === 'SignatureDoesNotMatch',
    );
    await assert.rejects(
      () => authenticate(data, withHeader(bodyRequest, 'x-amz-content-sha256', '0'.repeat(64), { body: 'exact-body' })),
      (error) => error?.s3Code === 'XAmzContentSHA256Mismatch',
    );
    const signedGet = signed(data, credential);
    await assert.rejects(
      () => authenticate(data, new Request(signedGet.url, { method: 'HEAD', headers: new Headers(signedGet.headers) })),
      (error) => error?.s3Code === 'SignatureDoesNotMatch',
      'changing a signed HTTP method changes the canonical request',
    );
    await assert.rejects(
      () => authenticate(data, new Request(`https://${ENDPOINT}/s3/assets/other.txt`, { headers: new Headers(signedGet.headers) })),
      (error) => error?.s3Code === 'SignatureDoesNotMatch',
      'changing a signed URI changes the canonical request',
    );
    const unknownAccessKeyId = `tgsk_live_${'z'.repeat(22)}`;
    await assert.rejects(
      () => authenticate(data, withHeader(signedGet, 'Authorization', signedGet.headers.get('authorization').replace(credential.credential.access_key_id, unknownAccessKeyId))),
      (error) => error?.s3Code === 'InvalidAccessKeyId',
    );
    await assert.rejects(
      () => authenticate(data, withHeader(bodyRequest, 'x-amz-content-sha256', 'UNSIGNED-PAYLOAD', { body: 'exact-body' })),
      (error) => error?.s3Code === 'InvalidRequest',
    );
    await assert.rejects(
      () => authenticate(data, signed(data, credential, {
        method: 'PUT', body: 'exact-body', headers: { 'Content-Type': 'text/plain', 'Content-Encoding': 'gzip' },
      })),
      (error) => error?.s3Code === 'InvalidRequest',
      'the narrow adapter does not accept a second encoded body representation',
    );

    const queryRequest = signed(data, credential, { url: `https://${ENDPOINT}/s3/assets/object.txt?empty=&a=one&a=two` });
    const changedQuery = new Request(`https://${ENDPOINT}/s3/assets/object.txt?empty=&a=one&a=three`, {
      headers: new Headers(queryRequest.headers),
    });
    await assert.rejects(() => authenticate(data, changedQuery), (error) => error?.s3Code === 'SignatureDoesNotMatch');
    const presignedStyle = signed(data, credential, { url: `https://${ENDPOINT}/s3/assets/object.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256` });
    await assert.rejects(() => authenticate(data, presignedStyle), (error) => error?.s3Code === 'InvalidRequest');

    const unsignedSemantic = withHeader(signed(data, credential), 'Range', 'bytes=0-1');
    await assert.rejects(() => authenticate(data, unsignedSemantic), (error) => error?.s3Code === 'InvalidRequest');
    const wrongRegion = signed(data, credential, { region: 'ap-southeast-1' });
    await assert.rejects(() => authenticate(data, wrongRegion), (error) => error?.s3Code === 'AuthorizationHeaderMalformed');
    const wrongService = signed(data, credential, { service: 'execute-api' });
    await assert.rejects(() => authenticate(data, wrongService), (error) => error?.s3Code === 'AuthorizationHeaderMalformed');
    const wrongScopeDate = withHeader(signedGet, 'Authorization', signedGet.headers.get('authorization').replace('/20260913/us-east-1/', '/20260912/us-east-1/'));
    await assert.rejects(() => authenticate(data, wrongScopeDate), (error) => error?.s3Code === 'AuthorizationHeaderMalformed');
    const stale = signed(data, credential, { amzDate: '20260912T080000Z' });
    await assert.rejects(() => authenticate(data, stale), (error) => error?.s3Code === 'RequestTimeTooSkewed');
    const future = signed(data, credential, { amzDate: '20260914T080000Z' });
    await assert.rejects(() => authenticate(data, future), (error) => error?.s3Code === 'RequestTimeTooSkewed');

    const malformed = withHeader(signed(data, credential), 'Authorization', `${signed(data, credential).headers.get('authorization')}, duplicate`);
    await assert.rejects(() => authenticate(data, malformed), (error) => error?.s3Code === 'AuthorizationHeaderMalformed');
    const repeatedAuthorizationHeaders = new Headers(signedGet.headers);
    repeatedAuthorizationHeaders.append('authorization', signedGet.headers.get('authorization'));
    await assert.rejects(
      () => authenticate(data, new Request(signedGet.url, { headers: repeatedAuthorizationHeaders })),
      (error) => error?.s3Code === 'AuthorizationHeaderMalformed',
      'a Fetch-coalesced duplicate Authorization field cannot select a signing identity',
    );
    const repeatedAmzHeaders = new Headers(signedGet.headers);
    repeatedAmzHeaders.append('x-amz-date', AMZ_DATE);
    await assert.rejects(
      () => authenticate(data, new Request(signedGet.url, { headers: repeatedAmzHeaders })),
      (error) => error?.s3Code === 'AuthorizationHeaderMalformed',
      'a Fetch-coalesced duplicate security-sensitive x-amz header fails closed',
    );
    const wrongHost = new Request(`https://other.example.test/s3/assets/object.txt`, {
      headers: new Headers(signed(data, credential).headers),
    });
    await assert.rejects(() => authenticate(data, wrongHost), (error) => error?.s3Code === 'AuthorizationHeaderMalformed');
  });

  it('binds project/scopes only to verified credential metadata and handles configured alternate/default ports plus raw target safety', async function () {
    const data = await initializedFixture();
    const alphaCredential = await data.credentials.createCredential(data.alpha.project_id, { scopes: ['s3:read'] });
    const betaCredential = await data.credentials.createCredential(data.beta.project_id, { scopes: ['s3:write'] });
    const alphaAuth = await authenticate(data, signed(data, alphaCredential));
    const betaAuth = await authenticate(data, signed(data, betaCredential, { method: 'PUT', body: 'beta', headers: { 'Content-Type': 'text/plain' } }));
    assert.strictEqual(alphaAuth.projectId, data.alpha.project_id);
    assert.deepStrictEqual([...alphaAuth.scopes], ['s3:read']);
    assert.strictEqual(betaAuth.projectId, data.beta.project_id);
    assert.deepStrictEqual([...betaAuth.scopes], ['s3:write']);

    const callerProjectHint = signed(data, alphaCredential, { url: `https://${ENDPOINT}/s3/assets/object.txt?project_id=${data.beta.project_id}` });
    await assert.rejects(() => authenticate(data, callerProjectHint), (error) => error?.s3Code === 'InvalidRequest');
    await data.projects.updateProject(data.alpha.project_id, { status: 'disabled' });
    await assert.rejects(() => authenticate(data, signed(data, alphaCredential)), (error) => error?.s3Code === 'AccessDenied');

    const alternateUrl = 'https://s3.example.test:8443/s3/assets/object.txt';
    const alternateRequest = signed(data, betaCredential, {
      url: alternateUrl,
      method: 'PUT',
      body: 'port',
      headers: { 'Content-Type': 'text/plain' },
    });
    await sigv4.verifyS3SigV4Request(alternateRequest, {
      accessKeyId: betaCredential.credential.access_key_id,
      secretAccessKey: betaCredential.secret_access_key,
      env: { ...data.env, TELEGRAPH_CLOUD_S3_ENDPOINT_HOST: 's3.example.test:8443' },
      now: () => NOW,
    });
    const defaultPortRequest = signed(data, betaCredential);
    await sigv4.verifyS3SigV4Request(defaultPortRequest, {
      accessKeyId: betaCredential.credential.access_key_id,
      secretAccessKey: betaCredential.secret_access_key,
      env: { ...data.env, TELEGRAPH_CLOUD_S3_ENDPOINT_HOST: 's3.example.test:443' },
      now: () => NOW,
    });

    assert.deepStrictEqual(protocol.s3TargetFromRequest(new Request(`https://${ENDPOINT}/s3/assets/literal+plus%20snow%E2%98%83`)), {
      bucket: 'assets', key: 'literal+plus snow☃', hasKey: true,
    });
    assert.strictEqual(protocol.s3TargetFromRequest(new Request(`https://${ENDPOINT}/s3/assets/encoded%2Fslash`)).bucket, null);
    assert.strictEqual(protocol.s3TargetFromRequest(new Request(`https://${ENDPOINT}/s3/assets/%zz`)).bucket, null);
    assert.throws(
      () => sigv4.canonicalS3Uri(`https://${ENDPOINT}/s3/assets/%FF`),
      (error) => error?.s3Code === 'InvalidRequest',
      'invalid UTF-8 cannot authenticate under an alternate raw-path representation',
    );
  });
});
