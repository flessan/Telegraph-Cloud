import { createDocumentDatabaseService } from './contracts.js';
import { applySchemaDefaults, normalizeSchemaFields, validateDocumentAgainstSchema } from './collection-schema.js';
import {
  CloudAdapterError,
  CloudConfigurationError,
  CloudConflictError,
  CloudNotFoundError,
  CloudRecoveryError,
  CloudRequestError,
  CloudValidationError,
  isTelegraphCloudError,
} from './errors.js';
import { createCloudPersistenceFoundation } from './foundation.js';
import {
  CLOUD_LIMITS,
  assertCollectionName,
  assertProjectId,
  assertDocumentId,
  assertDocumentQueryField,
  assertDocumentQueryValue,
  assertIdempotencyKey,
  assertTelegramFileId,
  assertTelegramMessageId,
  serializeJsonDocument,
  utf8ByteLength,
} from './validation.js';

// This provider accepts an optional trusted server-derived project scope. With
// no scope it deliberately retains the Phase 2 dashboard-only legacy namespace;
// with one, every data-plane KV key and immutable Telegram revision is isolated
// under that opaque project identifier. It never trusts a client project ID.
export const DOCUMENT_REVISION_SCHEMA = 'telegraph-cloud.record.v1';
export const DOCUMENT_RECORD_INDEX_SCHEMA = 'telegraph-cloud.record-index.v1';
export const DOCUMENT_REVISION_INDEX_SCHEMA = 'telegraph-cloud.revision-index.v1';
export const DOCUMENT_OUTBOX_SCHEMA = 'telegraph-cloud.mutation-outbox.v1';

export const DOCUMENT_INDEX_NAMESPACES = Object.freeze({
  record: 'db-record',
  revision: 'db-revision',
  outbox: 'db-outbox',
  collection: 'db-collection',
  collectionMeta: 'db-collection-meta',
  filter: 'db-filter',
});

export const DOCUMENT_DATABASE_ENV = Object.freeze({
  maxDocumentBytes: 'TELEGRAPH_CLOUD_MAX_DOCUMENT_BYTES',
  maxCollectionNameLength: 'TELEGRAPH_CLOUD_MAX_COLLECTION_NAME_LENGTH',
  maxRecordIdLength: 'TELEGRAPH_CLOUD_MAX_RECORD_ID_LENGTH',
  defaultQueryLimit: 'TELEGRAPH_CLOUD_DEFAULT_QUERY_LIMIT',
  maxQueryLimit: 'TELEGRAPH_CLOUD_MAX_QUERY_LIMIT',
});

const RESERVED_DOCUMENT_FIELDS = new Set([
  'id',
  'collection',
  'record_id',
  'version',
  'created_at',
  'updated_at',
  'deleted',
  'deleted_at',
  'tombstone',
  'operation',
  'event_id',
  'parent',
  'parent_event_id',
  'schema',
  'journal_pointer',
  'query_fields',
]);
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
// Applied/conflict idempotency receipts are intentionally short-lived. Pending
// outboxes never expire because they are the only automatic recovery trail for
// a Telegram revision that did not finish materializing in KV.
const APPLIED_OUTBOX_TTL_SECONDS = 7 * 24 * 60 * 60;
const encoder = new TextEncoder();

function own(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function indexFailure(operation, error) {
  if (isTelegraphCloudError(error)) return error;
  return new CloudAdapterError(
    `cloud_index_${operation}_failed`,
    'The Telegraph Cloud index is temporarily unavailable.',
    { status: 503 },
  );
}

function storedStateFailure() {
  return new CloudAdapterError(
    'cloud_index_invalid_record',
    'The Telegraph Cloud index contains invalid record state.',
    { status: 500 },
  );
}

function safeTimestamp(value) {
  return typeof value === 'string' && ISO_DATE_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

function toIsoTimestamp(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (!safeTimestamp(timestamp)) {
    throw new CloudConfigurationError('invalid_database_clock', 'Database clock configuration is invalid.');
  }
  return timestamp;
}

function readConfiguredInteger(env, variable, fallback, { min, max }) {
  const raw = env?.[variable];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = typeof raw === 'number' ? raw : String(raw);
  if (typeof value === 'string' && !/^\d+$/.test(value)) {
    throw new CloudConfigurationError('invalid_database_limit', 'A Telegraph Cloud database limit is invalid.');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new CloudConfigurationError('invalid_database_limit', 'A Telegraph Cloud database limit is invalid.');
  }
  return parsed;
}

/**
 * Resolves explicit, operator-configurable ceilings while retaining hard
 * transport caps. The document cap deliberately stays below the Phase 1
 * 128 KiB journal cap so revision metadata always has space as well.
 */
export function resolveDocumentDatabaseLimits(env) {
  const maxCollectionNameLength = readConfiguredInteger(
    env,
    DOCUMENT_DATABASE_ENV.maxCollectionNameLength,
    CLOUD_LIMITS.MAX_COLLECTION_NAME_LENGTH,
    { min: 1, max: CLOUD_LIMITS.MAX_COLLECTION_NAME_LENGTH },
  );
  const maxRecordIdLength = readConfiguredInteger(
    env,
    DOCUMENT_DATABASE_ENV.maxRecordIdLength,
    CLOUD_LIMITS.MAX_DOCUMENT_ID_LENGTH,
    { min: 26, max: CLOUD_LIMITS.MAX_DOCUMENT_ID_LENGTH },
  );
  const maxDocumentBytes = readConfiguredInteger(
    env,
    DOCUMENT_DATABASE_ENV.maxDocumentBytes,
    CLOUD_LIMITS.DEFAULT_DOCUMENT_DATABASE_MAX_BYTES,
    { min: 1024, max: CLOUD_LIMITS.MAX_DOCUMENT_DATABASE_MAX_BYTES },
  );
  const maxQueryLimit = readConfiguredInteger(
    env,
    DOCUMENT_DATABASE_ENV.maxQueryLimit,
    CLOUD_LIMITS.MAX_DOCUMENT_QUERY_LIMIT,
    { min: 1, max: CLOUD_LIMITS.MAX_DOCUMENT_QUERY_LIMIT },
  );
  const defaultQueryLimit = readConfiguredInteger(
    env,
    DOCUMENT_DATABASE_ENV.defaultQueryLimit,
    CLOUD_LIMITS.DEFAULT_DOCUMENT_QUERY_LIMIT,
    { min: 1, max: maxQueryLimit },
  );

  return Object.freeze({
    maxCollectionNameLength,
    maxRecordIdLength,
    maxDocumentBytes,
    defaultQueryLimit,
    maxQueryLimit,
    maxQueryFilters: CLOUD_LIMITS.MAX_DOCUMENT_QUERY_FILTERS,
    maxCursorBytes: CLOUD_LIMITS.MAX_DOCUMENT_CURSOR_BYTES,
  });
}

function bytesToBase64url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBytes(value) {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    throw new CloudValidationError('invalid_cursor', 'Invalid pagination cursor.');
  }
  let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  try {
    const binary = atob(normalized);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch (_) {
    throw new CloudValidationError('invalid_cursor', 'Invalid pagination cursor.');
  }
}

function createRandomId(prefix) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}${bytesToBase64url(bytes)}`;
}

function assertGeneratedId(value, maxBytes = CLOUD_LIMITS.MAX_DOCUMENT_ID_LENGTH) {
  try {
    return assertDocumentId(value, { maxBytes });
  } catch (_) {
    throw new CloudConfigurationError('invalid_database_id_generator', 'Database ID generation is unavailable.');
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

async function sha256Base64url(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToBase64url(new Uint8Array(digest));
}

async function requestFingerprint(value) {
  return sha256Base64url(canonicalJson(value));
}

function encodeFilterValue(value) {
  return bytesToBase64url(encoder.encode(value));
}

function normalizeUserDocument(value, limits) {
  let normalized;
  try {
    normalized = serializeJsonDocument(value, { maxBytes: limits.maxDocumentBytes }).value;
  } catch (error) {
    if (error?.code === 'document_too_large') {
      throw new CloudRequestError('document_too_large', 'Document exceeds the supported size limit.', { status: 413 });
    }
    throw error;
  }

  for (const key of Object.keys(normalized)) {
    if (RESERVED_DOCUMENT_FIELDS.has(key) || key === '_expected_version') {
      throw new CloudValidationError('managed_field_not_allowed', 'Document contains a managed field.');
    }
  }
  return normalized;
}

function validateFullDocument(document, limits) {
  try {
    return serializeJsonDocument(document, { maxBytes: limits.maxDocumentBytes }).value;
  } catch (error) {
    if (error?.code === 'document_too_large') {
      throw new CloudRequestError('document_too_large', 'Document exceeds the supported size limit.', { status: 413 });
    }
    throw error;
  }
}

function normalizeStoredDocument(value, recordId) {
  const document = serializeJsonDocument(value).value;
  if (document.id !== recordId) throw new Error('invalid document id');
  for (const key of Object.keys(document)) {
    if ((key !== 'id' && RESERVED_DOCUMENT_FIELDS.has(key)) || key === '_expected_version') {
      throw new Error('invalid managed document field');
    }
  }
  return document;
}

function indexedQueryFields(document) {
  const fields = [];
  for (const [rawField, value] of Object.entries(document)) {
    if (rawField === 'id' || typeof value !== 'string') continue;
    try {
      const field = assertDocumentQueryField(rawField);
      const string = assertDocumentQueryValue(value);
      fields.push([field, string]);
    } catch (_) {
      // Documents are arbitrary JSON. A value can remain stored/readable even
      // when it is deliberately outside the bounded equality-index subset.
    }
  }
  fields.sort(([left], [right]) => left.localeCompare(right));
  return Object.fromEntries(fields.slice(0, CLOUD_LIMITS.MAX_DOCUMENT_INDEXED_FIELDS));
}

function normalizeStoredQueryFields(value) {
  if (!plainObject(value)) throw storedStateFailure();
  const entries = [];
  for (const [rawField, rawValue] of Object.entries(value)) {
    try {
      entries.push([assertDocumentQueryField(rawField), assertDocumentQueryValue(rawValue)]);
    } catch (_) {
      throw storedStateFailure();
    }
  }
  if (entries.length > CLOUD_LIMITS.MAX_DOCUMENT_INDEXED_FIELDS) throw storedStateFailure();
  return Object.fromEntries(entries);
}

function normalizeJournalPointer(value) {
  try {
    if (!plainObject(value) || value.provider !== 'telegram-journal') throw new Error('invalid pointer');
    return {
      provider: 'telegram-journal',
      fileId: assertTelegramFileId(value.fileId),
      messageId: assertTelegramMessageId(value.messageId),
    };
  } catch (_) {
    throw storedStateFailure();
  }
}

function normalizeStoredProjectScope(value, expectedProjectId) {
  const hasProjectId = own(value, 'project_id');
  if (expectedProjectId === null) {
    if (hasProjectId) throw new Error('unexpected project scope');
    return null;
  }
  if (!hasProjectId || assertProjectId(value.project_id) !== expectedProjectId) {
    throw new Error('invalid project scope');
  }
  return expectedProjectId;
}

function scopedProjectField(projectId) {
  return projectId === null ? {} : { project_id: projectId };
}

function normalizeCurrentRecord(value, expectedProjectId = null) {
  if (value === null) return null;
  try {
    if (!plainObject(value) || value.schema !== DOCUMENT_RECORD_INDEX_SCHEMA) throw new Error('invalid record');
    const projectId = normalizeStoredProjectScope(value, expectedProjectId);
    const collection = assertCollectionName(value.collection);
    const recordId = assertDocumentId(value.record_id);
    if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Error('invalid version');
    if (!safeTimestamp(value.created_at) || !safeTimestamp(value.updated_at)
      || Date.parse(value.updated_at) < Date.parse(value.created_at)) throw new Error('invalid timestamp');
    if (typeof value.deleted !== 'boolean' || typeof value.event_id !== 'string') throw new Error('invalid metadata');
    const eventId = assertDocumentId(value.event_id);
    const parentEventId = value.parent_event_id === null || value.parent_event_id === undefined
      ? null
      : assertDocumentId(value.parent_event_id);
    if ((value.version === 1 && (parentEventId !== null || value.updated_at !== value.created_at))
      || (value.version > 1 && parentEventId === null)) {
      throw new Error('invalid record parent');
    }
    const document = normalizeStoredDocument(value.document, recordId);
    const journalPointer = normalizeJournalPointer(value.journal_pointer);
    const queryFields = normalizeStoredQueryFields(value.query_fields || {});
    const deletedAt = value.deleted_at === undefined ? undefined : value.deleted_at;
    if (deletedAt !== undefined && !safeTimestamp(deletedAt)) throw new Error('invalid deletion timestamp');
    if ((value.deleted && !deletedAt) || (!value.deleted && deletedAt !== undefined)
      || (deletedAt && deletedAt !== value.updated_at)) {
      throw new Error('invalid tombstone timestamp');
    }
    return {
      schema: DOCUMENT_RECORD_INDEX_SCHEMA,
      ...scopedProjectField(projectId),
      collection,
      record_id: recordId,
      version: value.version,
      created_at: value.created_at,
      updated_at: value.updated_at,
      deleted: value.deleted,
      ...(deletedAt ? { deleted_at: deletedAt } : {}),
      event_id: eventId,
      parent_event_id: parentEventId,
      journal_pointer: journalPointer,
      document,
      query_fields: queryFields,
    };
  } catch (error) {
    if (error?.code === 'cloud_index_invalid_record') throw error;
    throw storedStateFailure();
  }
}

function normalizeRevisionIndex(value, expectedProjectId = null) {
  try {
    if (!plainObject(value) || value.schema !== DOCUMENT_REVISION_INDEX_SCHEMA) throw new Error('invalid revision index');
    const projectId = normalizeStoredProjectScope(value, expectedProjectId);
    const collection = assertCollectionName(value.collection);
    const recordId = assertDocumentId(value.record_id);
    const eventId = assertDocumentId(value.event_id);
    if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Error('invalid version');
    if (!safeTimestamp(value.created_at) || !safeTimestamp(value.updated_at)
      || Date.parse(value.updated_at) < Date.parse(value.created_at)) throw new Error('invalid timestamp');
    if (!['create', 'update', 'delete'].includes(value.operation) || typeof value.deleted !== 'boolean') {
      throw new Error('invalid operation');
    }
    if ((value.operation === 'delete') !== value.deleted) throw new Error('invalid tombstone');
    const parentEventId = value.parent_event_id === null || value.parent_event_id === undefined
      ? null
      : assertDocumentId(value.parent_event_id);
    if ((value.version === 1 && (value.operation !== 'create' || parentEventId !== null
      || value.updated_at !== value.created_at))
      || (value.version > 1 && (value.operation === 'create' || parentEventId === null))) {
      throw new Error('invalid revision parent');
    }
    const deletedAt = value.deleted_at === undefined ? undefined : value.deleted_at;
    if (deletedAt !== undefined && !safeTimestamp(deletedAt)) throw new Error('invalid deletion timestamp');
    if ((value.deleted && !deletedAt) || (!value.deleted && deletedAt !== undefined)
      || (deletedAt && deletedAt !== value.updated_at)) {
      throw new Error('invalid tombstone timestamp');
    }
    return {
      schema: DOCUMENT_REVISION_INDEX_SCHEMA,
      ...scopedProjectField(projectId),
      collection,
      record_id: recordId,
      version: value.version,
      event_id: eventId,
      parent_event_id: parentEventId,
      operation: value.operation,
      created_at: value.created_at,
      updated_at: value.updated_at,
      deleted: value.deleted,
      ...(deletedAt ? { deleted_at: deletedAt } : {}),
      journal_pointer: normalizeJournalPointer(value.journal_pointer),
    };
  } catch (_) {
    throw storedStateFailure();
  }
}

function normalizeRevision(value, expectedProjectId = null) {
  try {
    if (!plainObject(value) || value.schema !== DOCUMENT_REVISION_SCHEMA) throw new Error('invalid revision');
    const projectId = normalizeStoredProjectScope(value, expectedProjectId);
    const collection = assertCollectionName(value.collection);
    const recordId = assertDocumentId(value.record_id);
    const eventId = assertDocumentId(value.event_id);
    if (!Number.isSafeInteger(value.version) || value.version < 1) throw new Error('invalid version');
    if (!safeTimestamp(value.created_at) || !safeTimestamp(value.updated_at)
      || Date.parse(value.updated_at) < Date.parse(value.created_at)) throw new Error('invalid timestamp');
    if (!['create', 'update', 'delete'].includes(value.operation) || typeof value.deleted !== 'boolean') {
      throw new Error('invalid operation');
    }
    if ((value.operation === 'delete') !== value.deleted) throw new Error('invalid tombstone');
    if (value.version === 1) {
      if (value.operation !== 'create' || value.parent !== null || value.updated_at !== value.created_at) {
        throw new Error('invalid create parent');
      }
    } else if (value.operation === 'create' || (
      !plainObject(value.parent)
      || !Number.isSafeInteger(value.parent.version)
      || value.parent.version !== value.version - 1
      || typeof value.parent.event_id !== 'string'
    )) {
      throw new Error('invalid revision parent');
    }
    const parent = value.parent === null ? null : {
      event_id: assertDocumentId(value.parent.event_id),
      version: value.parent.version,
    };
    const document = normalizeStoredDocument(value.document, recordId);
    const deletedAt = value.deleted_at === undefined ? undefined : value.deleted_at;
    if (deletedAt !== undefined && !safeTimestamp(deletedAt)) throw new Error('invalid deletion timestamp');
    if ((value.deleted && !deletedAt) || (!value.deleted && deletedAt !== undefined)
      || (deletedAt && deletedAt !== value.updated_at)) {
      throw new Error('invalid tombstone timestamp');
    }
    return {
      schema: DOCUMENT_REVISION_SCHEMA,
      ...scopedProjectField(projectId),
      event_id: eventId,
      collection,
      record_id: recordId,
      operation: value.operation,
      version: value.version,
      parent,
      created_at: value.created_at,
      updated_at: value.updated_at,
      deleted: value.deleted,
      ...(deletedAt ? { deleted_at: deletedAt } : {}),
      document,
    };
  } catch (_) {
    throw storedStateFailure();
  }
}

function normalizeOutbox(value, expectedProjectId = null) {
  if (value === null) return null;
  try {
    if (!plainObject(value) || value.schema !== DOCUMENT_OUTBOX_SCHEMA) throw new Error('invalid outbox');
    const projectId = normalizeStoredProjectScope(value, expectedProjectId);
    const eventId = assertDocumentId(value.event_id);
    const collection = assertCollectionName(value.collection);
    const recordId = assertDocumentId(value.record_id);
    if (!['intent', 'journaled', 'applied', 'conflict'].includes(value.status)) throw new Error('invalid status');
    if (typeof value.request_fingerprint !== 'string' || !BASE64URL_PATTERN.test(value.request_fingerprint)) {
      throw new Error('invalid fingerprint');
    }
    if (value.idempotency_digest !== null && value.idempotency_digest !== undefined
      && (typeof value.idempotency_digest !== 'string' || !BASE64URL_PATTERN.test(value.idempotency_digest))) {
      throw new Error('invalid idempotency digest');
    }
    if (!safeTimestamp(value.created_at) || !safeTimestamp(value.updated_at)) throw new Error('invalid timestamps');
    const revision = normalizeRevision(value.revision, expectedProjectId);
    if (revision.event_id !== eventId || revision.collection !== collection || revision.record_id !== recordId) {
      throw new Error('outbox revision mismatch');
    }
    const previousQueryFields = normalizeStoredQueryFields(value.previous_query_fields || {});
    let journalPointer = null;
    if (value.journal_pointer !== null && value.journal_pointer !== undefined) {
      journalPointer = normalizeJournalPointer(value.journal_pointer);
    }
    if ((value.status === 'journaled' || value.status === 'applied') && !journalPointer) {
      throw new Error('journal pointer missing');
    }
    return {
      schema: DOCUMENT_OUTBOX_SCHEMA,
      ...scopedProjectField(projectId),
      event_id: eventId,
      collection,
      record_id: recordId,
      status: value.status,
      request_fingerprint: value.request_fingerprint,
      idempotency_digest: value.idempotency_digest || null,
      revision,
      previous_query_fields: previousQueryFields,
      journal_pointer: journalPointer,
      created_at: value.created_at,
      updated_at: value.updated_at,
      ...(value.conflict ? { conflict: clone(value.conflict) } : {}),
    };
  } catch (error) {
    if (error?.code === 'cloud_index_invalid_record') throw error;
    throw storedStateFailure();
  }
}

function normalizeCollectionDefinition(value, limits) {
  if (!plainObject(value)) throw new CloudValidationError('invalid_collection_definition', 'Collection definition must be an object.');
  const name = assertCollectionName(value.name, { maxBytes: limits.maxCollectionNameLength });
  const description = value.description === undefined ? '' : String(value.description);
  if (utf8ByteLength(description) > 1000) {
    throw new CloudValidationError('invalid_collection_description', 'Collection description is too long.');
  }
  const fields = normalizeSchemaFields(value.fields === undefined ? [] : value.fields, RESERVED_DOCUMENT_FIELDS);
  return { schema: 'telegraph-cloud.collection.v1', name, description, fields };
}

function normalizeExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CloudValidationError('invalid_expected_version', 'Expected version must be a positive integer.');
  }
  return value;
}

function publicRecord(record) {
  return {
    data: clone(record.document),
    version: record.version,
    created_at: record.created_at,
    updated_at: record.updated_at,
  };
}

function publicDelete(record) {
  return {
    data: { id: record.record_id },
    version: record.version,
    created_at: record.created_at,
    updated_at: record.updated_at,
    deleted_at: record.deleted_at || record.updated_at,
    deleted: true,
  };
}

function resultForRecord(record, operation) {
  return {
    status: operation === 'create' ? 201 : 200,
    etag: `"${record.version}"`,
    body: operation === 'delete' ? publicDelete(record) : publicRecord(record),
  };
}

// An applied outbox replay derives its response from the validated immutable
// revision rather than trusting a separately persisted arbitrary response body.
// This keeps internal journal pointers out of the HTTP surface even if an
// index value is malformed or manually inspected/altered.
function resultForRevision(revision) {
  return resultForRecord({
    record_id: revision.record_id,
    version: revision.version,
    created_at: revision.created_at,
    updated_at: revision.updated_at,
    ...(revision.deleted_at ? { deleted_at: revision.deleted_at } : {}),
    document: revision.document,
  }, revision.operation);
}

function recordFromRevision(revision, journalPointer) {
  return {
    schema: DOCUMENT_RECORD_INDEX_SCHEMA,
    ...scopedProjectField(own(revision, 'project_id') ? revision.project_id : null),
    collection: revision.collection,
    record_id: revision.record_id,
    version: revision.version,
    created_at: revision.created_at,
    updated_at: revision.updated_at,
    deleted: revision.deleted,
    ...(revision.deleted_at ? { deleted_at: revision.deleted_at } : {}),
    event_id: revision.event_id,
    parent_event_id: revision.parent?.event_id || null,
    journal_pointer: journalPointer,
    document: revision.document,
    query_fields: revision.deleted ? {} : indexedQueryFields(revision.document),
  };
}

function revisionIndexFromRevision(revision, journalPointer) {
  return {
    schema: DOCUMENT_REVISION_INDEX_SCHEMA,
    ...scopedProjectField(own(revision, 'project_id') ? revision.project_id : null),
    collection: revision.collection,
    record_id: revision.record_id,
    version: revision.version,
    event_id: revision.event_id,
    parent_event_id: revision.parent ? revision.parent.event_id : null,
    operation: revision.operation,
    created_at: revision.created_at,
    updated_at: revision.updated_at,
    deleted: revision.deleted,
    ...(revision.deleted_at ? { deleted_at: revision.deleted_at } : {}),
    journal_pointer: journalPointer,
  };
}

function indexEntry(record) {
  return {
    event_id: record.event_id,
    version: record.version,
    updated_at: record.updated_at,
  };
}

function compareOpaqueIds(left, right) {
  if (left === right) return 0;
  // IDs are URL-safe ASCII generated by this service. Code-point comparison is
  // deliberately used instead of locale collation so every edge resolves a
  // concurrently visible same-version fork the same way.
  return left < right ? -1 : 1;
}

function sameQueryFieldValue(left, right) {
  return left === right;
}

function satisfiesFilters(record, filters) {
  if (record.deleted) return false;
  return Object.entries(filters).every(([field, value]) => (
    own(record.document, field) && typeof record.document[field] === 'string'
      && sameQueryFieldValue(record.document[field], value)
  ));
}

function querySignature(collection, filters) {
  return canonicalJson({ collection, filters: Object.fromEntries(Object.entries(filters).sort(([a], [b]) => a.localeCompare(b))) });
}

function encodeCursor(cursor, signature) {
  return bytesToBase64url(encoder.encode(JSON.stringify({ v: 1, c: cursor, s: signature })));
}

function decodeCursor(value, signature, limits) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || utf8ByteLength(value) > limits.maxCursorBytes) {
    throw new CloudValidationError('invalid_cursor', 'Invalid pagination cursor.');
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(base64urlToBytes(value)));
  } catch (_) {
    throw new CloudValidationError('invalid_cursor', 'Invalid pagination cursor.');
  }
  if (
    !plainObject(parsed)
    || parsed.v !== 1
    || typeof parsed.c !== 'string'
    || parsed.c.length > limits.maxCursorBytes
    || typeof parsed.s !== 'string'
    || parsed.s !== signature
  ) {
    throw new CloudValidationError('invalid_cursor', 'Invalid pagination cursor.');
  }
  return parsed.c;
}

function normalizeListQuery(query, limits) {
  const source = query || {};
  if (!plainObject(source)) {
    throw new CloudValidationError('invalid_query_filter', 'Invalid document query filter.');
  }
  const filters = source.filters === undefined || source.filters === null ? {} : source.filters;
  if (!plainObject(filters)) {
    throw new CloudValidationError('invalid_query_filter', 'Invalid document query filter.');
  }
  const normalizedFilters = {};
  const entries = Object.entries(filters);
  if (entries.length > limits.maxQueryFilters) {
    throw new CloudValidationError('too_many_query_filters', 'Too many document query filters.');
  }
  for (const [rawField, rawValue] of entries) {
    const field = assertDocumentQueryField(rawField);
    if (field === 'id') {
      throw new CloudValidationError('invalid_query_filter', 'Record IDs must be addressed by the single-record route.');
    }
    if (own(normalizedFilters, field)) {
      throw new CloudValidationError('invalid_query_filter', 'Duplicate document query filter.');
    }
    normalizedFilters[field] = assertDocumentQueryValue(rawValue);
  }

  const limit = source.limit === undefined || source.limit === null
    ? limits.defaultQueryLimit
    : source.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.maxQueryLimit) {
    throw new CloudValidationError('invalid_query_limit', 'Query limit is outside the supported range.');
  }
  if (source.cursor !== undefined && source.cursor !== null && typeof source.cursor !== 'string') {
    throw new CloudValidationError('invalid_cursor', 'Invalid pagination cursor.');
  }

  return {
    limit,
    cursor: source.cursor || undefined,
    filters: normalizedFilters,
  };
}

function keyRecordId(keyName) {
  const recordId = String(keyName).split(':').pop();
  try {
    return assertDocumentId(recordId);
  } catch (_) {
    throw storedStateFailure();
  }
}

/**
 * The real Phase 2 provider. Telegram receives complete immutable revision
 * snapshots; Cloudflare KV receives only derived current/index/outbox state.
 * It intentionally does not attempt to model relational transactions or SQL.
 */
export function createTelegramDocumentDatabase(env, {
  foundation = null,
  index = null,
  journal = null,
  // This option is internal server composition state. Route code may supply it
  // only after Bearer-key authentication; no request parameter is ever mapped
  // into it. `null` preserves the Phase 2 dashboard legacy namespace.
  projectId = null,
  now = () => new Date(),
  createId = createRandomId,
} = {}) {
  const projectScope = projectId === null || projectId === undefined ? null : assertProjectId(projectId);
  const limits = resolveDocumentDatabaseLimits(env);
  const persistence = foundation || createCloudPersistenceFoundation(env, { index, journal });
  const cloudIndex = persistence?.index;
  const telegramJournal = persistence?.journal;

  if (!cloudIndex || typeof cloudIndex.getJson !== 'function' || typeof cloudIndex.putJson !== 'function'
    || typeof cloudIndex.remove !== 'function' || typeof cloudIndex.list !== 'function') {
    throw new CloudConfigurationError('cloud_index_unavailable', 'The Telegraph Cloud index is unavailable.');
  }
  if (!telegramJournal || typeof telegramJournal.appendJson !== 'function' || typeof telegramJournal.validateConfig !== 'function') {
    throw new CloudConfigurationError('telegram_journal_unavailable', 'The Telegram journal is unavailable.');
  }

  function scopedSegments(segments) {
    return projectScope === null ? segments : [projectScope, ...segments];
  }

  async function getIndex(namespace, ...segments) {
    try {
      return await cloudIndex.getJson(namespace, ...scopedSegments(segments));
    } catch (error) {
      throw indexFailure('read', error);
    }
  }

  async function putIndex(namespace, segments, value, options = {}) {
    try {
      await cloudIndex.putJson(namespace, scopedSegments(segments), value, options);
    } catch (error) {
      throw indexFailure('write', error);
    }
  }

  async function removeIndex(namespace, ...segments) {
    try {
      await cloudIndex.remove(namespace, ...scopedSegments(segments));
    } catch (error) {
      throw indexFailure('delete', error);
    }
  }

  async function listIndex(namespace, options = {}) {
    try {
      return await cloudIndex.list(namespace, {
        ...options,
        prefixSegments: scopedSegments(options.prefixSegments || []),
      });
    } catch (error) {
      throw indexFailure('list', error);
    }
  }

  async function readCurrent(collection, recordId) {
    return normalizeCurrentRecord(await getIndex(DOCUMENT_INDEX_NAMESPACES.record, collection, recordId), projectScope);
  }

  async function readOutbox(outboxId) {
    return normalizeOutbox(await getIndex(DOCUMENT_INDEX_NAMESPACES.outbox, outboxId), projectScope);
  }

  async function writeOutbox(outboxId, value, options) {
    await putIndex(DOCUMENT_INDEX_NAMESPACES.outbox, [outboxId], value, options);
  }

  function validateJournalConfiguration() {
    try {
      telegramJournal.validateConfig();
    } catch (_) {
      throw new CloudConfigurationError('telegram_journal_unavailable', 'Telegram journal configuration is unavailable.');
    }
  }

  async function appendRevision(revision) {
    validateJournalConfiguration();
    try {
      const pointer = await telegramJournal.appendJson(revision);
      try {
        return normalizeJournalPointer(pointer);
      } catch (_) {
        throw new CloudAdapterError(
          'telegram_journal_append_invalid_response',
          'Telegram journal append returned an invalid pointer.',
          { status: 502 },
        );
      }
    } catch (error) {
      // The journal adapter normally emits a safe CloudAdapterError already,
      // but normalize even injected/future adapter failures here. Upstream
      // descriptions can contain URLs or credentials and must not survive in
      // a database-level error instance or telemetry event.
      const code = isTelegraphCloudError(error) && /^telegram_journal_[a-z_]+$/.test(error.code)
        ? error.code
        : 'telegram_journal_append_failed';
      throw new CloudAdapterError(code, 'Telegram journal append failed.', { status: 502 });
    }
  }

  async function allocateRecordId(collection) {
    // Collisions are cryptographically unlikely, but checking before the
    // journal write makes the generated-id guarantee explicit and bounded.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const recordId = assertGeneratedId(createId('rec_'), limits.maxRecordIdLength);
      const existing = await readCurrent(collection, recordId);
      if (!existing) return recordId;
    }
    throw new CloudAdapterError('record_id_allocation_failed', 'A record identifier could not be allocated.', { status: 503 });
  }

  function generatedId(prefix) {
    return assertGeneratedId(createId(prefix));
  }

  async function mutationIdentity(idempotencyKey, fingerprint) {
    if (idempotencyKey === undefined || idempotencyKey === null) {
      return {
        outboxId: generatedId('mut_'),
        idempotencyDigest: null,
        fingerprint,
      };
    }
    const safeKey = assertIdempotencyKey(idempotencyKey);
    const idempotencyDigest = await sha256Base64url(`idempotency:v1:${safeKey}`);
    return {
      outboxId: assertGeneratedId(`idem_${idempotencyDigest}`),
      idempotencyDigest,
      fingerprint,
    };
  }

  function assertMatchingIdempotency(existing, fingerprint) {
    if (existing.request_fingerprint !== fingerprint) {
      throw new CloudConflictError(
        'idempotency_key_reused',
        'The Idempotency-Key has already been used with a different mutation.',
      );
    }
  }

  function createRevision({ eventId, collection, recordId, operation, version, parent, createdAt, updatedAt, document }) {
    const deleted = operation === 'delete';
    return {
      schema: DOCUMENT_REVISION_SCHEMA,
      ...scopedProjectField(projectScope),
      event_id: eventId,
      collection,
      record_id: recordId,
      operation,
      version,
      parent,
      created_at: createdAt,
      updated_at: updatedAt,
      deleted,
      ...(deleted ? { deleted_at: updatedAt } : {}),
      document,
    };
  }

  async function ensureRevisionIndex(revision, journalPointer) {
    const segments = [revision.collection, revision.record_id, String(revision.version)];
    const candidate = revisionIndexFromRevision(revision, journalPointer);

    // KV does not offer compare-and-swap. If two edges append children of the
    // same parent, the lexically smaller opaque event ID is the deterministic
    // materialized winner. Both immutable Telegram events remain retained.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existingValue = await getIndex(DOCUMENT_INDEX_NAMESPACES.revision, ...segments);
      if (existingValue !== null) {
        const existing = normalizeRevisionIndex(existingValue, projectScope);
        if (existing.collection !== revision.collection || existing.record_id !== revision.record_id
          || existing.version !== revision.version) {
          throw storedStateFailure();
        }
        if (existing.parent_event_id !== candidate.parent_event_id) {
          throw new CloudConflictError(
            'version_conflict',
            'A competing revision already exists for this record version.',
          );
        }
        const comparison = compareOpaqueIds(existing.event_id, revision.event_id);
        if (comparison === 0) return;
        if (comparison < 0) {
          throw new CloudConflictError(
            'version_conflict',
            'A competing revision already exists for this record version.',
          );
        }
      }

      await putIndex(DOCUMENT_INDEX_NAMESPACES.revision, segments, candidate);
      const confirmedValue = await getIndex(DOCUMENT_INDEX_NAMESPACES.revision, ...segments);
      if (confirmedValue === null) {
        throw new CloudAdapterError('cloud_index_revision_unconfirmed', 'Cloud index revision state is unavailable.', { status: 503 });
      }
      const confirmed = normalizeRevisionIndex(confirmedValue, projectScope);
      if (confirmed.collection !== revision.collection || confirmed.record_id !== revision.record_id
        || confirmed.version !== revision.version) {
        throw storedStateFailure();
      }
      if (confirmed.parent_event_id !== candidate.parent_event_id) {
        throw new CloudConflictError(
          'version_conflict',
          'A competing revision already exists for this record version.',
        );
      }
      const comparison = compareOpaqueIds(confirmed.event_id, revision.event_id);
      if (comparison === 0) return;
      if (comparison < 0) {
        throw new CloudConflictError(
          'version_conflict',
          'A competing revision already exists for this record version.',
        );
      }
      // A larger candidate became visible between our write and confirmation;
      // retry the deterministic lower-ID write a bounded number of times.
    }
    throw new CloudAdapterError('cloud_index_revision_unconfirmed', 'Cloud index revision state is unavailable.', { status: 503 });
  }

  async function confirmCurrentRecord(record) {
    const segments = [record.collection, record.record_id];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const confirmed = await readCurrent(record.collection, record.record_id);
      if (!confirmed) {
        throw new CloudAdapterError('cloud_index_record_unconfirmed', 'Cloud index record state is unavailable.', { status: 503 });
      }
      const comparison = compareOpaqueIds(confirmed.event_id, record.event_id);
      if (comparison === 0) return confirmed;

      const isSameParentFork = confirmed.version === record.version
        && confirmed.parent_event_id === record.parent_event_id;
      if (isSameParentFork && comparison > 0) {
        await putIndex(DOCUMENT_INDEX_NAMESPACES.record, segments, record);
        continue;
      }
      throw new CloudConflictError(
        'version_conflict',
        'A competing revision became current while this mutation was applying.',
        { details: { current_version: confirmed.version } },
      );
    }
    throw new CloudAdapterError('cloud_index_record_unconfirmed', 'Cloud index record state is unavailable.', { status: 503 });
  }

  async function putVisibleIndexes(record) {
    await putIndex(
      DOCUMENT_INDEX_NAMESPACES.collection,
      [record.collection, record.record_id],
      indexEntry(record),
    );
    for (const [field, value] of Object.entries(record.query_fields)) {
      await putIndex(
        DOCUMENT_INDEX_NAMESPACES.filter,
        [record.collection, field, encodeFilterValue(value), record.record_id],
        indexEntry(record),
      );
    }
  }

  async function removeVisibleIndexes(record, { keepCollection = false, onlyMissingFrom = null } = {}) {
    if (!keepCollection) {
      await removeIndex(DOCUMENT_INDEX_NAMESPACES.collection, record.collection, record.record_id);
    }
    for (const [field, value] of Object.entries(record.query_fields)) {
      if (onlyMissingFrom && own(onlyMissingFrom, field) && onlyMissingFrom[field] === value) continue;
      await removeIndex(
        DOCUMENT_INDEX_NAMESPACES.filter,
        record.collection,
        field,
        encodeFilterValue(value),
        record.record_id,
      );
    }
  }

  async function applyMaterialization(outbox) {
    const revision = outbox.revision;
    const journalPointer = outbox.journal_pointer;
    const current = await readCurrent(revision.collection, revision.record_id);

    if (current && current.event_id === revision.event_id) {
      if (current.version !== revision.version || current.deleted !== revision.deleted) {
        throw storedStateFailure();
      }
      // A prior invocation may have completed the current-record write but
      // stopped before cleaning stale visibility keys or its outbox. Repeating
      // these idempotent writes is the bounded recovery path.
      await ensureRevisionIndex(revision, journalPointer);
      if (current.deleted) {
        await removeVisibleIndexes(current);
      } else {
        await putVisibleIndexes(current);
        const prior = {
          ...current,
          query_fields: outbox.previous_query_fields,
        };
        await removeVisibleIndexes(prior, { keepCollection: true, onlyMissingFrom: current.query_fields });
      }
      return resultForRecord(current, revision.operation);
    }

    if (revision.operation === 'create') {
      if (current) {
        throw new CloudConflictError('record_id_collision', 'A generated record identifier already exists.');
      }
    } else {
      const isSameParentFork = current
        && current.version === revision.version
        && current.parent_event_id === revision.parent.event_id;
      if (isSameParentFork) {
        if (compareOpaqueIds(current.event_id, revision.event_id) < 0) {
          throw new CloudConflictError(
            'version_conflict',
            'A competing revision already exists for this record version.',
            { details: { current_version: current.version } },
          );
        }
      } else if (!current || current.deleted || current.version !== revision.parent.version
        || current.event_id !== revision.parent.event_id) {
        throw new CloudConflictError(
          'version_conflict',
          'The record changed before this mutation could be applied.',
          { details: { ...(current ? { current_version: current.version } : {}) } },
        );
      }
    }

    await ensureRevisionIndex(revision, journalPointer);
    const next = recordFromRevision(revision, journalPointer);

    if (next.deleted) {
      // Write the tombstone before removing visibility keys. A concurrent read
      // then fails closed (404) even if a stale collection/filter key remains.
      await putIndex(DOCUMENT_INDEX_NAMESPACES.record, [next.collection, next.record_id], next);
      await confirmCurrentRecord(next);
      if (current) await removeVisibleIndexes(current);
    } else {
      // Make lookup/filter entries available before publishing the new current
      // pointer. Stale prior filter entries are cleaned afterwards and are
      // always verified against the current record while listing.
      await putVisibleIndexes(next);
      await putIndex(DOCUMENT_INDEX_NAMESPACES.record, [next.collection, next.record_id], next);
      await confirmCurrentRecord(next);
      if (current) {
        await removeVisibleIndexes(current, {
          keepCollection: true,
          onlyMissingFrom: next.query_fields,
        });
      }
    }

    return resultForRecord(next, revision.operation);
  }

  async function persistConflict(outboxId, outbox, error) {
    const conflict = {
      code: error.code === 'record_id_collision' ? 'record_id_collision' : 'version_conflict',
      ...(error.details && plainObject(error.details) ? { details: clone(error.details) } : {}),
    };
    try {
      await writeOutbox(outboxId, {
        ...outbox,
        status: 'conflict',
        conflict,
        updated_at: toIsoTimestamp(now),
      }, { expirationTtl: APPLIED_OUTBOX_TTL_SECONDS });
    } catch (_) {
      // The journal itself remains immutable/canonical. A future retry will
      // evaluate the same event again rather than treating an outbox write as
      // proof of success.
    }
  }

  async function resumeMutation(outboxId, outbox) {
    if (outbox.status === 'applied') {
      return resultForRevision(outbox.revision);
    }
    if (outbox.status === 'conflict') {
      const conflict = plainObject(outbox.conflict) ? outbox.conflict : { code: 'version_conflict' };
      throw new CloudConflictError(
        conflict.code === 'record_id_collision' ? 'record_id_collision' : 'version_conflict',
        'The mutation conflicts with the current record revision.',
        { details: plainObject(conflict.details) ? clone(conflict.details) : undefined },
      );
    }

    let journaled = outbox;
    if (outbox.status === 'intent') {
      const journalPointer = await appendRevision(outbox.revision);
      journaled = {
        ...outbox,
        status: 'journaled',
        journal_pointer: journalPointer,
        updated_at: toIsoTimestamp(now),
      };
      try {
        await writeOutbox(outboxId, journaled);
      } catch (_) {
        // Telegram has accepted the immutable revision but its materialized
        // pointer could not be recorded. The retained intent/event ID lets a
        // client retry safely with the same Idempotency-Key.
        throw new CloudRecoveryError();
      }
    }

    try {
      const result = await applyMaterialization(journaled);
      const applied = {
        ...journaled,
        status: 'applied',
        updated_at: toIsoTimestamp(now),
      };
      try {
        await writeOutbox(outboxId, applied, { expirationTtl: APPLIED_OUTBOX_TTL_SECONDS });
      } catch (_) {
        // Current/index state is already materialized. A same-key retry can
        // deterministically complete the outbox marker without a new record.
      }
      return result;
    } catch (error) {
      if (error instanceof CloudConflictError) {
        await persistConflict(outboxId, journaled, error);
        throw error;
      }
      // A Telegram revision exists at this point. Do not report a normal
      // mutation success if KV failed part way through; expose a retryable,
      // safe pending state instead of losing the recovery trail.
      throw new CloudRecoveryError();
    }
  }

  async function beginMutation(identity, intent) {
    const existing = await readOutbox(identity.outboxId);
    if (existing) {
      assertMatchingIdempotency(existing, identity.fingerprint);
      return resumeMutation(identity.outboxId, existing);
    }
    try {
      await writeOutbox(identity.outboxId, intent);
    } catch (error) {
      // No Telegram append has happened before this write, so this is an
      // ordinary index availability failure rather than a pending mutation.
      throw error;
    }
    return resumeMutation(identity.outboxId, intent);
  }

  function createIntent({ identity, eventId, collection, recordId, revision, previousQueryFields }) {
    const timestamp = toIsoTimestamp(now);
    return {
      schema: DOCUMENT_OUTBOX_SCHEMA,
      ...scopedProjectField(projectScope),
      event_id: eventId,
      collection,
      record_id: recordId,
      status: 'intent',
      request_fingerprint: identity.fingerprint,
      idempotency_digest: identity.idempotencyDigest,
      revision,
      previous_query_fields: previousQueryFields,
      journal_pointer: null,
      created_at: timestamp,
      updated_at: timestamp,
    };
  }

  async function getCollection(collectionInput) {
    const collection = assertCollectionName(collectionInput, { maxBytes: limits.maxCollectionNameLength });
    const stored = await getIndex(DOCUMENT_INDEX_NAMESPACES.collectionMeta, collection);
    if (!stored) throw new CloudNotFoundError('collection_not_found', 'The collection does not exist.');
    return normalizeCollectionDefinition(stored, limits);
  }

  // Collections without metadata are legacy: null schema, no enforcement.
  async function readCollectionSchema(collection) {
    const stored = await getIndex(DOCUMENT_INDEX_NAMESPACES.collectionMeta, collection);
    if (!stored) return null;
    return normalizeCollectionDefinition(stored, limits);
  }

  async function createCollection(input) {
    const definition = normalizeCollectionDefinition(input, limits);
    const existing = await getIndex(DOCUMENT_INDEX_NAMESPACES.collectionMeta, definition.name);
    if (existing) throw new CloudConflictError('collection_exists', 'A collection with this name already exists.');
    await putIndex(DOCUMENT_INDEX_NAMESPACES.collectionMeta, [definition.name], definition);
    return { status: 201, body: definition };
  }

  // Update a collection's description and/or schema. Defining a schema on a
  // legacy collection is the migration path: it constrains future writes but
  // never touches stored records.
  async function patchCollection(nameInput, patchInput) {
    const name = assertCollectionName(nameInput, { maxBytes: limits.maxCollectionNameLength });
    if (!plainObject(patchInput)) {
      throw new CloudValidationError('invalid_collection_patch', 'Collection patch must be an object.');
    }
    const unsupported = Object.keys(patchInput).filter((field) => field !== 'description' && field !== 'fields');
    if (unsupported.length > 0) {
      throw new CloudValidationError('invalid_collection_patch', 'Collection patch contains unsupported fields.');
    }
    const stored = await getIndex(DOCUMENT_INDEX_NAMESPACES.collectionMeta, name);
    if (!stored) throw new CloudNotFoundError('collection_not_found', 'The collection does not exist.');
    const current = normalizeCollectionDefinition(stored, limits);
    const description = patchInput.description === undefined ? current.description : String(patchInput.description);
    if (utf8ByteLength(description) > 1000) {
      throw new CloudValidationError('invalid_collection_description', 'Collection description is too long.');
    }
    const fields = patchInput.fields === undefined
      ? current.fields
      : normalizeSchemaFields(patchInput.fields, RESERVED_DOCUMENT_FIELDS);
    const definition = { schema: 'telegraph-cloud.collection.v1', name, description, fields };
    await putIndex(DOCUMENT_INDEX_NAMESPACES.collectionMeta, [name], definition);
    return definition;
  }

  // Delete a collection's metadata only. A collection with records is
  // refused (409) rather than orphaning data; records are deleted
  // individually through the versioned document API.
  async function deleteCollection(nameInput) {
    const name = assertCollectionName(nameInput, { maxBytes: limits.maxCollectionNameLength });
    const stored = await getIndex(DOCUMENT_INDEX_NAMESPACES.collectionMeta, name);
    if (!stored) throw new CloudNotFoundError('collection_not_found', 'The collection does not exist.');
    const page = await listIndex(DOCUMENT_INDEX_NAMESPACES.collection, { limit: 1 });
    if (page && Array.isArray(page.keys) && page.keys.length > 0) {
      throw new CloudConflictError('collection_not_empty', 'Delete the records before deleting the collection.');
    }
    await removeIndex(DOCUMENT_INDEX_NAMESPACES.collectionMeta, name);
    return { deleted: true, name };
  }

  async function createDocument(collectionInput, documentInput, { idempotencyKey } = {}) {
    const collection = assertCollectionName(collectionInput, { maxBytes: limits.maxCollectionNameLength });
    let document = normalizeUserDocument(documentInput, limits);
    const schema = await readCollectionSchema(collection);
    if (schema) {
      // Defaults are applied before the idempotency fingerprint so retries
      // and first writes agree on the canonical document.
      document = applySchemaDefaults(document, schema);
      validateDocumentAgainstSchema(document, schema, { operation: 'create' });
    }
    const fingerprint = await requestFingerprint({ operation: 'create', collection, document });
    const identity = await mutationIdentity(idempotencyKey, fingerprint);
    const existing = await readOutbox(identity.outboxId);
    if (existing) {
      assertMatchingIdempotency(existing, identity.fingerprint);
      return resumeMutation(identity.outboxId, existing);
    }

    const recordId = await allocateRecordId(collection);
    const createdAt = toIsoTimestamp(now);
    const fullDocument = validateFullDocument({ id: recordId, ...document }, limits);
    const eventId = generatedId('evt_');
    const revision = createRevision({
      eventId,
      collection,
      recordId,
      operation: 'create',
      version: 1,
      parent: null,
      createdAt,
      updatedAt: createdAt,
      document: fullDocument,
    });
    const intent = createIntent({
      identity,
      eventId,
      collection,
      recordId,
      revision,
      previousQueryFields: {},
    });
    return beginMutation(identity, intent);
  }

  async function patchDocument(collectionInput, recordIdInput, patchInput, {
    expectedVersion,
    idempotencyKey,
  } = {}) {
    const collection = assertCollectionName(collectionInput, { maxBytes: limits.maxCollectionNameLength });
    const recordId = assertDocumentId(recordIdInput, { maxBytes: limits.maxRecordIdLength });
    const expected = normalizeExpectedVersion(expectedVersion);
    const patch = normalizeUserDocument(patchInput, limits);
    if (Object.keys(patch).length === 0) {
      throw new CloudValidationError('empty_patch', 'Patch must contain at least one document field.');
    }
    const fingerprint = await requestFingerprint({
      operation: 'update', collection, record_id: recordId, expected_version: expected, patch,
    });
    const identity = await mutationIdentity(idempotencyKey, fingerprint);
    const existing = await readOutbox(identity.outboxId);
    if (existing) {
      assertMatchingIdempotency(existing, identity.fingerprint);
      return resumeMutation(identity.outboxId, existing);
    }

    const current = await readCurrent(collection, recordId);
    if (!current || current.deleted) throw new CloudNotFoundError();
    if (current.version !== expected) {
      throw new CloudConflictError(
        'version_conflict',
        'Expected version does not match the current record version.',
        { details: { current_version: current.version } },
      );
    }

    const schema = await readCollectionSchema(collection);
    if (schema) {
      // The merged document is what the new revision will store. Legacy
      // fields predating the schema stay readable; the patch may not add
      // fields outside the schema or violate required/type/select rules.
      validateDocumentAgainstSchema({ ...current.document, ...patch }, schema, { operation: 'patch', patch });
    }
    const updatedAt = toIsoTimestamp(now);
    const nextDocument = validateFullDocument({ ...current.document, ...patch }, limits);
    const eventId = generatedId('evt_');
    const revision = createRevision({
      eventId,
      collection,
      recordId,
      operation: 'update',
      version: current.version + 1,
      parent: { event_id: current.event_id, version: current.version },
      createdAt: current.created_at,
      updatedAt,
      document: nextDocument,
    });
    const intent = createIntent({
      identity,
      eventId,
      collection,
      recordId,
      revision,
      previousQueryFields: current.query_fields,
    });
    return beginMutation(identity, intent);
  }

  async function deleteDocument(collectionInput, recordIdInput, {
    expectedVersion,
    idempotencyKey,
  } = {}) {
    const collection = assertCollectionName(collectionInput, { maxBytes: limits.maxCollectionNameLength });
    const recordId = assertDocumentId(recordIdInput, { maxBytes: limits.maxRecordIdLength });
    const expected = normalizeExpectedVersion(expectedVersion);
    const fingerprint = await requestFingerprint({
      operation: 'delete', collection, record_id: recordId, expected_version: expected,
    });
    const identity = await mutationIdentity(idempotencyKey, fingerprint);
    const existing = await readOutbox(identity.outboxId);
    if (existing) {
      assertMatchingIdempotency(existing, identity.fingerprint);
      return resumeMutation(identity.outboxId, existing);
    }

    const current = await readCurrent(collection, recordId);
    if (!current || current.deleted) throw new CloudNotFoundError();
    if (current.version !== expected) {
      throw new CloudConflictError(
        'version_conflict',
        'Expected version does not match the current record version.',
        { details: { current_version: current.version } },
      );
    }

    const updatedAt = toIsoTimestamp(now);
    const eventId = generatedId('evt_');
    const revision = createRevision({
      eventId,
      collection,
      recordId,
      operation: 'delete',
      version: current.version + 1,
      parent: { event_id: current.event_id, version: current.version },
      createdAt: current.created_at,
      updatedAt,
      document: current.document,
    });
    const intent = createIntent({
      identity,
      eventId,
      collection,
      recordId,
      revision,
      previousQueryFields: current.query_fields,
    });
    return beginMutation(identity, intent);
  }

  async function getDocument(collectionInput, recordIdInput) {
    const collection = assertCollectionName(collectionInput, { maxBytes: limits.maxCollectionNameLength });
    const recordId = assertDocumentId(recordIdInput, { maxBytes: limits.maxRecordIdLength });
    const record = await readCurrent(collection, recordId);
    if (!record || record.deleted) throw new CloudNotFoundError();
    return resultForRecord(record, 'get');
  }

  async function listDocuments(collectionInput, query = {}) {
    const collection = assertCollectionName(collectionInput, { maxBytes: limits.maxCollectionNameLength });
    const { limit, cursor, filters } = normalizeListQuery(query, limits);
    const signature = querySignature(collection, filters);
    const selectedFilter = Object.entries(filters).sort(([left], [right]) => left.localeCompare(right))[0];
    const namespace = selectedFilter ? DOCUMENT_INDEX_NAMESPACES.filter : DOCUMENT_INDEX_NAMESPACES.collection;
    const prefixSegments = selectedFilter
      ? [collection, selectedFilter[0], encodeFilterValue(selectedFilter[1])]
      : [collection];
    const page = await listIndex(namespace, {
      prefixSegments,
      limit,
      cursor: decodeCursor(cursor, signature, limits),
    });
    if (!page || !Array.isArray(page.keys) || typeof page.list_complete !== 'boolean') {
      throw new CloudAdapterError('cloud_index_invalid_page', 'Cloud index returned an invalid page.', { status: 500 });
    }

    // Collection/filter index keys end with the opaque record ID. KV prefix
    // pages are key-ordered; sorting this bounded page explicitly keeps the
    // documented id:asc response deterministic even with a simple mock.
    const candidateIds = page.keys
      .map((key) => keyRecordId(key?.name))
      .sort((left, right) => left.localeCompare(right));
    const records = await Promise.all(candidateIds.map((recordId) => readCurrent(collection, recordId)));
    const data = records
      .filter((record) => record && satisfiesFilters(record, filters))
      .map((record) => publicRecord(record));

    const hasMore = !page.list_complete;
    if (hasMore && (typeof page.cursor !== 'string' || !page.cursor)) {
      throw new CloudAdapterError('cloud_index_invalid_page', 'Cloud index returned an invalid page.', { status: 500 });
    }
    return {
      data,
      limit,
      order: 'id:asc',
      ...(hasMore ? { next_cursor: encodeCursor(page.cursor, signature) } : {}),
      has_more: hasMore,
    };
  }

  async function listDocumentHistory(collectionInput, recordIdInput) {
    const collection = assertCollectionName(collectionInput, { maxBytes: limits.maxCollectionNameLength });
    const recordId = assertDocumentId(recordIdInput, { maxBytes: limits.maxRecordIdLength });
    const page = await listIndex(DOCUMENT_INDEX_NAMESPACES.revision, {
      prefixSegments: [collection, recordId],
      limit: CLOUD_LIMITS.MAX_DOCUMENT_QUERY_LIMIT,
    });
    const entries = await Promise.all((page.keys || []).map(async (key) => {
      const version = String(key?.name || '').split(':').pop();
      const value = normalizeRevisionIndex(await getIndex(
        DOCUMENT_INDEX_NAMESPACES.revision,
        collection,
        recordId,
        version,
      ), projectScope);
      if (value.collection !== collection || value.record_id !== recordId || String(value.version) !== version) {
        throw storedStateFailure();
      }
      return {
        version: value.version,
        operation: value.operation,
        created_at: value.created_at,
        updated_at: value.updated_at,
        deleted: value.deleted,
      };
    }));
    return entries.sort((left, right) => left.version - right.version);
  }

  // Console-only collection discovery. The collection index stores one small
  // key-name entry per visible record, so distinct collections come from key
  // names alone (no revision payloads). The scan is deliberately bounded: a
  // larger project gets truthful `truncated` state instead of an unbounded KV
  // walk, and this never becomes a query engine.
  async function listCollections(input = {}) {
    if (!plainObject(input) || Object.keys(input).some((field) => field !== 'maxKeys')) {
      throw new CloudValidationError('invalid_collection_query', 'Collection query is invalid.');
    }
    const hardCap = CLOUD_LIMITS.MAX_COLLECTION_SCAN_KEYS;
    const requested = input.maxKeys === undefined ? hardCap : Number(input.maxKeys);
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > hardCap) {
      throw new CloudValidationError('invalid_collection_scan_limit', 'Collection scan limit is invalid.');
    }

    const data = [];
    const metadataPage = await listIndex(DOCUMENT_INDEX_NAMESPACES.collectionMeta, { limit: Math.min(requested, 1000) });
    for (const entry of (metadataPage.keys || [])) {
      const name = String(entry?.name || '').split(':').pop();
      if (!name) continue;
      const definition = await getIndex(DOCUMENT_INDEX_NAMESPACES.collectionMeta, name);
      if (!definition) continue;
      data.push({ ...normalizeCollectionDefinition(definition, limits), record_count: 0 });
    }

    const scopeSegments = projectScope === null ? [] : [projectScope];
    const basePrefix = [cloudIndex.key(DOCUMENT_INDEX_NAMESPACES.collection), ...scopeSegments].join(':') + ':';
    const counts = new Map();
    let cursor;
    let scanned = 0;
    let truncated = false;
    while (scanned < requested) {
      const page = await listIndex(DOCUMENT_INDEX_NAMESPACES.collection, {
        prefixSegments: [],
        limit: Math.min(1000, requested - scanned),
        ...(cursor ? { cursor } : {}),
      });
      if (!page || !Array.isArray(page.keys) || typeof page.list_complete !== 'boolean') {
        throw new CloudAdapterError('cloud_index_invalid_page', 'Cloud index returned an invalid page.', { status: 500 });
      }
      for (const entry of page.keys) {
        const name = String(entry?.name || '');
        if (!name.startsWith(basePrefix)) continue;
        const remainder = name.slice(basePrefix.length);
        const separator = remainder.indexOf(':');
        const collection = separator === -1 ? remainder : remainder.slice(0, separator);
        if (collection) counts.set(collection, (counts.get(collection) || 0) + 1);
      }
      scanned += page.keys.length;
      if (page.list_complete) break;
      cursor = page.cursor;
      if (!cursor) { truncated = true; break; }
    }

    for (const [name, count] of counts.entries()) {
      const existing = data.find((item) => item.name === name);
      if (existing) existing.record_count = count;
      else {
        try {
          const safeName = assertCollectionName(name, { maxBytes: limits.maxCollectionNameLength });
          data.push({ schema: 'telegraph-cloud.collection.v1', name: safeName, description: '', fields: [], record_count: count });
        } catch (_) { /* ignore corrupt legacy collection key */ }
      }
    }
    data.sort((left, right) => left.name.localeCompare(right.name));
    if (truncated) for (const item of data) item.record_count_truncated = true;
    return Object.freeze({ data: Object.freeze(data), order: 'name:asc', scanned_keys: scanned, truncated });
  }

  return createDocumentDatabaseService({
    createCollection,
    getCollection,
    patchCollection,
    deleteCollection,
    createDocument,
    getDocument,
    listDocuments,
    patchDocument,
    deleteDocument,
    listDocumentHistory,
    listCollections,
  });
}

/**
 * Parse a document-list query without accepting duplicate controls or turning
 * an arbitrary URL parameter into executable query syntax. Values are exact
 * top-level string equality filters only; the provider performs the matching.
 */
export function parseDocumentListQuery(searchParams, env) {
  const limits = resolveDocumentDatabaseLimits(env);
  const filters = {};
  let limit;
  let cursor;
  const seenControls = new Set();

  for (const [name, value] of searchParams.entries()) {
    if (name === 'limit' || name === 'cursor' || name === 'sort') {
      if (seenControls.has(name)) {
        throw new CloudValidationError('invalid_query_parameter', 'Duplicate query parameter.');
      }
      seenControls.add(name);
      if (name === 'limit') {
        if (!/^\d+$/.test(value)) {
          throw new CloudValidationError('invalid_query_limit', 'Query limit is outside the supported range.');
        }
        limit = Number(value);
      } else if (name === 'cursor') {
        cursor = value;
      } else if (value !== 'id' && value !== '+id') {
        // The first release intentionally guarantees one portable ordering
        // rather than pretending a KV scan is a general sort engine.
        throw new CloudValidationError('unsupported_sort', 'Only id:asc ordering is supported.');
      }
      continue;
    }
    const field = assertDocumentQueryField(name);
    if (field === 'id' || own(filters, field)) {
      throw new CloudValidationError('invalid_query_filter', 'Invalid document query filter.');
    }
    filters[field] = assertDocumentQueryValue(value);
  }

  return normalizeListQuery({ limit, cursor, filters }, limits);
}
