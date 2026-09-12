import { CloudRequestError, CloudValidationError } from './errors.js';

const encoder = new TextEncoder();
const DEFAULT_MAX_BYTES = 8 * 1024;

function isJsonContentType(request) {
  const contentType = request.headers.get('Content-Type') || '';
  return contentType.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

function declaredLength(request, maxBytes) {
  const raw = request.headers.get('Content-Length');
  if (raw === null || raw === '') return;
  if (!/^\d+$/.test(raw) || Number(raw) > maxBytes) {
    throw new CloudRequestError('control_payload_too_large', 'Control-plane request body exceeds the supported size limit.', { status: 413 });
  }
}

async function readBoundedText(request, maxBytes) {
  if (!request.body) return '';
  if (!request.body.getReader) {
    const text = await request.text();
    if (encoder.encode(text).byteLength > maxBytes) {
      throw new CloudRequestError('control_payload_too_large', 'Control-plane request body exceeds the supported size limit.', { status: 413 });
    }
    return text;
  }

  const reader = request.body.getReader();
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
        throw new CloudRequestError('control_payload_too_large', 'Control-plane request body exceeds the supported size limit.', { status: 413 });
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
    throw new CloudRequestError('malformed_json', 'Control-plane request body must be valid UTF-8 JSON.', { status: 400 });
  }
}

/**
 * Bounded JSON reader for dashboard-only control-plane requests. It rejects
 * form uploads and oversized bodies before project/key services inspect input.
 */
export async function readControlJson(request, { allowEmpty = false, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new CloudValidationError('invalid_control_limit', 'Control-plane request configuration is invalid.');
  }
  declaredLength(request, maxBytes);
  if (!isJsonContentType(request)) {
    if (allowEmpty && !request.body) return undefined;
    throw new CloudRequestError('unsupported_content_type', 'Control-plane requests require application/json.', { status: 415 });
  }
  const text = await readBoundedText(request, maxBytes);
  if (!text.trim()) {
    if (allowEmpty) return undefined;
    throw new CloudRequestError('malformed_json', 'Control-plane request body must be valid JSON.', { status: 400 });
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new CloudRequestError('malformed_json', 'Control-plane request body must be valid JSON.', { status: 400 });
  }
}

/**
 * Project list query parser intentionally recognizes only pagination controls.
 * In particular no token/key query parameter can accidentally become auth.
 */
function parseBoundedListQuery(searchParams, { queryCode, limitCode, label }) {
  const result = {};
  const seen = new Set();
  for (const [name, value] of searchParams.entries()) {
    if ((name !== 'limit' && name !== 'cursor') || seen.has(name)) {
      throw new CloudValidationError(queryCode, `${label} list query is invalid.`);
    }
    seen.add(name);
    if (name === 'limit') {
      if (!/^\d+$/.test(value)) {
        throw new CloudValidationError(limitCode, `${label} list limit is outside the supported range.`);
      }
      result.limit = Number(value);
    } else {
      result.cursor = value;
    }
  }
  return result;
}

export function parseProjectListQuery(searchParams) {
  return parseBoundedListQuery(searchParams, {
    queryCode: 'invalid_project_query',
    limitCode: 'invalid_project_limit',
    label: 'Project',
  });
}

export function parseApiKeyListQuery(searchParams) {
  return parseBoundedListQuery(searchParams, {
    queryCode: 'invalid_api_key_query',
    limitCode: 'invalid_api_key_limit',
    label: 'API key',
  });
}
