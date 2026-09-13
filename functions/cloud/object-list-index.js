import {
  CloudAdapterError,
  CloudConfigurationError,
  CloudRequestError,
  CloudValidationError,
  isTelegraphCloudError,
} from './errors.js';
import { cloudIndexKey } from './index-store.js';
import {
  CLOUD_LIMITS,
  assertBucketName,
  assertObjectKey,
  assertObjectKeyPrefix,
  assertProjectId,
  serializeJsonDocument,
  utf8ByteLength,
} from './validation.js';

/**
 * A bounded, lexicographically traversable secondary index for the current
 * object manifests. It deliberately contains no object bytes or Telegram
 * pointers. Current manifests remain the authority: a list leaf is checked
 * against its manifest before becoming a public result.
 */
export const OBJECT_LIST_INDEX_SCHEMA = 'telegraph-cloud.object-list-index.v1';
export const OBJECT_LIST_CURSOR_SCHEMA = 'telegraph-cloud.object-list-cursor.v1';
export const OBJECT_LIST_INDEX_NAMESPACE = 'object-list';
export const OBJECT_LIST_CURSOR_NAMESPACE = 'object-list-cursor';
export const DEFAULT_OBJECT_LIST_LIMIT = CLOUD_LIMITS.DEFAULT_OBJECT_LIST_LIMIT;
export const MAX_OBJECT_LIST_LIMIT = CLOUD_LIMITS.MAX_OBJECT_LIST_LIMIT;
export const OBJECT_LIST_CURSOR_TTL_SECONDS = 10 * 60;

const OBJECT_LIST_DEFAULT_LIMIT_ENV = 'TELEGRAPH_CLOUD_DEFAULT_OBJECT_LIST_LIMIT';
const OBJECT_LIST_MAX_LIMIT_ENV = 'TELEGRAPH_CLOUD_MAX_OBJECT_LIST_LIMIT';
const CURSOR_ID_PATTERN = /^objcur_[A-Za-z0-9_-]{16,64}$/;
const KEY_HASH_PATTERN = /^objkey_[A-Za-z0-9_-]{43}$/;
const NODE_ID_PATTERN = /^(?:objroot|objnode_[A-Za-z0-9_-]{43})$/;
const TOKEN_PATTERN = /^[b-q]*$/;
const CURSOR_MAC_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const CURSOR_VERSION = 1;
const ROOT_NODE_ID = 'objroot';
// 32 raw bytes => 64 sortable characters. Together with the fixed node/hash
// segments this remains well under the Cloudflare KV 512-byte key limit even
// for Phase 4's 1,024-byte object-key ceiling.
const KEY_CHUNK_BYTES = 32;
const KEY_CHUNK_TOKEN_LENGTH = KEY_CHUNK_BYTES * 2;
const TERMINAL_MARKER = 'a';
const BRANCH_MARKER = 'b';
const NIBBLE_ALPHABET = 'bcdefghijklmnopq';
const MAX_TREE_DEPTH = Math.ceil(CLOUD_LIMITS.MAX_OBJECT_KEY_BYTES / KEY_CHUNK_BYTES) + 1;
// A small node page keeps the worst-case persisted continuation (up to 32
// levels, each retaining unconsumed sibling entries) safely below the 64 KiB
// cursor-state limit even for maximum-length object keys.
const INDEX_PAGE_SIZE = 6;
const MAX_INDEX_ENTRIES_PER_LIST = 400;
const MAX_KV_CURSOR_BYTES = 4096;
const MAX_CURSOR_STATE_BYTES = 64 * 1024;
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
    throw new CloudConfigurationError('invalid_object_storage_clock', 'Object storage clock configuration is invalid.');
  }
  return timestamp;
}

function invalidCursor() {
  return new CloudValidationError('invalid_cursor', 'Invalid object listing cursor.');
}

function invalidIndex() {
  return new CloudAdapterError('object_list_index_invalid', 'Object listing index state is invalid.', { status: 500 });
}

function invalidPage() {
  return new CloudAdapterError('object_list_index_page_invalid', 'Object listing index is temporarily unavailable.', { status: 503 });
}

function listBackendFailure() {
  return new CloudAdapterError('object_list_index_unavailable', 'Object listing is temporarily unavailable.', { status: 503 });
}

function normalizeConfiguredPositiveInteger(value, fallback, maximum, code) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number'
    ? value
    : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new CloudConfigurationError(code, 'Object listing limit configuration is invalid.');
  }
  return parsed;
}

/** Resolve bounded list controls without changing Phase 4 object-body limits. */
export function resolveObjectListLimits(env = {}) {
  const maxListLimit = normalizeConfiguredPositiveInteger(
    env?.[OBJECT_LIST_MAX_LIMIT_ENV],
    MAX_OBJECT_LIST_LIMIT,
    MAX_OBJECT_LIST_LIMIT,
    'invalid_object_list_limit',
  );
  const defaultListLimit = normalizeConfiguredPositiveInteger(
    env?.[OBJECT_LIST_DEFAULT_LIMIT_ENV],
    Math.min(DEFAULT_OBJECT_LIST_LIMIT, maxListLimit),
    maxListLimit,
    'invalid_object_list_limit',
  );
  return Object.freeze({
    defaultListLimit,
    maxListLimit,
    maxCursorBytes: CLOUD_LIMITS.MAX_OBJECT_LIST_CURSOR_BYTES,
  });
}

function normalizeDelimiter(value) {
  if (value === undefined || value === null) return null;
  if (value === '/') return '/';
  throw new CloudValidationError('invalid_object_delimiter', 'Only the slash object delimiter is supported.');
}

/**
 * Structured callers use this helper directly; HTTP callers first reject
 * duplicate/unknown URL parameters in parseObjectListQuery below.
 */
export function normalizeObjectListOptions(value = {}, limits = resolveObjectListLimits()) {
  if (!plainObject(value)) {
    throw new CloudValidationError('invalid_object_list_query', 'Object listing query is invalid.');
  }
  for (const field of Object.keys(value)) {
    if (!['prefix', 'cursor', 'limit', 'delimiter'].includes(field)) {
      throw new CloudValidationError('invalid_object_list_query', 'Object listing query contains an unsupported field.');
    }
  }
  const prefix = value.prefix === undefined || value.prefix === null
    ? ''
    : assertObjectKeyPrefix(value.prefix);
  const delimiter = normalizeDelimiter(value.delimiter);
  const limit = value.limit === undefined || value.limit === null
    ? limits.defaultListLimit
    : value.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.maxListLimit) {
    throw new CloudValidationError('invalid_object_list_limit', 'Object listing limit is outside the supported range.');
  }
  const cursor = value.cursor === undefined || value.cursor === null || value.cursor === ''
    ? undefined
    : value.cursor;
  if (cursor !== undefined && (typeof cursor !== 'string' || utf8ByteLength(cursor) > limits.maxCursorBytes)) {
    throw invalidCursor();
  }
  return Object.freeze({ prefix, delimiter, limit, cursor });
}

/** Parse only the documented URL controls and reject duplicate controls. */
export function parseObjectListQuery(searchParams, env = {}) {
  if (!searchParams || typeof searchParams.entries !== 'function') {
    throw new CloudValidationError('invalid_object_list_query', 'Object listing query is invalid.');
  }
  const values = {};
  const seen = new Set();
  for (const [name, value] of searchParams.entries()) {
    if (!['prefix', 'cursor', 'limit', 'delimiter'].includes(name) || seen.has(name)) {
      throw new CloudValidationError('invalid_object_list_query', 'Object listing query contains an unsupported or duplicate parameter.');
    }
    seen.add(name);
    if (name === 'limit') {
      if (!/^\d+$/.test(value)) {
        throw new CloudValidationError('invalid_object_list_limit', 'Object listing limit is outside the supported range.');
      }
      values.limit = Number(value);
    } else {
      values[name] = value;
    }
  }
  return normalizeObjectListOptions(values, resolveObjectListLimits(env));
}

function tokenForBytes(bytes) {
  let token = '';
  for (const byte of bytes) {
    token += NIBBLE_ALPHABET[byte >>> 4];
    token += NIBBLE_ALPHABET[byte & 0x0f];
  }
  return token;
}

function bytesForToken(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length % 2 !== 0 || !TOKEN_PATTERN.test(token)) {
    throw invalidIndex();
  }
  const bytes = new Uint8Array(token.length / 2);
  for (let index = 0; index < token.length; index += 2) {
    const high = NIBBLE_ALPHABET.indexOf(token[index]);
    const low = NIBBLE_ALPHABET.indexOf(token[index + 1]);
    if (high < 0 || low < 0) throw invalidIndex();
    bytes[index / 2] = (high << 4) | low;
  }
  return bytes;
}

function keyToken(value) {
  return tokenForBytes(encoder.encode(value));
}

function keyFromToken(token) {
  try {
    const key = decoder.decode(bytesForToken(token));
    return assertObjectKey(key);
  } catch (error) {
    if (isTelegraphCloudError(error)) throw invalidIndex();
    throw invalidIndex();
  }
}

// Frames retain only their deterministic path. The literal prefix remainder is
// derived when needed rather than duplicated at every tree depth in a cursor.
// This keeps a maximum-length prefix plus maximum-depth continuation bounded.
function filterTokenForPath(prefixToken, pathToken) {
  if (prefixToken.startsWith(pathToken)) return prefixToken.slice(pathToken.length);
  if (pathToken.startsWith(prefixToken)) return '';
  throw invalidIndex();
}

function chunksForKeyToken(token) {
  if (!token || token.length % 2 !== 0 || token.length > CLOUD_LIMITS.MAX_OBJECT_KEY_BYTES * 2 || !TOKEN_PATTERN.test(token)) {
    throw invalidIndex();
  }
  const chunks = [];
  for (let offset = 0; offset < token.length; offset += KEY_CHUNK_TOKEN_LENGTH) {
    chunks.push(token.slice(offset, offset + KEY_CHUNK_TOKEN_LENGTH));
  }
  if (chunks.length === 0 || chunks.length >= MAX_TREE_DEPTH) throw invalidIndex();
  return chunks;
}

function entryToken(chunk, terminal) {
  if (!chunk || chunk.length % 2 !== 0 || chunk.length > KEY_CHUNK_TOKEN_LENGTH || !TOKEN_PATTERN.test(chunk)) {
    throw invalidIndex();
  }
  if (!terminal && chunk.length !== KEY_CHUNK_TOKEN_LENGTH) throw invalidIndex();
  return `${chunk}${terminal ? TERMINAL_MARKER : BRANCH_MARKER}`;
}

function safeCursorValue(value) {
  return typeof value === 'string'
    && value.length > 0
    && utf8ByteLength(value) <= MAX_KV_CURSOR_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function publicSelection(bucket, options) {
  return Object.freeze({ bucket, prefix: options.prefix, delimiter: options.delimiter });
}

function cursorSigningKey(env, cryptoApi) {
  const pepper = env?.API_KEY_PEPPER;
  if (typeof pepper !== 'string') {
    throw new CloudConfigurationError('object_cursor_signing_unavailable', 'Object listing cursor signing is not configured.');
  }
  const bytes = encoder.encode(pepper);
  if (bytes.byteLength < 32 || bytes.byteLength > MAX_PEPPER_BYTES
    || !cryptoApi?.subtle || typeof cryptoApi.subtle.importKey !== 'function'
    || typeof cryptoApi.subtle.sign !== 'function' || typeof cryptoApi.subtle.verify !== 'function') {
    throw new CloudConfigurationError('object_cursor_signing_unavailable', 'Object listing cursor signing is not configured.');
  }
  return cryptoApi.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    .catch(() => {
      throw new CloudConfigurationError('object_cursor_signing_unavailable', 'Object listing cursor signing is not configured.');
    });
}

function cursorMacPayload(projectId, selection, cursorId) {
  // JSON array encoding avoids delimiter ambiguity while keeping the secret
  // signature domain-separated from developer-key verifiers.
  return encoder.encode(JSON.stringify([
    'telegraph-cloud.object-list-cursor.v1',
    projectId,
    selection.bucket,
    selection.prefix,
    selection.delimiter || '',
    cursorId,
  ]));
}

async function sha256Base64url(value, cryptoApi) {
  if (!cryptoApi?.subtle || typeof cryptoApi.subtle.digest !== 'function') {
    throw new CloudConfigurationError('object_storage_crypto_unavailable', 'Object storage hashing is unavailable.');
  }
  try {
    const bytes = typeof value === 'string' ? encoder.encode(value) : value;
    return base64url(new Uint8Array(await cryptoApi.subtle.digest('SHA-256', bytes)));
  } catch (_) {
    throw new CloudConfigurationError('object_storage_crypto_unavailable', 'Object storage hashing is unavailable.');
  }
}

function validatePage(page) {
  if (!plainObject(page) || !Array.isArray(page.keys) || typeof page.list_complete !== 'boolean') {
    throw invalidPage();
  }
  if (!page.list_complete && !safeCursorValue(page.cursor)) throw invalidPage();
  if (page.keys.length > INDEX_PAGE_SIZE) throw invalidPage();
  return page;
}

function validatePendingEntry(entry) {
  if (!plainObject(entry) || (entry.kind !== 'branch' && entry.kind !== 'terminal')
    || typeof entry.token !== 'string' || !TOKEN_PATTERN.test(entry.token)
    || entry.token.length === 0 || entry.token.length % 2 !== 0 || entry.token.length > KEY_CHUNK_TOKEN_LENGTH) {
    throw invalidIndex();
  }
  if (entry.kind === 'branch' && entry.token.length !== KEY_CHUNK_TOKEN_LENGTH) throw invalidIndex();
  if (entry.kind === 'terminal' && (!KEY_HASH_PATTERN.test(entry.key_hash || '') || entry.token.length > KEY_CHUNK_TOKEN_LENGTH)) {
    throw invalidIndex();
  }
  return entry.kind === 'branch'
    ? { kind: 'branch', token: entry.token }
    : { kind: 'terminal', token: entry.token, key_hash: entry.key_hash };
}

function validateFrame(value) {
  if (!plainObject(value)
    || typeof value.node_id !== 'string' || !NODE_ID_PATTERN.test(value.node_id)
    || typeof value.path_token !== 'string' || !TOKEN_PATTERN.test(value.path_token)
    || value.path_token.length % KEY_CHUNK_TOKEN_LENGTH !== 0
    || value.path_token.length > CLOUD_LIMITS.MAX_OBJECT_KEY_BYTES * 2
    || !(value.kv_cursor === null || safeCursorValue(value.kv_cursor))
    || typeof value.list_complete !== 'boolean'
    || !Array.isArray(value.pending) || value.pending.length > INDEX_PAGE_SIZE
  ) {
    throw invalidIndex();
  }
  return {
    node_id: value.node_id,
    path_token: value.path_token,
    kv_cursor: value.kv_cursor,
    list_complete: value.list_complete,
    pending: value.pending.map(validatePendingEntry),
  };
}

function normalizeCursorRecord(value, projectId, selection) {
  try {
    if (!plainObject(value) || value.schema !== OBJECT_LIST_CURSOR_SCHEMA) throw new Error('schema');
    if (assertProjectId(value.project_id) !== projectId || assertBucketName(value.bucket) !== selection.bucket) throw new Error('scope');
    if (assertObjectKeyPrefix(value.prefix) !== selection.prefix || normalizeDelimiter(value.delimiter) !== selection.delimiter) {
      throw new Error('selection');
    }
    if (!safeTimestamp(value.created_at) || !Array.isArray(value.stack)
      || value.stack.length === 0 || value.stack.length > MAX_TREE_DEPTH
      || !(value.last_common_prefix === null || typeof value.last_common_prefix === 'string')) {
      throw new Error('state');
    }
    if (value.last_common_prefix !== null) {
      const commonPrefix = assertObjectKeyPrefix(value.last_common_prefix);
      if (!selection.delimiter || !commonPrefix.startsWith(selection.prefix)
        || !commonPrefix.endsWith(selection.delimiter)) throw new Error('group');
    }
    const stack = value.stack.map(validateFrame);
    const prefixToken = keyToken(selection.prefix);
    for (let indexPosition = 0; indexPosition < stack.length; indexPosition += 1) {
      const frame = stack[indexPosition];
      filterTokenForPath(prefixToken, frame.path_token);
      if (indexPosition === 0) {
        if (frame.node_id !== ROOT_NODE_ID || frame.path_token !== '') throw new Error('root');
      } else {
        const parentPath = stack[indexPosition - 1].path_token;
        if (frame.path_token.length !== parentPath.length + KEY_CHUNK_TOKEN_LENGTH
          || !frame.path_token.startsWith(parentPath)) throw new Error('stack');
      }
    }
    return {
      schema: OBJECT_LIST_CURSOR_SCHEMA,
      project_id: projectId,
      bucket: selection.bucket,
      prefix: selection.prefix,
      delimiter: selection.delimiter,
      created_at: value.created_at,
      last_common_prefix: value.last_common_prefix,
      stack,
    };
  } catch (_) {
    throw invalidIndex();
  }
}

function cursorRecord(state, projectId, selection, timestamp) {
  const record = {
    schema: OBJECT_LIST_CURSOR_SCHEMA,
    project_id: projectId,
    bucket: selection.bucket,
    prefix: selection.prefix,
    delimiter: selection.delimiter,
    created_at: timestamp,
    last_common_prefix: state.last_common_prefix,
    stack: state.stack,
  };
  try {
    return serializeJsonDocument(record, { maxBytes: MAX_CURSOR_STATE_BYTES }).value;
  } catch (_) {
    throw invalidIndex();
  }
}

/**
 * Create the index helper around engine-owned KV wrappers and manifest reader.
 * The reader is deliberately injected so this module never learns Telegram
 * pointer layout or makes a public result from an unverified index leaf.
 */
export function createObjectListIndex({
  env,
  index,
  projectId,
  now = () => new Date(),
  createId,
  cryptoApi = globalThis.crypto,
  readManifest,
  publicObject,
} = {}) {
  const safeProjectId = assertProjectId(projectId);
  if (!index || typeof index.getJson !== 'function' || typeof index.putJson !== 'function'
    || typeof index.remove !== 'function' || typeof index.list !== 'function' || typeof index.listWithSuffix !== 'function'
    || typeof readManifest !== 'function' || typeof publicObject !== 'function' || typeof createId !== 'function') {
    throw new CloudConfigurationError('object_list_index_unavailable', 'Object listing index is not configured.');
  }
  const limits = resolveObjectListLimits(env);

  async function nodeIdFor(pathToken) {
    if (!pathToken) return ROOT_NODE_ID;
    if (pathToken.length % KEY_CHUNK_TOKEN_LENGTH !== 0 || !TOKEN_PATTERN.test(pathToken)) throw invalidIndex();
    return `objnode_${await sha256Base64url(`telegraph-cloud.object-list-node.v1\u0000${pathToken}`, cryptoApi)}`;
  }

  async function getIndex(segments) {
    try {
      return await index.getJson(OBJECT_LIST_INDEX_NAMESPACE, ...segments);
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw listBackendFailure();
    }
  }

  async function putIndex(segments, value, options) {
    try {
      await index.putJson(OBJECT_LIST_INDEX_NAMESPACE, segments, value, options);
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw listBackendFailure();
    }
  }

  async function removeIndex(segments) {
    try {
      await index.remove(OBJECT_LIST_INDEX_NAMESPACE, ...segments);
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw listBackendFailure();
    }
  }

  async function getCursor(cursorId) {
    try {
      return await index.getJson(OBJECT_LIST_CURSOR_NAMESPACE, safeProjectId, cursorId);
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw listBackendFailure();
    }
  }

  async function putCursor(cursorId, value) {
    try {
      await index.putJson(OBJECT_LIST_CURSOR_NAMESPACE, [safeProjectId, cursorId], value, {
        expirationTtl: OBJECT_LIST_CURSOR_TTL_SECONDS,
      });
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw listBackendFailure();
    }
  }

  async function listNode(bucket, frame, prefixToken) {
    const expectedNodeId = await nodeIdFor(frame.path_token);
    if (frame.node_id !== expectedNodeId) throw invalidIndex();
    const segmentPrefix = [safeProjectId, bucket, frame.node_id];
    const suffix = filterTokenForPath(prefixToken, frame.path_token).slice(0, KEY_CHUNK_TOKEN_LENGTH);
    let page;
    try {
      page = suffix
        ? await index.listWithSuffix(OBJECT_LIST_INDEX_NAMESPACE, {
          prefixSegments: segmentPrefix,
          suffix,
          limit: INDEX_PAGE_SIZE,
          ...(frame.kv_cursor ? { cursor: frame.kv_cursor } : {}),
        })
        : await index.list(OBJECT_LIST_INDEX_NAMESPACE, {
          prefixSegments: segmentPrefix,
          limit: INDEX_PAGE_SIZE,
          ...(frame.kv_cursor ? { cursor: frame.kv_cursor } : {}),
        });
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw listBackendFailure();
    }
    return validatePage(page);
  }

  function nodeEntryFromKey(name, bucket, nodeId) {
    const prefix = `${cloudIndexKey(OBJECT_LIST_INDEX_NAMESPACE, safeProjectId, bucket, nodeId)}:`;
    if (typeof name !== 'string' || !name.startsWith(prefix)) throw invalidIndex();
    const parts = name.slice(prefix.length).split(':');
    const tokenWithMarker = parts[0];
    if (typeof tokenWithMarker !== 'string' || tokenWithMarker.length < 3) throw invalidIndex();
    const marker = tokenWithMarker.at(-1);
    const token = tokenWithMarker.slice(0, -1);
    if (!TOKEN_PATTERN.test(token) || token.length === 0 || token.length % 2 !== 0 || token.length > KEY_CHUNK_TOKEN_LENGTH) {
      throw invalidIndex();
    }
    if (marker === BRANCH_MARKER && parts.length === 1 && token.length === KEY_CHUNK_TOKEN_LENGTH) {
      return { kind: 'branch', token };
    }
    if (marker === TERMINAL_MARKER && parts.length === 2 && KEY_HASH_PATTERN.test(parts[1])) {
      return { kind: 'terminal', token, key_hash: parts[1] };
    }
    throw invalidIndex();
  }

  function popExhaustedFrames(state) {
    while (state.stack.length > 0) {
      const frame = state.stack.at(-1);
      if (frame.pending.length !== 0 || !frame.list_complete) break;
      state.stack.pop();
    }
  }

  async function nextTerminal(bucket, state, budget, prefixToken) {
    if (state.pending_terminal) return state.pending_terminal;
    while (state.stack.length > 0) {
      if (budget.entries >= MAX_INDEX_ENTRIES_PER_LIST) return null;
      const frame = state.stack.at(-1);
      const filterToken = filterTokenForPath(prefixToken, frame.path_token);
      if (frame.pending.length === 0) {
        if (frame.list_complete) {
          state.stack.pop();
          continue;
        }
        const page = await listNode(bucket, frame, prefixToken);
        frame.pending = page.keys.map((key) => nodeEntryFromKey(key?.name, bucket, frame.node_id));
        frame.list_complete = page.list_complete;
        frame.kv_cursor = page.list_complete ? null : page.cursor;
        if (frame.pending.length === 0) {
          if (!frame.list_complete) throw invalidPage();
          continue;
        }
      }

      const entry = frame.pending.shift();
      budget.entries += 1;
      if (entry.kind === 'branch') {
        const pathToken = `${frame.path_token}${entry.token}`;
        if (pathToken.length > CLOUD_LIMITS.MAX_OBJECT_KEY_BYTES * 2 || state.stack.length >= MAX_TREE_DEPTH) {
          throw invalidIndex();
        }
        // The exact literal prefix either continues below this full chunk or
        // has already been satisfied by it; validate that relationship before
        // persisting/traversing an untrusted KV branch marker.
        filterTokenForPath(prefixToken, pathToken);
        state.stack.push({
          node_id: await nodeIdFor(pathToken),
          path_token: pathToken,
          kv_cursor: null,
          list_complete: false,
          pending: [],
        });
        continue;
      }

      // A terminal whose key is shorter than a still-unmatched prefix cannot
      // satisfy the literal prefix selection even though its first full chunk
      // shared the lower-level list suffix.
      if (filterToken.length > entry.token.length) continue;
      const fullToken = `${frame.path_token}${entry.token}`;
      const key = keyFromToken(fullToken);
      state.pending_terminal = { key, key_hash: entry.key_hash };
      return state.pending_terminal;
    }
    return null;
  }

  function consumeTerminal(state) {
    const terminal = state.pending_terminal;
    state.pending_terminal = null;
    popExhaustedFrames(state);
    return terminal;
  }

  function initialState() {
    return {
      last_common_prefix: null,
      pending_terminal: null,
      stack: [{
        node_id: ROOT_NODE_ID,
        path_token: '',
        kv_cursor: null,
        list_complete: false,
        pending: [],
      }],
    };
  }

  function groupForKey(key, selection) {
    if (!selection.delimiter) return null;
    if (!key.startsWith(selection.prefix)) throw invalidIndex();
    const remainder = key.slice(selection.prefix.length);
    const position = remainder.indexOf(selection.delimiter);
    if (position < 0) return null;
    return `${selection.prefix}${remainder.slice(0, position + selection.delimiter.length)}`;
  }

  async function importSigningKey() {
    return cursorSigningKey(env, cryptoApi);
  }

  async function signCursorId(cursorId, selection) {
    const key = await importSigningKey();
    try {
      return base64url(new Uint8Array(await cryptoApi.subtle.sign(
        'HMAC',
        key,
        cursorMacPayload(safeProjectId, selection, cursorId),
      )));
    } catch (_) {
      throw new CloudConfigurationError('object_cursor_signing_unavailable', 'Object listing cursor signing is not configured.');
    }
  }

  async function encodeCursor(cursorId, selection) {
    const signature = await signCursorId(cursorId, selection);
    return base64url(encoder.encode(JSON.stringify({ v: CURSOR_VERSION, i: cursorId, s: signature })));
  }

  async function decodeCursor(value, selection) {
    if (typeof value !== 'string' || utf8ByteLength(value) > limits.maxCursorBytes) throw invalidCursor();
    let parsed;
    try {
      parsed = JSON.parse(decoder.decode(fromBase64url(value)));
    } catch (_) {
      throw invalidCursor();
    }
    if (!plainObject(parsed) || parsed.v !== CURSOR_VERSION || typeof parsed.i !== 'string'
      || !CURSOR_ID_PATTERN.test(parsed.i) || typeof parsed.s !== 'string' || !CURSOR_MAC_PATTERN.test(parsed.s)) {
      throw invalidCursor();
    }
    const key = await importSigningKey();
    let valid = false;
    try {
      valid = await cryptoApi.subtle.verify(
        'HMAC',
        key,
        fromBase64url(parsed.s),
        cursorMacPayload(safeProjectId, selection, parsed.i),
      );
    } catch (_) {
      throw invalidCursor();
    }
    if (!valid) throw invalidCursor();
    return parsed.i;
  }

  async function allocateCursorId() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let candidate;
      try {
        candidate = createId('objcur_');
      } catch (_) {
        throw new CloudConfigurationError('object_cursor_generation_unavailable', 'Object listing cursor generation is unavailable.');
      }
      if (typeof candidate !== 'string' || !CURSOR_ID_PATTERN.test(candidate)) {
        throw new CloudConfigurationError('object_cursor_generation_unavailable', 'Object listing cursor generation is unavailable.');
      }
      if (await getCursor(candidate) === null) return candidate;
    }
    throw new CloudAdapterError('object_cursor_generation_unavailable', 'Object listing cursor generation is unavailable.', { status: 503 });
  }

  async function cursorStateFor(options, bucket) {
    const selection = publicSelection(bucket, options);
    if (!options.cursor) return { selection, state: initialState() };
    const cursorId = await decodeCursor(options.cursor, selection);
    const stored = await getCursor(cursorId);
    // An expired/missing opaque cursor must not reveal whether another project
    // has a state record at the same internal key.
    if (stored === null) throw invalidCursor();
    const record = normalizeCursorRecord(stored, safeProjectId, selection);
    return {
      selection,
      state: {
        last_common_prefix: record.last_common_prefix,
        pending_terminal: null,
        stack: record.stack,
      },
    };
  }

  async function persistContinuation(state, selection) {
    if (state.pending_terminal) throw invalidIndex();
    const cursorId = await allocateCursorId();
    const record = cursorRecord(state, safeProjectId, selection, timestampFrom(now));
    await putCursor(cursorId, record);
    return encodeCursor(cursorId, selection);
  }

  async function materialize(manifest) {
    if (assertProjectId(manifest?.project_id) !== safeProjectId) throw invalidIndex();
    const bucket = assertBucketName(manifest?.bucket);
    const key = assertObjectKey(manifest?.key);
    if (!KEY_HASH_PATTERN.test(manifest?.key_hash || '')) throw invalidIndex();
    if (manifest.state !== 'active' && manifest.state !== 'deleted') throw invalidIndex();

    const token = keyToken(key);
    const chunks = chunksForKeyToken(token);
    let parentNodeId = ROOT_NODE_ID;
    let parentPathToken = '';

    for (let indexPosition = 0; indexPosition < chunks.length - 1; indexPosition += 1) {
      const chunk = chunks[indexPosition];
      const branch = entryToken(chunk, false);
      const pathToken = `${parentPathToken}${chunk}`;
      const childNodeId = await nodeIdFor(pathToken);
      if (manifest.state === 'active') {
        const branchSegments = [safeProjectId, bucket, parentNodeId, branch];
        // Shared branch keys are intentionally write-once. This avoids turning
        // a common key prefix into a hot KV key while still letting concurrent
        // first writers safely converge on the same deterministic child node.
        if (await getIndex(branchSegments) === null) {
          await putIndex(branchSegments, {
            schema: OBJECT_LIST_INDEX_SCHEMA,
            kind: 'branch',
            project_id: safeProjectId,
            bucket,
            node_id: parentNodeId,
            child_node_id: childNodeId,
            created_at: manifest.updated_at,
          });
        }
      }
      parentNodeId = childNodeId;
      parentPathToken = pathToken;
    }

    const terminal = entryToken(chunks.at(-1), true);
    const terminalSegments = [safeProjectId, bucket, parentNodeId, terminal, manifest.key_hash];
    if (manifest.state === 'active') {
      await putIndex(terminalSegments, {
        schema: OBJECT_LIST_INDEX_SCHEMA,
        kind: 'terminal',
        project_id: safeProjectId,
        bucket,
        node_id: parentNodeId,
        key_hash: manifest.key_hash,
      });
      return;
    }

    // Branch markers are intentionally retained. Removing a shared branch
    // without an atomic child-count would race another active object; stale
    // branches are harmless, bounded traversal work and never public data.
    await removeIndex(terminalSegments);
  }

  async function listObjects(bucketInput, input = {}) {
    const bucket = assertBucketName(bucketInput);
    const options = normalizeObjectListOptions(input, limits);
    const { selection, state } = await cursorStateFor(options, bucket);
    const prefixToken = keyToken(options.prefix);
    const objects = [];
    const commonPrefixes = [];
    const budget = { entries: 0 };

    while ((objects.length + commonPrefixes.length) < options.limit) {
      const terminal = await nextTerminal(bucket, state, budget, prefixToken);
      if (!terminal) break;
      consumeTerminal(state);
      let manifest;
      try {
        manifest = await readManifest({ bucket, key: terminal.key, keyHash: terminal.key_hash });
      } catch (error) {
        if (isTelegraphCloudError(error)) throw error;
        throw listBackendFailure();
      }
      // A missing, tombstoned, or mismatched current manifest is a stale leaf
      // and is deliberately omitted rather than exposing partial history.
      if (!manifest || manifest.state !== 'active' || manifest.bucket !== bucket
        || manifest.key !== terminal.key || manifest.key_hash !== terminal.key_hash
        || !manifest.key.startsWith(options.prefix)) {
        continue;
      }
      const commonPrefix = groupForKey(manifest.key, selection);
      if (commonPrefix !== null) {
        if (state.last_common_prefix === commonPrefix) continue;
        commonPrefixes.push(commonPrefix);
        state.last_common_prefix = commonPrefix;
      } else {
        objects.push(publicObject(manifest));
        state.last_common_prefix = null;
      }
    }

    popExhaustedFrames(state);
    const hasMore = state.stack.length > 0 || state.pending_terminal !== null;
    return Object.freeze({
      objects: Object.freeze(objects),
      ...(selection.delimiter ? { common_prefixes: Object.freeze(commonPrefixes) } : {}),
      limit: options.limit,
      order: 'key:asc',
      ...(hasMore ? { next_cursor: await persistContinuation(state, selection) } : {}),
      has_more: hasMore,
    });
  }

  return Object.freeze({
    materialize,
    listObjects,
    limits,
  });
}
