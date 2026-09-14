import { normalizeCustomMetadata } from './validation.js';

// Request-header parsing shared by the legacy object HTTP facade and the S3
// protocol adapter. It intentionally owns neither object storage nor transport
// behavior, so authentication/protocol modules do not pull in Telegram code.
export const CUSTOM_METADATA_PREFIX = 'x-amz-meta-';

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

export function objectWriteInput(request) {
  return {
    ifMatch: request.headers.get('If-Match'),
    ifNoneMatch: request.headers.get('If-None-Match'),
    ifUnmodifiedSince: request.headers.get('If-Unmodified-Since'),
    idempotencyKey: request.headers.get('Idempotency-Key'),
  };
}

export function objectReadConditions(request) {
  return {
    ifMatch: request.headers.get('If-Match'),
    ifNoneMatch: request.headers.get('If-None-Match'),
    ifModifiedSince: request.headers.get('If-Modified-Since'),
    ifUnmodifiedSince: request.headers.get('If-Unmodified-Since'),
    range: request.headers.get('Range'),
  };
}

// Pages Functions route params may arrive percent-encoded or already decoded
// depending on the runtime. The S3 adapter avoids the ambiguity by decoding
// the request path itself; catch-all object routes use this helper to do the
// same, exactly once. A single route segment that decodes into a path
// separator is rejected so an encoded slash cannot rewrite the hierarchy
// after routing. Returns null on malformed percent encoding; valid object
// keys never contain a literal '%' (validation rejects that character), so
// decoding an already-decoded segment is idempotent here.
function decodeSingle(segment, { rejectSeparator }) {
  try {
    const decoded = decodeURIComponent(String(segment));
    if (rejectSeparator && (decoded.includes('/') || decoded.includes('\\'))) return null;
    return decoded;
  } catch (_) {
    return null;
  }
}

export function decodeRouteSegment(value) {
  // A catch-all parameter is an array of individual path segments: an encoded
  // slash inside one element must not create new hierarchy after routing.
  if (Array.isArray(value)) {
    const decoded = [];
    for (const segment of value) {
      const part = decodeSingle(segment, { rejectSeparator: true });
      if (part === null) return null;
      decoded.push(part);
    }
    return decoded.join('/');
  }
  if (value === undefined || value === null) return '';
  // Tests (and single-segment params) may supply the full key as one scalar;
  // real separators in that string are already the intended hierarchy.
  return decodeSingle(value, { rejectSeparator: false });
}
