#!/usr/bin/env node
'use strict';

/*
 * Deliberately opt-in, destructive-in-a-bounded-way release smoke for a
 * separately authorized staging/production Pages deployment. It creates two
 * temporary Telegraph Cloud projects and immutable Telegram-backed test data.
 * Cleanup attempts to tombstone a known test object, revokes known credentials,
 * and logically deletes known projects, but cannot promise physical Telegram/KV
 * erasure or recovery of an unreturned credential after a network failure.
 *
 * It never prints control-plane response bodies, project IDs, access keys,
 * authorization headers, secrets, payload hashes, signatures, or object paths.
 */

const { createHash, createHmac, randomBytes } = require('crypto');

const CONFIRMATION = 'I_UNDERSTAND_THIS_WRITES_TELEGRAM';
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('missing required smoke configuration');
  }
  return value;
}

function safeBaseUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    throw new Error('invalid smoke target');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('invalid smoke target');
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !local) throw new Error('smoke target must use HTTPS');
  return url.origin + url.pathname.replace(/\/$/, '');
}

function bytes(value) {
  if (value === undefined || value === null) return Buffer.alloc(0);
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function awsEncode(value) {
  return Array.from(Buffer.from(value, 'utf8'), (byte) => {
    const character = String.fromCharCode(byte);
    return /[A-Za-z0-9\-_.~]/.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

function canonicalQuery(target) {
  const raw = target.search.slice(1);
  if (!raw) return '';
  return raw.split('&').map((part) => {
    const split = part.indexOf('=');
    const name = split < 0 ? part : part.slice(0, split);
    const value = split < 0 ? '' : part.slice(split + 1);
    return [awsEncode(decodeURIComponent(name)), awsEncode(decodeURIComponent(value))];
  }).sort((left, right) => (
    left[0] === right[0]
      ? (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0)
      : (left[0] < right[0] ? -1 : 1)
  )).map(([name, value]) => `${name}=${value}`).join('&');
}

function normalizeHeader(value) {
  return String(value).trim().replace(/[ \t]+/g, ' ');
}

function isoAmzDate() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Create a header-form AWS4-HMAC-SHA256 request without logging its material. */
function signedHeaders({ url, method, accessKeyId, secretAccessKey, body, headers = {} }) {
  const target = new URL(url);
  const payload = bytes(body);
  const signed = new Headers(headers);
  const amzDate = isoAmzDate();
  signed.set('host', target.host);
  signed.set('x-amz-date', amzDate);
  signed.set('x-amz-content-sha256', sha256(payload));

  const names = Array.from(signed.keys()).map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = names.map((name) => `${name}:${normalizeHeader(signed.get(name))}\n`).join('');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/us-east-1/s3/aws4_request`;
  const canonicalRequest = `${method}\n${target.pathname}\n${canonicalQuery(target)}\n${canonicalHeaders}\n${names.join(';')}\n${sha256(payload)}`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;

  let signingKey = hmac(Buffer.from(`AWS4${secretAccessKey}`, 'utf8'), dateStamp);
  signingKey = hmac(signingKey, 'us-east-1');
  signingKey = hmac(signingKey, 's3');
  signingKey = hmac(signingKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  signed.set('authorization', `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`);
  return signed;
}

function assertCondition(condition, step) {
  if (!condition) throw new Error(`staged smoke failed at ${step}`);
}

function report(step) {
  // Every line is a fixed description; never interpolate URLs, IDs, values,
  // payloads, headers, or caught errors into stdout/stderr.
  process.stdout.write(`[phase6c] ${step}\n`);
}

function xmlCode(body, code) {
  return new RegExp(`<Code>${code}</Code>`).test(body);
}

async function responseJson(response, expectedStatus, step) {
  assertCondition(response.status === expectedStatus, step);
  let value;
  try {
    value = await response.json();
  } catch (_) {
    throw new Error(`staged smoke failed at ${step}`);
  }
  assertCondition(value && typeof value === 'object', step);
  return value;
}

async function controlRequest(state, path, { method = 'GET', body, expectedStatus = 200, step } = {}) {
  const headers = new Headers({
    Authorization: state.dashboardAuthorization,
    Accept: 'application/json',
  });
  const init = { method, headers };
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`${state.baseUrl}${path}`, init);
  } catch (_) {
    throw new Error(`staged smoke failed at ${step}`);
  }
  return responseJson(response, expectedStatus, step);
}

async function s3Request(state, credential, path, {
  method = 'GET',
  body,
  headers = {},
  expectedStatus,
  expectedBody,
  expectedXmlCode,
  step,
} = {}) {
  const url = `${state.baseUrl}${path}`;
  const payload = body === undefined ? undefined : bytes(body);
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: signedHeaders({
        url,
        method,
        accessKeyId: credential.accessKeyId,
        secretAccessKey: credential.secretAccessKey,
        body: payload,
        headers,
      }),
      ...(payload === undefined ? {} : { body: payload }),
    });
  } catch (_) {
    throw new Error(`staged smoke failed at ${step}`);
  }
  assertCondition(response.status === expectedStatus, step);
  if (expectedBody !== undefined) {
    assertCondition(await response.text() === expectedBody, step);
  } else if (expectedXmlCode) {
    assertCondition(xmlCode(await response.text(), expectedXmlCode), step);
  } else {
    // Drain a response without printing it. S3 responses can contain object
    // metadata, so a smoke must never copy the body to terminal output.
    await response.arrayBuffer();
  }
}

async function createProject(state, suffix, label) {
  const result = await controlRequest(state, '/api/projects', {
    method: 'POST',
    body: { slug: `phase6c-${suffix}-${label}`, name: 'Phase 6C staged smoke' },
    expectedStatus: 201,
    step: `create-${label}-project`,
  });
  assertCondition(typeof result.project_id === 'string' && result.project_id.length > 0, `create-${label}-project`);
  const project = { id: result.project_id, deleted: false };
  state.projects.push(project);
  return project;
}

async function createCredential(state, project, label) {
  const result = await controlRequest(state, `/api/projects/${encodeURIComponent(project.id)}/s3-credentials`, {
    method: 'POST',
    body: { label: `phase6c-${label}`, scopes: ['s3:read', 's3:write'] },
    expectedStatus: 201,
    step: `create-${label}-credential`,
  });
  assertCondition(typeof result?.credential?.access_key_id === 'string'
    && typeof result?.secret_access_key === 'string', `create-${label}-credential`);
  const credential = {
    project,
    accessKeyId: result.credential.access_key_id,
    secretAccessKey: result.secret_access_key,
    revoked: false,
  };
  state.credentials.push(credential);
  return credential;
}

async function rotateCredential(state, credential) {
  const result = await controlRequest(state, `/api/projects/${encodeURIComponent(credential.project.id)}/s3-credentials/${encodeURIComponent(credential.accessKeyId)}/rotate`, {
    method: 'POST',
    body: { label: 'phase6c-replacement', scopes: ['s3:read', 's3:write'] },
    expectedStatus: 201,
    step: 'rotate-credential',
  });
  assertCondition(typeof result?.credential?.access_key_id === 'string'
    && typeof result?.secret_access_key === 'string', 'rotate-credential');
  credential.revoked = true;
  const replacement = {
    project: credential.project,
    accessKeyId: result.credential.access_key_id,
    secretAccessKey: result.secret_access_key,
    revoked: false,
  };
  state.credentials.push(replacement);
  return replacement;
}

async function revokeCredential(state, credential, step = 'revoke-credential') {
  if (!credential || credential.revoked) return;
  const result = await controlRequest(state, `/api/projects/${encodeURIComponent(credential.project.id)}/s3-credentials/${encodeURIComponent(credential.accessKeyId)}`, {
    method: 'DELETE',
    expectedStatus: 200,
    step,
  });
  assertCondition(result.status === 'revoked', step);
  credential.revoked = true;
}

async function deleteProject(state, project, step = 'delete-project') {
  if (!project || project.deleted) return;
  await controlRequest(state, `/api/projects/${encodeURIComponent(project.id)}`, {
    method: 'DELETE',
    expectedStatus: 200,
    step,
  });
  project.deleted = true;
}

async function bestEffortDeleteObject(state) {
  const object = state.object;
  if (!object?.mayExist || object.deleted) return true;
  // Prefer the most recently issued still-known active credential. A failed
  // rotate response can leave an unreturned replacement secret, in which case
  // this cannot promise cleanup; operators must inspect safe metadata instead.
  const credential = [...state.credentials].reverse().find((entry) => (
    entry.project === object.project && !entry.revoked && !entry.project.deleted
  ));
  if (!credential) return false;
  const url = `${state.baseUrl}${object.path}`;
  try {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: signedHeaders({
        url,
        method: 'DELETE',
        accessKeyId: credential.accessKeyId,
        secretAccessKey: credential.secretAccessKey,
        headers: { 'idempotency-key': object.cleanupIdempotencyKey },
      }),
    });
    // Never print a cleanup response: it can contain object metadata. A 204
    // proves the logical tombstone operation; a 404 means no visible object.
    await response.arrayBuffer();
    if (response.status === 204 || response.status === 404) object.deleted = true;
    return object.deleted;
  } catch (_) {
    return false;
  }
}

async function bestEffortCleanup(state) {
  // Do not echo errors from cleanup; a provider error can contain sensitive
  // request information. A failed cleanup is signalled by the final generic
  // result and must be inspected through authenticated control-plane metadata.
  let complete = await bestEffortDeleteObject(state);
  for (const credential of state.credentials) {
    try {
      await revokeCredential(state, credential, 'cleanup-revoke-credential');
    } catch (_) {
      complete = false;
    }
  }
  for (const project of state.projects) {
    try {
      await deleteProject(state, project, 'cleanup-delete-project');
    } catch (_) {
      complete = false;
    }
  }
  return complete;
}

async function main() {
  if (process.env.TELEGRAPH_CLOUD_SMOKE_CONFIRM !== CONFIRMATION) {
    throw new Error('staged smoke confirmation is required');
  }
  const baseUrl = safeBaseUrl(requiredEnvironment('TELEGRAPH_CLOUD_SMOKE_BASE_URL'));
  const user = requiredEnvironment('TELEGRAPH_CLOUD_SMOKE_DASHBOARD_USER');
  const pass = requiredEnvironment('TELEGRAPH_CLOUD_SMOKE_DASHBOARD_PASS');
  const state = {
    baseUrl,
    dashboardAuthorization: `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`,
    projects: [],
    credentials: [],
  };
  const suffix = randomBytes(8).toString('hex');
  const bucket = `phase6c${suffix.slice(0, 12)}`;
  const key = `release-smoke-${suffix}.txt`;
  const objectPath = `/s3/${bucket}/${key}`;
  const listPath = `/s3/${bucket}?list-type=2`;
  const payload = Buffer.from('phase6c-staged-smoke-payload', 'utf8');
  state.object = {
    path: objectPath,
    project: null,
    cleanupIdempotencyKey: `phase6c-${suffix}-cleanup-delete`,
    mayExist: false,
    deleted: false,
  };

  let cleanupComplete = false;
  try {
    report('checking public health');
    const health = await controlRequest(state, '/api/health', { step: 'public-health' });
    assertCondition(health.status === 'ok', 'public-health');

    report('checking authenticated non-mutating readiness');
    const readiness = await controlRequest(state, '/api/projects/diagnostics', { step: 'operator-readiness' });
    assertCondition(readiness.status === 'ready_for_smoke', 'operator-readiness');
    const telegramProbe = await controlRequest(state, '/api/projects/diagnostics?probe=telegram', { step: 'telegram-probe' });
    assertCondition(telegramProbe.status === 'ready_for_smoke'
      && telegramProbe?.checks?.telegram_api === 'reachable', 'telegram-probe');

    const primaryProject = await createProject(state, suffix, 'primary');
    const isolatedProject = await createProject(state, suffix, 'isolated');
    const primary = await createCredential(state, primaryProject, 'primary');
    const isolated = await createCredential(state, isolatedProject, 'isolated');
    report('created temporary projects and one-time credentials');

    // Mark before the request because a timeout can still leave an immutable
    // Telegram-backed object pending/visible; cleanup should attempt a tombstone.
    state.object.project = primaryProject;
    state.object.mayExist = true;
    await s3Request(state, primary, objectPath, {
      method: 'PUT',
      body: payload,
      headers: {
        'content-type': 'text/plain',
        'idempotency-key': `phase6c-${suffix}-put`,
      },
      expectedStatus: 200,
      step: 'signed-put',
    });
    await s3Request(state, primary, objectPath, {
      expectedStatus: 200,
      expectedBody: payload.toString('utf8'),
      step: 'signed-get',
    });
    await s3Request(state, primary, objectPath, {
      method: 'HEAD',
      expectedStatus: 200,
      step: 'signed-head',
    });
    await s3Request(state, primary, objectPath, {
      headers: { range: 'bytes=0-4' },
      expectedStatus: 206,
      expectedBody: payload.toString('utf8').slice(0, 5),
      step: 'signed-range',
    });
    await s3Request(state, primary, listPath, {
      expectedStatus: 200,
      step: 'signed-list',
    });
    report('verified signed PUT GET HEAD range and list');

    await s3Request(state, isolated, objectPath, {
      expectedStatus: 404,
      expectedXmlCode: 'NoSuchKey',
      step: 'cross-project-non-visibility',
    });
    await controlRequest(state, `/api/projects/${encodeURIComponent(isolatedProject.id)}`, {
      method: 'PATCH',
      body: { status: 'disabled' },
      expectedStatus: 200,
      step: 'disable-isolated-project',
    });
    await s3Request(state, isolated, listPath, {
      expectedStatus: 403,
      expectedXmlCode: 'AccessDenied',
      step: 'inactive-project-rejection',
    });
    report('verified project isolation and inactive-project rejection');

    const replacement = await rotateCredential(state, primary);
    await s3Request(state, primary, objectPath, {
      expectedStatus: 403,
      expectedXmlCode: 'InvalidAccessKeyId',
      step: 'rotated-credential-rejection',
    });
    await s3Request(state, replacement, objectPath, {
      expectedStatus: 200,
      expectedBody: payload.toString('utf8'),
      step: 'replacement-credential-success',
    });
    report('verified old credential rejection and replacement success');

    await s3Request(state, replacement, objectPath, {
      method: 'DELETE',
      headers: { 'idempotency-key': `phase6c-${suffix}-delete` },
      expectedStatus: 204,
      step: 'signed-delete',
    });
    state.object.deleted = true;
    await s3Request(state, replacement, objectPath, {
      expectedStatus: 404,
      expectedXmlCode: 'NoSuchKey',
      step: 'post-delete-non-visibility',
    });
    await revokeCredential(state, replacement, 'explicit-compromised-credential-revocation');
    await s3Request(state, replacement, listPath, {
      expectedStatus: 403,
      expectedXmlCode: 'InvalidAccessKeyId',
      step: 'revoked-credential-rejection',
    });
    report('verified signed delete and explicit credential revocation');
  } finally {
    cleanupComplete = await bestEffortCleanup(state);
  }

  if (!cleanupComplete) {
    throw new Error('staged smoke cleanup incomplete');
  }
  report('passed; credentials were revoked and projects logically deleted');
  report('immutable Telegram records may remain retained; see the production-readiness guide');
}

if (require.main === module) {
  main().catch(() => {
    // Avoid passing an Error to console: fetch/HTTP errors can carry a URL or
    // request details. Operators can use authenticated diagnostics/listing to
    // investigate a generic failure.
    console.error('[phase6c] staged smoke failed; inspect authenticated operator diagnostics and protected logs.');
    process.exitCode = 1;
  });
}

module.exports = {
  EMPTY_SHA256,
  canonicalQuery,
  signedHeaders,
};
