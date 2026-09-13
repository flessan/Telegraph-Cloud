import { createTelegramDocumentDatabase, resolveDocumentDatabaseLimits } from './document-database.js';
import { CloudRequestError, CloudValidationError } from './errors.js';
import { assertProjectId } from './validation.js';
import { jsonResponse } from '../utils/http.js';

const encoder = new TextEncoder();

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isJsonContentType(request) {
  const contentType = request.headers.get('Content-Type') || '';
  return contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function declaredLength(request, maxBytes) {
  const raw = request.headers.get('Content-Length');
  if (raw === null || raw === '') return null;
  if (!/^\d+$/.test(raw)) {
    throw new CloudValidationError('invalid_content_length', 'Invalid Content-Length header.');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CloudValidationError('invalid_content_length', 'Invalid Content-Length header.');
  }
  if (value > maxBytes) {
    throw new CloudRequestError('document_too_large', 'Document exceeds the supported size limit.', { status: 413 });
  }
  return value;
}

async function readBoundedText(request, maxBytes) {
  const body = request.body;
  if (!body) return '';

  // Pages Functions and standards-compliant test Requests expose a readable
  // stream. Keep a fallback for a minimal Request implementation used by a
  // future adapter without losing the post-read byte check.
  if (!body.getReader) {
    const text = await request.text();
    if (encoder.encode(text).byteLength > maxBytes) {
      throw new CloudRequestError('document_too_large', 'Document exceeds the supported size limit.', { status: 413 });
    }
    return text;
  }

  const reader = body.getReader();
  const chunks = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      byteLength += chunk.byteLength;
      if (byteLength > maxBytes) {
        try { await reader.cancel(); } catch (_) { /* best effort */ }
        throw new CloudRequestError('document_too_large', 'Document exceeds the supported size limit.', { status: 413 });
      }
      chunks.push(chunk);
    }
  } finally {
    try { reader.releaseLock(); } catch (_) { /* best effort */ }
  }

  const joined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(joined);
  } catch (_) {
    throw new CloudRequestError('malformed_json', 'Database request body must be valid UTF-8 JSON.', { status: 400 });
  }
}

/**
 * Reads only a bounded JSON request body. Database documents never accept
 * browser form data or arbitrary content types; this keeps record validation
 * independent from the broader legacy upload endpoint.
 */
export async function readDatabaseJson(request, env, { allowEmpty = false } = {}) {
  const { maxDocumentBytes } = resolveDocumentDatabaseLimits(env);
  declaredLength(request, maxDocumentBytes);

  if (!isJsonContentType(request)) {
    if (!allowEmpty || request.body) {
      throw new CloudRequestError('unsupported_content_type', 'Database requests require application/json.', { status: 415 });
    }
    return undefined;
  }

  const text = await readBoundedText(request, maxDocumentBytes);
  if (!text.trim()) {
    if (allowEmpty) return undefined;
    throw new CloudRequestError('malformed_json', 'Database request body must be valid JSON.', { status: 400 });
  }

  try {
    return JSON.parse(text);
  } catch (_) {
    throw new CloudRequestError('malformed_json', 'Database request body must be valid JSON.', { status: 400 });
  }
}

function parseIfMatch(request) {
  const raw = request.headers.get('If-Match');
  if (raw === null || raw.trim() === '') return null;
  const value = raw.trim();
  const match = /^(?:"([1-9]\d*)"|([1-9]\d*))$/.exec(value);
  const version = match ? Number(match[1] || match[2]) : NaN;
  if (!Number.isSafeInteger(version)) {
    throw new CloudValidationError('invalid_expected_version', 'If-Match must contain one positive record version.');
  }
  return version;
}

/**
 * Accept a body `_expected_version` (the documented JSON API form) and/or a
 * standard `If-Match: "<version>"` precondition. At least one is mandatory
 * for PATCH and DELETE, and both must agree when supplied together.
 */
export function expectedVersionForMutation(request, body) {
  const fromHeader = parseIfMatch(request);
  let fromBody = null;
  if (body !== null && body !== undefined && typeof body === 'object' && !Array.isArray(body)
    && own(body, '_expected_version')) {
    fromBody = body._expected_version;
    if (!Number.isSafeInteger(fromBody) || fromBody < 1) {
      throw new CloudValidationError('invalid_expected_version', 'Expected version must be a positive integer.');
    }
  }

  if (fromHeader !== null && fromBody !== null && fromHeader !== fromBody) {
    throw new CloudValidationError('invalid_expected_version', 'If-Match and _expected_version must agree.');
  }
  const expectedVersion = fromBody === null ? fromHeader : fromBody;
  if (expectedVersion === null) {
    throw new CloudRequestError(
      'precondition_required',
      'PATCH and DELETE require _expected_version or If-Match.',
      { status: 428 },
    );
  }
  return expectedVersion;
}

export function patchBodyWithoutPrecondition(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  // A null-prototype intermediate preserves a literal `__proto__` key for the
  // shared JSON validator to reject; assigning it to `{}` would otherwise
  // invoke the legacy prototype setter before validation.
  const patch = Object.create(null);
  for (const [key, value] of Object.entries(body)) {
    if (key !== '_expected_version') patch[key] = value;
  }
  return patch;
}

export function assertDeleteBody(body) {
  if (body === undefined) return;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CloudValidationError('invalid_delete_body', 'Delete body must contain only _expected_version.');
  }
  for (const key of Object.keys(body)) {
    if (key !== '_expected_version') {
      throw new CloudValidationError('invalid_delete_body', 'Delete body must contain only _expected_version.');
    }
  }
}

// `context.data` is internal Pages middleware state, never client input. The
// DB middleware writes `databaseAuthentication` only after a dashboard session
// or a verified Bearer developer key. A developer provider receives its project
// solely from that authenticated context; request paths and query parameters do
// not participate in project selection.
//
// The optional prebuilt-provider seam keeps legacy route behavior testable with
// a mocked journal. It is deliberately ignored for developer authentication;
// production developer requests construct the Telegram-backed provider from
// bindings after the authentication middleware has selected the scope.
export function documentDatabaseForContext(context) {
  const authentication = context?.data?.databaseAuthentication;
  // Never allow an incidental legacy/test provider stored in generic context
  // data to override an authenticated developer project scope. Validate even
  // this trusted middleware value so a malformed internal state fails closed
  // instead of accidentally falling back to the unscoped legacy provider.
  if (authentication?.authentication === 'developer_api_key') {
    return createTelegramDocumentDatabase(context.env, {
      projectId: assertProjectId(authentication.project_id),
    });
  }
  if (context?.data?.documentDatabase) return context.data.documentDatabase;
  return createTelegramDocumentDatabase(context.env);
}

export function databaseResultResponse(result, { location } = {}) {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    ...(result?.etag ? { ETag: result.etag } : {}),
    ...(location ? { Location: location } : {}),
  });
  return jsonResponse(result.body, {
    status: result.status,
    headers,
  });
}

export function databaseListResponse(result) {
  return jsonResponse(result, {
    headers: { 'Cache-Control': 'no-store' },
  });
}

export function idempotencyKeyForRequest(request) {
  const value = request.headers.get('Idempotency-Key');
  return value === null ? undefined : value;
}
