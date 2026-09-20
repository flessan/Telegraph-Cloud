import {
  CloudConflictError,
  CloudNotFoundError,
  CloudRequestError,
  CloudValidationError,
} from './errors.js';
import {
  assertBucketName,
  assertMimeType,
  assertObjectKey,
  assertObjectKeyPrefix,
  normalizeCustomMetadata,
} from './validation.js';
import { resolveObjectStorageLimits } from './object-limits.js';
import { createTelegramObjectStorage } from './object-storage.js';
import { createDriveStateService } from './drive-state.js';
import { createProjectRegistry } from './project-registry.js';

// Console presentation views that require a bounded flat scan rather than the
// delimited folder traversal. They never return more than SCAN_CAP examined
// objects per request and always report truncation truthfully.
const SCAN_CAP = 1000;
const STATS_OBJECT_CAP = 2000;
const MAX_BULK_FLAG_ITEMS = 100;

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function assertView(value) {
  if (value === undefined || value === null || value === 'all') return 'all';
  if (value === 'trash' || value === 'starred' || value === 'objects') return value;
  throw new CloudValidationError('invalid_drive_view', 'Unsupported Drive view.');
}

function assertSearchTerm(value) {
  if (value === undefined || value === null || value === '') return '';
  const term = String(value);
  if (term.length > 256 || /[\u0000-\u001f]/.test(term)) {
    throw new CloudValidationError('invalid_drive_search', 'Search term is invalid or too long.');
  }
  return term;
}

function baseName(key) {
  const parts = String(key).split('/');
  return parts[parts.length - 1] || String(key);
}

function folderName(prefix, parentPrefix) {
  const rest = prefix.startsWith(parentPrefix) ? prefix.slice(parentPrefix.length) : prefix;
  const trimmed = rest.endsWith('/') ? rest.slice(0, -1) : rest;
  const parts = trimmed.split('/');
  return parts[parts.length - 1] || trimmed;
}

/**
 * Dashboard composition layer for Drive. It is project-bound on the server
 * from the verified dashboard session (the route verifies the path project
 * against the registry); it adds only console presentation state (stars,
 * trash, empty folders, search) on top of the same object engine that backs
 * the developer API and S3. It never stores a second copy of object bytes.
 */
export function createDriveService(contextEnv, {
  projectId,
  storage = createTelegramObjectStorage(contextEnv, { projectId }),
  state = createDriveStateService(contextEnv),
  projects = createProjectRegistry(contextEnv),
} = {}) {
  if (!projectId) {
    throw new CloudValidationError('drive_project_required', 'A project scope is required.');
  }

  async function requireProject() {
    return projects.requireActiveProject(projectId);
  }

  function publicFlags(flags) {
    if (!flags) return Object.freeze({ starred: false, trashed: false });
    return Object.freeze({
      starred: !!flags.starred,
      trashed: !!flags.trashed,
      ...(flags.trashed_at ? { trashed_at: flags.trashed_at } : {}),
    });
  }

  async function decorate(object, flagsRecords) {
    const keyHash = await state.hashObjectKey(object.key);
    const flags = flagsRecords.get(keyHash) || null;
    return Object.freeze({
      ...object,
      name: baseName(object.key),
      flags: publicFlags(flags),
    });
  }

  async function listBuckets() {
    await requireProject();
    return storage.listBuckets();
  }

  async function createBucket(name) {
    await requireProject();
    return storage.createBucketMarker(assertBucketName(name));
  }

  async function listObjects(input = {}) {
    await requireProject();
    if (!plainObject(input)) throw new CloudValidationError('invalid_drive_list_query', 'Drive list query is invalid.');
    const bucket = assertBucketName(input.bucket);
    const prefix = input.prefix === undefined || input.prefix === null ? '' : assertObjectKeyPrefix(input.prefix);
    const view = assertView(input.view);
    const search = assertSearchTerm(input.search);
    // 'objects' is the flat, object-centric listing (the console's Files >
    // Objects tab): every non-trashed object as a full key, no folders.
    const flat = view !== 'all' || search !== '';

    const flagsRecords = await state.listFlagRecords(projectId, bucket);

    if (!flat) {
      const limit = input.limit === undefined
        ? storage.limits.defaultListLimit
        : (() => {
          const value = Number(input.limit);
          if (!Number.isSafeInteger(value) || value < 1 || value > storage.limits.maxListLimit) {
            throw new CloudValidationError('invalid_object_list_limit', 'Object listing limit is outside the supported range.');
          }
          return value;
        })();
      const page = await storage.listObjects(bucket, {
        prefix,
        delimiter: '/',
        ...(input.cursor ? { cursor: String(input.cursor) } : {}),
        limit,
      });
      const decorated = await Promise.all((page.objects || []).map((object) => decorate(object, flagsRecords)));
      const objects = decorated.filter((object) => !object.flags.trashed);

      const commonPrefixes = page.common_prefixes || [];
      const commonSet = new Set(commonPrefixes);
      const explicitFolders = [];
      const folderRecords = await state.listFolderRecords(projectId, bucket);
      for (const folder of folderRecords) {
        if (!folder.prefix.startsWith(prefix) || folder.prefix === prefix) continue;
        const remainder = folder.prefix.slice(prefix.length);
        if (/^[^/]+\/$/.test(remainder) && !commonSet.has(folder.prefix)) {
          explicitFolders.push(folder);
        }
      }
      const folders = [...commonPrefixes, ...explicitFolders.map((f) => f.prefix)]
        .filter((value, index, all) => all.indexOf(value) === index)
        .sort((left, right) => left.localeCompare(right))
        .map((folderPrefix) => {
          const record = explicitFolders.find((f) => f.prefix === folderPrefix);
          return Object.freeze({
            prefix: folderPrefix,
            name: folderName(folderPrefix, prefix),
            ...(record ? { created_at: record.created_at } : {}),
            empty: !!record && !commonSet.has(folderPrefix),
          });
        });

      return Object.freeze({
        kind: 'drive-list',
        view: 'all',
        bucket,
        prefix,
        delimiter: '/',
        limit: page.limit,
        order: page.order,
        folders: Object.freeze(folders),
        objects: Object.freeze(objects),
        ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
        has_more: !!page.has_more,
      });
    }

    // Bounded flat scan for Trash, Starred, and search. Matching happens on the
    // server; the browser never receives an entire bucket to filter locally.
    const needle = search.toLowerCase();
    const matches = [];
    let cursor = input.cursor ? String(input.cursor) : undefined;
    let scanned = 0;
    let hasMore = false;
    let nextCursor;
    while (scanned < SCAN_CAP) {
      const remaining = SCAN_CAP - scanned;
      const page = await storage.listObjects(bucket, {
        prefix,
        limit: Math.min(storage.limits.maxListLimit, remaining),
        ...(cursor ? { cursor } : {}),
      });
      scanned += (page.objects || []).length;
      for (const object of page.objects || []) {
        const keyHash = await state.hashObjectKey(object.key);
        const flags = flagsRecords.get(keyHash);
        if (view === 'trash' && !flags?.trashed) continue;
        if (view === 'starred' && !flags?.starred) continue;
        if (view === 'objects' && flags?.trashed) continue;
        if (needle) {
          const haystack = `${object.key}\n${baseName(object.key)}`.toLowerCase();
          if (!haystack.includes(needle)) continue;
          if (view === 'all' && flags?.trashed) continue;
        }
        matches.push(await decorate(object, flagsRecords));
      }
      if (page.has_more && page.next_cursor) {
        cursor = page.next_cursor;
      } else {
        cursor = undefined;
        break;
      }
      if (scanned >= SCAN_CAP) break;
    }
    if (cursor) { hasMore = true; nextCursor = cursor; }
    return Object.freeze({
      kind: 'drive-list',
      view: search ? 'search' : view,
      bucket,
      prefix,
      ...(search ? { search } : {}),
      folders: Object.freeze([]),
      objects: Object.freeze(matches),
      scanned,
      truncated: hasMore || scanned >= SCAN_CAP,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
      has_more: hasMore,
    });
  }

  async function headObject(bucketInput, keyInput) {
    await requireProject();
    const bucket = assertBucketName(bucketInput);
    const key = assertObjectKey(keyInput);
    const result = await storage.headObject(bucket, key);
    const flags = await state.getFlags(projectId, bucket, key);
    return Object.freeze({ object: headShape(result.object, flags) });
  }

  function headShape(object, flags) {
    return Object.freeze({
      ...object,
      name: baseName(object.key),
      flags: publicFlags(flags),
    });
  }

  async function getObject(bucketInput, keyInput, conditions = {}) {
    await requireProject();
    const bucket = assertBucketName(bucketInput);
    const key = assertObjectKey(keyInput);
    return storage.getObject(bucket, key, conditions);
  }

  async function putObject(bucketInput, keyInput, input = {}) {
    await requireProject();
    const bucket = assertBucketName(bucketInput);
    const key = assertObjectKey(keyInput);
    if (!plainObject(input)) throw new CloudValidationError('invalid_object_request', 'Object request is invalid.');
    if (!(input.body instanceof Uint8Array)) {
      throw new CloudValidationError('invalid_object_body', 'Object request body is invalid.');
    }
    const limits = resolveObjectStorageLimits(contextEnv);
    if (input.body.byteLength > limits.maxObjectBytes) {
      throw new CloudRequestError('object_too_large', 'Object exceeds the supported size limit.', { status: 413 });
    }
    const result = await storage.putObject(bucket, key, {
      body: input.body,
      contentType: input.contentType === undefined || input.contentType === null
        ? 'application/octet-stream'
        : assertMimeType(input.contentType),
      metadata: normalizeCustomMetadata(input.metadata || {}),
    });
    return Object.freeze({ object: headShape(result.object, await state.getFlags(projectId, bucket, key)) });
  }

  async function deleteObject(bucketInput, keyInput) {
    await requireProject();
    const bucket = assertBucketName(bucketInput);
    const key = assertObjectKey(keyInput);
    const result = await storage.deleteObject(bucket, key, {});
    await state.clearFlags(projectId, bucket, key);
    return result;
  }

  // Same-project server-side copy used for rename, move, duplicate, and
  // metadata-safe folder moves. Bytes pass through the worker once; the hard
  // object size ceiling already bounds that work. Cross-bucket copies are
  // allowed within the same project, cross-project copies never are.
  async function copyObject(input = {}) {
    await requireProject();
    if (!plainObject(input)) throw new CloudValidationError('invalid_drive_copy', 'Copy request is invalid.');
    const destBucket = assertBucketName(input.bucket);
    const sourceBucket = assertBucketName(input.sourceBucket || input.bucket);
    const sourceKey = assertObjectKey(input.sourceKey);
    const destKey = assertObjectKey(input.destKey);
    if (sourceBucket === destBucket && sourceKey === destKey) {
      throw new CloudValidationError('invalid_drive_copy', 'Source and destination are the same object.');
    }
    const source = await storage.getObject(sourceBucket, sourceKey);
    // PutObject buffers the full bounded body (the hard object size cap), so a
    // move/rename materializes bytes through the worker exactly once. The byte
    // adapter normally resolves a ReadableStream.
    let body;
    if (source.body instanceof Uint8Array) {
      body = source.body;
    } else if (source.body instanceof ArrayBuffer) {
      body = new Uint8Array(source.body);
    } else if (source.body && typeof source.body.getReader === 'function') {
      body = new Uint8Array(await new Response(source.body).arrayBuffer());
    } else {
      throw new CloudValidationError('invalid_object_body', 'Object bytes are unavailable for copying.');
    }
    const put = await storage.putObject(destBucket, destKey, {
      body,
      contentType: source.object.content_type,
      metadata: { ...(source.object.metadata || {}) },
    });
    if (input.deleteSource) {
      const movedFlags = await state.getFlags(projectId, sourceBucket, sourceKey);
      await storage.deleteObject(sourceBucket, sourceKey, {});
      await state.clearFlags(projectId, sourceBucket, sourceKey);
      if (movedFlags) {
        const patch = {};
        if (movedFlags.starred) patch.starred = true;
        if (movedFlags.trashed) patch.trashed = true;
        if (Object.keys(patch).length) await state.setFlags(projectId, destBucket, destKey, patch);
      }
    }
    const flags = await state.getFlags(projectId, destBucket, destKey);
    return Object.freeze({
      object: headShape(put.object, flags),
      moved: !!input.deleteSource,
      source: Object.freeze({ bucket: sourceBucket, key: sourceKey }),
    });
  }

  async function setFlags(bucketInput, keyInput, patch) {
    await requireProject();
    const bucket = assertBucketName(bucketInput);
    const key = assertObjectKey(keyInput);
    // Fail closed if the object no longer exists; starring a ghost key would
    // create orphan console state.
    await storage.headObject(bucket, key);
    return state.setFlags(projectId, bucket, key, patch);
  }

  async function bulkSetFlags(items, patch) {
    await requireProject();
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BULK_FLAG_ITEMS) {
      throw new CloudValidationError('invalid_drive_bulk', 'Bulk selection is outside the supported range.');
    }
    if (!plainObject(patch)) throw new CloudValidationError('invalid_drive_flags', 'Drive flag patch must be an object.');
    const results = [];
    for (const item of items) {
      const bucket = assertBucketName(item.bucket);
      const key = assertObjectKey(item.key);
      try {
        await storage.headObject(bucket, key);
        const result = await state.setFlags(projectId, bucket, key, patch);
        results.push(Object.freeze({ bucket, key, ...result }));
      } catch (error) {
        if (error instanceof CloudNotFoundError) continue;
        throw error;
      }
    }
    return Object.freeze({ data: Object.freeze(results) });
  }

  async function createFolder(bucketInput, prefixInput) {
    await requireProject();
    const bucket = assertBucketName(bucketInput);
    const prefix = assertObjectKeyPrefix(prefixInput);
    if (!prefix.endsWith('/') || prefix === '/') {
      throw new CloudValidationError('invalid_drive_folder', 'A folder prefix must end with a slash.');
    }
    return state.createFolder(projectId, bucket, prefix);
  }

  async function deleteFolder(bucketInput, prefixInput, { force = false } = {}) {
    await requireProject();
    const bucket = assertBucketName(bucketInput);
    const prefix = assertObjectKeyPrefix(prefixInput);
    if (!prefix.endsWith('/') || prefix === '/') {
      throw new CloudValidationError('invalid_drive_folder', 'A folder prefix must end with a slash.');
    }
    if (!force) {
      const children = await storage.listObjects(bucket, { prefix, limit: 1 });
      if ((children.objects || []).length > 0) {
        throw new CloudConflictError('drive_folder_not_empty', 'Folder still contains objects.');
      }
    }
    await state.deleteFolder(projectId, bucket, prefix);
    return Object.freeze({ deleted: true, bucket, prefix });
  }

  // Bounded, truthful overview inputs. Counts are exact while the scan stays
  // within the cap; beyond it the response says so instead of guessing.
  async function stats() {
    await requireProject();
    const bucketsPage = await storage.listBuckets({ limit: 100 });
    const buckets = bucketsPage.data || [];
    let objectCount = 0;
    let totalBytes = 0;
    let starredCount = 0;
    let trashedCount = 0;
    let truncated = bucketsPage.has_more === true;
    for (const { bucket } of buckets) {
      let cursor;
      const flags = await state.listFlagRecords(projectId, bucket);
      for (const record of flags.values()) {
        if (record.starred) starredCount += 1;
        if (record.trashed) trashedCount += 1;
      }
      let pages = 0;
      while (objectCount < STATS_OBJECT_CAP && pages < 20) {
        const page = await storage.listObjects(bucket, {
          prefix: '',
          limit: storage.limits.maxListLimit,
          ...(cursor ? { cursor } : {}),
        });
        for (const object of page.objects || []) {
          objectCount += 1;
          totalBytes += Number(object.size) || 0;
        }
        pages += 1;
        if (page.has_more && page.next_cursor) cursor = page.next_cursor;
        else { cursor = undefined; break; }
      }
      if (cursor) truncated = true;
    }
    return Object.freeze({
      buckets: buckets.length,
      ...(bucketsPage.has_more ? { buckets_truncated: true } : {}),
      objects: objectCount,
      bytes: totalBytes,
      starred: starredCount,
      trashed: trashedCount,
      truncated,
    });
  }

  return Object.freeze({
    listBuckets,
    createBucket,
    listObjects,
    headObject,
    getObject,
    putObject,
    deleteObject,
    copyObject,
    setFlags,
    bulkSetFlags,
    createFolder,
    deleteFolder,
    stats,
  });
}
