import {
  createTelegramObjectStorage,
  parseObjectListQuery,
} from './object-storage.js';
import { readBoundedObjectBody } from './bounded-body.js';
import { resolveObjectStorageLimits } from './object-limits.js';
import {
  CUSTOM_METADATA_PREFIX,
  customMetadataFromHeaders,
  objectReadConditions,
  objectWriteInput,
} from './object-request-input.js';
import { CloudUnauthorizedError } from './errors.js';
import { jsonResponse } from '../utils/http.js';

// Keep the established object-http import surface while generic request
// parsing remains dependency-light for the SigV4/protocol boundary.
export { readBoundedObjectBody } from './bounded-body.js';
export {
  CUSTOM_METADATA_PREFIX,
  customMetadataFromHeaders,
  objectReadConditions,
  objectWriteInput,
} from './object-request-input.js';

function keyFromParams(params) {
  const raw = params?.key;
  if (Array.isArray(raw)) return raw.join('/');
  return raw;
}

/** True only for the object route, never for GET /api/storage/:bucket listing. */
export function objectKeyWasProvided(context) {
  const raw = context?.params?.key;
  return (typeof raw === 'string' && raw.length > 0) || (Array.isArray(raw) && raw.length > 0);
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

function baseObjectHeaders(object, { representation = false, range = null } = {}) {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'ETag': quotedEtag(object.etag),
    'Last-Modified': safeLastModified(object.updated_at),
    'Vary': 'Authorization',
    'X-Content-Type-Options': 'nosniff',
    'X-Telegraph-Cloud-Object-Version': String(object.version),
    'Accept-Ranges': 'bytes',
  });
  for (const [name, value] of Object.entries(object.metadata)) {
    headers.set(`${CUSTOM_METADATA_PREFIX}${name}`, value);
  }
  if (representation) {
    headers.set('Content-Type', object.content_type);
    headers.set('Content-Length', String(range ? range.length : object.size));
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${range.size}`);
    // A fixed safe filename avoids treating a user-controlled key as a header
    // filename or serving executable uploaded content inline at this origin.
    headers.set('Content-Disposition', 'attachment; filename="download"');
  }
  return headers;
}

export function objectReadResponse(result, { method = 'GET' } = {}) {
  const headers = baseObjectHeaders(result.object, {
    representation: result.status === 200 || result.status === 206,
    range: result.range || null,
  });
  if (result.status === 304) return new Response(null, { status: 304, headers });
  if (method === 'HEAD') return new Response(null, { status: result.status, headers });
  return new Response(result.body || null, { status: result.status, headers });
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

export function objectListResponse(result) {
  return jsonResponse(result, {
    headers: {
      'Cache-Control': 'private, no-store',
      'Vary': 'Authorization',
    },
  });
}

export function objectListQueryForRequest(request, env) {
  return parseObjectListQuery(new URL(request.url).searchParams, env);
}

export function methodNotAllowedResponse(allow = 'GET, HEAD, PUT, DELETE') {
  return jsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: {
      Allow: allow,
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
    ifUnmodifiedSince: request.headers.get('If-Unmodified-Since'),
    idempotencyKey: request.headers.get('Idempotency-Key'),
  };
}
