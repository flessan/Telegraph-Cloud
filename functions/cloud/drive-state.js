import { CloudAdapterError, CloudConfigurationError, CloudValidationError, isTelegraphCloudError } from './errors.js';
import { cloudIndexKey, createCloudIndexStore } from './index-store.js';
import {
  CLOUD_LIMITS,
  assertBucketName,
  assertObjectKey,
  assertObjectKeyPrefix,
  assertProjectId,
} from './validation.js';

// Drive state is console-only presentation metadata. It never duplicates
// object bytes, manifests, or Telegram pointers, and it never changes an
// object's identity. Star flags and trash markers live in the same Cloud KV
// index as control-plane state; actual deletion still goes through the object
// engine's tombstone path. Folders are virtual (key prefixes) in S3 terms; the
// records here only make *empty* folders and explicit folder creation stable.
export const DRIVE_FLAGS_SCHEMA = 'telegraph-cloud.drive-flags.v1';
export const DRIVE_FOLDER_SCHEMA = 'telegraph-cloud.drive-folder.v1';

export const DRIVE_STATE_NAMESPACES = Object.freeze({
  flags: 'drive-flags',
  folder: 'drive-folder',
});

const FLAGS_KEY_HASH_PATTERN = /^objkey_[A-Za-z0-9_-]{43}$/;
const FOLDER_HASH_PATTERN = /^drvdir_[A-Za-z0-9_-]{43}$/;
const FLAGS_LIST_CAP = 2000;
const FOLDER_LIST_CAP = 1000;
const encoder = new TextEncoder();

function safeTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function timestampFrom(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (!safeTimestamp(timestamp)) {
    throw new CloudConfigurationError('invalid_drive_state_clock', 'Drive state clock configuration is invalid.');
  }
  return timestamp;
}

function bytesToBase64url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Must stay byte-for-byte identical to the object engine's key hash so a flag
// record always attaches to exactly one manifest key.
export async function hashObjectKey(key, cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle || typeof cryptoApi.subtle.digest !== 'function') {
    throw new CloudConfigurationError('drive_state_crypto_unavailable', 'Drive state hashing is unavailable.');
  }
  const digest = await cryptoApi.subtle.digest('SHA-256', encoder.encode(`telegraph-cloud.object-key.v1\u0000${key}`));
  return `objkey_${bytesToBase64url(new Uint8Array(digest))}`;
}

async function hashFolderPrefix(prefix, cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.subtle || typeof cryptoApi.subtle.digest !== 'function') {
    throw new CloudConfigurationError('drive_state_crypto_unavailable', 'Drive state hashing is unavailable.');
  }
  const digest = await cryptoApi.subtle.digest('SHA-256', encoder.encode(`telegraph-cloud.drive-folder.v1\u0000${prefix}`));
  return `drvdir_${bytesToBase64url(new Uint8Array(digest))}`;
}

function assertFolderPrefix(value) {
  const prefix = assertObjectKeyPrefix(value);
  if (!prefix.endsWith('/') || prefix === '/') {
    throw new CloudValidationError('invalid_drive_folder', 'A folder prefix must end with a slash.');
  }
  return prefix;
}

function stateFailure(operation, error) {
  if (isTelegraphCloudError(error)) return error;
  return new CloudAdapterError(
    `cloud_drive_state_${operation}_failed`,
    'Drive state is temporarily unavailable.',
    { status: 503 },
  );
}

export function createDriveStateService(env, {
  index = createCloudIndexStore(env),
  now = () => new Date(),
  cryptoApi = globalThis.crypto,
} = {}) {
  if (!index || typeof index.getJson !== 'function' || typeof index.putJson !== 'function'
    || typeof index.remove !== 'function' || typeof index.list !== 'function') {
    throw new CloudConfigurationError('cloud_drive_state_unavailable', 'Drive state service is unavailable.');
  }

  function normalizeFlagsRecord(value, { projectId, bucket, keyHash }) {
    try {
      if (!value || typeof value !== 'object' || value.schema !== DRIVE_FLAGS_SCHEMA) return null;
      if (value.project_id !== projectId || value.bucket !== bucket || value.key_hash !== keyHash) return null;
      if (typeof value.starred !== 'boolean' || typeof value.trashed !== 'boolean') return null;
      if (value.trashed && !safeTimestamp(value.trashed_at)) return null;
      if (!safeTimestamp(value.updated_at)) return null;
      return {
        schema: DRIVE_FLAGS_SCHEMA,
        project_id: projectId,
        bucket,
        key_hash: keyHash,
        starred: value.starred,
        trashed: value.trashed,
        trashed_at: value.trashed ? value.trashed_at : null,
        updated_at: value.updated_at,
      };
    } catch (_) {
      return null;
    }
  }

  function normalizeFolderRecord(value, { projectId, bucket, prefixHash }) {
    try {
      if (!value || typeof value !== 'object' || value.schema !== DRIVE_FOLDER_SCHEMA) return null;
      if (value.project_id !== projectId || value.bucket !== bucket || value.prefix_hash !== prefixHash) return null;
      assertFolderPrefix(value.prefix);
      if (!safeTimestamp(value.created_at) || !safeTimestamp(value.updated_at)
        || Date.parse(value.updated_at) < Date.parse(value.created_at)) return null;
      return {
        schema: DRIVE_FOLDER_SCHEMA,
        project_id: projectId,
        bucket,
        prefix_hash: prefixHash,
        prefix: value.prefix,
        created_at: value.created_at,
        updated_at: value.updated_at,
      };
    } catch (_) {
      return null;
    }
  }

  async function getFlags(projectIdInput, bucketInput, keyInput) {
    const projectId = assertProjectId(projectIdInput);
    const bucket = assertBucketName(bucketInput);
    const key = assertObjectKey(keyInput);
    const keyHash = await hashObjectKey(key, cryptoApi);
    try {
      const value = await index.getJson(DRIVE_STATE_NAMESPACES.flags, projectId, bucket, keyHash);
      return normalizeFlagsRecord(value, { projectId, bucket, keyHash });
    } catch (error) {
      throw stateFailure('read', error);
    }
  }

  async function setFlags(projectIdInput, bucketInput, keyInput, patch) {
    const projectId = assertProjectId(projectIdInput);
    const bucket = assertBucketName(bucketInput);
    const key = assertObjectKey(keyInput);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new CloudValidationError('invalid_drive_flags', 'Drive flag patch must be an object.');
    }
    const fields = Object.keys(patch);
    if (fields.some((field) => field !== 'starred' && field !== 'trashed')) {
      throw new CloudValidationError('invalid_drive_flags', 'Unsupported drive flag field.');
    }
    if (fields.length === 0) {
      throw new CloudValidationError('invalid_drive_flags', 'Drive flag patch must change a flag.');
    }
    if (fields.some((field) => typeof patch[field] !== 'boolean')) {
      throw new CloudValidationError('invalid_drive_flags', 'Drive flags must be booleans.');
    }
    const keyHash = await hashObjectKey(key, cryptoApi);
    try {
      const current = normalizeFlagsRecord(
        await index.getJson(DRIVE_STATE_NAMESPACES.flags, projectId, bucket, keyHash),
        { projectId, bucket, keyHash },
      );
      const timestamp = timestampFrom(now);
      const next = {
        starred: fields.includes('starred') ? patch.starred : !!current?.starred,
        trashed: fields.includes('trashed') ? patch.trashed : !!current?.trashed,
      };
      // A record with no state carries no information; drop it so trash/star
      // toggles do not accumulate dead KV entries forever.
      if (!next.starred && !next.trashed) {
        await index.remove(DRIVE_STATE_NAMESPACES.flags, projectId, bucket, keyHash);
        return Object.freeze({
          bucket, key, key_hash: keyHash, starred: false, trashed: false, trashed_at: null,
        });
      }
      const record = {
        schema: DRIVE_FLAGS_SCHEMA,
        project_id: projectId,
        bucket,
        key_hash: keyHash,
        starred: next.starred,
        trashed: next.trashed,
        trashed_at: next.trashed ? (current?.trashed ? current.trashed_at : timestamp) : null,
        updated_at: timestamp,
      };
      await index.putJson(DRIVE_STATE_NAMESPACES.flags, [projectId, bucket, keyHash], record);
      return Object.freeze({
        bucket,
        key,
        key_hash: keyHash,
        starred: record.starred,
        trashed: record.trashed,
        trashed_at: record.trashed_at,
      });
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw stateFailure('write', error);
    }
  }

  async function clearFlags(projectIdInput, bucketInput, keyInput) {
    const projectId = assertProjectId(projectIdInput);
    const bucket = assertBucketName(bucketInput);
    const key = assertObjectKey(keyInput);
    const keyHash = await hashObjectKey(key, cryptoApi);
    try {
      await index.remove(DRIVE_STATE_NAMESPACES.flags, projectId, bucket, keyHash);
    } catch (error) {
      throw stateFailure('delete', error);
    }
  }

  async function listFlagRecords(projectIdInput, bucketInput, { cap = FLAGS_LIST_CAP } = {}) {
    const projectId = assertProjectId(projectIdInput);
    const bucket = assertBucketName(bucketInput);
    const prefix = `${cloudIndexKey(DRIVE_STATE_NAMESPACES.flags, projectId, bucket)}:`;
    const records = new Map();
    let cursor;
    let scanned = 0;
    try {
      while (scanned < cap) {
        const page = await index.list(DRIVE_STATE_NAMESPACES.flags, {
          prefixSegments: [projectId, bucket],
          limit: Math.min(1000, cap - scanned),
          ...(cursor ? { cursor } : {}),
        });
        if (!page || !Array.isArray(page.keys) || typeof page.list_complete !== 'boolean') {
          throw new CloudAdapterError('cloud_drive_state_invalid_page', 'Drive state page is invalid.', { status: 500 });
        }
        const values = [];
        for (const entry of page.keys) {
          const name = String(entry?.name || '');
          if (!name.startsWith(prefix)) continue;
          const suffix = name.slice(prefix.length);
          if (suffix.includes(':') || !FLAGS_KEY_HASH_PATTERN.test(suffix)) continue;
          values.push(suffix);
        }
        const loaded = await Promise.all(values.map(async (keyHash) => {
          const value = await index.getJson(DRIVE_STATE_NAMESPACES.flags, projectId, bucket, keyHash);
          const record = normalizeFlagsRecord(value, { projectId, bucket, keyHash });
          return record ? [keyHash, record] : null;
        }));
        for (const pair of loaded) {
          if (pair) records.set(pair[0], pair[1]);
        }
        scanned += page.keys.length;
        if (page.list_complete) break;
        cursor = page.cursor;
        if (!cursor) break;
      }
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw stateFailure('list', error);
    }
    return records;
  }

  async function createFolder(projectIdInput, bucketInput, prefixInput) {
    const projectId = assertProjectId(projectIdInput);
    const bucket = assertBucketName(bucketInput);
    const prefix = assertFolderPrefix(prefixInput);
    const prefixHash = await hashFolderPrefix(prefix, cryptoApi);
    try {
      const existing = normalizeFolderRecord(
        await index.getJson(DRIVE_STATE_NAMESPACES.folder, projectId, bucket, prefixHash),
        { projectId, bucket, prefixHash },
      );
      if (existing) return Object.freeze({ created: false, folder: publicFolder(existing) });
      const timestamp = timestampFrom(now);
      const record = {
        schema: DRIVE_FOLDER_SCHEMA,
        project_id: projectId,
        bucket,
        prefix_hash: prefixHash,
        prefix,
        created_at: timestamp,
        updated_at: timestamp,
      };
      await index.putJson(DRIVE_STATE_NAMESPACES.folder, [projectId, bucket, prefixHash], record);
      return Object.freeze({ created: true, folder: publicFolder(record) });
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw stateFailure('write', error);
    }
  }

  async function deleteFolder(projectIdInput, bucketInput, prefixInput) {
    const projectId = assertProjectId(projectIdInput);
    const bucket = assertBucketName(bucketInput);
    const prefix = assertFolderPrefix(prefixInput);
    const prefixHash = await hashFolderPrefix(prefix, cryptoApi);
    try {
      await index.remove(DRIVE_STATE_NAMESPACES.folder, projectId, bucket, prefixHash);
    } catch (error) {
      throw stateFailure('delete', error);
    }
  }

  async function listFolderRecords(projectIdInput, bucketInput, { cap = FOLDER_LIST_CAP } = {}) {
    const projectId = assertProjectId(projectIdInput);
    const bucket = assertBucketName(bucketInput);
    const prefix = `${cloudIndexKey(DRIVE_STATE_NAMESPACES.folder, projectId, bucket)}:`;
    const folders = [];
    let cursor;
    let scanned = 0;
    try {
      while (scanned < cap) {
        const page = await index.list(DRIVE_STATE_NAMESPACES.folder, {
          prefixSegments: [projectId, bucket],
          limit: Math.min(1000, cap - scanned),
          ...(cursor ? { cursor } : {}),
        });
        if (!page || !Array.isArray(page.keys) || typeof page.list_complete !== 'boolean') {
          throw new CloudAdapterError('cloud_drive_state_invalid_page', 'Drive state page is invalid.', { status: 500 });
        }
        const hashes = [];
        for (const entry of page.keys) {
          const name = String(entry?.name || '');
          if (!name.startsWith(prefix)) continue;
          const suffix = name.slice(prefix.length);
          if (suffix.includes(':') || !FOLDER_HASH_PATTERN.test(suffix)) continue;
          hashes.push(suffix);
        }
        const loaded = await Promise.all(hashes.map(async (prefixHash) => {
          const value = await index.getJson(DRIVE_STATE_NAMESPACES.folder, projectId, bucket, prefixHash);
          return normalizeFolderRecord(value, { projectId, bucket, prefixHash });
        }));
        for (const record of loaded) if (record) folders.push(publicFolder(record));
        scanned += page.keys.length;
        if (page.list_complete) break;
        cursor = page.cursor;
        if (!cursor) break;
      }
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw stateFailure('list', error);
    }
    return Object.freeze(folders);
  }

  function publicFolder(record) {
    return Object.freeze({
      bucket: record.bucket,
      prefix: record.prefix,
      created_at: record.created_at,
      updated_at: record.updated_at,
    });
  }

  return Object.freeze({
    getFlags,
    setFlags,
    clearFlags,
    listFlagRecords,
    createFolder,
    deleteFolder,
    listFolderRecords,
    hashObjectKey: (key) => hashObjectKey(key, cryptoApi),
    hashFolderPrefix: (prefix) => hashFolderPrefix(prefix, cryptoApi),
  });
}

// Re-exported so HTTP layers and tests share one bound instead of re-deriving
// the object key byte ceiling.
export const DRIVE_STATE_LIMITS = Object.freeze({
  FLAGS_LIST_CAP,
  FOLDER_LIST_CAP,
  MAX_OBJECT_KEY_BYTES: CLOUD_LIMITS.MAX_OBJECT_KEY_BYTES,
});
