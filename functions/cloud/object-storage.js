import { createObjectStorageService } from './contracts.js';
import {
  CloudAdapterError,
  CloudConfigurationError,
  CloudConflictError,
  CloudNotFoundError,
  CloudRecoveryError,
  CloudRequestError,
  isTelegraphCloudError,
} from './errors.js';
import { createCloudIndexStore } from './index-store.js';
import {
  createObjectListIndex,
  parseObjectListQuery,
  resolveObjectListLimits,
  OBJECT_LIST_CURSOR_NAMESPACE,
  OBJECT_LIST_CURSOR_SCHEMA,
  OBJECT_LIST_INDEX_NAMESPACE,
  OBJECT_LIST_INDEX_SCHEMA,
} from './object-list-index.js';
import {
  createTelegramObjectStorageAdapter,
  TELEGRAM_OBJECT_EVENT_POINTER_PROVIDER,
  TELEGRAM_OBJECT_POINTER_PROVIDER,
} from './telegram-object-storage.js';
export {
  parseObjectListQuery,
  resolveObjectListLimits,
  OBJECT_LIST_CURSOR_SCHEMA,
  OBJECT_LIST_INDEX_SCHEMA,
} from './object-list-index.js';

import {
  CLOUD_LIMITS,
  assertBucketName,
  assertByteLength,
  assertIdempotencyKey,
  assertMimeType,
  assertObjectKey,
  assertProjectId,
  normalizeCustomMetadata,
} from './validation.js';

// The hard ceiling is the known Telegram getFile compatibility boundary. The
// lower default is intentional: this adapter currently needs a bounded buffer
// to make a SHA-256 ETag and a multipart Telegram document in one request.
export const DEFAULT_OBJECT_STORAGE_MAX_BYTES = 10 * 1024 * 1024;
export const OBJECT_STORAGE_LIMIT_ENV = 'TELEGRAPH_CLOUD_MAX_OBJECT_BYTES';
export const OBJECT_MANIFEST_SCHEMA = 'telegraph-cloud.object-manifest.v1';
export const OBJECT_REVISION_SCHEMA = 'telegraph-cloud.object-revision.v1';
export const OBJECT_REVISION_INDEX_SCHEMA = 'telegraph-cloud.object-revision-index.v1';
export const OBJECT_OUTBOX_SCHEMA = 'telegraph-cloud.object-outbox.v1';
export const OBJECT_BUCKET_SCHEMA = 'telegraph-cloud.object-bucket.v1';
export const OBJECT_INDEX_NAMESPACES = Object.freeze({
  manifest: 'object-manifest',
  revision: 'object-revision',
  outbox: 'object-outbox',
  bucket: 'object-bucket',
  list: OBJECT_LIST_INDEX_NAMESPACE,
  cursor: OBJECT_LIST_CURSOR_NAMESPACE,
});

const ACTIVE = 'active';
const DELETED = 'deleted';
const OUTBOX_INTENT = 'intent';
const OUTBOX_UPLOADED = 'uploaded';
const OUTBOX_READY = 'ready';
const OUTBOX_APPLIED = 'applied';
const OUTBOX_STATUS = new Set([OUTBOX_INTENT, OUTBOX_UPLOADED, OUTBOX_READY, OUTBOX_APPLIED]);
const OUTBOX_APPLIED_TTL_SECONDS = 7 * 24 * 60 * 60;
const CONTENT_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const KEY_HASH_PATTERN = /^objkey_[A-Za-z0-9_-]{43}$/;
const REVISION_ID_PATTERN = /^objrev_[A-Za-z0-9_-]{16,64}$/;
const MUTATION_ID_PATTERN = /^(?:objmut|objidem)_[A-Za-z0-9_-]{16,64}$/;
const STORAGE_POINTER_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const ETAG_PATTERN = /^sha256-[A-Za-z0-9_-]{43}-v[1-9][0-9]*$/;
const HEADER_ETAG_PATTERN = /^(W\/)?"([A-Za-z0-9._-]{1,160})"$/;
const encoder = new TextEncoder();

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function bytesToBase64url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function timestampFrom(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (!safeTimestamp(timestamp)) {
    throw new CloudConfigurationError('invalid_object_storage_clock', 'Object storage clock configuration is invalid.');
  }
  return timestamp;
}

function storageBackendFailure() {
  return new CloudAdapterError(
    'storage_backend_failure',
    'Object storage is temporarily unavailable.',
    { status: 503 },
  );
}

function corruptIndex() {
  return new CloudAdapterError(
    'object_manifest_invalid',
    'Object storage index state is invalid.',
    { status: 500 },
  );
}

function mapInputError(error, code, message, status) {
  if (isTelegraphCloudError(error)) {
    throw new CloudRequestError(code || error.code, message || error.message, { status });
  }
  throw error;
}

function normalizeBucket(value) {
  try {
    return assertBucketName(value);
  } catch (error) {
    return mapInputError(error, 'invalid_bucket_name', 'Invalid bucket name.', 422);
  }
}

function normalizeKey(value) {
  try {
    return assertObjectKey(value);
  } catch (error) {
    return mapInputError(error, 'invalid_object_key', 'Invalid object key.', 422);
  }
}

function normalizeContentType(value) {
  try {
    return assertMimeType(value);
  } catch (error) {
    return mapInputError(error, 'unsupported_media_type', 'Unsupported object Content-Type.', 415);
  }
}

function normalizeMetadata(value) {
  try {
    const metadata = normalizeCustomMetadata(value);
    return Object.fromEntries(Object.keys(metadata).sort().map((key) => [key, metadata[key]]));
  } catch (error) {
    if (isTelegraphCloudError(error)) throw error;
    throw error;
  }
}

function normalizeObjectBytes(value, maxBytes) {
  let bytes;
  if (value instanceof Uint8Array) {
    bytes = new Uint8Array(value);
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value.slice(0));
  } else if (ArrayBuffer.isView(value)) {
    bytes = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  } else {
    throw new CloudRequestError('invalid_object_body', 'Object body must be binary data.', { status: 400 });
  }
  try {
    assertByteLength(bytes.byteLength, { maxBytes });
  } catch (error) {
    return mapInputError(error, 'object_too_large', 'Object exceeds the supported size limit.', 413);
  }
  return bytes;
}

function normalizePointer(value, provider, { allowNull = false } = {}) {
  if (value === null && allowNull) return null;
  if (
    !plainObject(value)
    || value.provider !== provider
    || typeof value.file_id !== 'string'
    || !STORAGE_POINTER_FILE_ID_PATTERN.test(value.file_id)
    || !Number.isSafeInteger(value.message_id)
    || value.message_id < 1
  ) {
    throw corruptIndex();
  }
  return {
    provider,
    file_id: value.file_id,
    message_id: value.message_id,
  };
}

function transportPointer(pointer) {
  return {
    provider: pointer.provider,
    fileId: pointer.file_id,
    messageId: pointer.message_id,
  };
}

function storagePointer(pointer, provider) {
  if (
    !pointer
    || pointer.provider !== provider
    || typeof pointer.fileId !== 'string'
    || !STORAGE_POINTER_FILE_ID_PATTERN.test(pointer.fileId)
    || !Number.isSafeInteger(pointer.messageId)
    || pointer.messageId < 1
  ) {
    throw storageBackendFailure();
  }
  return {
    provider,
    file_id: pointer.fileId,
    message_id: pointer.messageId,
  };
}

function objectEtag(contentHash, version) {
  return `sha256-${contentHash}-v${version}`;
}

function publicObject(manifest) {
  return Object.freeze({
    bucket: manifest.bucket,
    key: manifest.key,
    size: manifest.size,
    content_type: manifest.content_type,
    etag: manifest.etag,
    version: manifest.version,
    created_at: manifest.created_at,
    updated_at: manifest.updated_at,
    metadata: Object.freeze({ ...manifest.metadata }),
  });
}

function publicDeletion(manifest) {
  return Object.freeze({
    bucket: manifest.bucket,
    key: manifest.key,
    version: manifest.version,
    deleted: true,
    deleted_at: manifest.deleted_at,
  });
}

function normalizeManifest(value, { allowMissingStorage = false, allowMissingEvent = false } = {}) {
  try {
    if (!plainObject(value) || value.schema !== OBJECT_MANIFEST_SCHEMA) throw new Error('schema');
    const projectId = assertProjectId(value.project_id);
    const bucket = assertBucketName(value.bucket);
    const key = assertObjectKey(value.key);
    if (typeof value.key_hash !== 'string' || !KEY_HASH_PATTERN.test(value.key_hash)) throw new Error('key hash');
    if (value.state !== ACTIVE && value.state !== DELETED) throw new Error('state');
    if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Error('version');
    if (typeof value.revision_id !== 'string' || !REVISION_ID_PATTERN.test(value.revision_id)) throw new Error('revision');
    const parent = value.parent_revision_id === null ? null : value.parent_revision_id;
    if (parent !== null && (typeof parent !== 'string' || !REVISION_ID_PATTERN.test(parent) || parent === value.revision_id)) {
      throw new Error('parent');
    }
    if (typeof value.content_sha256 !== 'string' || !CONTENT_HASH_PATTERN.test(value.content_sha256)) throw new Error('digest');
    if (typeof value.etag !== 'string' || value.etag !== objectEtag(value.content_sha256, value.version) || !ETAG_PATTERN.test(value.etag)) {
      throw new Error('etag');
    }
    assertByteLength(value.size, { maxBytes: CLOUD_LIMITS.MAX_OBJECT_BYTES });
    const contentType = assertMimeType(value.content_type);
    const metadata = normalizeCustomMetadata(value.metadata);
    if (!safeTimestamp(value.created_at) || !safeTimestamp(value.updated_at)
      || Date.parse(value.updated_at) < Date.parse(value.created_at)) {
      throw new Error('timestamp');
    }
    const deletedAt = value.deleted_at === undefined ? undefined : value.deleted_at;
    if (value.state === DELETED) {
      if (!safeTimestamp(deletedAt) || deletedAt !== value.updated_at) throw new Error('tombstone');
    } else if (deletedAt !== undefined) {
      throw new Error('active tombstone');
    }
    const pointer = normalizePointer(value.storage, TELEGRAM_OBJECT_POINTER_PROVIDER, {
      allowNull: allowMissingStorage && value.state === ACTIVE,
    });
    const event = normalizePointer(value.event, TELEGRAM_OBJECT_EVENT_POINTER_PROVIDER, {
      allowNull: allowMissingEvent,
    });
    if (value.state === DELETED && pointer === null) throw new Error('tombstone pointer');
    if (!allowMissingStorage && pointer === null) throw new Error('storage pointer');
    if (!allowMissingEvent && event === null) throw new Error('event pointer');
    return {
      schema: OBJECT_MANIFEST_SCHEMA,
      project_id: projectId,
      bucket,
      key,
      key_hash: value.key_hash,
      state: value.state,
      version: value.version,
      revision_id: value.revision_id,
      parent_revision_id: parent,
      content_sha256: value.content_sha256,
      etag: value.etag,
      size: value.size,
      content_type: contentType,
      metadata: Object.fromEntries(Object.keys(metadata).sort().map((name) => [name, metadata[name]])),
      created_at: value.created_at,
      updated_at: value.updated_at,
      ...(deletedAt ? { deleted_at: deletedAt } : {}),
      storage: pointer,
      event,
    };
  } catch (_) {
    throw corruptIndex();
  }
}

function normalizeRevisionRecord(value) {
  try {
    if (!plainObject(value) || value.schema !== OBJECT_REVISION_INDEX_SCHEMA) throw new Error('schema');
    const projectId = assertProjectId(value.project_id);
    const manifest = normalizeManifest(value.manifest);
    if (manifest.project_id !== projectId || !safeTimestamp(value.recorded_at)) throw new Error('revision');
    return {
      schema: OBJECT_REVISION_INDEX_SCHEMA,
      project_id: projectId,
      manifest,
      recorded_at: value.recorded_at,
    };
  } catch (_) {
    throw corruptIndex();
  }
}

function sameRevision(left, right) {
  // Both values have passed normalizeManifest, which rebuilds fields and sorted
  // metadata in one canonical order. Treat every persisted field as immutable;
  // a random revision-ID collision must never silently overwrite metadata,
  // timestamps, tombstone state, or an internal event/byte pointer.
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeBucketRecord(value) {
  try {
    if (!plainObject(value) || value.schema !== OBJECT_BUCKET_SCHEMA) throw new Error('schema');
    const projectId = assertProjectId(value.project_id);
    const bucket = assertBucketName(value.bucket);
    if (!safeTimestamp(value.created_at) || !safeTimestamp(value.updated_at)
      || Date.parse(value.updated_at) < Date.parse(value.created_at)) {
      throw new Error('timestamp');
    }
    return {
      schema: OBJECT_BUCKET_SCHEMA,
      project_id: projectId,
      bucket,
      created_at: value.created_at,
      updated_at: value.updated_at,
    };
  } catch (_) {
    throw corruptIndex();
  }
}

function normalizeOutbox(value) {
  try {
    if (!plainObject(value) || value.schema !== OBJECT_OUTBOX_SCHEMA) throw new Error('schema');
    const projectId = assertProjectId(value.project_id);
    if (typeof value.mutation_id !== 'string' || !MUTATION_ID_PATTERN.test(value.mutation_id)) throw new Error('mutation');
    if (typeof value.request_fingerprint !== 'string' || !CONTENT_HASH_PATTERN.test(value.request_fingerprint)) throw new Error('fingerprint');
    if (value.operation !== 'put' && value.operation !== 'delete') throw new Error('operation');
    if (!OUTBOX_STATUS.has(value.status)) throw new Error('status');
    const candidate = normalizeManifest(value.candidate, {
      allowMissingStorage: value.status === OUTBOX_INTENT && value.operation === 'put',
      allowMissingEvent: value.status === OUTBOX_INTENT || value.status === OUTBOX_UPLOADED,
    });
    if (candidate.project_id !== projectId) throw new Error('project');
    if (value.operation === 'put' && candidate.state !== ACTIVE) throw new Error('put state');
    if (value.operation === 'delete' && candidate.state !== DELETED) throw new Error('delete state');
    if (value.status === OUTBOX_INTENT && (
      candidate.event !== null
      || (value.operation === 'put' && candidate.storage !== null)
      || (value.operation === 'delete' && candidate.storage === null)
    )) {
      throw new Error('intent state');
    }
    if (value.status === OUTBOX_UPLOADED && (value.operation !== 'put' || candidate.storage === null || candidate.event !== null)) {
      throw new Error('uploaded state');
    }
    if ((value.status === OUTBOX_READY || value.status === OUTBOX_APPLIED) && (candidate.storage === null || candidate.event === null)) {
      throw new Error('ready pointers');
    }
    if (![200, 201].includes(value.response_status)) throw new Error('status code');
    if (!safeTimestamp(value.created_at) || !safeTimestamp(value.updated_at)
      || Date.parse(value.updated_at) < Date.parse(value.created_at)) {
      throw new Error('timestamp');
    }
    return {
      schema: OBJECT_OUTBOX_SCHEMA,
      project_id: projectId,
      mutation_id: value.mutation_id,
      request_fingerprint: value.request_fingerprint,
      operation: value.operation,
      status: value.status,
      candidate,
      response_status: value.response_status,
      created_at: value.created_at,
      updated_at: value.updated_at,
    };
  } catch (_) {
    throw corruptIndex();
  }
}

function defaultCreateId(prefix) {
  if (!globalThis.crypto || typeof globalThis.crypto.getRandomValues !== 'function') {
    throw new CloudConfigurationError('object_storage_randomness_unavailable', 'Object storage randomness is unavailable.');
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}${bytesToBase64url(bytes)}`;
}

function generatedId(createId, prefix, pattern) {
  try {
    const value = createId(prefix);
    if (typeof value !== 'string' || !pattern.test(value)) throw new Error('invalid id');
    return value;
  } catch (error) {
    if (isTelegraphCloudError(error)) throw error;
    throw new CloudConfigurationError('object_storage_id_generation_unavailable', 'Object storage identifier generation is unavailable.');
  }
}

async function sha256(value, cryptoApi) {
  if (!cryptoApi || !cryptoApi.subtle || typeof cryptoApi.subtle.digest !== 'function') {
    throw new CloudConfigurationError('object_storage_crypto_unavailable', 'Object storage hashing is unavailable.');
  }
  let bytes;
  if (typeof value === 'string') bytes = encoder.encode(value);
  else if (value instanceof Uint8Array) bytes = value;
  else bytes = new Uint8Array(value);
  try {
    const digest = await cryptoApi.subtle.digest('SHA-256', bytes);
    return bytesToBase64url(new Uint8Array(digest));
  } catch (_) {
    throw new CloudConfigurationError('object_storage_crypto_unavailable', 'Object storage hashing is unavailable.');
  }
}

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_OBJECT_STORAGE_MAX_BYTES;
  const parsed = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > CLOUD_LIMITS.MAX_OBJECT_BYTES) {
    throw new CloudConfigurationError('invalid_object_storage_limit', 'Object storage size limit is invalid.');
  }
  return parsed;
}

/** Returns the bounded request-body limit used by the current Telegram adapter. */
export function resolveObjectStorageLimits(env = {}) {
  return Object.freeze({ maxObjectBytes: normalizeLimit(env?.[OBJECT_STORAGE_LIMIT_ENV]) });
}

function normalizeEntityTags(value, headerName) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new CloudRequestError('invalid_precondition', `Invalid ${headerName} header.`, { status: 400 });
  }
  const rawTags = value.split(',').map((item) => item.trim());
  if (rawTags.length === 0 || rawTags.some((item) => !item)) {
    throw new CloudRequestError('invalid_precondition', `Invalid ${headerName} header.`, { status: 400 });
  }
  if (rawTags.length === 1 && rawTags[0] === '*') return Object.freeze({ wildcard: true, tags: [] });
  if (rawTags.includes('*')) {
    throw new CloudRequestError('invalid_precondition', `Invalid ${headerName} header.`, { status: 400 });
  }
  const tags = rawTags.map((item) => {
    const match = HEADER_ETAG_PATTERN.exec(item);
    if (!match) {
      throw new CloudRequestError('invalid_precondition', `Invalid ${headerName} header.`, { status: 400 });
    }
    return Object.freeze({ weak: Boolean(match[1]), value: match[2] });
  });
  return Object.freeze({ wildcard: false, tags: Object.freeze(tags) });
}

function normalizedHttpDate(value, headerName) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 1024) {
    throw new CloudRequestError('invalid_precondition', `Invalid ${headerName} header.`, { status: 400 });
  }
  const parsed = Date.parse(value);
  // HTTP date parsing is deliberately forgiving: an invalid date is ignored
  // rather than becoming an authorization or visibility control.
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : null;
}

function normalizeWriteConditions(input = {}) {
  if (!plainObject(input)) {
    throw new CloudRequestError('invalid_precondition', 'Object preconditions are invalid.', { status: 400 });
  }
  const ifMatch = normalizeEntityTags(input.ifMatch, 'If-Match');
  const ifNoneMatch = normalizeEntityTags(input.ifNoneMatch, 'If-None-Match');
  if (ifMatch && ifNoneMatch) {
    throw new CloudRequestError('invalid_precondition', 'If-Match and If-None-Match cannot be combined.', { status: 400 });
  }
  return Object.freeze({
    ifMatch,
    ifNoneMatch,
    ifUnmodifiedSince: normalizedHttpDate(input.ifUnmodifiedSince, 'If-Unmodified-Since'),
  });
}

function normalizeReadConditions(input = {}) {
  if (!plainObject(input)) {
    throw new CloudRequestError('invalid_precondition', 'Object read preconditions are invalid.', { status: 400 });
  }
  return Object.freeze({
    ifMatch: normalizeEntityTags(input.ifMatch, 'If-Match'),
    ifUnmodifiedSince: normalizedHttpDate(input.ifUnmodifiedSince, 'If-Unmodified-Since'),
    ifNoneMatch: normalizeEntityTags(input.ifNoneMatch, 'If-None-Match'),
    ifModifiedSince: normalizedHttpDate(input.ifModifiedSince, 'If-Modified-Since'),
  });
}

function tagMatches(condition, etag, { strong = false } = {}) {
  if (!condition) return false;
  if (condition.wildcard) return true;
  return condition.tags.some((tag) => tag.value === etag && (!strong || !tag.weak));
}

function modificationSecond(manifest) {
  return Math.floor(Date.parse(manifest.updated_at) / 1000);
}

function assertWritePreconditions(current, conditions) {
  const active = current?.state === ACTIVE;
  if (conditions.ifMatch && (!active || !tagMatches(conditions.ifMatch, current.etag, { strong: true }))) {
    throw new CloudRequestError('precondition_failed', 'Object precondition did not match.', { status: 412 });
  }
  // RFC precedence ignores If-Unmodified-Since when If-Match was supplied.
  if (!conditions.ifMatch && conditions.ifUnmodifiedSince !== null && active
    && modificationSecond(current) > conditions.ifUnmodifiedSince) {
    throw new CloudRequestError('precondition_failed', 'Object precondition did not match.', { status: 412 });
  }
  if (conditions.ifNoneMatch && active && tagMatches(conditions.ifNoneMatch, current.etag)) {
    throw new CloudRequestError('precondition_failed', 'Object precondition did not match.', { status: 412 });
  }
}

function assertReadPreconditions(manifest, conditions) {
  if (conditions.ifMatch && !tagMatches(conditions.ifMatch, manifest.etag, { strong: true })) {
    throw new CloudRequestError('precondition_failed', 'Object precondition did not match.', { status: 412 });
  }
  // RFC precedence ignores If-Unmodified-Since when If-Match was supplied.
  if (!conditions.ifMatch && conditions.ifUnmodifiedSince !== null
    && modificationSecond(manifest) > conditions.ifUnmodifiedSince) {
    throw new CloudRequestError('precondition_failed', 'Object precondition did not match.', { status: 412 });
  }
  if (conditions.ifNoneMatch) return tagMatches(conditions.ifNoneMatch, manifest.etag);
  if (conditions.ifModifiedSince === null) return false;
  return modificationSecond(manifest) <= conditions.ifModifiedSince;
}

function rangeNotSatisfiable(size) {
  return new CloudRequestError('range_not_satisfiable', 'The requested object range is not satisfiable.', {
    status: 416,
    details: { object_size: size },
  });
}

function safeRangeInteger(value) {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Parse only a single RFC-style bytes range after the active manifest is known. */
function normalizeByteRange(value, size) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > CLOUD_LIMITS.MAX_OBJECT_RANGE_HEADER_BYTES || size < 1) {
    throw rangeNotSatisfiable(size);
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2])) throw rangeNotSatisfiable(size);
  const start = match[1] ? safeRangeInteger(match[1]) : null;
  const end = match[2] ? safeRangeInteger(match[2]) : null;
  if ((match[1] && start === null) || (match[2] && end === null)) throw rangeNotSatisfiable(size);

  let first;
  let last;
  if (start === null) {
    if (end === 0) throw rangeNotSatisfiable(size);
    first = end >= size ? 0 : size - end;
    last = size - 1;
  } else {
    if (start >= size) throw rangeNotSatisfiable(size);
    first = start;
    last = end === null ? size - 1 : Math.min(end, size - 1);
    if (last < first) throw rangeNotSatisfiable(size);
  }
  return Object.freeze({
    start: first,
    end: last,
    size,
    length: last - first + 1,
  });
}

function validatePartialResponse(response, range) {
  if (!response || response.status !== 206) {
    throw new CloudAdapterError('storage_range_unavailable', 'Object range retrieval is temporarily unavailable.', { status: 502 });
  }
  const expectedRange = `bytes ${range.start}-${range.end}/${range.size}`;
  const upstreamLength = response.headers?.get?.('Content-Length');
  if (response.headers?.get?.('Content-Range') !== expectedRange
    || (upstreamLength !== null && upstreamLength !== String(range.length))) {
    throw new CloudAdapterError('storage_range_unavailable', 'Object range retrieval is temporarily unavailable.', { status: 502 });
  }
}

function idempotencyFingerprintPayload({ operation, bucket, key, contentHash, size, contentType, metadata }) {
  return JSON.stringify({
    v: 1,
    operation,
    bucket,
    key,
    ...(operation === 'put' ? {
      content_sha256: contentHash,
      size,
      content_type: contentType,
      metadata,
    } : {}),
  });
}

function ensureServiceDependencies(index, transport) {
  if (
    !index
    || typeof index.key !== 'function'
    || typeof index.getJson !== 'function'
    || typeof index.putJson !== 'function'
    || typeof index.remove !== 'function'
    || typeof index.list !== 'function'
    || typeof index.listWithSuffix !== 'function'
    || !transport
    || typeof transport.putObject !== 'function'
    || typeof transport.appendEvent !== 'function'
    || typeof transport.getObject !== 'function'
    || typeof transport.headObject !== 'function'
    || typeof transport.deleteObject !== 'function'
  ) {
    throw new CloudConfigurationError('object_storage_service_unavailable', 'Object storage service is unavailable.');
  }
}

/**
 * Creates a project-bound generic object service. The project id is supplied
 * only by trusted server composition (the API-key middleware); none of its
 * methods accept a caller-selected project id. Telegram is used only through
 * the injected object byte transport, while Cloudflare KV holds a repairable
 * current manifest, bucket marker, and small mutation outbox.
 */
export function createTelegramObjectStorage(env, {
  projectId,
  index = createCloudIndexStore(env),
  transport = createTelegramObjectStorageAdapter(env),
  now = () => new Date(),
  createId = defaultCreateId,
  cryptoApi = globalThis.crypto,
} = {}) {
  const safeProjectId = assertProjectId(projectId);
  ensureServiceDependencies(index, transport);
  const limits = Object.freeze({
    ...resolveObjectStorageLimits(env),
    ...resolveObjectListLimits(env),
  });

  async function digest(value) {
    return sha256(value, cryptoApi);
  }

  async function keyHash(key) {
    return `objkey_${await digest(`telegraph-cloud.object-key.v1\u0000${key}`)}`;
  }

  async function manifestLocation(bucket, key) {
    const safeBucket = normalizeBucket(bucket);
    const safeKey = normalizeKey(key);
    return { bucket: safeBucket, key: safeKey, keyHash: await keyHash(safeKey) };
  }

  async function indexGet(namespace, ...segments) {
    try {
      return await index.getJson(namespace, ...segments);
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw storageBackendFailure();
    }
  }

  async function indexPut(namespace, segments, value, options) {
    try {
      await index.putJson(namespace, segments, value, options);
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw storageBackendFailure();
    }
  }

  async function readManifest(location) {
    const value = await indexGet(OBJECT_INDEX_NAMESPACES.manifest, safeProjectId, location.bucket, location.keyHash);
    if (value === null) return null;
    const manifest = normalizeManifest(value);
    if (
      manifest.project_id !== safeProjectId
      || manifest.bucket !== location.bucket
      || manifest.key !== location.key
      || manifest.key_hash !== location.keyHash
    ) {
      throw corruptIndex();
    }
    return manifest;
  }

  async function writeManifest(manifest) {
    await indexPut(
      OBJECT_INDEX_NAMESPACES.manifest,
      [safeProjectId, manifest.bucket, manifest.key_hash],
      manifest,
    );
  }

  const objectListIndex = createObjectListIndex({
    env,
    index,
    projectId: safeProjectId,
    now,
    createId,
    cryptoApi,
    readManifest,
    publicObject,
  });

  async function persistRevision(manifest) {
    const existingValue = await indexGet(OBJECT_INDEX_NAMESPACES.revision, safeProjectId, manifest.revision_id);
    if (existingValue !== null) {
      const existing = normalizeRevisionRecord(existingValue);
      if (existing.project_id !== safeProjectId || !sameRevision(existing.manifest, manifest)) throw corruptIndex();
      return existing;
    }
    const record = {
      schema: OBJECT_REVISION_INDEX_SCHEMA,
      project_id: safeProjectId,
      manifest,
      recorded_at: timestampFrom(now),
    };
    await indexPut(OBJECT_INDEX_NAMESPACES.revision, [safeProjectId, manifest.revision_id], record);
    return record;
  }

  async function readOutbox(mutationId) {
    const value = await indexGet(OBJECT_INDEX_NAMESPACES.outbox, safeProjectId, mutationId);
    if (value === null) return null;
    const mutation = normalizeOutbox(value);
    if (mutation.project_id !== safeProjectId || mutation.mutation_id !== mutationId) throw corruptIndex();
    return mutation;
  }

  async function writeOutbox(mutation, { applied = false } = {}) {
    await indexPut(
      OBJECT_INDEX_NAMESPACES.outbox,
      [safeProjectId, mutation.mutation_id],
      mutation,
      applied ? { expirationTtl: OUTBOX_APPLIED_TTL_SECONDS } : undefined,
    );
  }

  async function ensureBucket(manifest) {
    const value = await indexGet(OBJECT_INDEX_NAMESPACES.bucket, safeProjectId, manifest.bucket);
    if (value !== null) {
      const record = normalizeBucketRecord(value);
      if (record.project_id !== safeProjectId || record.bucket !== manifest.bucket) throw corruptIndex();
      return record;
    }
    const timestamp = timestampFrom(now);
    const bucket = {
      schema: OBJECT_BUCKET_SCHEMA,
      project_id: safeProjectId,
      bucket: manifest.bucket,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await indexPut(OBJECT_INDEX_NAMESPACES.bucket, [safeProjectId, manifest.bucket], bucket);
    return bucket;
  }

  async function allocateMutationId(idempotencyKey) {
    if (idempotencyKey) {
      const token = await digest(`telegraph-cloud.object-idempotency.v1\u0000${safeProjectId}\u0000${idempotencyKey}`);
      return `objidem_${token}`;
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generatedId(createId, 'objmut_', MUTATION_ID_PATTERN);
      if (!await readOutbox(candidate)) return candidate;
    }
    throw new CloudAdapterError('object_mutation_id_allocation_failed', 'Object storage is temporarily unavailable.', { status: 503 });
  }

  async function allocateRevisionId() {
    // Revision ids are random opaque identifiers, but checking the immutable
    // revision namespace makes a faulty/injected generator fail safely instead
    // of reusing a previous event pointer.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generatedId(createId, 'objrev_', REVISION_ID_PATTERN);
      const existing = await indexGet(OBJECT_INDEX_NAMESPACES.revision, safeProjectId, candidate);
      if (existing === null) return candidate;
    }
    throw new CloudAdapterError('object_revision_id_allocation_failed', 'Object storage is temporarily unavailable.', { status: 503 });
  }

  async function initialMutation({ operation, location, mutationId, fingerprint, current, contentHash, size, contentType, metadata }) {
    const timestamp = timestampFrom(now);
    const revisionId = await allocateRevisionId();
    const version = current ? current.version + 1 : 1;
    const candidate = {
      schema: OBJECT_MANIFEST_SCHEMA,
      project_id: safeProjectId,
      bucket: location.bucket,
      key: location.key,
      key_hash: location.keyHash,
      state: operation === 'put' ? ACTIVE : DELETED,
      version,
      revision_id: revisionId,
      parent_revision_id: current ? current.revision_id : null,
      content_sha256: operation === 'put' ? contentHash : current.content_sha256,
      etag: objectEtag(operation === 'put' ? contentHash : current.content_sha256, version),
      size: operation === 'put' ? size : current.size,
      content_type: operation === 'put' ? contentType : current.content_type,
      metadata: operation === 'put' ? metadata : current.metadata,
      // A logically recreated object has a new creation time; a replacement or
      // tombstone retains the creation timestamp of its currently visible one.
      created_at: operation === 'put' && current?.state !== ACTIVE ? timestamp : (current?.created_at || timestamp),
      updated_at: timestamp,
      ...(operation === 'delete' ? { deleted_at: timestamp } : {}),
      storage: operation === 'put' ? null : current.storage,
      event: null,
    };
    return {
      schema: OBJECT_OUTBOX_SCHEMA,
      project_id: safeProjectId,
      mutation_id: mutationId,
      request_fingerprint: fingerprint,
      operation,
      status: OUTBOX_INTENT,
      candidate,
      response_status: operation === 'put' && current?.state !== ACTIVE ? 201 : 200,
      created_at: timestamp,
      updated_at: timestamp,
    };
  }

  async function buildOrLoadMutation({ operation, location, fingerprint, currentInput, conditions, contentHash, size, contentType, metadata, idempotencyKey }) {
    const mutationId = await allocateMutationId(idempotencyKey);
    const existing = await readOutbox(mutationId);
    if (existing) {
      if (existing.operation !== operation || existing.request_fingerprint !== fingerprint
        || existing.candidate.bucket !== location.bucket || existing.candidate.key !== location.key
        || existing.candidate.key_hash !== location.keyHash) {
        throw new CloudConflictError('idempotency_key_reused', 'Idempotency-Key was already used for a different object mutation.');
      }
      return existing;
    }

    const current = currentInput || await readManifest(location);
    assertWritePreconditions(current, conditions);
    // The mutation id is either a fresh opaque value or a digest of the
    // optional Idempotency-Key. The raw caller header is never persisted.
    const mutation = await initialMutation({
      operation,
      location,
      mutationId,
      fingerprint,
      current,
      contentHash,
      size,
      contentType,
      metadata,
    });
    await writeOutbox(mutation);
    return mutation;
  }

  async function materializeCandidate(candidate) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const location = { bucket: candidate.bucket, key: candidate.key, keyHash: candidate.key_hash };
      const current = await readManifest(location);
      if (current?.revision_id === candidate.revision_id) return current;

      const sameParentFork = current
        && current.version === candidate.version
        && current.parent_revision_id === candidate.parent_revision_id;
      if (sameParentFork) {
        // KV lacks cross-edge compare-and-swap. Choosing the lexically smaller
        // opaque revision is deterministic and lets the loser report conflict
        // instead of silently claiming it overwrote the winner.
        if (current.revision_id.localeCompare(candidate.revision_id) < 0) {
          throw new CloudConflictError('object_conflict', 'A concurrent object mutation won the materialization race.');
        }
        await writeManifest(candidate);
        continue;
      }

      const expectedParent = current ? current.revision_id : null;
      const expectedVersion = current ? current.version + 1 : 1;
      if (candidate.parent_revision_id !== expectedParent || candidate.version !== expectedVersion) {
        throw new CloudConflictError('object_conflict', 'The object changed before this mutation could be materialized.');
      }
      await writeManifest(candidate);
    }
    throw new CloudRecoveryError('object_mutation_pending', 'Object mutation is pending index recovery.');
  }

  function objectRevisionEvent(candidate, operation) {
    return {
      schema: OBJECT_REVISION_SCHEMA,
      event_id: candidate.revision_id,
      project_id: candidate.project_id,
      bucket: candidate.bucket,
      key: candidate.key,
      operation,
      version: candidate.version,
      parent_revision_id: candidate.parent_revision_id,
      created_at: candidate.updated_at,
      object: {
        etag: candidate.etag,
        content_sha256: candidate.content_sha256,
        size: candidate.size,
        content_type: candidate.content_type,
        metadata: candidate.metadata,
        // This pointer is Telegram-internal event data only. It is not copied
        // to any HTTP response and lets an operator/recovery tool associate an
        // immutable byte document with this immutable revision event.
        storage: candidate.storage,
      },
    };
  }

  async function appendRevisionEvent(candidate, operation) {
    try {
      const pointer = await transport.appendEvent(objectRevisionEvent(candidate, operation));
      return storagePointer(pointer, TELEGRAM_OBJECT_EVENT_POINTER_PROVIDER);
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw storageBackendFailure();
    }
  }

  async function markUploaded(mutation, candidate) {
    const uploaded = {
      ...mutation,
      status: OUTBOX_UPLOADED,
      candidate,
      updated_at: timestampFrom(now),
    };
    try {
      await writeOutbox(uploaded);
    } catch (error) {
      // Bytes may be in Telegram while their pointer is not yet durable in KV.
      // A same-key retry with the original body may create a retained duplicate,
      // but it will never expose a false successful object response.
      if (isTelegraphCloudError(error)) {
        throw new CloudRecoveryError('object_mutation_pending', 'Object mutation is pending index recovery.');
      }
      throw error;
    }
    return uploaded;
  }

  async function markReady(mutation, candidate) {
    const ready = {
      ...mutation,
      status: OUTBOX_READY,
      candidate,
      updated_at: timestampFrom(now),
    };
    try {
      await writeOutbox(ready);
    } catch (error) {
      // Telegram may already have accepted immutable bytes or an event. The
      // staged outbox remains retryable; never report a false successful PUT.
      if (isTelegraphCloudError(error)) {
        throw new CloudRecoveryError('object_mutation_pending', 'Object mutation is pending index recovery.');
      }
      throw error;
    }
    return ready;
  }

  async function markApplied(mutation, candidate) {
    const applied = {
      ...mutation,
      status: OUTBOX_APPLIED,
      candidate,
      updated_at: timestampFrom(now),
    };
    try {
      await writeOutbox(applied, { applied: true });
      return applied;
    } catch (_) {
      // The current manifest is already visible. Leaving a ready outbox is a
      // safe, retryable condition rather than turning a completed object write
      // into an ambiguous failure for the caller.
      return mutation;
    }
  }

  async function applyReadyMutation(mutation) {
    const candidate = normalizeManifest(mutation.candidate);
    let materialized;
    try {
      // The event's internal pointer is first retained in an append-only KV
      // revision record, then materialized as current state. A later current
      // manifest write failure therefore has a bounded recovery trail.
      await persistRevision(candidate);
      materialized = await materializeCandidate(candidate);
      if (materialized.state === ACTIVE) await ensureBucket(materialized);
      // The secondary key-order index is derived from the authoritative current
      // manifest. It is replay-safe from a ready outbox and never becomes a
      // public source of truth when it lags a direct manifest read.
      await objectListIndex.materialize(materialized);
    } catch (error) {
      if (error instanceof CloudConflictError || error instanceof CloudRequestError || error instanceof CloudNotFoundError) {
        throw error;
      }
      if (error instanceof CloudRecoveryError) throw error;
      if (isTelegraphCloudError(error)) {
        throw new CloudRecoveryError('object_mutation_pending', 'Object mutation is pending index recovery.');
      }
      throw error;
    }

    if (mutation.operation === 'delete') {
      // The byte adapter makes this retention policy explicit and does not call
      // Telegram deleteMessage. A logical tombstone is authoritative here.
      try { await transport.deleteObject(transportPointer(materialized.storage)); } catch (_) { /* no physical delete promised */ }
    }
    await markApplied(mutation, materialized);
    return materialized;
  }

  async function resumePutMutation(mutation, body, contentType) {
    if (mutation.status === OUTBOX_APPLIED) return mutation.candidate;
    if (mutation.status === OUTBOX_READY) return applyReadyMutation(mutation);

    let uploaded = mutation;
    if (mutation.status === OUTBOX_INTENT) {
      if (!(body instanceof Uint8Array)) {
        throw new CloudRecoveryError('object_mutation_requires_retry_body', 'Object mutation requires the original request body to recover.');
      }
      let pointer;
      try {
        pointer = await transport.putObject({ body, contentType });
      } catch (error) {
        if (isTelegraphCloudError(error)) throw error;
        throw storageBackendFailure();
      }
      const candidate = {
        ...mutation.candidate,
        storage: storagePointer(pointer, TELEGRAM_OBJECT_POINTER_PROVIDER),
      };
      uploaded = await markUploaded(mutation, candidate);
    }

    if (uploaded.status !== OUTBOX_UPLOADED || uploaded.candidate.storage === null) {
      throw new CloudRecoveryError('object_mutation_pending', 'Object mutation is pending index recovery.');
    }
    const candidate = {
      ...uploaded.candidate,
      event: await appendRevisionEvent(uploaded.candidate, 'put'),
    };
    const ready = await markReady(uploaded, candidate);
    return applyReadyMutation(ready);
  }

  async function resumeDeleteMutation(mutation) {
    if (mutation.status === OUTBOX_APPLIED) return mutation.candidate;
    if (mutation.status === OUTBOX_INTENT) {
      const candidate = {
        ...mutation.candidate,
        event: await appendRevisionEvent(mutation.candidate, 'delete'),
      };
      const ready = await markReady(mutation, candidate);
      return applyReadyMutation(ready);
    }
    return applyReadyMutation(mutation);
  }

  async function putObject(_scope, bucket, key, input = {}) {
    if (!plainObject(input)) {
      throw new CloudRequestError('invalid_object_request', 'Object request is invalid.', { status: 400 });
    }
    const location = await manifestLocation(bucket, key);
    const contentType = normalizeContentType(input.contentType);
    const metadata = normalizeMetadata(input.metadata);
    const body = normalizeObjectBytes(input.body, limits.maxObjectBytes);
    const contentHash = await digest(body);
    const conditions = normalizeWriteConditions({
      ifMatch: input.ifMatch,
      ifNoneMatch: input.ifNoneMatch,
      ifUnmodifiedSince: input.ifUnmodifiedSince,
    });
    let idempotencyKey = null;
    if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
      idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    }
    const fingerprint = await digest(idempotencyFingerprintPayload({
      operation: 'put',
      bucket: location.bucket,
      key: location.key,
      contentHash,
      size: body.byteLength,
      contentType,
      metadata,
    }));
    const mutation = await buildOrLoadMutation({
      operation: 'put',
      location,
      fingerprint,
      conditions,
      contentHash,
      size: body.byteLength,
      contentType,
      metadata,
      idempotencyKey,
    });
    const manifest = await resumePutMutation(mutation, body, contentType);
    return Object.freeze({
      status: mutation.response_status,
      object: publicObject(normalizeManifest(manifest)),
    });
  }

  async function activeManifest(bucket, key) {
    const location = await manifestLocation(bucket, key);
    const manifest = await readManifest(location);
    if (!manifest || manifest.state !== ACTIVE) {
      throw new CloudNotFoundError('object_not_found', 'The requested object was not found.');
    }
    return manifest;
  }

  async function getObject(_scope, bucket, key, conditions = {}) {
    const readConditions = normalizeReadConditions(conditions);
    const manifest = await activeManifest(bucket, key);
    if (assertReadPreconditions(manifest, readConditions)) {
      return Object.freeze({ status: 304, not_modified: true, object: publicObject(manifest) });
    }
    const range = normalizeByteRange(conditions.range, manifest.size);
    let response;
    try {
      response = await transport.getObject(
        transportPointer(manifest.storage),
        range ? { range } : undefined,
      );
      if (range) validatePartialResponse(response, range);
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw storageBackendFailure();
    }
    return Object.freeze({
      status: range ? 206 : 200,
      not_modified: false,
      object: publicObject(manifest),
      ...(range ? { range } : {}),
      body: response.body,
    });
  }

  async function headObject(_scope, bucket, key, conditions = {}) {
    const readConditions = normalizeReadConditions(conditions);
    const manifest = await activeManifest(bucket, key);
    if (assertReadPreconditions(manifest, readConditions)) {
      return Object.freeze({ status: 304, not_modified: true, object: publicObject(manifest) });
    }
    const range = normalizeByteRange(conditions.range, manifest.size);
    try {
      await transport.headObject(transportPointer(manifest.storage));
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw storageBackendFailure();
    }
    return Object.freeze({
      status: range ? 206 : 200,
      not_modified: false,
      object: publicObject(manifest),
      ...(range ? { range } : {}),
    });
  }

  async function deleteObject(_scope, bucket, key, input = {}) {
    if (!plainObject(input)) {
      throw new CloudRequestError('invalid_object_request', 'Object request is invalid.', { status: 400 });
    }
    const location = await manifestLocation(bucket, key);
    const conditions = normalizeWriteConditions({
      ifMatch: input.ifMatch,
      ifNoneMatch: input.ifNoneMatch,
      ifUnmodifiedSince: input.ifUnmodifiedSince,
    });
    let idempotencyKey = null;
    if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
      idempotencyKey = assertIdempotencyKey(input.idempotencyKey);
    }
    const fingerprint = await digest(idempotencyFingerprintPayload({ operation: 'delete', bucket: location.bucket, key: location.key }));
    const mutationId = await allocateMutationId(idempotencyKey);
    const existing = await readOutbox(mutationId);
    if (existing) {
      if (existing.operation !== 'delete' || existing.request_fingerprint !== fingerprint
        || existing.candidate.bucket !== location.bucket || existing.candidate.key !== location.key
        || existing.candidate.key_hash !== location.keyHash) {
        throw new CloudConflictError('idempotency_key_reused', 'Idempotency-Key was already used for a different object mutation.');
      }
      const manifest = await resumeDeleteMutation(existing);
      return Object.freeze({ status: 200, deletion: publicDeletion(normalizeManifest(manifest)) });
    }

    const current = await readManifest(location);
    if (!current || current.state !== ACTIVE) {
      throw new CloudNotFoundError('object_not_found', 'The requested object was not found.');
    }
    assertWritePreconditions(current, conditions);
    const mutation = await initialMutation({
      operation: 'delete',
      location,
      mutationId,
      fingerprint,
      current,
      contentHash: null,
      size: null,
      contentType: null,
      metadata: null,
    });
    await writeOutbox(mutation);
    const manifest = await resumeDeleteMutation(mutation);
    return Object.freeze({ status: 200, deletion: publicDeletion(normalizeManifest(manifest)) });
  }

  async function listObjects(_scope, bucket, input = {}) {
    // Keep bucket validation/status consistent with PUT/GET/HEAD/DELETE before
    // entering the lower-level ordered-index traversal.
    return objectListIndex.listObjects(normalizeBucket(bucket), input);
  }

  const providerAdapter = {
    putObject: (_scope, bucket, key, input) => putObject(_scope, bucket, key, input),
    getObject: (_scope, bucket, key, conditions) => getObject(_scope, bucket, key, conditions),
    headObject: (_scope, bucket, key, conditions) => headObject(_scope, bucket, key, conditions),
    deleteObject: (_scope, bucket, key, input) => deleteObject(_scope, bucket, key, input),
    listObjects: (_scope, bucket, input) => listObjects(_scope, bucket, input),
  };
  const generic = createObjectStorageService(providerAdapter);
  const scope = Object.freeze({ projectId: safeProjectId });

  // This project facade deliberately captures scope. It means no HTTP handler
  // can accidentally pass params.project_id/query.project_id through to the
  // generic provider contract.
  return Object.freeze({
    putObject: (bucket, key, input) => generic.putObject(scope, bucket, key, input),
    getObject: (bucket, key, conditions) => generic.getObject(scope, bucket, key, conditions),
    headObject: (bucket, key, conditions) => generic.headObject(scope, bucket, key, conditions),
    deleteObject: (bucket, key, input) => generic.deleteObject(scope, bucket, key, input),
    listObjects: (bucket, input) => generic.listObjects(scope, bucket, input),
    limits,
  });
}
