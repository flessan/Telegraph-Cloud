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
