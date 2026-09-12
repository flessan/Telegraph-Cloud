import { CloudValidationError } from './errors.js';

// These limits apply to future Telegraph Cloud document and object APIs only.
// They intentionally do not change the established /upload compatibility
// contract in this phase.
export const CLOUD_LIMITS = Object.freeze({
  MAX_PROJECT_ID_LENGTH: 64,
  MAX_COLLECTION_NAME_LENGTH: 64,
  MAX_DOCUMENT_ID_LENGTH: 128,
  MIN_BUCKET_NAME_LENGTH: 3,
  MAX_BUCKET_NAME_LENGTH: 63,
  MAX_OBJECT_KEY_BYTES: 1024,
  MAX_DOCUMENT_JSON_BYTES: 128 * 1024,
  MAX_DOCUMENT_DEPTH: 32,
  MAX_DOCUMENT_NODES: 10_000,
  MAX_OBJECT_BYTES: 20 * 1024 * 1024,
  MAX_CUSTOM_METADATA_ENTRIES: 20,
  MAX_CUSTOM_METADATA_NAME_BYTES: 64,
  MAX_CUSTOM_METADATA_VALUE_BYTES: 1024,
  MAX_CUSTOM_METADATA_BYTES: 8 * 1024,
  MAX_LEGACY_FILE_ID_LENGTH: 512,
  MAX_TELEGRAM_FILE_ID_LENGTH: 512,
});

const encoder = new TextEncoder();
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const PROJECT_ID_PATTERN = /^prj_[A-Za-z0-9_-]{8,48}$/;
const COLLECTION_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BUCKET_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])$/;
const MIME_TYPE_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CUSTOM_METADATA_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const TELEGRAM_FILE_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DANGEROUS_JSON_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function invalid(code, message) {
  throw new CloudValidationError(code, message);
}

function hasUnpairedSurrogate(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertString(value, code, message, { allowEmpty = false, maxBytes } = {}) {
  if (typeof value !== 'string') invalid(code, message);
  if (!allowEmpty && value.length === 0) invalid(code, message);
  if (hasUnpairedSurrogate(value)) invalid(code, message);
  if (maxBytes !== undefined && utf8ByteLength(value) > maxBytes) invalid(code, message);
  return value;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIpv4Like(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value);
}

function objectKeyHasUnsafeSegment(value) {
  return value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..');
}

export function utf8ByteLength(value) {
  return encoder.encode(String(value)).byteLength;
}

/**
 * Project ids are generated server-side in later phases. Keeping the prefix
 * mandatory prevents a project id from being confused with a human-facing slug
 * or a Cloudflare binding name.
 */
export function assertProjectId(value) {
  const projectId = assertString(value, 'invalid_project_id', 'Invalid project identifier.', {
    maxBytes: CLOUD_LIMITS.MAX_PROJECT_ID_LENGTH,
  });
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    invalid('invalid_project_id', 'Invalid project identifier.');
  }
  return projectId;
}

export function assertCollectionName(value) {
  const collection = assertString(value, 'invalid_collection_name', 'Invalid collection name.', {
    maxBytes: CLOUD_LIMITS.MAX_COLLECTION_NAME_LENGTH,
  });
  if (!COLLECTION_NAME_PATTERN.test(collection)) {
    invalid('invalid_collection_name', 'Invalid collection name.');
  }
  return collection;
}

export function assertDocumentId(value) {
  const documentId = assertString(value, 'invalid_document_id', 'Invalid document identifier.', {
    maxBytes: CLOUD_LIMITS.MAX_DOCUMENT_ID_LENGTH,
  });
  if (!DOCUMENT_ID_PATTERN.test(documentId) || documentId === '.' || documentId === '..') {
    invalid('invalid_document_id', 'Invalid document identifier.');
  }
  return documentId;
}

/**
 * The bucket rule intentionally follows the portable S3 DNS-style subset.
 * Full S3 compatibility belongs to Phase 5, but rejecting ambiguous names now
 * means later adapters do not have to reinterpret existing bucket identities.
 */
export function assertBucketName(value) {
  const bucket = assertString(value, 'invalid_bucket_name', 'Invalid bucket name.', {
    maxBytes: CLOUD_LIMITS.MAX_BUCKET_NAME_LENGTH,
  });
  if (
    bucket.length < CLOUD_LIMITS.MIN_BUCKET_NAME_LENGTH
    || !BUCKET_NAME_PATTERN.test(bucket)
    || bucket.includes('..')
    || isIpv4Like(bucket)
  ) {
    invalid('invalid_bucket_name', 'Invalid bucket name.');
  }
  return bucket;
}

/**
 * Object keys are a safe, URL-path-shaped subset rather than arbitrary S3 keys
 * in the first release. They can contain Unicode text and `/` hierarchy, but
 * cannot contain a traversal segment, percent encoding, query/fragment marker,
 * control character, backslash, or ambiguous empty segment.
 */
export function assertObjectKey(value) {
  const key = assertString(value, 'invalid_object_key', 'Invalid object key.', {
    maxBytes: CLOUD_LIMITS.MAX_OBJECT_KEY_BYTES,
  });
  if (
    key !== key.normalize('NFC')
    || CONTROL_CHARACTER.test(key)
    || /[\\%?#]/.test(key)
    || objectKeyHasUnsafeSegment(key)
  ) {
    invalid('invalid_object_key', 'Invalid object key.');
  }
  return key;
}

/**
 * This deliberately conservative check is used only by the legacy file proxy.
 * It blocks values that could alter an upstream URL while allowing historical
 * opaque ids and filenames to remain readable. New Cloud object keys use the
 * stricter assertObjectKey rule above.
 */
export function isSafeLegacyFileId(value) {
  return typeof value === 'string'
    && value.length > 0
    && utf8ByteLength(value) <= CLOUD_LIMITS.MAX_LEGACY_FILE_ID_LENGTH
    && !hasUnpairedSurrogate(value)
    && !CONTROL_CHARACTER.test(value)
    && !/[\\/%?#]/.test(value)
    && value !== '.'
    && value !== '..';
}

export function assertMimeType(value, { fallback = 'application/octet-stream' } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const supplied = assertString(value, 'invalid_mime_type', 'Invalid MIME type.', { maxBytes: 255 });
  if (CONTROL_CHARACTER.test(supplied)) {
    invalid('invalid_mime_type', 'Invalid MIME type.');
  }
  const mediaType = supplied.split(';', 1)[0].trim().toLowerCase();
  if (!MIME_TYPE_PATTERN.test(mediaType)) {
    invalid('invalid_mime_type', 'Invalid MIME type.');
  }
  return mediaType;
}

/**
 * Normalizes safe bare metadata names for later `x-amz-meta-*` header mapping.
 * Values remain strings so they cannot become implicit JSON structures or HTTP
 * header syntax when a storage adapter renders them.
 */
export function normalizeCustomMetadata(value) {
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    invalid('invalid_custom_metadata', 'Custom metadata must be a JSON object.');
  }

  const entries = Object.entries(value);
  if (entries.length > CLOUD_LIMITS.MAX_CUSTOM_METADATA_ENTRIES) {
    invalid('too_many_custom_metadata_entries', 'Too many custom metadata entries.');
  }

  const normalized = {};
  let totalBytes = 0;
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (
      DANGEROUS_JSON_KEYS.has(rawName)
      || utf8ByteLength(name) > CLOUD_LIMITS.MAX_CUSTOM_METADATA_NAME_BYTES
      || !CUSTOM_METADATA_NAME_PATTERN.test(name)
      || Object.prototype.hasOwnProperty.call(normalized, name)
    ) {
      invalid('invalid_custom_metadata_name', 'Invalid custom metadata name.');
    }
    if (typeof rawValue !== 'string' || CONTROL_CHARACTER.test(rawValue) || hasUnpairedSurrogate(rawValue)) {
      invalid('invalid_custom_metadata_value', 'Invalid custom metadata value.');
    }
    const valueBytes = utf8ByteLength(rawValue);
    if (valueBytes > CLOUD_LIMITS.MAX_CUSTOM_METADATA_VALUE_BYTES) {
      invalid('invalid_custom_metadata_value', 'Invalid custom metadata value.');
    }

    totalBytes += utf8ByteLength(name) + valueBytes;
    if (totalBytes > CLOUD_LIMITS.MAX_CUSTOM_METADATA_BYTES) {
      invalid('custom_metadata_too_large', 'Custom metadata is too large.');
    }
    normalized[name] = rawValue;
  }

  return normalized;
}

export function assertDeclaredContentLength(value, { maxBytes = CLOUD_LIMITS.MAX_OBJECT_BYTES } = {}) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    invalid('invalid_content_length', 'Invalid Content-Length header.');
  }
  const bytes = Number(value);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes) {
    invalid('object_too_large', 'Object exceeds the supported size limit.');
  }
  return bytes;
}

export function assertByteLength(value, { maxBytes = CLOUD_LIMITS.MAX_OBJECT_BYTES, code = 'object_too_large', message = 'Object exceeds the supported size limit.' } = {}) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maxBytes) {
    invalid(code, message);
  }
  return value;
}

/**
 * Validates a JSON document/journal payload without applying any collection
 * schema. Telegraph Cloud documents are arbitrary JSON objects, bounded only
 * for safe Cloudflare/Telegram transport and predictable recovery behavior.
 */
export function serializeJsonDocument(value, { maxBytes = CLOUD_LIMITS.MAX_DOCUMENT_JSON_BYTES } = {}) {
  if (!isPlainObject(value)) {
    invalid('document_must_be_object', 'Document must be a JSON object.');
  }

  const state = { nodes: 0 };
  validateJsonValue(value, 0, state);

  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (_) {
    invalid('invalid_json_document', 'Document must be JSON serializable.');
  }
  if (typeof serialized !== 'string') {
    invalid('invalid_json_document', 'Document must be JSON serializable.');
  }

  const byteLength = utf8ByteLength(serialized);
  if (byteLength > maxBytes) {
    invalid('document_too_large', 'Document exceeds the supported size limit.');
  }

  // Return a plain JSON clone so callers cannot accidentally persist a value
  // with getters, mutable prototypes, or non-JSON types after validation.
  return {
    value: JSON.parse(serialized),
    serialized,
    byteLength,
  };
}

export function assertTelegramFileId(value) {
  const fileId = assertString(value, 'invalid_telegram_file_id', 'Invalid Telegram file identifier.', {
    maxBytes: CLOUD_LIMITS.MAX_TELEGRAM_FILE_ID_LENGTH,
  });
  if (!TELEGRAM_FILE_ID_PATTERN.test(fileId)) {
    invalid('invalid_telegram_file_id', 'Invalid Telegram file identifier.');
  }
  return fileId;
}

export function assertTelegramMessageId(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalid('invalid_telegram_message_id', 'Invalid Telegram message identifier.');
  }
  return value;
}

function validateJsonValue(value, depth, state) {
  state.nodes += 1;
  if (state.nodes > CLOUD_LIMITS.MAX_DOCUMENT_NODES) {
    invalid('document_too_complex', 'Document exceeds the supported complexity limit.');
  }
  if (depth > CLOUD_LIMITS.MAX_DOCUMENT_DEPTH) {
    invalid('document_too_deep', 'Document exceeds the supported nesting depth.');
  }

  if (value === null) return;
  const type = typeof value;
  if (type === 'string' || type === 'boolean') return;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      invalid('invalid_json_document', 'Document must contain JSON values only.');
    }
    return;
  }
  if (type !== 'object') {
    invalid('invalid_json_document', 'Document must contain JSON values only.');
  }

  if (Array.isArray(value)) {
    if (value.length > CLOUD_LIMITS.MAX_DOCUMENT_NODES) {
      invalid('document_too_complex', 'Document exceeds the supported complexity limit.');
    }
    for (const item of value) validateJsonValue(item, depth + 1, state);
    return;
  }

  if (!isPlainObject(value)) {
    invalid('invalid_json_document', 'Document must contain JSON values only.');
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (
      DANGEROUS_JSON_KEYS.has(key)
      || CONTROL_CHARACTER.test(key)
      || hasUnpairedSurrogate(key)
      || utf8ByteLength(key) > CLOUD_LIMITS.MAX_DOCUMENT_ID_LENGTH
    ) {
      invalid('invalid_document_property', 'Document contains an invalid property name.');
    }
    validateJsonValue(nestedValue, depth + 1, state);
  }
}
