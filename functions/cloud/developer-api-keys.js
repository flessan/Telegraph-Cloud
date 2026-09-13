import {
  CloudAdapterError,
  CloudConfigurationError,
  CloudConflictError,
  CloudForbiddenError,
  CloudNotFoundError,
  CloudUnauthorizedError,
  CloudValidationError,
  isTelegraphCloudError,
} from './errors.js';
import { createCloudIndexStore } from './index-store.js';
import { createProjectRegistry } from './project-registry.js';
import {
  CLOUD_LIMITS,
  assertApiKeyId,
  assertApiKeyName,
  assertProjectId,
  serializeJsonDocument,
  utf8ByteLength,
} from './validation.js';

// All persistent key material is in TELEGRAPH_CLOUD_KV. Telegram journal
// records must never contain a credential, verifier, pepper, or dashboard
// secret. The verifier is a domain-separated HMAC, not a recoverable key.
export const API_KEY_SCHEMA = 'telegraph-cloud.api-key.v1';
export const API_KEY_LOOKUP_SCHEMA = 'telegraph-cloud.api-key-lookup.v1';
export const API_KEY_PROJECT_INDEX_SCHEMA = 'telegraph-cloud.project-api-key.v1';
export const API_KEY_INDEX_NAMESPACES = Object.freeze({
  key: 'api-key',
  lookup: 'api-key-lookup',
  project: 'project-api-key',
});
// New keys retain the established database-only default. Storage access is
// opt-in so adding Phase 4 does not silently widen the authority of a newly
// issued developer credential.
export const API_KEY_SCOPES = Object.freeze(['db:read', 'db:write', 'storage:read', 'storage:write']);
export const DEFAULT_API_KEY_SCOPES = Object.freeze(['db:read', 'db:write']);

const API_KEY_STATUS = new Set(['active', 'revoked']);
const API_KEY_SCOPE_SET = new Set(API_KEY_SCOPES);
const KEY_ID_RANDOM_BYTES = 16;
const SECRET_RANDOM_BYTES = 32;
const KEY_ID_RANDOM_LENGTH = 22;
const SECRET_RANDOM_LENGTH = 43;
const API_KEY_PATTERN = new RegExp(
  `^tg_live_(key_[A-Za-z0-9_-]{${KEY_ID_RANDOM_LENGTH}})_([A-Za-z0-9_-]{${SECRET_RANDOM_LENGTH}})$`,
);
const MAX_PEPPER_BYTES = 4096;
const KEY_LIST_LIMIT = 100;
const encoder = new TextEncoder();

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function toIsoTimestamp(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (!safeTimestamp(timestamp)) {
    throw new CloudConfigurationError('invalid_api_key_clock', 'API key clock configuration is invalid.');
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
  return bytes;
}

function decodeKeyListCursor(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || utf8ByteLength(value) > CLOUD_LIMITS.MAX_DOCUMENT_CURSOR_BYTES) {
    throw new CloudValidationError('invalid_api_key_cursor', 'API key pagination cursor is invalid.');
  }
  try {
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64urlToBytes(value)));
    if (!plainObject(parsed) || parsed.v !== 1 || typeof parsed.c !== 'string'
      || utf8ByteLength(parsed.c) > CLOUD_LIMITS.MAX_DOCUMENT_CURSOR_BYTES) {
      throw new Error('invalid cursor');
    }
    return parsed.c;
  } catch (_) {
    throw new CloudValidationError('invalid_api_key_cursor', 'API key pagination cursor is invalid.');
  }
}

function encodeKeyListCursor(cursor) {
  return bytesToBase64url(encoder.encode(JSON.stringify({ v: 1, c: cursor })));
}

function normalizeKeyListOptions(value = {}) {
  if (!plainObject(value)) {
    throw new CloudValidationError('invalid_api_key_query', 'API key list query is invalid.');
  }
  const limit = value.limit === undefined ? 20 : value.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > KEY_LIST_LIMIT) {
    throw new CloudValidationError('invalid_api_key_limit', 'API key list limit is outside the supported range.');
  }
  return { limit, cursor: decodeKeyListCursor(value.cursor) };
}

function defaultCreateId(prefix) {
  const bytes = new Uint8Array(KEY_ID_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  return `${prefix}${bytesToBase64url(bytes)}`;
}

function defaultRandomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function normalizePayload(value) {
  return serializeJsonDocument(value, { maxBytes: 8 * 1024 }).value;
}

function normalizeScopes(value, { defaultScopes = DEFAULT_API_KEY_SCOPES } = {}) {
  if (value === undefined) return [...defaultScopes];
  if (!Array.isArray(value) || value.length === 0 || value.length > CLOUD_LIMITS.MAX_API_KEY_SCOPES) {
    throw new CloudValidationError('invalid_api_key_scopes', 'API key scopes are invalid.');
  }
  const scopes = [];
  for (const scope of value) {
    if (typeof scope !== 'string' || !API_KEY_SCOPE_SET.has(scope) || scopes.includes(scope)) {
      throw new CloudValidationError('invalid_api_key_scopes', 'API key scopes are invalid.');
    }
    scopes.push(scope);
  }
  return scopes.sort();
}

function normalizeCreatePayload(value, { fallbackLabel = 'Developer key', fallbackScopes = DEFAULT_API_KEY_SCOPES } = {}) {
  const payload = normalizePayload(value);
  for (const field of Object.keys(payload)) {
    if (field !== 'label' && field !== 'scopes') {
      throw new CloudValidationError('invalid_api_key_payload', 'API key request contains an unsupported field.');
    }
  }
  return {
    label: payload.label === undefined ? fallbackLabel : assertApiKeyName(payload.label),
    scopes: normalizeScopes(payload.scopes, { defaultScopes: fallbackScopes }),
  };
}

function parseDeveloperApiKey(value) {
  if (typeof value !== 'string') return null;
  const match = API_KEY_PATTERN.exec(value);
  if (!match) return null;
  try {
    const keyId = assertApiKeyId(match[1]);
    const secret = base64urlToBytes(match[2]);
    if (secret.byteLength !== SECRET_RANDOM_BYTES) return null;
    return { key_id: keyId };
  } catch (_) {
    return null;
  }
}

function assertPepper(env) {
  const pepper = env?.API_KEY_PEPPER;
  if (typeof pepper !== 'string') {
    throw new CloudConfigurationError('api_key_pepper_unavailable', 'Developer API key verification is not configured.');
  }
  const bytes = encoder.encode(pepper);
  if (bytes.byteLength < 32 || bytes.byteLength > MAX_PEPPER_BYTES) {
    throw new CloudConfigurationError('api_key_pepper_unavailable', 'Developer API key verification is not configured.');
  }
  return bytes;
}

function safePrefix(keyId) {
  // The public component stops before the random secret. The ellipsis makes it
  // impossible to mistake this display value for a credential that can work.
  return `tg_live_${keyId}…`;
}

function lookupSegment(verifier) {
  // HMAC base64url may begin with '-' or '_', while Cloud index segments are
  // deliberately required to begin with an alphanumeric character. Always use
  // a versioned-safe prefix for new records: conditional prefixing could let a
  // raw verifier beginning with that prefix collide with a prefixed one.
  return `h_${verifier}`;
}

function legacyLookupSegment(verifier) {
  // Phase 3 originally stored successful lookup records at the raw verifier
  // segment. Those could only have begun with an alphanumeric character, since
  // the index would reject the other form during creation. Retain a read-only
  // fallback so existing valid deployments do not lose authentication when the
  // safe prefix is introduced.
  return /^[A-Za-z0-9]/.test(verifier) ? verifier : null;
}

function publicKey(metadata) {
  return {
    key_id: metadata.key_id,
    project_id: metadata.project_id,
    label: metadata.label,
    key_prefix: metadata.key_prefix,
    fingerprint: metadata.fingerprint,
    scopes: [...metadata.scopes],
    status: metadata.status,
    created_at: metadata.created_at,
    updated_at: metadata.updated_at,
    ...(metadata.revoked_at ? { revoked_at: metadata.revoked_at } : {}),
    ...(metadata.rotated_from ? { rotated_from: metadata.rotated_from } : {}),
  };
}

function indexFailure(operation, error) {
  if (isTelegraphCloudError(error)) return error;
  return new CloudAdapterError(
    `cloud_api_key_${operation}_failed`,
    'Developer key control-plane storage is temporarily unavailable.',
    { status: 503 },
  );
}

function normalizeStoredKey(value) {
  try {
    if (!plainObject(value) || value.schema !== API_KEY_SCHEMA) throw new Error('invalid key');
    const keyId = assertApiKeyId(value.key_id);
    const projectId = assertProjectId(value.project_id);
    const label = assertApiKeyName(value.label);
    const keyPrefix = typeof value.key_prefix === 'string' && value.key_prefix === safePrefix(keyId)
      ? value.key_prefix : null;
    if (!keyPrefix || typeof value.verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.verifier)
      || typeof value.fingerprint !== 'string' || !/^[A-Za-z0-9_-]{12}$/.test(value.fingerprint)
      || value.fingerprint !== value.verifier.slice(0, 12)) {
      throw new Error('invalid verifier');
    }
    if (!Array.isArray(value.scopes)) throw new Error('invalid scopes');
    const scopes = normalizeScopes(value.scopes);
    if (!API_KEY_STATUS.has(value.status) || !safeTimestamp(value.created_at) || !safeTimestamp(value.updated_at)
      || Date.parse(value.updated_at) < Date.parse(value.created_at) || value.created_via !== 'dashboard') {
      throw new Error('invalid metadata');
    }
    const revokedAt = value.revoked_at === undefined ? undefined : value.revoked_at;
    if ((value.status === 'revoked' && (!safeTimestamp(revokedAt) || revokedAt !== value.updated_at))
      || (value.status !== 'revoked' && revokedAt !== undefined)) {
      throw new Error('invalid revocation state');
    }
    const rotatedFrom = value.rotated_from === undefined ? undefined : assertApiKeyId(value.rotated_from);
    if (rotatedFrom === keyId) throw new Error('invalid rotation metadata');
    return {
      schema: API_KEY_SCHEMA,
      key_id: keyId,
      project_id: projectId,
      label,
      key_prefix: keyPrefix,
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
    throw new CloudAdapterError('cloud_api_key_invalid_record', 'Developer key control-plane state is invalid.', { status: 500 });
  }
}

function normalizeLookup(value) {
  try {
    if (!plainObject(value) || value.schema !== API_KEY_LOOKUP_SCHEMA) throw new Error('invalid lookup');
    if (typeof value.verifier !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.verifier)) throw new Error('invalid verifier');
    return {
      schema: API_KEY_LOOKUP_SCHEMA,
      key_id: assertApiKeyId(value.key_id),
      project_id: assertProjectId(value.project_id),
      verifier: value.verifier,
    };
  } catch (_) {
    throw new CloudAdapterError('cloud_api_key_invalid_record', 'Developer key control-plane state is invalid.', { status: 500 });
  }
}

function normalizeProjectEntry(value) {
  try {
    if (!plainObject(value) || value.schema !== API_KEY_PROJECT_INDEX_SCHEMA) throw new Error('invalid project entry');
    return {
      schema: API_KEY_PROJECT_INDEX_SCHEMA,
      project_id: assertProjectId(value.project_id),
      key_id: assertApiKeyId(value.key_id),
    };
  } catch (_) {
    throw new CloudAdapterError('cloud_api_key_invalid_record', 'Developer key control-plane state is invalid.', { status: 500 });
  }
}

function equalBytes(left, right) {
  // A fixed-work comparison for the HMAC strings prior to the native Web
  // Crypto verify below. It avoids an early-exit JavaScript comparison when
  // validating a stored lookup pointer.
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] || 0) ^ (rightBytes[index] || 0);
  }
  return difference === 0;
}

function generatedKeyId(createId) {
  try {
    const keyId = assertApiKeyId(createId('key_'));
    // The externally usable grammar is deliberately fixed-width so parsing a
    // credential never needs heuristic splitting around base64url underscores.
    if (keyId.length !== 4 + KEY_ID_RANDOM_LENGTH) throw new Error('unexpected id length');
    return keyId;
  } catch (_) {
    throw new CloudConfigurationError('invalid_api_key_id_generator', 'Developer API key generation is unavailable.');
  }
}

function generatedSecret(randomBytes) {
  let bytes;
  try {
    bytes = randomBytes(SECRET_RANDOM_BYTES);
  } catch (_) {
    throw new CloudConfigurationError('api_key_randomness_unavailable', 'Developer API key generation is unavailable.');
  }
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== SECRET_RANDOM_BYTES) {
    throw new CloudConfigurationError('api_key_randomness_unavailable', 'Developer API key generation is unavailable.');
  }
  const secret = bytesToBase64url(bytes);
  if (secret.length !== SECRET_RANDOM_LENGTH) {
    throw new CloudConfigurationError('api_key_randomness_unavailable', 'Developer API key generation is unavailable.');
  }
  return secret;
}

/**
 * Creates and verifies developer credentials. A key is an opaque bearer token
 * in the form `tg_live_key_<public-id>_<32-byte-secret>`. The full credential
 * is returned from create/rotate exactly once and is never persisted.
 */
export function createDeveloperApiKeyService(env, {
  index = createCloudIndexStore(env),
  projects = createProjectRegistry(env, { index }),
  now = () => new Date(),
  createId = defaultCreateId,
  randomBytes = defaultRandomBytes,
  cryptoApi = globalThis.crypto,
} = {}) {
  if (!index || typeof index.key !== 'function' || typeof index.getJson !== 'function' || typeof index.putJson !== 'function'
    || typeof index.remove !== 'function' || typeof index.list !== 'function'
    || !projects || typeof projects.getProjectRecord !== 'function') {
    throw new CloudConfigurationError('cloud_api_key_service_unavailable', 'Developer key service is unavailable.');
  }
  let hmacKeyPromise;

  async function hmacKey() {
    if (!cryptoApi || !cryptoApi.subtle || typeof cryptoApi.subtle.importKey !== 'function'
      || typeof cryptoApi.subtle.sign !== 'function' || typeof cryptoApi.subtle.verify !== 'function') {
      throw new CloudConfigurationError('api_key_crypto_unavailable', 'Developer API key verification is not available.');
    }
    if (!hmacKeyPromise) {
      // Keep key-list/revoke control-plane recovery available even if a pepper
      // was accidentally removed. Operations that create or verify a secret
      // still fail closed as soon as they need this HMAC key.
      const pepperBytes = assertPepper(env);
      hmacKeyPromise = cryptoApi.subtle.importKey(
        'raw',
        pepperBytes,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify'],
      ).catch(() => {
        hmacKeyPromise = null;
        throw new CloudConfigurationError('api_key_crypto_unavailable', 'Developer API key verification is not available.');
      });
    }
    return hmacKeyPromise;
  }

  async function verifierFor(credential) {
    try {
      const signature = await cryptoApi.subtle.sign('HMAC', await hmacKey(), encoder.encode(`telegraph-cloud.api-key.v1\u0000${credential}`));
      return bytesToBase64url(new Uint8Array(signature));
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw new CloudConfigurationError('api_key_crypto_unavailable', 'Developer API key verification is not available.');
    }
  }

  async function verifyVerifier(credential, verifier) {
    try {
      return await cryptoApi.subtle.verify(
        'HMAC',
        await hmacKey(),
        base64urlToBytes(verifier),
        encoder.encode(`telegraph-cloud.api-key.v1\u0000${credential}`),
      );
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw new CloudConfigurationError('api_key_crypto_unavailable', 'Developer API key verification is not available.');
    }
  }

  async function getIndex(namespace, ...segments) {
    try {
      return await index.getJson(namespace, ...segments);
    } catch (error) {
      throw indexFailure('read', error);
    }
  }

  async function readLookupForVerifier(verifier) {
    const current = await getIndex(API_KEY_INDEX_NAMESPACES.lookup, lookupSegment(verifier));
    if (current !== null) return current;
    const legacy = legacyLookupSegment(verifier);
    return legacy ? getIndex(API_KEY_INDEX_NAMESPACES.lookup, legacy) : null;
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

  async function readKey(keyId) {
    const safeKeyId = assertApiKeyId(keyId);
    const value = await getIndex(API_KEY_INDEX_NAMESPACES.key, safeKeyId);
    if (value === null) return null;
    const metadata = normalizeStoredKey(value);
    if (metadata.key_id !== safeKeyId) {
      throw new CloudAdapterError('cloud_api_key_invalid_record', 'Developer key control-plane state is invalid.', { status: 500 });
    }
    return metadata;
  }

  async function scopedKey(projectId, keyId) {
    const safeProjectId = assertProjectId(projectId);
    const metadata = await readKey(keyId);
    // Do not turn this into a 403: a dashboard user is allowed to manage only
    // through a project route, and callers do not learn whether another
    // project's key ID exists.
    if (!metadata || metadata.project_id !== safeProjectId) {
      throw new CloudNotFoundError('api_key_not_found', 'The requested API key was not found.');
    }
    return metadata;
  }

  async function ensureProjectExists(projectId) {
    const safeProjectId = assertProjectId(projectId);
    const project = await projects.getProjectRecord(safeProjectId, { includeDeleted: false });
    if (!project) throw new CloudNotFoundError('project_not_found', 'The requested project was not found.');
    return project;
  }

  async function allocateKeyId() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generatedKeyId(createId);
      if (!await readKey(candidate)) return candidate;
    }
    throw new CloudAdapterError('api_key_id_allocation_failed', 'A developer API key identifier could not be allocated.', { status: 503 });
  }

  async function createKeyInternal(projectId, payload, { rotatedFrom } = {}) {
    const safeProjectId = assertProjectId(projectId);
    await hmacKey();
    const keyId = await allocateKeyId();
    const secret = generatedSecret(randomBytes);
    const credential = `tg_live_${keyId}_${secret}`;
    const verifier = await verifierFor(credential);
    const timestamp = toIsoTimestamp(now);
    const metadata = {
      schema: API_KEY_SCHEMA,
      key_id: keyId,
      project_id: safeProjectId,
      label: payload.label,
      key_prefix: safePrefix(keyId),
      verifier,
      fingerprint: verifier.slice(0, 12),
      scopes: [...payload.scopes],
      status: 'active',
      created_at: timestamp,
      updated_at: timestamp,
      ...(rotatedFrom ? { rotated_from: assertApiKeyId(rotatedFrom) } : {}),
      created_via: 'dashboard',
    };

    let wroteKey = false;
    let wroteLookup = false;
    let wroteProjectEntry = false;
    try {
      await putIndex(API_KEY_INDEX_NAMESPACES.key, [keyId], metadata);
      wroteKey = true;
      await putIndex(API_KEY_INDEX_NAMESPACES.lookup, [lookupSegment(verifier)], {
        schema: API_KEY_LOOKUP_SCHEMA,
        key_id: keyId,
        project_id: safeProjectId,
        verifier,
      });
      wroteLookup = true;
      await putIndex(API_KEY_INDEX_NAMESPACES.project, [safeProjectId, keyId], {
        schema: API_KEY_PROJECT_INDEX_SCHEMA,
        project_id: safeProjectId,
        key_id: keyId,
      });
      wroteProjectEntry = true;
    } catch (error) {
      // A partially-created secret is never returned. Best-effort cleanup
      // avoids an active but unrecoverable credential after a KV write failure.
      const cleanups = [];
      if (wroteProjectEntry) cleanups.push(removeIndex(API_KEY_INDEX_NAMESPACES.project, safeProjectId, keyId));
      if (wroteLookup) cleanups.push(removeIndex(API_KEY_INDEX_NAMESPACES.lookup, lookupSegment(verifier)));
      if (wroteKey) cleanups.push(removeIndex(API_KEY_INDEX_NAMESPACES.key, keyId));
      await Promise.allSettled(cleanups);
      throw error;
    }
    return { credential, metadata };
  }

  async function createKey(projectId, input = {}) {
    await ensureProjectExists(projectId);
    const payload = normalizeCreatePayload(input);
    const { credential, metadata } = await createKeyInternal(projectId, payload);
    return { api_key: credential, key: publicKey(metadata) };
  }

  async function listKeys(projectId, options = {}) {
    const safeProjectId = assertProjectId(projectId);
    const { limit, cursor } = normalizeKeyListOptions(options);
    await ensureProjectExists(safeProjectId);
    let page;
    try {
      page = await index.list(API_KEY_INDEX_NAMESPACES.project, {
        prefixSegments: [safeProjectId],
        limit,
        cursor,
      });
    } catch (error) {
      throw indexFailure('list', error);
    }
    if (!page || !Array.isArray(page.keys) || typeof page.list_complete !== 'boolean') {
      throw new CloudAdapterError('cloud_api_key_invalid_page', 'Developer key list state is invalid.', { status: 500 });
    }
    const prefix = index.key(API_KEY_INDEX_NAMESPACES.project, safeProjectId);
    const keys = await Promise.all(page.keys.map(async (entry) => {
      const name = String(entry?.name || '');
      if (!name.startsWith(`${prefix}:`)) {
        throw new CloudAdapterError('cloud_api_key_invalid_page', 'Developer key list state is invalid.', { status: 500 });
      }
      const keyId = name.slice(prefix.length + 1);
      try {
        assertApiKeyId(keyId);
      } catch (_) {
        throw new CloudAdapterError('cloud_api_key_invalid_page', 'Developer key list state is invalid.', { status: 500 });
      }
      const projectEntryValue = await getIndex(API_KEY_INDEX_NAMESPACES.project, safeProjectId, keyId);
      if (projectEntryValue === null) return null;
      const projectEntry = normalizeProjectEntry(projectEntryValue);
      if (projectEntry.project_id !== safeProjectId || projectEntry.key_id !== keyId) {
        throw new CloudAdapterError('cloud_api_key_invalid_record', 'Developer key control-plane state is invalid.', { status: 500 });
      }
      const metadata = await readKey(keyId);
      return metadata && metadata.project_id === safeProjectId ? publicKey(metadata) : null;
    }));
    const hasMore = !page.list_complete;
    if (hasMore && (typeof page.cursor !== 'string' || !page.cursor)) {
      throw new CloudAdapterError('cloud_api_key_invalid_page', 'Developer key list state is invalid.', { status: 500 });
    }
    return {
      data: keys.filter(Boolean).sort((left, right) => left.key_id.localeCompare(right.key_id)),
      limit,
      order: 'key_id:asc',
      ...(hasMore ? { next_cursor: encodeKeyListCursor(page.cursor) } : {}),
      has_more: hasMore,
    };
  }

  async function revokeKey(projectId, keyId) {
    await ensureProjectExists(projectId);
    const metadata = await scopedKey(projectId, keyId);
    if (metadata.status === 'revoked') return publicKey(metadata);
    const timestamp = toIsoTimestamp(now);
    const revoked = {
      ...metadata,
      status: 'revoked',
      updated_at: timestamp,
      revoked_at: timestamp,
    };
    await putIndex(API_KEY_INDEX_NAMESPACES.key, [metadata.key_id], revoked);
    // Status is checked after lookup, so failure to remove a stale lookup does
    // not restore access. KV propagation still bounds real-world revocation.
    try {
      const segments = [lookupSegment(metadata.verifier), legacyLookupSegment(metadata.verifier)].filter(Boolean);
      await Promise.allSettled(segments.map((segment) => removeIndex(API_KEY_INDEX_NAMESPACES.lookup, segment)));
    } catch (_) { /* safe best-effort lookup cleanup */ }
    return publicKey(revoked);
  }

  async function rotateKey(projectId, keyId, input = {}) {
    await ensureProjectExists(projectId);
    const current = await scopedKey(projectId, keyId);
    if (current.status !== 'active') {
      throw new CloudConflictError('api_key_not_active', 'Only active API keys can be rotated.');
    }
    const payload = normalizeCreatePayload(input, {
      fallbackLabel: current.label,
      fallbackScopes: current.scopes,
    });
    const replacement = await createKeyInternal(projectId, payload, { rotatedFrom: current.key_id });
    try {
      await revokeKey(projectId, current.key_id);
    } catch (error) {
      // Do not leave a successful-looking rotation with both credentials live.
      // If cleanup itself fails, the unreturned replacement remains visible to
      // an administrator and can be revoked through the normal route.
      try { await revokeKey(projectId, replacement.metadata.key_id); } catch (_) { /* best effort */ }
      throw error;
    }
    return { api_key: replacement.credential, key: publicKey(replacement.metadata) };
  }

  async function authenticate(credential) {
    const parsed = parseDeveloperApiKey(credential);
    if (!parsed) {
      throw new CloudUnauthorizedError('invalid_api_key', 'A valid developer API key is required.');
    }
    const verifier = await verifierFor(credential);
    const lookupValue = await readLookupForVerifier(verifier);
    if (lookupValue === null) {
      throw new CloudUnauthorizedError('invalid_api_key', 'A valid developer API key is required.');
    }
    const lookup = normalizeLookup(lookupValue);
    if (!equalBytes(lookup.verifier, verifier) || lookup.key_id !== parsed.key_id) {
      throw new CloudUnauthorizedError('invalid_api_key', 'A valid developer API key is required.');
    }
    const metadata = await readKey(lookup.key_id);
    if (!metadata || metadata.project_id !== lookup.project_id || !equalBytes(metadata.verifier, verifier)) {
      throw new CloudUnauthorizedError('invalid_api_key', 'A valid developer API key is required.');
    }
    if (!await verifyVerifier(credential, metadata.verifier)) {
      throw new CloudUnauthorizedError('invalid_api_key', 'A valid developer API key is required.');
    }
    if (metadata.status !== 'active') {
      // Deliberately indistinguishable from a malformed/nonexistent key.
      throw new CloudUnauthorizedError('invalid_api_key', 'A valid developer API key is required.');
    }
    const project = await projects.getProjectRecord(metadata.project_id, { includeDeleted: true });
    if (!project || project.status !== 'active') {
      throw new CloudForbiddenError('project_inactive', 'The project associated with this API key is not active.');
    }
    return Object.freeze({
      authentication: 'developer_api_key',
      project_id: metadata.project_id,
      key_id: metadata.key_id,
      scopes: [...metadata.scopes],
    });
  }

  return Object.freeze({
    createKey,
    listKeys,
    revokeKey,
    rotateKey,
    authenticate,
  });
}
