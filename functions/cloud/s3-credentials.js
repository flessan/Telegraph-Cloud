import {
  CloudAdapterError,
  CloudConfigurationError,
  CloudConflictError,
  CloudNotFoundError,
  CloudValidationError,
  isTelegraphCloudError,
} from './errors.js';
import { createCloudIndexStore } from './index-store.js';
import { createProjectRegistry } from './project-registry.js';
import { S3_CREDENTIAL_PEPPER_ENV } from './s3-config.js';
import {
  CLOUD_LIMITS,
  assertProjectId,
  assertS3AccessKeyId,
  assertS3CredentialLabel,
  serializeJsonDocument,
  utf8ByteLength,
} from './validation.js';

// S3 credentials are intentionally separate from the Phase 3 `tg_live_…`
// bearer-key registry. Telegram stores no control-plane credential material.
export const S3_CREDENTIAL_SCHEMA = 'telegraph-cloud.s3-credential.v1';
export const S3_CREDENTIAL_PROJECT_INDEX_SCHEMA = 'telegraph-cloud.project-s3-credential.v1';
export const S3_CREDENTIAL_USE_SCHEMA = 'telegraph-cloud.s3-credential-use.v1';
export const S3_CREDENTIAL_INDEX_NAMESPACES = Object.freeze({
  credential: 's3-credential',
  project: 'project-s3-credential',
  use: 's3-credential-use',
});
export const S3_CREDENTIAL_SCOPES = Object.freeze(['s3:read', 's3:write']);
export const DEFAULT_S3_CREDENTIAL_SCOPES = Object.freeze(['s3:read', 's3:write']);

const S3_CREDENTIAL_STATUS = new Set(['active', 'revoked']);
const S3_CREDENTIAL_SCOPE_SET = new Set(S3_CREDENTIAL_SCOPES);
const ACCESS_KEY_RANDOM_BYTES = 16;
const ACCESS_KEY_RANDOM_LENGTH = 22;
const DERIVED_SECRET_LENGTH = 43;
const MAX_PEPPER_BYTES = 4096;
const LIST_LIMIT = 100;
const encoder = new TextEncoder();

const SECRET_DERIVATION_DOMAIN = 'telegraph-cloud.s3-credential.secret.v1';
const VERIFIER_DOMAIN = 'telegraph-cloud.s3-credential.verifier.v1';
const LIST_CURSOR_DOMAIN = 'telegraph-cloud.s3-credential-list-cursor.v1';

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return false;
  try {
    const normalized = new Date(milliseconds).toISOString();
    // Date.parse can normalize impossible calendar values (for example a 31st
    // day in a shorter month). Require the original UTC spelling to round-trip.
    return value.includes('.') ? normalized === value : normalized === `${value.slice(0, -1)}.000Z`;
  } catch (_) {
    return false;
  }
}

function toIsoTimestamp(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (!safeTimestamp(timestamp)) {
    throw new CloudConfigurationError('invalid_s3_credential_clock', 'S3 credential clock configuration is invalid.');
  }
  return timestamp;
}

function bytesToBase64url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytesToBase64url(bytes) !== value) throw new Error('non-canonical base64url');
  return bytes;
}

function normalizeListOptions(value = {}) {
  if (!plainObject(value)) {
    throw new CloudValidationError('invalid_s3_credential_query', 'S3 credential list query is invalid.');
  }
  const limit = value.limit === undefined ? 20 : value.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT) {
    throw new CloudValidationError('invalid_s3_credential_limit', 'S3 credential list limit is outside the supported range.');
  }
  if (value.cursor !== undefined && value.cursor !== null && value.cursor !== ''
    && (typeof value.cursor !== 'string' || utf8ByteLength(value.cursor) > CLOUD_LIMITS.MAX_S3_CREDENTIAL_CURSOR_BYTES)) {
    throw new CloudValidationError('invalid_s3_credential_cursor', 'S3 credential pagination cursor is invalid.');
  }
  return { limit, cursor: value.cursor || undefined };
}

function normalizeScopes(value, { defaultScopes = DEFAULT_S3_CREDENTIAL_SCOPES } = {}) {
  if (value === undefined) {
    if (!defaultScopes) throw new CloudValidationError('invalid_s3_credential_scopes', 'S3 credential scopes are invalid.');
    return [...defaultScopes];
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > CLOUD_LIMITS.MAX_S3_CREDENTIAL_SCOPES) {
    throw new CloudValidationError('invalid_s3_credential_scopes', 'S3 credential scopes are invalid.');
  }
  const scopes = [];
  for (const scope of value) {
    if (typeof scope !== 'string' || !S3_CREDENTIAL_SCOPE_SET.has(scope) || scopes.includes(scope)) {
      throw new CloudValidationError('invalid_s3_credential_scopes', 'S3 credential scopes are invalid.');
    }
    scopes.push(scope);
  }
  return scopes.sort();
}

function normalizeCreatePayload(value, { fallbackLabel, fallbackScopes = DEFAULT_S3_CREDENTIAL_SCOPES } = {}) {
  const payload = serializeJsonDocument(value, { maxBytes: 8 * 1024 }).value;
  for (const field of Object.keys(payload)) {
    if (field !== 'label' && field !== 'scopes') {
      throw new CloudValidationError('invalid_s3_credential_payload', 'S3 credential request contains an unsupported field.');
    }
  }
  const label = payload.label === undefined ? fallbackLabel : assertS3CredentialLabel(payload.label);
  return {
    ...(label === undefined ? {} : { label }),
    scopes: normalizeScopes(payload.scopes, { defaultScopes: fallbackScopes }),
  };
}

function indexFailure(operation, error) {
  if (isTelegraphCloudError(error)) return error;
  return new CloudAdapterError(
    `cloud_s3_credential_${operation}_failed`,
    'S3 credential control-plane storage is temporarily unavailable.',
    { status: 503 },
  );
}

function invalidStoredCredential() {
  return new CloudAdapterError('cloud_s3_credential_invalid_record', 'S3 credential control-plane state is invalid.', { status: 503 });
}

function normalizeStoredCredential(value) {
  try {
    if (!plainObject(value) || value.schema !== S3_CREDENTIAL_SCHEMA) throw new Error('schema');
    const allowed = new Set([
      'schema', 'access_key_id', 'project_id', 'label', 'verifier', 'fingerprint', 'scopes',
      'status', 'created_at', 'updated_at', 'revoked_at', 'rotated_from', 'created_via',
    ]);
    if (Object.keys(value).some((name) => !allowed.has(name))) throw new Error('fields');
    const accessKeyId = assertS3AccessKeyId(value.access_key_id);
    const projectId = assertProjectId(value.project_id);
    const label = value.label === undefined ? undefined : assertS3CredentialLabel(value.label);
    if (typeof value.verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.verifier)
      || typeof value.fingerprint !== 'string' || !/^[A-Za-z0-9_-]{12}$/.test(value.fingerprint)
      || value.fingerprint !== value.verifier.slice(0, 12)) {
      throw new Error('verifier');
    }
    const scopes = normalizeScopes(value.scopes, { defaultScopes: null });
    if (!S3_CREDENTIAL_STATUS.has(value.status) || !safeTimestamp(value.created_at) || !safeTimestamp(value.updated_at)
      || Date.parse(value.updated_at) < Date.parse(value.created_at) || value.created_via !== 'dashboard') {
      throw new Error('metadata');
    }
    const revokedAt = value.revoked_at === undefined ? undefined : value.revoked_at;
    if ((value.status === 'revoked' && (!safeTimestamp(revokedAt) || revokedAt !== value.updated_at))
      || (value.status !== 'revoked' && revokedAt !== undefined)) {
      throw new Error('revocation');
    }
    const rotatedFrom = value.rotated_from === undefined ? undefined : assertS3AccessKeyId(value.rotated_from);
    if (rotatedFrom === accessKeyId) throw new Error('rotation');
    return {
      schema: S3_CREDENTIAL_SCHEMA,
      access_key_id: accessKeyId,
      project_id: projectId,
      ...(label === undefined ? {} : { label }),
      verifier: value.verifier,
      fingerprint: value.fingerprint,
      scopes,
      status: value.status,
      created_at: value.created_at,
      updated_at: value.updated_at,
      ...(revokedAt ? { revoked_at: revokedAt } : {}),
      ...(rotatedFrom ? { rotated_from: rotatedFrom } : {}),
      created_via: 'dashboard',
    };
  } catch (_) {
    throw invalidStoredCredential();
  }
}

function normalizeProjectEntry(value) {
  try {
    if (!plainObject(value) || value.schema !== S3_CREDENTIAL_PROJECT_INDEX_SCHEMA) throw new Error('schema');
    if (Object.keys(value).some((name) => !['schema', 'project_id', 'access_key_id'].includes(name))) throw new Error('fields');
    return {
      schema: S3_CREDENTIAL_PROJECT_INDEX_SCHEMA,
      project_id: assertProjectId(value.project_id),
      access_key_id: assertS3AccessKeyId(value.access_key_id),
    };
  } catch (_) {
    throw invalidStoredCredential();
  }
}

function normalizeUseRecord(value) {
  try {
    if (!plainObject(value) || value.schema !== S3_CREDENTIAL_USE_SCHEMA) throw new Error('schema');
    if (Object.keys(value).some((name) => !['schema', 'access_key_id', 'last_used_at'].includes(name))) throw new Error('fields');
    return {
      schema: S3_CREDENTIAL_USE_SCHEMA,
      access_key_id: assertS3AccessKeyId(value.access_key_id),
      last_used_at: (() => {
        if (!safeTimestamp(value.last_used_at)) throw new Error('timestamp');
        return value.last_used_at;
      })(),
    };
  } catch (_) {
    throw invalidStoredCredential();
  }
}

function compareAccessKeyIds(left, right) {
  if (left.access_key_id < right.access_key_id) return -1;
  if (left.access_key_id > right.access_key_id) return 1;
  return 0;
}

function publicCredential(metadata, use = null) {
  return {
    access_key_id: metadata.access_key_id,
    project_id: metadata.project_id,
    ...(metadata.label === undefined ? {} : { label: metadata.label }),
    fingerprint: metadata.fingerprint,
    scopes: [...metadata.scopes],
    status: metadata.status,
    created_at: metadata.created_at,
    updated_at: metadata.updated_at,
    ...(metadata.revoked_at ? { revoked_at: metadata.revoked_at } : {}),
    ...(metadata.rotated_from ? { rotated_from: metadata.rotated_from } : {}),
    ...(use?.last_used_at ? { last_used_at: use.last_used_at } : {}),
  };
}

function defaultRandomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function generatedAccessKeyId(randomBytes) {
  let bytes;
  try {
    bytes = randomBytes(ACCESS_KEY_RANDOM_BYTES);
  } catch (_) {
    throw new CloudConfigurationError('s3_credential_randomness_unavailable', 'S3 credential generation is unavailable.');
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== ACCESS_KEY_RANDOM_BYTES) {
    throw new CloudConfigurationError('s3_credential_randomness_unavailable', 'S3 credential generation is unavailable.');
  }
  const accessKeyId = `tgsk_live_${bytesToBase64url(bytes)}`;
  try {
    if (accessKeyId.length !== 'tgsk_live_'.length + ACCESS_KEY_RANDOM_LENGTH) throw new Error('length');
    return assertS3AccessKeyId(accessKeyId);
  } catch (_) {
    throw new CloudConfigurationError('s3_credential_randomness_unavailable', 'S3 credential generation is unavailable.');
  }
}

/**
 * Dashboard-managed S3 credential control plane. The random access-key ID is
 * the per-credential entropy. A domain-separated HMAC under a server-only
 * pepper derives the client secret on demand, so no plaintext or encrypted
 * client secret is ever persisted in KV.
 */
export function createS3CredentialService(env, {
  index = createCloudIndexStore(env),
  projects = createProjectRegistry(env, { index }),
  now = () => new Date(),
  randomBytes = defaultRandomBytes,
  cryptoApi = globalThis.crypto,
} = {}) {
  if (!index || typeof index.key !== 'function' || typeof index.getJson !== 'function' || typeof index.putJson !== 'function'
    || typeof index.remove !== 'function' || typeof index.list !== 'function'
    || !projects || typeof projects.getProjectRecord !== 'function') {
    throw new CloudConfigurationError('cloud_s3_credential_service_unavailable', 'S3 credential service is unavailable.');
  }
  let masterKeyPromise;

  function pepperBytes() {
    const pepper = env?.[S3_CREDENTIAL_PEPPER_ENV];
    if (typeof pepper !== 'string') {
      throw new CloudConfigurationError('s3_credential_pepper_unavailable', 'S3 credential verification is not configured.');
    }
    const bytes = encoder.encode(pepper);
    if (bytes.byteLength < 32 || bytes.byteLength > MAX_PEPPER_BYTES) {
      throw new CloudConfigurationError('s3_credential_pepper_unavailable', 'S3 credential verification is not configured.');
    }
    return bytes;
  }

  async function masterKey() {
    if (!cryptoApi?.subtle || typeof cryptoApi.subtle.importKey !== 'function'
      || typeof cryptoApi.subtle.sign !== 'function' || typeof cryptoApi.subtle.verify !== 'function') {
      throw new CloudConfigurationError('s3_credential_crypto_unavailable', 'S3 credential verification is unavailable.');
    }
    if (!masterKeyPromise) {
      try {
        masterKeyPromise = cryptoApi.subtle.importKey(
          'raw',
          pepperBytes(),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['sign', 'verify'],
        ).catch(() => {
          masterKeyPromise = null;
          throw new CloudConfigurationError('s3_credential_crypto_unavailable', 'S3 credential verification is unavailable.');
        });
      } catch (error) {
        if (isTelegraphCloudError(error)) throw error;
        throw new CloudConfigurationError('s3_credential_crypto_unavailable', 'S3 credential verification is unavailable.');
      }
    }
    return masterKeyPromise;
  }

  async function signMaster(value) {
    try {
      return new Uint8Array(await cryptoApi.subtle.sign('HMAC', await masterKey(), encoder.encode(value)));
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw new CloudConfigurationError('s3_credential_crypto_unavailable', 'S3 credential verification is unavailable.');
    }
  }

  function invalidListCursor() {
    return new CloudValidationError('invalid_s3_credential_cursor', 'S3 credential pagination cursor is invalid.');
  }

  async function encodeListCursor(cursor, projectId) {
    if (typeof cursor !== 'string' || cursor.length === 0 || utf8ByteLength(cursor) > CLOUD_LIMITS.MAX_DOCUMENT_CURSOR_BYTES) {
      throw invalidStoredCredential();
    }
    const payload = JSON.stringify({ v: 1, p: assertProjectId(projectId), c: cursor });
    const bytes = encoder.encode(payload);
    if (bytes.byteLength > CLOUD_LIMITS.MAX_DOCUMENT_CURSOR_BYTES) throw invalidStoredCredential();
    const mac = await signMaster(`${LIST_CURSOR_DOMAIN}\u0000${payload}`);
    const token = `${bytesToBase64url(bytes)}.${bytesToBase64url(mac)}`;
    if (utf8ByteLength(token) > CLOUD_LIMITS.MAX_S3_CREDENTIAL_CURSOR_BYTES) throw invalidStoredCredential();
    return token;
  }

  async function decodeListCursor(value, projectId) {
    if (value === undefined) return undefined;
    const safeProjectId = assertProjectId(projectId);
    if (typeof value !== 'string' || utf8ByteLength(value) > CLOUD_LIMITS.MAX_S3_CREDENTIAL_CURSOR_BYTES) throw invalidListCursor();
    const parts = value.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw invalidListCursor();
    let payload;
    let signature;
    let parsed;
    try {
      payload = new TextDecoder('utf-8', { fatal: true }).decode(base64urlToBytes(parts[0]));
      signature = base64urlToBytes(parts[1]);
      parsed = JSON.parse(payload);
      if (!plainObject(parsed) || parsed.v !== 1 || parsed.p !== safeProjectId || typeof parsed.c !== 'string'
        || parsed.c.length === 0 || utf8ByteLength(parsed.c) > CLOUD_LIMITS.MAX_DOCUMENT_CURSOR_BYTES
        || signature.byteLength !== 32) {
        throw new Error('invalid cursor');
      }
    } catch (_) {
      throw invalidListCursor();
    }
    let valid;
    try {
      valid = await cryptoApi.subtle.verify(
        'HMAC',
        await masterKey(),
        signature,
        encoder.encode(`${LIST_CURSOR_DOMAIN}\u0000${payload}`),
      );
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw new CloudConfigurationError('s3_credential_crypto_unavailable', 'S3 credential verification is unavailable.');
    }
    if (!valid) throw invalidListCursor();
    return parsed.c;
  }

  async function derivedSecret(accessKeyId) {
    const safeAccessKeyId = assertS3AccessKeyId(accessKeyId);
    const secret = bytesToBase64url(await signMaster(`${SECRET_DERIVATION_DOMAIN}\u0000${safeAccessKeyId}`));
    if (secret.length !== DERIVED_SECRET_LENGTH) {
      throw new CloudConfigurationError('s3_credential_crypto_unavailable', 'S3 credential verification is unavailable.');
    }
    return secret;
  }

  function verifierPayload(metadata, secret) {
    // Bind every authorization-relevant field. Labels and use telemetry remain
    // safe metadata, while a status/project/scope alteration cannot turn an
    // existing derived secret into a different authority without the pepper.
    return `${VERIFIER_DOMAIN}\u0000${metadata.access_key_id}\u0000${metadata.project_id}\u0000${metadata.scopes.join(',')}\u0000${metadata.status}\u0000${metadata.created_at}\u0000${secret}`;
  }

  async function verifierFor(metadata, secret) {
    return bytesToBase64url(await signMaster(verifierPayload(metadata, secret)));
  }

  async function verifyVerifier(metadata, secret) {
    try {
      // Web Crypto verifies the HMAC in its cryptographic implementation. Do
      // not turn this into a JavaScript string comparison of stored material.
      return await cryptoApi.subtle.verify(
        'HMAC',
        await masterKey(),
        base64urlToBytes(metadata.verifier),
        encoder.encode(verifierPayload(metadata, secret)),
      );
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw new CloudConfigurationError('s3_credential_crypto_unavailable', 'S3 credential verification is unavailable.');
    }
  }

  async function getIndex(namespace, ...segments) {
    try {
      return await index.getJson(namespace, ...segments);
    } catch (error) {
      throw indexFailure('read', error);
    }
  }

  async function putIndex(namespace, segments, value, options) {
    try {
      await index.putJson(namespace, segments, value, options);
    } catch (error) {
      throw indexFailure('write', error);
    }
  }

  async function removeIndex(namespace, ...segments) {
    try {
      await index.remove(namespace, ...segments);
    } catch (error) {
      throw indexFailure('delete', error);
    }
  }

  async function readCredential(accessKeyId) {
    const safeAccessKeyId = assertS3AccessKeyId(accessKeyId);
    const value = await getIndex(S3_CREDENTIAL_INDEX_NAMESPACES.credential, safeAccessKeyId);
    if (value === null) return null;
    const metadata = normalizeStoredCredential(value);
    if (metadata.access_key_id !== safeAccessKeyId) throw invalidStoredCredential();
    return metadata;
  }

  async function readUse(accessKeyId) {
    const safeAccessKeyId = assertS3AccessKeyId(accessKeyId);
    const value = await getIndex(S3_CREDENTIAL_INDEX_NAMESPACES.use, safeAccessKeyId);
    if (value === null) return null;
    const use = normalizeUseRecord(value);
    if (use.access_key_id !== safeAccessKeyId) throw invalidStoredCredential();
    return use;
  }

  async function ensureProjectExists(projectId) {
    const safeProjectId = assertProjectId(projectId);
    const project = await projects.getProjectRecord(safeProjectId, { includeDeleted: false });
    if (!project) throw new CloudNotFoundError('project_not_found', 'The requested project was not found.');
    return project;
  }

  async function scopedCredential(projectId, accessKeyId) {
    const safeProjectId = assertProjectId(projectId);
    const metadata = await readCredential(accessKeyId);
    // Do not reveal whether a credential identifier belongs to another project.
    if (!metadata || metadata.project_id !== safeProjectId) {
      throw new CloudNotFoundError('s3_credential_not_found', 'The requested S3 credential was not found.');
    }
    return metadata;
  }

  async function allocateAccessKeyId() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generatedAccessKeyId(randomBytes);
      if (!await readCredential(candidate)) return candidate;
    }
    throw new CloudAdapterError('s3_access_key_id_allocation_failed', 'S3 credential generation is temporarily unavailable.', { status: 503 });
  }

  async function createCredentialInternal(projectId, payload, { rotatedFrom } = {}) {
    const safeProjectId = assertProjectId(projectId);
    await masterKey();
    const accessKeyId = await allocateAccessKeyId();
    const timestamp = toIsoTimestamp(now);
    const preliminary = {
      access_key_id: accessKeyId,
      project_id: safeProjectId,
      scopes: [...payload.scopes],
      status: 'active',
      created_at: timestamp,
    };
    const secret = await derivedSecret(accessKeyId);
    const verifier = await verifierFor(preliminary, secret);
    const metadata = {
      schema: S3_CREDENTIAL_SCHEMA,
      access_key_id: accessKeyId,
      project_id: safeProjectId,
      ...(payload.label === undefined ? {} : { label: payload.label }),
      verifier,
      fingerprint: verifier.slice(0, 12),
      scopes: [...payload.scopes],
      status: 'active',
      created_at: timestamp,
      updated_at: timestamp,
      ...(rotatedFrom ? { rotated_from: assertS3AccessKeyId(rotatedFrom) } : {}),
      created_via: 'dashboard',
    };

    let wroteCredential = false;
    let wroteProjectEntry = false;
    try {
      await putIndex(S3_CREDENTIAL_INDEX_NAMESPACES.credential, [accessKeyId], metadata);
      wroteCredential = true;
      await putIndex(S3_CREDENTIAL_INDEX_NAMESPACES.project, [safeProjectId, accessKeyId], {
        schema: S3_CREDENTIAL_PROJECT_INDEX_SCHEMA,
        project_id: safeProjectId,
        access_key_id: accessKeyId,
      });
      wroteProjectEntry = true;
    } catch (error) {
      // A failed creation never reveals a secret. Clean up a partial active
      // record best-effort rather than leave an unrecoverable credential live.
      const cleanups = [];
      if (wroteProjectEntry) cleanups.push(removeIndex(S3_CREDENTIAL_INDEX_NAMESPACES.project, safeProjectId, accessKeyId));
      if (wroteCredential) cleanups.push(removeIndex(S3_CREDENTIAL_INDEX_NAMESPACES.credential, accessKeyId));
      await Promise.allSettled(cleanups);
      throw error;
    }
    return { secret_access_key: secret, credential: publicCredential(metadata), metadata };
  }

  async function createCredential(projectId, input = {}) {
    await ensureProjectExists(projectId);
    const payload = normalizeCreatePayload(input);
    const created = await createCredentialInternal(projectId, payload);
    return { secret_access_key: created.secret_access_key, credential: created.credential };
  }

  async function listCredentials(projectId, options = {}) {
    const safeProjectId = assertProjectId(projectId);
    const { limit, cursor: suppliedCursor } = normalizeListOptions(options);
    await ensureProjectExists(safeProjectId);
    const cursor = await decodeListCursor(suppliedCursor, safeProjectId);
    let page;
    try {
      page = await index.list(S3_CREDENTIAL_INDEX_NAMESPACES.project, {
        prefixSegments: [safeProjectId],
        limit,
        cursor,
      });
    } catch (error) {
      throw indexFailure('list', error);
    }
    if (!page || !Array.isArray(page.keys) || typeof page.list_complete !== 'boolean') throw invalidStoredCredential();
    const prefix = index.key(S3_CREDENTIAL_INDEX_NAMESPACES.project, safeProjectId);
    const entries = await Promise.all(page.keys.map(async (entry) => {
      const name = String(entry?.name || '');
      if (!name.startsWith(`${prefix}:`)) throw invalidStoredCredential();
      const accessKeyId = name.slice(prefix.length + 1);
      try {
        assertS3AccessKeyId(accessKeyId);
      } catch (_) {
        throw invalidStoredCredential();
      }
      const projectEntryValue = await getIndex(S3_CREDENTIAL_INDEX_NAMESPACES.project, safeProjectId, accessKeyId);
      if (projectEntryValue === null) return null;
      const projectEntry = normalizeProjectEntry(projectEntryValue);
      if (projectEntry.project_id !== safeProjectId || projectEntry.access_key_id !== accessKeyId) throw invalidStoredCredential();
      const metadata = await readCredential(accessKeyId);
      if (!metadata || metadata.project_id !== safeProjectId) return null;
      return publicCredential(metadata, await readUse(accessKeyId));
    }));
    const hasMore = !page.list_complete;
    if (hasMore && (typeof page.cursor !== 'string' || !page.cursor)) throw invalidStoredCredential();
    const nextCursor = hasMore ? await encodeListCursor(page.cursor, safeProjectId) : undefined;
    return {
      data: entries.filter(Boolean).sort(compareAccessKeyIds),
      limit,
      order: 'access_key_id:asc',
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      has_more: hasMore,
    };
  }

  async function revokeCredential(projectId, accessKeyId) {
    await ensureProjectExists(projectId);
    const metadata = await scopedCredential(projectId, accessKeyId);
    if (metadata.status === 'revoked') return publicCredential(metadata, await readUse(metadata.access_key_id));
    const timestamp = toIsoTimestamp(now);
    const revokedDraft = {
      ...metadata,
      status: 'revoked',
      updated_at: timestamp,
      revoked_at: timestamp,
    };
    const verifier = await verifierFor(revokedDraft, await derivedSecret(metadata.access_key_id));
    const revoked = {
      ...revokedDraft,
      verifier,
      fingerprint: verifier.slice(0, 12),
    };
    await putIndex(S3_CREDENTIAL_INDEX_NAMESPACES.credential, [metadata.access_key_id], revoked);
    // Retain the project list entry: dashboard recovery needs to see revoked
    // credentials, while direct authentication always checks primary status.
    return publicCredential(revoked, await readUse(metadata.access_key_id));
  }

  async function rotateCredential(projectId, accessKeyId, input = {}) {
    await ensureProjectExists(projectId);
    const current = await scopedCredential(projectId, accessKeyId);
    if (current.status !== 'active') {
      throw new CloudConflictError('s3_credential_not_active', 'Only active S3 credentials can be rotated.');
    }
    const payload = normalizeCreatePayload(input, {
      fallbackLabel: current.label,
      fallbackScopes: current.scopes,
    });
    const replacement = await createCredentialInternal(projectId, payload, { rotatedFrom: current.access_key_id });
    try {
      await revokeCredential(projectId, current.access_key_id);
    } catch (error) {
      // Do not return a successful-looking rotation with both credentials live.
      try { await revokeCredential(projectId, replacement.metadata.access_key_id); } catch (_) { /* best effort */ }
      throw error;
    }
    return { secret_access_key: replacement.secret_access_key, credential: replacement.credential };
  }

  /**
   * Direct, bounded auth lookup. It never uses the dashboard project index and
   * returns the derived secret only to the in-process SigV4 verification layer.
   */
  async function resolveSigningCredential(accessKeyId) {
    const metadata = await readCredential(accessKeyId);
    if (!metadata || metadata.status !== 'active') return null;
    const secretAccessKey = await derivedSecret(metadata.access_key_id);
    if (!await verifyVerifier(metadata, secretAccessKey)) throw invalidStoredCredential();
    return Object.freeze({
      accessKeyId: metadata.access_key_id,
      projectId: metadata.project_id,
      scopes: Object.freeze([...metadata.scopes]),
      secretAccessKey,
    });
  }

  /** Best-effort telemetry-safe usage marker; never read for authorization. */
  async function markUsed(accessKeyId) {
    const safeAccessKeyId = assertS3AccessKeyId(accessKeyId);
    const timestamp = toIsoTimestamp(now);
    await putIndex(S3_CREDENTIAL_INDEX_NAMESPACES.use, [safeAccessKeyId], {
      schema: S3_CREDENTIAL_USE_SCHEMA,
      access_key_id: safeAccessKeyId,
      last_used_at: timestamp,
    });
  }

  return Object.freeze({
    createCredential,
    listCredentials,
    revokeCredential,
    rotateCredential,
    resolveSigningCredential,
    markUsed,
  });
}
