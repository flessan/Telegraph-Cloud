import {
  customMetadataFromHeaders,
  objectReadConditions,
  objectWriteInput,
} from './object-request-input.js';
import { readBoundedObjectBody } from './bounded-body.js';
import { resolveObjectStorageLimits } from './object-limits.js';
import { resolveObjectListLimits } from './object-list-index.js';
import {
  CloudConfigurationError,
  isTelegraphCloudError,
} from './errors.js';
import {
  assertBucketName,
  assertObjectKey,
  assertObjectKeyPrefix,
  assertProjectId,
  utf8ByteLength,
} from './validation.js';
import { xmlElement, xmlResponse } from './s3-xml.js';
import { S3ProtocolError, s3ProtocolError } from './s3-errors.js';
import { S3_CREDENTIAL_PEPPER_ENV } from './s3-config.js';
import { S3RequestTargetError, parseS3RawQuery } from './s3-request-target.js';

export const S3_CONTINUATION_TOKEN_VERSION = 1;
export const S3_CONTINUATION_TOKEN_TTL_MS = 10 * 60 * 1000;
export const S3_MAX_CONTINUATION_TOKEN_BYTES = 12 * 1024;

const S3_CONTINUATION_KEY_DOMAIN = 'telegraph-cloud.s3-continuation.v1';
const MAX_PEPPER_BYTES = 4096;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const LIST_QUERY_FIELDS = new Set([
  'list-type',
  'prefix',
  'delimiter',
  'max-keys',
  'continuation-token',
  'start-after',
  'fetch-owner',
  'encoding-type',
]);
const SUPPORTED_PUT_AMZ_PREFIX = 'x-amz-meta-';
const SUPPORTED_SIGV4_AMZ_HEADERS = new Set(['x-amz-date', 'x-amz-content-sha256']);
// StartAfter is layered over the existing cursor-only engine. A tiny bounded
// loop avoids an empty first result for common selections without turning a
// client-controlled lower bound into an unbounded index scan.
const MAX_START_AFTER_SOURCE_PAGES = 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

const S3_ERROR_DEFINITIONS = Object.freeze({
  AccessDenied: Object.freeze({ status: 403, message: 'Access Denied.' }),
  AuthorizationHeaderMalformed: Object.freeze({ status: 400, message: 'The authorization header is malformed.' }),
  InvalidAccessKeyId: Object.freeze({ status: 403, message: 'The provided access key is not valid.' }),
  SignatureDoesNotMatch: Object.freeze({ status: 403, message: 'The request signature does not match.' }),
  RequestTimeTooSkewed: Object.freeze({ status: 403, message: 'The request time is outside the allowed window.' }),
  XAmzContentSHA256Mismatch: Object.freeze({ status: 400, message: 'The x-amz-content-sha256 value does not match the request body.' }),
  InvalidRequest: Object.freeze({ status: 400, message: 'The request is invalid for this endpoint.' }),
  InvalidArgument: Object.freeze({ status: 400, message: 'The specified argument is not valid.' }),
  NoSuchBucket: Object.freeze({ status: 404, message: 'The specified bucket does not exist.' }),
  NoSuchKey: Object.freeze({ status: 404, message: 'The specified key does not exist.' }),
  InvalidRange: Object.freeze({ status: 416, message: 'The requested range is not satisfiable.' }),
  PreconditionFailed: Object.freeze({ status: 412, message: 'At least one precondition did not hold.' }),
  EntityTooLarge: Object.freeze({ status: 413, message: 'Your proposed upload exceeds the maximum allowed object size.' }),
  UnsupportedMediaType: Object.freeze({ status: 415, message: 'The specified Content-Type is not supported.' }),
  MethodNotAllowed: Object.freeze({ status: 405, message: 'The specified method is not allowed against this resource.' }),
  SlowDown: Object.freeze({ status: 429, message: 'Please reduce your request rate.' }),
  OperationAborted: Object.freeze({ status: 409, message: 'A conflicting conditional operation is in progress.' }),
  ServiceUnavailable: Object.freeze({ status: 503, message: 'Please reduce your request rate or try again later.' }),
  InternalError: Object.freeze({ status: 500, message: 'We encountered an internal error. Please try again.' }),
});

// Preserve the established protocol-module export surface while the safe error
// marker stays dependency-light for strict SigV4 authentication as well.
export { S3ProtocolError, s3ProtocolError } from './s3-errors.js';

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function base64url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64url(value) {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) throw new Error('invalid base64url');
  let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function validRequestId(value) {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

/** Generate an opaque response id; it is neither a credential nor a storage id. */
export function createS3RequestId(cryptoApi = globalThis.crypto) {
  if (!cryptoApi || typeof cryptoApi.getRandomValues !== 'function') {
    throw new S3ProtocolError('InternalError');
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  let value = '';
  for (const byte of bytes) value += byte.toString(16).padStart(2, '0');
  return value.toUpperCase();
}

function safeRequestId(value) {
  if (validRequestId(value)) return value;
  try {
    return createS3RequestId();
  } catch (_) {
    // A Workers runtime has Web Crypto. Keep this final fallback non-sensitive
    // rather than allowing an error envelope itself to throw during an outage.
    return '00000000000000000000000000000000';
  }
}

function s3Headers(requestId, extraHeaders = {}) {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Vary': 'Authorization',
    'X-Content-Type-Options': 'nosniff',
    'x-amz-request-id': safeRequestId(requestId),
  });
  for (const [name, value] of new Headers(extraHeaders).entries()) headers.set(name, value);
  return headers;
}

function mappedS3Error(error) {
  if (error instanceof S3ProtocolError) {
    return S3_ERROR_DEFINITIONS[error.s3Code] || S3_ERROR_DEFINITIONS.InternalError;
  }

  if (isTelegraphCloudError(error)) {
    if (error.code === 'object_not_found') return S3_ERROR_DEFINITIONS.NoSuchKey;
    if (error.code === 'range_not_satisfiable') return S3_ERROR_DEFINITIONS.InvalidRange;
    if (error.code === 'precondition_failed') return S3_ERROR_DEFINITIONS.PreconditionFailed;
    if (error.code === 'object_too_large') return S3_ERROR_DEFINITIONS.EntityTooLarge;
    if (error.code === 'unsupported_media_type') return S3_ERROR_DEFINITIONS.UnsupportedMediaType;
    if (error.status === 401 || error.status === 403) return S3_ERROR_DEFINITIONS.AccessDenied;
    if (error.status === 409) return S3_ERROR_DEFINITIONS.OperationAborted;
    if (error.status === 429) return S3_ERROR_DEFINITIONS.SlowDown;
    if (error.status === 400 || error.status === 422) return S3_ERROR_DEFINITIONS.InvalidArgument;
    if (error.status === 502 || error.status === 503) return S3_ERROR_DEFINITIONS.ServiceUnavailable;
  }
  return S3_ERROR_DEFINITIONS.InternalError;
}

function safeS3ErrorHeaders(error, requestId) {
  const headers = s3Headers(requestId);
  if (error instanceof S3ProtocolError) {
    if (Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0) {
      headers.set('Retry-After', String(error.retryAfter));
    }
    if (error.s3Code === 'MethodNotAllowed' && typeof error.allow === 'string' && /^[A-Z, ]{3,64}$/.test(error.allow)) {
      headers.set('Allow', error.allow);
    }
  }
  // The already-public object length is valid on a range response and is the
  // sole selected engine detail that can safely survive into the S3 response.
  if (error?.code === 'range_not_satisfiable'
    && Number.isSafeInteger(error.details?.object_size) && error.details.object_size >= 0) {
    headers.set('Content-Range', `bytes */${error.details.object_size}`);
    headers.set('Accept-Ranges', 'bytes');
  }
  return headers;
}

/** Convert a safe engine/protocol error into a deterministic S3 XML error. */
export function s3ErrorResponse(error, { requestId, resource = null } = {}) {
  const definition = mappedS3Error(error);
  const responseRequestId = safeRequestId(requestId);
  const children = [
    xmlElement('Code', error instanceof S3ProtocolError && S3_ERROR_DEFINITIONS[error.s3Code]
      ? error.s3Code
      : Object.entries(S3_ERROR_DEFINITIONS).find(([, value]) => value === definition)?.[0] || 'InternalError'),
    xmlElement('Message', definition.message),
  ];
  if (typeof resource === 'string' && resource.length > 0) children.push(xmlElement('Resource', resource));
  children.push(xmlElement('RequestId', responseRequestId));
  return xmlResponse(xmlElement('Error', children), {
    status: definition.status,
    headers: safeS3ErrorHeaders(error, responseRequestId),
  });
}

function timestampToHttpDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new CloudConfigurationError('s3_object_timestamp_invalid', 'S3 object metadata is unavailable.');
  }
  return date.toUTCString();
}

function quotedEtag(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CloudConfigurationError('s3_object_etag_invalid', 'S3 object metadata is unavailable.');
  }
  return `"${value}"`;
}

function objectResponseHeaders(object, requestId, { representation = false, range = null } = {}) {
  const headers = s3Headers(requestId, {
    'ETag': quotedEtag(object?.etag),
    'Last-Modified': timestampToHttpDate(object?.updated_at),
    'Accept-Ranges': 'bytes',
  });
  const metadata = object?.metadata;
  if (!isPlainObject(metadata)) {
    throw new CloudConfigurationError('s3_object_metadata_invalid', 'S3 object metadata is unavailable.');
  }
  for (const [name, value] of Object.entries(metadata)) {
    headers.set(`${SUPPORTED_PUT_AMZ_PREFIX}${name}`, value);
  }
  if (representation) {
    headers.set('Content-Type', object.content_type);
    headers.set('Content-Length', String(range ? range.length : object.size));
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${range.size}`);
    // Preserve the existing private object serving safety posture. The object
    // key is never copied into a response filename/header.
    headers.set('Content-Disposition', 'attachment; filename="download"');
  }
  return headers;
}

function s3ObjectReadResponse(result, requestId, method) {
  const headers = objectResponseHeaders(result.object, requestId, {
    representation: result.status === 200 || result.status === 206,
    range: result.range || null,
  });
  if (result.status === 304 || method === 'HEAD') return new Response(null, { status: result.status, headers });
  return new Response(result.body ?? null, { status: result.status, headers });
}

function s3PutResponse(result, requestId) {
  return new Response(null, {
    // S3 PutObject uses 200 even though the underlying engine distinguishes an
    // initial materialization (201) from replacement (200).
    status: 200,
    headers: s3Headers(requestId, { ETag: quotedEtag(result.object?.etag) }),
  });
}

function s3DeleteResponse(requestId) {
  // DeleteObject success has no body. The engine's logical-tombstone details
  // remain internal and are not represented as S3 version/delete-marker data.
  return new Response(null, { status: 204, headers: s3Headers(requestId) });
}

function assertS3Storage(storage) {
  const required = ['putObject', 'getObject', 'headObject', 'deleteObject', 'listObjects', 'bucketExists'];
  if (!storage || typeof storage !== 'object' || required.some((method) => typeof storage[method] !== 'function')) {
    throw new CloudConfigurationError('s3_object_engine_unavailable', 'S3 object storage is unavailable.');
  }
  return storage;
}

function storageBodyLimits(storage, env) {
  if (Number.isSafeInteger(storage?.limits?.maxObjectBytes) && storage.limits.maxObjectBytes >= 0) {
    return { maxObjectBytes: storage.limits.maxObjectBytes };
  }
  return resolveObjectStorageLimits(env);
}

function invalidContinuation() {
  return new S3ProtocolError('InvalidArgument');
}

function continuationPepper(env) {
  // Phase 6B keeps all S3-only cryptographic material under a dedicated
  // server secret rather than coupling continuation tokens to `tg_live_` key
  // verification. Phase 6A continuation tokens are intentionally invalidated.
  const value = env?.[S3_CREDENTIAL_PEPPER_ENV];
  if (typeof value !== 'string' || utf8ByteLength(value) < 32 || utf8ByteLength(value) > MAX_PEPPER_BYTES) {
    throw new CloudConfigurationError('s3_continuation_unavailable', 'S3 continuation tokens are unavailable.');
  }
  return value;
}

async function continuationKey(env, cryptoApi) {
  if (!cryptoApi?.subtle || typeof cryptoApi.getRandomValues !== 'function') {
    throw new CloudConfigurationError('s3_continuation_crypto_unavailable', 'S3 continuation tokens are unavailable.');
  }
  try {
    const material = encoder.encode(`${S3_CONTINUATION_KEY_DOMAIN}\u0000${continuationPepper(env)}`);
    const digest = await cryptoApi.subtle.digest('SHA-256', material);
    return cryptoApi.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } catch (error) {
    if (isTelegraphCloudError(error)) throw error;
    throw new CloudConfigurationError('s3_continuation_crypto_unavailable', 'S3 continuation tokens are unavailable.');
  }
}

function safeTimestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new CloudConfigurationError('s3_clock_invalid', 'S3 compatibility clock is unavailable.');
  }
  return milliseconds;
}

function normalizeContinuationState(value, { projectId, limits, now }) {
  try {
    if (!isPlainObject(value)) throw new Error('state');
    const allowed = new Set(['v', 'project_id', 'bucket', 'prefix', 'delimiter', 'max_keys', 'start_after', 'cursor', 'issued_at']);
    if (Object.keys(value).some((name) => !allowed.has(name))) throw new Error('fields');
    if (value.v !== S3_CONTINUATION_TOKEN_VERSION) throw new Error('version');
    const stateProjectId = assertProjectId(value.project_id);
    const bucket = assertBucketName(value.bucket);
    const prefix = assertObjectKeyPrefix(value.prefix);
    const delimiter = value.delimiter === null ? null : (value.delimiter === '/' ? '/' : (() => { throw new Error('delimiter'); })());
    if (!Number.isSafeInteger(value.max_keys) || value.max_keys < 1 || value.max_keys > limits.maxListLimit) throw new Error('limit');
    const startAfter = value.start_after === null ? null : assertObjectKeyPrefix(value.start_after);
    if (typeof value.cursor !== 'string' || value.cursor.length === 0
      || utf8ByteLength(value.cursor) > limits.maxCursorBytes) throw new Error('cursor');
    if (!Number.isSafeInteger(value.issued_at) || value.issued_at < 0
      || value.issued_at > now + 60 * 1000 || now - value.issued_at > S3_CONTINUATION_TOKEN_TTL_MS) {
      throw new Error('timestamp');
    }
    if (stateProjectId !== projectId) throw new Error('project');
    return Object.freeze({
      bucket,
      prefix,
      delimiter,
      maxKeys: value.max_keys,
      startAfter,
      cursor: value.cursor,
      issuedAt: value.issued_at,
    });
  } catch (_) {
    throw invalidContinuation();
  }
}

async function encodeContinuationToken(state, { env, cryptoApi, now }) {
  const issuedAt = safeTimestamp(now);
  const payload = {
    v: S3_CONTINUATION_TOKEN_VERSION,
    project_id: state.projectId,
    bucket: state.bucket,
    prefix: state.prefix,
    delimiter: state.delimiter,
    max_keys: state.maxKeys,
    start_after: state.startAfter,
    cursor: state.cursor,
    issued_at: issuedAt,
  };
  try {
    const key = await continuationKey(env, cryptoApi);
    const iv = new Uint8Array(12);
    cryptoApi.getRandomValues(iv);
    const ciphertext = await cryptoApi.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(payload)));
    const envelope = base64url(encoder.encode(JSON.stringify({
      v: S3_CONTINUATION_TOKEN_VERSION,
      i: base64url(iv),
      d: base64url(new Uint8Array(ciphertext)),
    })));
    if (utf8ByteLength(envelope) > S3_MAX_CONTINUATION_TOKEN_BYTES) {
      throw new CloudConfigurationError('s3_continuation_too_large', 'S3 continuation tokens are unavailable.');
    }
    return envelope;
  } catch (error) {
    if (error instanceof CloudConfigurationError || error instanceof S3ProtocolError) throw error;
    throw new CloudConfigurationError('s3_continuation_crypto_unavailable', 'S3 continuation tokens are unavailable.');
  }
}

async function decodeContinuationToken(token, { env, cryptoApi, projectId, limits, now }) {
  try {
    if (typeof token !== 'string' || !BASE64URL_PATTERN.test(token)
      || utf8ByteLength(token) > S3_MAX_CONTINUATION_TOKEN_BYTES) throw new Error('token');
    const envelope = JSON.parse(decoder.decode(fromBase64url(token)));
    if (!isPlainObject(envelope) || Object.keys(envelope).some((name) => !['v', 'i', 'd'].includes(name))
      || envelope.v !== S3_CONTINUATION_TOKEN_VERSION) throw new Error('envelope');
    const iv = fromBase64url(envelope.i);
    const data = fromBase64url(envelope.d);
    if (iv.byteLength !== 12 || data.byteLength < 17) throw new Error('ciphertext');
    const key = await continuationKey(env, cryptoApi);
    const plaintext = await cryptoApi.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    const state = JSON.parse(decoder.decode(plaintext));
    return normalizeContinuationState(state, {
      projectId,
      limits,
      now: safeTimestamp(now),
    });
  } catch (error) {
    if (error instanceof CloudConfigurationError) throw error;
    if (error instanceof S3ProtocolError) throw error;
    throw invalidContinuation();
  }
}

/**
 * Parse only the Phase 6B ListObjectsV2 controls. Unsupported query fields are
 * rejected rather than silently becoming future selectors or fake S3 options.
 */
export function parseS3ListObjectsV2Request(request, env = {}) {
  const values = Object.create(null);
  const supplied = Object.create(null);
  let query;
  try {
    // Use the same raw-query parser as the SigV4 verifier. In particular `+`
    // remains a literal plus rather than becoming form-style whitespace.
    query = parseS3RawQuery(request);
  } catch (error) {
    if (error instanceof S3RequestTargetError) throw new S3ProtocolError('InvalidRequest');
    throw new S3ProtocolError('InvalidRequest');
  }
  for (const { name, value } of query) {
    if (!LIST_QUERY_FIELDS.has(name) || supplied[name]) throw new S3ProtocolError('InvalidRequest');
    supplied[name] = true;
    values[name] = value;
  }
  if (values['list-type'] !== '2') throw new S3ProtocolError('InvalidRequest');
  if (values['fetch-owner'] !== undefined && values['fetch-owner'] !== 'false') {
    throw new S3ProtocolError('InvalidRequest');
  }
  // XML escaping is used instead of S3's encoding-type=url response mode. Do
  // not claim a URL-encoded result representation that this adapter does not
  // implement.
  if (values['encoding-type'] !== undefined) throw new S3ProtocolError('InvalidRequest');
  if (values['continuation-token'] !== undefined
    && (values['continuation-token'].length === 0 || utf8ByteLength(values['continuation-token']) > S3_MAX_CONTINUATION_TOKEN_BYTES)) {
    throw invalidContinuation();
  }
  if (values['continuation-token'] !== undefined && values['start-after'] !== undefined) {
    throw new S3ProtocolError('InvalidArgument');
  }

  const limits = resolveObjectListLimits(env);
  let maxKeys = limits.maxListLimit;
  if (values['max-keys'] !== undefined) {
    if (!/^\d+$/.test(values['max-keys'])) throw new S3ProtocolError('InvalidArgument');
    maxKeys = Number(values['max-keys']);
    if (!Number.isSafeInteger(maxKeys) || maxKeys < 1 || maxKeys > limits.maxListLimit) {
      throw new S3ProtocolError('InvalidArgument');
    }
  }
  const delimiter = values.delimiter === undefined ? null : values.delimiter;
  if (delimiter !== null && delimiter !== '/') throw new S3ProtocolError('InvalidArgument');

  return Object.freeze({
    prefix: values.prefix === undefined ? '' : assertObjectKeyPrefix(values.prefix),
    delimiter,
    maxKeys,
    continuationToken: values['continuation-token'],
    startAfter: values['start-after'] === undefined ? null : assertObjectKeyPrefix(values['start-after']),
    supplied: Object.freeze({
      prefix: Boolean(supplied.prefix),
      delimiter: Boolean(supplied.delimiter),
      maxKeys: Boolean(supplied['max-keys']),
    }),
  });
}

function continuationSelectionMismatch() {
  return new S3ProtocolError('InvalidArgument');
}

// The Phase 5 index orders the UTF-8 byte representation of NFC keys. Do not
// use JavaScript UTF-16 string comparison for StartAfter, which would order
// astral-plane characters differently from the underlying deterministic index.
function isStrictlyAfterUtf8(value, lowerBound) {
  const candidate = encoder.encode(value);
  const boundary = encoder.encode(lowerBound);
  const length = Math.min(candidate.byteLength, boundary.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (candidate[index] !== boundary[index]) return candidate[index] > boundary[index];
  }
  return candidate.byteLength > boundary.byteLength;
}

async function resolveListSelection(controls, bucket, { projectId, env, cryptoApi, now }) {
  const limits = resolveObjectListLimits(env);
  if (!controls.continuationToken) {
    return Object.freeze({
      bucket,
      prefix: controls.prefix,
      delimiter: controls.delimiter,
      maxKeys: controls.maxKeys,
      startAfter: controls.startAfter,
      cursor: undefined,
    });
  }

  const state = await decodeContinuationToken(controls.continuationToken, {
    env,
    cryptoApi,
    projectId,
    limits,
    now,
  });
  if (state.bucket !== bucket) throw continuationSelectionMismatch();
  if (controls.supplied.prefix && controls.prefix !== state.prefix) throw continuationSelectionMismatch();
  if (controls.supplied.delimiter && controls.delimiter !== state.delimiter) throw continuationSelectionMismatch();
  if (controls.supplied.maxKeys && controls.maxKeys !== state.maxKeys) throw continuationSelectionMismatch();
  return Object.freeze({
    bucket,
    prefix: state.prefix,
    delimiter: state.delimiter,
    maxKeys: state.maxKeys,
    startAfter: state.startAfter,
    cursor: state.cursor,
  });
}

function listContentXml(object) {
  return xmlElement('Contents', [
    xmlElement('Key', object.key),
    xmlElement('LastModified', object.updated_at),
    xmlElement('ETag', quotedEtag(object.etag)),
    xmlElement('Size', String(object.size)),
    xmlElement('StorageClass', 'STANDARD'),
  ]);
}

function listResponseXml({ bucket, selection, listing, nextContinuationToken }) {
  const objects = Array.isArray(listing.objects) ? listing.objects : [];
  const prefixes = Array.isArray(listing.common_prefixes) ? listing.common_prefixes : [];
  const children = [
    xmlElement('Name', bucket),
    xmlElement('Prefix', selection.prefix),
  ];
  if (selection.startAfter !== null) children.push(xmlElement('StartAfter', selection.startAfter));
  children.push(
    xmlElement('KeyCount', String(objects.length + prefixes.length)),
    xmlElement('MaxKeys', String(selection.maxKeys)),
  );
  if (selection.delimiter !== null) children.push(xmlElement('Delimiter', selection.delimiter));
  children.push(xmlElement('IsTruncated', listing.has_more ? 'true' : 'false'));
  for (const object of objects) children.push(listContentXml(object));
  for (const prefix of prefixes) children.push(xmlElement('CommonPrefixes', xmlElement('Prefix', prefix)));
  if (nextContinuationToken) children.push(xmlElement('NextContinuationToken', nextContinuationToken));
  return xmlElement('ListBucketResult', children, {
    xmlns: 'http://s3.amazonaws.com/doc/2006-03-01/',
  });
}

function assertNoObjectQuery(request) {
  try {
    if (parseS3RawQuery(request).length > 0) throw new Error('query');
  } catch (_) {
    throw new S3ProtocolError('InvalidRequest');
  }
}

function assertSupportedS3Headers(request, { allowMetadata = false } = {}) {
  if (request.headers.has('Content-MD5')) throw new S3ProtocolError('InvalidRequest');
  for (const [rawName] of request.headers.entries()) {
    const name = rawName.toLowerCase();
    if (!name.startsWith('x-amz-')) continue;
    if (SUPPORTED_SIGV4_AMZ_HEADERS.has(name)) continue;
    if (allowMetadata && name.startsWith(SUPPORTED_PUT_AMZ_PREFIX)) continue;
    // Do not silently claim ACL, temporary-token, SSE, tagging, checksum,
    // copy-source, object-lock, or future x-amz behavior. SigV4's two required
    // headers and PUT metadata are the only x-amz request fields in this scope.
    throw new S3ProtocolError('InvalidRequest');
  }
}

function normalizedRouteSegments(rawPath) {
  if (typeof rawPath === 'string') return rawPath.split('/');
  if (Array.isArray(rawPath)) {
    const segments = [];
    for (const part of rawPath) {
      if (typeof part !== 'string') return null;
      segments.push(...part.split('/'));
    }
    return segments;
  }
  if (rawPath === undefined || rawPath === null) return [];
  return null;
}

/** Extract the bucket/key route shape without looking at query/header selectors. */
export function s3TargetFromPath(rawPath) {
  const segments = normalizedRouteSegments(rawPath);
  if (segments === null || segments.length === 0 || (segments.length === 1 && segments[0] === '')) {
    return Object.freeze({ bucket: null, key: null, hasKey: false });
  }
  return Object.freeze({
    bucket: segments[0],
    key: segments.length > 1 ? segments.slice(1).join('/') : null,
    hasKey: segments.length > 1,
  });
}

export function s3TargetFromContext(context) {
  return s3TargetFromPath(context?.params?.path);
}

function invalidS3Target() {
  return Object.freeze({ bucket: null, key: null, hasKey: false });
}

/**
 * Parse the request-target exposed by Pages instead of trusting decoded route
 * params. Percent-decoding occurs exactly once for later storage validation;
 * encoded path separators are rejected so a raw URI cannot become a different
 * object hierarchy after routing.
 */
export function s3TargetFromRequest(request) {
  let pathname;
  try {
    pathname = new URL(request?.url).pathname;
  } catch (_) {
    return invalidS3Target();
  }
  if (pathname === '/s3' || pathname === '/s3/') return invalidS3Target();
  if (!pathname.startsWith('/s3/')) return invalidS3Target();
  const rawSegments = pathname.slice('/s3/'.length).split('/');
  if (rawSegments.length === 0 || rawSegments[0] === '') return invalidS3Target();
  const segments = [];
  try {
    for (const rawSegment of rawSegments) {
      const segment = decodeURIComponent(rawSegment);
      // Encoded `/` or `\\` must not turn one raw segment into another path
      // segment after the signature's raw URI has already been verified.
      if (segment.includes('/') || segment.includes('\\')) return invalidS3Target();
      segments.push(segment);
    }
  } catch (_) {
    return invalidS3Target();
  }
  return s3TargetFromPath(segments);
}

/** Return only an externally safe S3 resource path, never a KV/Telegram path. */
export function safeS3Resource(target) {
  try {
    if (!target || typeof target !== 'object') return null;
    const bucket = assertBucketName(target.bucket);
    if (!target.hasKey) return `/${bucket}`;
    const key = assertObjectKey(target.key);
    return `/${bucket}/${key}`;
  } catch (_) {
    return null;
  }
}

export function safeS3ResourceFromContext(context) {
  // Derive this again from the received path rather than arbitrary middleware
  // data or decoded Pages params. A future handler cannot echo an internal
  // pointer/diagnostic by setting context.data.s3Resource.
  return safeS3Resource(s3TargetFromRequest(context?.request));
}

/**
 * Protocol-only S3 adapter. It receives a project-bound object facade and
 * invokes only that facade; it has no Telegram, KV, index, or credential
 * binding access of its own.
 */
export function createS3ProtocolAdapter({
  storage,
  projectId,
  env = {},
  requestId,
  cryptoApi = globalThis.crypto,
  now = () => Date.now(),
} = {}) {
  const objectStorage = assertS3Storage(storage);
  let safeProjectId;
  try {
    safeProjectId = assertProjectId(projectId);
  } catch (_) {
    throw new CloudConfigurationError('s3_project_scope_unavailable', 'S3 project scope is unavailable.');
  }
  const safeRequest = safeRequestId(requestId);

  async function requireExistingBucket(bucket) {
    const safeBucket = assertBucketName(bucket);
    const exists = await objectStorage.bucketExists(safeBucket);
    if (exists !== true && exists !== false) {
      throw new CloudConfigurationError('s3_bucket_lookup_unavailable', 'S3 bucket lookup is unavailable.');
    }
    if (!exists) throw new S3ProtocolError('NoSuchBucket');
    return safeBucket;
  }

  async function listObjectsV2(bucket, request) {
    assertSupportedS3Headers(request);
    const controls = parseS3ListObjectsV2Request(request, env);
    const safeBucket = await requireExistingBucket(bucket);
    const selection = await resolveListSelection(controls, safeBucket, {
      projectId: safeProjectId,
      env,
      cryptoApi,
      now,
    });
    // Require continuation cryptography even on a first/short list so a caller
    // cannot receive a page that later fails only when it happens to truncate.
    await continuationKey(env, cryptoApi);
    const after = selection.startAfter;
    const visibleObjects = [];
    const visiblePrefixes = [];
    let sourceCursor = selection.cursor;
    let sourceHasMore = false;
    let sourcePages = 0;
    do {
      const remaining = selection.maxKeys - visibleObjects.length - visiblePrefixes.length;
      const listing = await objectStorage.listObjects(safeBucket, {
        prefix: selection.prefix,
        delimiter: selection.delimiter,
        // Passing only the remaining result capacity means no unreturned
        // public listing entry has to be copied into the outer token.
        limit: remaining,
        cursor: sourceCursor,
      });
      sourceHasMore = listing.has_more === true;
      sourceCursor = listing.next_cursor;
      for (const object of listing.objects || []) {
        if (after === null || isStrictlyAfterUtf8(object.key, after)) visibleObjects.push(object);
      }
      for (const prefix of listing.common_prefixes || []) {
        if (after === null || isStrictlyAfterUtf8(prefix, after)) visiblePrefixes.push(prefix);
      }
      sourcePages += 1;
      // Normal pages are already filled by the engine. Only StartAfter can
      // consume a complete source page while producing no public S3 entry.
    } while (
      after !== null
      && visibleObjects.length + visiblePrefixes.length < selection.maxKeys
      && sourceHasMore
      && sourcePages < MAX_START_AFTER_SOURCE_PAGES
    );
    const visibleListing = Object.freeze({
      objects: visibleObjects,
      common_prefixes: visiblePrefixes,
      has_more: sourceHasMore,
    });
    let nextContinuationToken;
    if (visibleListing.has_more) {
      if (typeof sourceCursor !== 'string' || sourceCursor.length === 0) {
        throw new CloudConfigurationError('s3_continuation_unavailable', 'S3 continuation tokens are unavailable.');
      }
      nextContinuationToken = await encodeContinuationToken({
        projectId: safeProjectId,
        bucket: safeBucket,
        prefix: selection.prefix,
        delimiter: selection.delimiter,
        maxKeys: selection.maxKeys,
        startAfter: selection.startAfter,
        cursor: sourceCursor,
      }, { env, cryptoApi, now });
    }
    return xmlResponse(listResponseXml({
      bucket: safeBucket,
      selection,
      listing: visibleListing,
      nextContinuationToken,
    }), { headers: s3Headers(safeRequest) });
  }

  async function getObject(bucket, key, request) {
    assertNoObjectQuery(request);
    assertSupportedS3Headers(request);
    const safeBucket = assertBucketName(bucket);
    const safeKey = assertObjectKey(key);
    await requireExistingBucket(safeBucket);
    const result = await objectStorage.getObject(safeBucket, safeKey, objectReadConditions(request));
    return s3ObjectReadResponse(result, safeRequest, 'GET');
  }

  async function headObject(bucket, key, request) {
    assertNoObjectQuery(request);
    assertSupportedS3Headers(request);
    const safeBucket = assertBucketName(bucket);
    const safeKey = assertObjectKey(key);
    await requireExistingBucket(safeBucket);
    const result = await objectStorage.headObject(safeBucket, safeKey, objectReadConditions(request));
    return s3ObjectReadResponse(result, safeRequest, 'HEAD');
  }

  async function putObject(bucket, key, request) {
    assertNoObjectQuery(request);
    const safeBucket = assertBucketName(bucket);
    const safeKey = assertObjectKey(key);
    assertSupportedS3Headers(request, { allowMetadata: true });
    const writeConditions = objectWriteInput(request);
    const result = await objectStorage.putObject(safeBucket, safeKey, {
      body: await readBoundedObjectBody(request, storageBodyLimits(objectStorage, env)),
      contentType: request.headers.get('Content-Type'),
      metadata: customMetadataFromHeaders(request.headers),
      ifMatch: writeConditions.ifMatch,
      ifNoneMatch: writeConditions.ifNoneMatch,
      ifUnmodifiedSince: writeConditions.ifUnmodifiedSince,
      idempotencyKey: writeConditions.idempotencyKey,
    });
    // Existing engine behavior materializes the bucket marker only after the
    // first successful object PUT. This is deliberately not a CreateBucket API.
    return s3PutResponse(result, safeRequest);
  }

  async function deleteObject(bucket, key, request) {
    assertNoObjectQuery(request);
    assertSupportedS3Headers(request);
    const safeBucket = assertBucketName(bucket);
    const safeKey = assertObjectKey(key);
    await requireExistingBucket(safeBucket);
    const writeConditions = objectWriteInput(request);
    await objectStorage.deleteObject(safeBucket, safeKey, {
      ifMatch: writeConditions.ifMatch,
      ifNoneMatch: writeConditions.ifNoneMatch,
      ifUnmodifiedSince: writeConditions.ifUnmodifiedSince,
      idempotencyKey: writeConditions.idempotencyKey,
    });
    return s3DeleteResponse(safeRequest);
  }

  return Object.freeze({ listObjectsV2, getObject, headObject, putObject, deleteObject });
}

/** Dispatch the limited Phase 6B route surface without adding bucket operations. */
export async function dispatchS3Request({ request, target, adapter } = {}) {
  if (!target?.bucket) throw new S3ProtocolError('InvalidRequest');
  if (!target.hasKey) {
    if (request?.method === 'GET') return adapter.listObjectsV2(target.bucket, request);
    throw new S3ProtocolError('MethodNotAllowed', { allow: 'GET' });
  }
  if (request?.method === 'GET') return adapter.getObject(target.bucket, target.key, request);
  if (request?.method === 'HEAD') return adapter.headObject(target.bucket, target.key, request);
  if (request?.method === 'PUT') return adapter.putObject(target.bucket, target.key, request);
  if (request?.method === 'DELETE') return adapter.deleteObject(target.bucket, target.key, request);
  throw new S3ProtocolError('MethodNotAllowed', { allow: 'GET, HEAD, PUT, DELETE' });
}
