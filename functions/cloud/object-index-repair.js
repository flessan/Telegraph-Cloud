import {
  CloudAdapterError,
  CloudConfigurationError,
  CloudValidationError,
  isTelegraphCloudError,
} from './errors.js';
import { createCloudIndexStore, cloudIndexKey } from './index-store.js';
import { createObjectListIndex } from './object-list-index.js';
import {
  normalizeObjectManifestForMaintenance,
  OBJECT_INDEX_NAMESPACES,
} from './object-storage.js';
import {
  assertBucketName,
  assertProjectId,
  serializeJsonDocument,
  utf8ByteLength,
} from './validation.js';

/**
 * Operator-only bounded repair for the Phase 5 list index. It always starts
 * from current object manifests and never asks Telegram for bytes or treats a
 * list-index entry as an authority record.
 */
export const OBJECT_INDEX_REPAIR_CHECKPOINT_SCHEMA = 'telegraph-cloud.object-index-repair-checkpoint.v1';
export const OBJECT_INDEX_REPAIR_OPERATION = 'object_index_repair';
export const DEFAULT_OBJECT_INDEX_REPAIR_BATCH_SIZE = 25;
export const MAX_OBJECT_INDEX_REPAIR_BATCH_SIZE = 50;
export const OBJECT_INDEX_REPAIR_CHECKPOINT_TTL_SECONDS = 24 * 60 * 60;

const REPAIR_MODES = new Set(['dry_run', 'apply']);
const KEY_HASH_PATTERN = /^objkey_[A-Za-z0-9_-]{43}$/;
const MAX_CHECKPOINT_BYTES = 12 * 1024;
const MAX_CHECKPOINT_STATE_BYTES = 7 * 1024;
const MAX_KV_CURSOR_BYTES = 4096;
const MAX_PEPPER_BYTES = 4096;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function plainObject(value) {
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
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
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
    throw new CloudConfigurationError('invalid_object_index_repair_clock', 'Object index repair clock configuration is invalid.');
  }
  return timestamp;
}

function invalidRepairRequest() {
  return new CloudValidationError('invalid_object_index_repair_request', 'Object index repair request is invalid.');
}

function invalidCheckpoint() {
  return new CloudValidationError('invalid_object_index_repair_checkpoint', 'Object index repair checkpoint is invalid or expired.');
}

function repairUnavailable() {
  return new CloudAdapterError('object_index_repair_unavailable', 'Object index repair is temporarily unavailable.', { status: 503 });
}

function invalidRepairPage() {
  return new CloudAdapterError('object_index_repair_page_invalid', 'Object index repair state is temporarily unavailable.', { status: 503 });
}

function safeKvCursor(value) {
  return typeof value === 'string'
    && value.length > 0
    && utf8ByteLength(value) <= MAX_KV_CURSOR_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeProgressValue(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function emptyProgress() {
  return {
    scanned: 0,
    repaired: 0,
    removed: 0,
    stale: 0,
    skipped: 0,
    errors: 0,
  };
}

function normalizeProgress(value) {
  if (!plainObject(value)) throw invalidCheckpoint();
  const expected = Object.keys(emptyProgress());
  if (Object.keys(value).length !== expected.length || expected.some((field) => !safeProgressValue(value[field]))) {
    throw invalidCheckpoint();
  }
  return Object.fromEntries(expected.map((field) => [field, value[field]]));
}

function publicProgress(progress) {
  return Object.freeze({
    scanned: progress.scanned,
    repaired: progress.repaired,
    removed: progress.removed,
    stale: progress.stale,
    skipped: progress.skipped,
    errors: progress.errors,
  });
}

function addProgress(left, right) {
  const total = {};
  for (const field of Object.keys(emptyProgress())) {
    const value = left[field] + right[field];
    if (!Number.isSafeInteger(value) || value < 0) throw invalidRepairPage();
    total[field] = value;
  }
  return total;
}

function normalizeBatchSize(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_OBJECT_INDEX_REPAIR_BATCH_SIZE) {
    throw invalidRepairRequest();
  }
  return value;
}

function normalizeStartRequest(input) {
  if (!plainObject(input)) throw invalidRepairRequest();
  const fields = Object.keys(input);
  if (fields.includes('checkpoint')) {
    if (fields.length !== 1 || typeof input.checkpoint !== 'string'
      || utf8ByteLength(input.checkpoint) > MAX_CHECKPOINT_BYTES || !input.checkpoint) {
      throw invalidRepairRequest();
    }
    return { kind: 'resume', checkpoint: input.checkpoint };
  }
  if (fields.some((field) => !['mode', 'bucket', 'batch_size'].includes(field))) throw invalidRepairRequest();
  if (!REPAIR_MODES.has(input.mode)) throw invalidRepairRequest();
  const bucket = input.bucket === undefined || input.bucket === null ? null : assertBucketName(input.bucket);
  const batchSize = input.batch_size === undefined
    ? DEFAULT_OBJECT_INDEX_REPAIR_BATCH_SIZE
    : normalizeBatchSize(input.batch_size);
  return {
    kind: 'start',
    mode: input.mode,
    bucket,
    batch_size: batchSize,
  };
}

function checkpointState({ projectId, bucket, mode, batchSize, cursor, progress, startedAt, updatedAt, page }) {
  return {
    schema: OBJECT_INDEX_REPAIR_CHECKPOINT_SCHEMA,
    project_id: projectId,
    bucket,
    mode,
    batch_size: batchSize,
    manifest_cursor: cursor,
    progress,
    started_at: startedAt,
    updated_at: updatedAt,
    page,
  };
}

function normalizeCheckpointState(value, projectId, timestamp) {
  try {
    if (!plainObject(value) || value.schema !== OBJECT_INDEX_REPAIR_CHECKPOINT_SCHEMA
      || assertProjectId(value.project_id) !== projectId
      || !(value.bucket === null || assertBucketName(value.bucket) === value.bucket)
      || !REPAIR_MODES.has(value.mode)
      || !Number.isSafeInteger(value.batch_size)
      || value.batch_size < 1 || value.batch_size > MAX_OBJECT_INDEX_REPAIR_BATCH_SIZE
      || !(value.manifest_cursor === null || safeKvCursor(value.manifest_cursor))
      || !safeTimestamp(value.started_at) || !safeTimestamp(value.updated_at)
      || Date.parse(value.updated_at) < Date.parse(value.started_at)
      || !Number.isSafeInteger(value.page) || value.page < 1
    ) {
      throw new Error('invalid state');
    }
    const startedAt = Date.parse(value.started_at);
    const currentTime = Date.parse(timestamp);
    if (currentTime - startedAt > OBJECT_INDEX_REPAIR_CHECKPOINT_TTL_SECONDS * 1000) {
      throw new Error('expired');
    }
    return checkpointState({
      projectId,
      bucket: value.bucket,
      mode: value.mode,
      batchSize: value.batch_size,
      cursor: value.manifest_cursor,
      progress: normalizeProgress(value.progress),
      startedAt: value.started_at,
      updatedAt: value.updated_at,
      page: value.page,
    });
  } catch (_) {
    throw invalidCheckpoint();
  }
}

async function checkpointEncryptionKey(env, cryptoApi) {
  const pepper = env?.API_KEY_PEPPER;
  if (typeof pepper !== 'string') {
    throw new CloudConfigurationError('object_index_repair_checkpoint_unavailable', 'Object index repair checkpoint protection is unavailable.');
  }
  const pepperBytes = encoder.encode(pepper);
  if (pepperBytes.byteLength < 32 || pepperBytes.byteLength > MAX_PEPPER_BYTES
    || !cryptoApi?.subtle || typeof cryptoApi.subtle.digest !== 'function'
    || typeof cryptoApi.subtle.importKey !== 'function' || typeof cryptoApi.subtle.encrypt !== 'function'
    || typeof cryptoApi.subtle.decrypt !== 'function' || typeof cryptoApi.getRandomValues !== 'function') {
    throw new CloudConfigurationError('object_index_repair_checkpoint_unavailable', 'Object index repair checkpoint protection is unavailable.');
  }
  try {
    const material = encoder.encode(JSON.stringify([OBJECT_INDEX_REPAIR_CHECKPOINT_SCHEMA, pepper]));
    const digest = await cryptoApi.subtle.digest('SHA-256', material);
    return await cryptoApi.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  } catch (_) {
    throw new CloudConfigurationError('object_index_repair_checkpoint_unavailable', 'Object index repair checkpoint protection is unavailable.');
  }
}

function validateCheckpointEnvelope(value) {
  if (!plainObject(value) || value.v !== 1 || typeof value.i !== 'string' || typeof value.d !== 'string'
    || !/^[A-Za-z0-9_-]{16}$/.test(value.i) || !/^[A-Za-z0-9_-]+$/.test(value.d)) {
    throw invalidCheckpoint();
  }
  return value;
}

function recordSerialization(value) {
  try {
    return serializeJsonDocument(value, { maxBytes: MAX_CHECKPOINT_STATE_BYTES }).serialized;
  } catch (_) {
    throw invalidRepairPage();
  }
}

function isRecordCorruption(error) {
  return error?.code === 'cloud_index_invalid_json'
    || error?.code === 'cloud_index_invalid_value'
    || error?.code === 'object_manifest_invalid'
    || error?.code === 'object_list_index_invalid';
}

function isRepairableLeafCorruption(error) {
  return error?.code === 'cloud_index_invalid_json' || error?.code === 'cloud_index_invalid_value';
}

/**
 * Create a project-bound repair service. It is intentionally not an object
 * storage facade: no developer API-key scope or object bytes are accepted.
 */
export function createObjectIndexRepairService(env, {
  projectId,
  index = createCloudIndexStore(env),
  now = () => new Date(),
  cryptoApi = globalThis.crypto,
} = {}) {
  const safeProjectId = assertProjectId(projectId);
  if (!index || typeof index.getJson !== 'function' || typeof index.list !== 'function'
    || typeof index.putJson !== 'function' || typeof index.remove !== 'function') {
    throw new CloudConfigurationError('object_index_repair_unavailable', 'Object index repair is not configured.');
  }

  const listIndex = createObjectListIndex({
    env,
    index,
    projectId: safeProjectId,
    now,
    cryptoApi,
    maintenanceOnly: true,
  });

  async function encodeCheckpoint(state) {
    const serialized = recordSerialization(state);
    const key = await checkpointEncryptionKey(env, cryptoApi);
    const iv = new Uint8Array(12);
    try {
      cryptoApi.getRandomValues(iv);
      const ciphertext = new Uint8Array(await cryptoApi.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoder.encode(serialized),
      ));
      const envelope = base64url(encoder.encode(JSON.stringify({ v: 1, i: base64url(iv), d: base64url(ciphertext) })));
      if (utf8ByteLength(envelope) > MAX_CHECKPOINT_BYTES) throw new Error('large');
      return envelope;
    } catch (error) {
      if (error?.code) throw error;
      throw new CloudConfigurationError('object_index_repair_checkpoint_unavailable', 'Object index repair checkpoint protection is unavailable.');
    }
  }

  async function decodeCheckpoint(value, timestamp) {
    if (typeof value !== 'string' || utf8ByteLength(value) > MAX_CHECKPOINT_BYTES) throw invalidCheckpoint();
    let envelope;
    try {
      envelope = validateCheckpointEnvelope(JSON.parse(decoder.decode(fromBase64url(value))));
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw invalidCheckpoint();
    }
    const key = await checkpointEncryptionKey(env, cryptoApi);
    try {
      const plaintext = await cryptoApi.subtle.decrypt(
        { name: 'AES-GCM', iv: fromBase64url(envelope.i) },
        key,
        fromBase64url(envelope.d),
      );
      return normalizeCheckpointState(JSON.parse(decoder.decode(new Uint8Array(plaintext))), safeProjectId, timestamp);
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw invalidCheckpoint();
    }
  }

  async function listManifestPage(state) {
    let page;
    try {
      page = await index.list(OBJECT_INDEX_NAMESPACES.manifest, {
        prefixSegments: state.bucket === null ? [safeProjectId] : [safeProjectId, state.bucket],
        limit: state.batch_size,
        ...(state.manifest_cursor ? { cursor: state.manifest_cursor } : {}),
      });
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw repairUnavailable();
    }
    if (!plainObject(page) || !Array.isArray(page.keys) || typeof page.list_complete !== 'boolean'
      || page.keys.length > state.batch_size || (!page.list_complete && !safeKvCursor(page.cursor))) {
      throw invalidRepairPage();
    }
    return page;
  }

  function manifestLocationFromListKey(name, bucketScope) {
    try {
      const prefix = `${cloudIndexKey(OBJECT_INDEX_NAMESPACES.manifest, safeProjectId)}:`;
      if (typeof name !== 'string' || !name.startsWith(prefix)) throw new Error('name');
      const segments = name.slice(prefix.length).split(':');
      if (segments.length !== 2) throw new Error('segments');
      const bucket = assertBucketName(segments[0]);
      if (bucketScope !== null && bucket !== bucketScope) throw new Error('scope');
      if (!KEY_HASH_PATTERN.test(segments[1])) throw new Error('hash');
      return { bucket, key_hash: segments[1] };
    } catch (_) {
      return null;
    }
  }

  async function readAuthoritativeManifest(location) {
    let value;
    try {
      value = await index.getJson(OBJECT_INDEX_NAMESPACES.manifest, safeProjectId, location.bucket, location.key_hash);
    } catch (error) {
      if (isRecordCorruption(error)) return { kind: 'invalid' };
      if (isTelegraphCloudError(error)) throw error;
      throw repairUnavailable();
    }
    if (value === null) return { kind: 'missing' };
    try {
      const manifest = normalizeObjectManifestForMaintenance(value);
      if (manifest.project_id !== safeProjectId || manifest.bucket !== location.bucket || manifest.key_hash !== location.key_hash) {
        return { kind: 'invalid' };
      }
      return { kind: 'manifest', manifest };
    } catch (error) {
      if (isRecordCorruption(error)) return { kind: 'invalid' };
      if (isTelegraphCloudError(error)) throw error;
      throw repairUnavailable();
    }
  }

  async function processManifestEntry(entry, state) {
    const delta = emptyProgress();
    delta.scanned = 1;
    const location = manifestLocationFromListKey(entry?.name, state.bucket);
    if (!location) {
      delta.errors = 1;
      delta.skipped = 1;
      return delta;
    }

    const authoritative = await readAuthoritativeManifest(location);
    if (authoritative.kind !== 'manifest') {
      if (authoritative.kind === 'invalid') delta.errors = 1;
      delta.skipped = 1;
      return delta;
    }

    let inspection;
    try {
      inspection = await listIndex.inspectManifest(authoritative.manifest);
    } catch (error) {
      if (isRecordCorruption(error) || isRepairableLeafCorruption(error)) {
        delta.errors = 1;
        delta.skipped = 1;
        return delta;
      }
      if (isTelegraphCloudError(error)) throw error;
      throw repairUnavailable();
    }

    if (inspection.status === 'correct' || inspection.status === 'deleted_absent') {
      delta.skipped = 1;
      return delta;
    }

    delta.stale = 1;
    if (state.mode === 'dry_run') return delta;

    try {
      await listIndex.materialize(authoritative.manifest);
    } catch (error) {
      // A corrupt shared branch/value encountered while materializing is not
      // safe to overwrite blindly. Record it for operator attention and
      // continue scanning other manifests.
      if (isRecordCorruption(error) || isRepairableLeafCorruption(error)) {
        delta.errors = 1;
        delta.skipped = 1;
        return delta;
      }
      if (isTelegraphCloudError(error)) throw error;
      throw repairUnavailable();
    }

    if (authoritative.manifest.state === 'deleted') delta.removed = 1;
    else delta.repaired = 1;
    return delta;
  }

  function publicResult(state, batch, complete, checkpoint) {
    const progress = addProgress(state.progress, batch);
    return Object.freeze({
      operation: OBJECT_INDEX_REPAIR_OPERATION,
      mode: state.mode,
      ...(state.bucket === null ? { scope: 'project' } : { bucket: state.bucket }),
      batch_size: state.batch_size,
      page: state.page,
      complete,
      status: complete ? (progress.errors ? 'completed_with_errors' : 'completed') : 'in_progress',
      batch: publicProgress(batch),
      progress: publicProgress(progress),
      ...(checkpoint ? { checkpoint } : {}),
    });
  }

  async function run(input) {
    const request = normalizeStartRequest(input);
    const timestamp = timestampFrom(now);
    // Validate checkpoint cryptography before any manifest/index mutation. A
    // multi-page apply must never repair a first page and then discover that it
    // cannot issue the continuation needed to resume safely.
    await checkpointEncryptionKey(env, cryptoApi);
    const state = request.kind === 'resume'
      ? await decodeCheckpoint(request.checkpoint, timestamp)
      : checkpointState({
        projectId: safeProjectId,
        bucket: request.bucket,
        mode: request.mode,
        batchSize: request.batch_size,
        cursor: null,
        progress: emptyProgress(),
        startedAt: timestamp,
        updatedAt: timestamp,
        page: 1,
      });
    const page = await listManifestPage(state);
    let batch = emptyProgress();
    for (const entry of page.keys) {
      batch = addProgress(batch, await processManifestEntry(entry, state));
    }

    const complete = page.list_complete;
    if (complete) return publicResult(state, batch, true);

    const nextState = checkpointState({
      projectId: safeProjectId,
      bucket: state.bucket,
      mode: state.mode,
      batchSize: state.batch_size,
      cursor: page.cursor,
      progress: addProgress(state.progress, batch),
      startedAt: state.started_at,
      updatedAt: timestamp,
      page: state.page + 1,
    });
    return publicResult(state, batch, false, await encodeCheckpoint(nextState));
  }

  return Object.freeze({
    run,
    limits: Object.freeze({
      defaultBatchSize: DEFAULT_OBJECT_INDEX_REPAIR_BATCH_SIZE,
      maxBatchSize: MAX_OBJECT_INDEX_REPAIR_BATCH_SIZE,
      checkpointTtlSeconds: OBJECT_INDEX_REPAIR_CHECKPOINT_TTL_SECONDS,
    }),
  });
}
