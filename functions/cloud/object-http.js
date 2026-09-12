import { createTelegramObjectStorage, resolveObjectStorageLimits } from './object-storage.js';
import { CloudRequestError, CloudUnauthorizedError, isTelegraphCloudError } from './errors.js';
import {
  assertDeclaredContentLength,
  normalizeCustomMetadata,
} from './validation.js';
import { jsonResponse } from '../utils/http.js';

const CUSTOM_METADATA_PREFIX = 'x-amz-meta-';

function contentLengthError(error) {
  if (error?.code === 'object_too_large') {
    throw new CloudRequestError('object_too_large', 'Object exceeds the supported size limit.', { status: 413 });
  }
  throw new CloudRequestError('invalid_content_length', 'Invalid Content-Length header.', { status: 400 });
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new CloudRequestError('invalid_object_body', 'Object request body is invalid.', { status: 400 });
}

/**
 * Consume a request body incrementally and stop once the configured bounded
 * object limit is exceeded. The Telegram multipart transport plus Web Crypto
 * SHA-256 still require a final bounded buffer; this function avoids an
 * unbounded request.arrayBuffer() allocation and checks declared length first.
 */
export async function readBoundedObjectBody(request, { maxObjectBytes }) {
  let declared;
  try {
    declared = assertDeclaredContentLength(request.headers.get('Content-Length'), { maxBytes: maxObjectBytes });
  } catch (error) {
    contentLengthError(error);
  }

  if (!request.body) {
    if (declared !== null && declared !== 0) {
      throw new CloudRequestError('invalid_content_length', 'Content-Length does not match the object body.', { status: 400 });
    }
    return new Uint8Array(0);
  }

  const reader = typeof request.body.getReader === 'function' ? request.body.getReader() : null;
  if (!reader) {
    throw new CloudRequestError('invalid_object_body', 'Object request body is invalid.', { status: 400 });
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = toUint8Array(value);
      total += chunk.byteLength;
      if (total > maxObjectBytes) {
        try { await reader.cancel(); } catch (_) { /* best-effort stream cleanup */ }
        throw new CloudRequestError('object_too_large', 'Object exceeds the supported size limit.', { status: 413 });
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (isTelegraphCloudError(error)) throw error;
    throw new CloudRequestError('invalid_object_body', 'Object request body is invalid.', { status: 400 });
  }

  if (declared !== null && declared !== total) {
    throw new CloudRequestError('invalid_content_length', 'Content-Length does not match the object body.', { status: 400 });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function customMetadataFromHeaders(headers) {
  // A null-prototype collector makes dangerous bare names such as __proto__ an
  // explicit validation error rather than a JavaScript prototype setter.
  const metadata = Object.create(null);
  for (const [rawName, value] of headers.entries()) {
    const name = rawName.toLowerCase();
    if (!name.startsWith(CUSTOM_METADATA_PREFIX)) continue;
    metadata[name.slice(CUSTOM_METADATA_PREFIX.length)] = value;
  }
  return normalizeCustomMetadata(metadata);
}

function keyFromParams(params) {
  const raw = params?.key;
  if (Array.isArray(raw)) return raw.join('/');
  return raw;
}

/** Extract only the route bucket/key; no query/header project selector exists. */
export function objectLocationFromContext(context) {
  return { bucket: context?.params?.bucket, key: keyFromParams(context?.params) };
}

/**
 * Compose the project-bound engine only from verified middleware output. In
 * particular, context.data.objectStorage or request project hints are never a
 * substitute for the authenticated key's project id.
 */
export function objectStorageForContext(context) {
  const authentication = context?.data?.storageAuthentication;
  if (authentication?.authentication !== 'developer_api_key' || typeof authentication.project_id !== 'string') {
    throw new CloudUnauthorizedError('invalid_api_key', 'A valid developer API key is required.');
  }
  return createTelegramObjectStorage(context.env, { projectId: authentication.project_id });
}

function quotedEtag(etag) {
  return `"${etag}"`;
}

function safeLastModified(timestamp) {
  const date = new Date(timestamp);
  return date.toUTCString();
}

function baseObjectHeaders(object, { representation = false } = {}) {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'ETag': quotedEtag(object.etag),
    'Last-Modified': safeLastModified(object.updated_at),
    'Vary': 'Authorization',
    'X-Content-Type-Options': 'nosniff',
    'X-Telegraph-Cloud-Object-Version': String(object.version),
  });
  for (const [name, value] of Object.entries(object.metadata)) {
    headers.set(`${CUSTOM_METADATA_PREFIX}${name}`, value);
  }
  if (representation) {
    headers.set('Content-Type', object.content_type);
    headers.set('Content-Length', String(object.size));
    // A fixed safe filename avoids treating a user-controlled key as a header
    // filename or serving executable uploaded content inline at this origin.
    headers.set('Content-Disposition', 'attachment; filename="download"');
  }
  return headers;
}

export function objectReadResponse(result, { method = 'GET' } = {}) {
  const headers = baseObjectHeaders(result.object, { representation: result.status === 200 });
  if (result.status === 304) return new Response(null, { status: 304, headers });
  if (method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(result.body || null, { status: 200, headers });
}

export function objectPutResponse(result) {
  const headers = baseObjectHeaders(result.object);
  return jsonResponse({ data: result.object }, { status: result.status, headers });
}

export function objectDeleteResponse(result) {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Vary': 'Authorization',
    'X-Telegraph-Cloud-Object-Version': String(result.deletion.version),
  });
  return jsonResponse({ data: result.deletion }, { status: result.status, headers });
}

export function ensureRangeIsNotRequested(request) {
  if (request.headers.has('Range')) {
    throw new CloudRequestError('range_not_supported', 'Range requests are not available for object storage yet.', { status: 416 });
  }
}

export function methodNotAllowedResponse() {
  return jsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: {
      'Allow': 'GET, HEAD, PUT, DELETE',
      'Cache-Control': 'no-store',
    },
  });
}

/** Parse and bound PUT input without allowing any body or header to Telegram. */
export async function objectPutInput(request, env) {
  const limits = resolveObjectStorageLimits(env);
  return {
    body: await readBoundedObjectBody(request, limits),
    contentType: request.headers.get('Content-Type'),
    metadata: customMetadataFromHeaders(request.headers),
    ifMatch: request.headers.get('If-Match'),
    ifNoneMatch: request.headers.get('If-None-Match'),
    idempotencyKey: request.headers.get('Idempotency-Key'),
  };
}

export function objectWriteInput(request) {
  return {
    ifMatch: request.headers.get('If-Match'),
    ifNoneMatch: request.headers.get('If-None-Match'),
    idempotencyKey: request.headers.get('Idempotency-Key'),
  };
}

export function objectReadConditions(request) {
  return {
    ifNoneMatch: request.headers.get('If-None-Match'),
    ifModifiedSince: request.headers.get('If-Modified-Since'),
  };
}
