import { CloudAdapterError, CloudConfigurationError, CloudValidationError } from './errors.js';
import { CLOUD_LIMITS, serializeJsonDocument, utf8ByteLength } from './validation.js';

// This binding is intentionally separate from legacy `img_url`: it will hold
// Telegraph Cloud's non-authoritative materialized index, recovery outbox,
// project registry, and API-key registry. Telegram remains the eventual source
// for immutable object bytes and document revision payloads.
export const CLOUD_INDEX_BINDING = 'TELEGRAPH_CLOUD_KV';
export const CLOUD_INDEX_PREFIX = 'tc:v1';

const INDEX_NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const INDEX_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function invalidKey() {
  throw new CloudValidationError('invalid_index_key', 'Invalid Telegraph Cloud index key.');
}

function normalizeSegments(segments) {
  if (!Array.isArray(segments)) return [segments];
  return segments;
}

function assertNamespace(namespace) {
  if (typeof namespace !== 'string' || !INDEX_NAMESPACE_PATTERN.test(namespace)) {
    invalidKey();
  }
  return namespace;
}

function assertSegment(segment) {
  if (
    typeof segment !== 'string'
    || !INDEX_SEGMENT_PATTERN.test(segment)
    || segment === '.'
    || segment === '..'
    || utf8ByteLength(segment) > CLOUD_LIMITS.MAX_DOCUMENT_ID_LENGTH
  ) {
    invalidKey();
  }
  return segment;
}

function assertBinding(binding) {
  if (
    !binding
    || typeof binding.get !== 'function'
    || typeof binding.put !== 'function'
    || typeof binding.delete !== 'function'
    || typeof binding.list !== 'function'
  ) {
    throw new CloudConfigurationError(
      'cloud_index_unavailable',
      `Missing required Cloudflare KV binding: ${CLOUD_INDEX_BINDING}.`,
    );
  }
  return binding;
}

function parseStoredJson(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') {
    throw new CloudAdapterError('cloud_index_invalid_value', 'Cloud index returned an invalid value.', { status: 500 });
  }
  try {
    const parsed = JSON.parse(raw);
    // Index records are objects, just like document revision payloads. This
    // rejects prototypes/non-JSON types and bounds a corrupt oversized value.
    return serializeJsonDocument(parsed).value;
  } catch (_) {
    // Corrupt materialized state is an adapter/server condition, never a
    // caller validation failure and never an opportunity to echo stored data.
    throw new CloudAdapterError('cloud_index_invalid_json', 'Cloud index contains invalid JSON.', { status: 500 });
  }
}

/**
 * Build an internal key without ever concatenating unvalidated project, object,
 * or collection values. The colon-delimited namespace is also visibly distinct
 * from legacy `img_url` records if an operator inspects storage manually.
 */
export function cloudIndexKey(namespace, ...segments) {
  const safeNamespace = assertNamespace(namespace);
  const safeSegments = normalizeSegments(segments).flat().map(assertSegment);
  return [CLOUD_INDEX_PREFIX, safeNamespace, ...safeSegments].join(':');
}

export function getCloudIndexBinding(env) {
  return env && env[CLOUD_INDEX_BINDING] ? env[CLOUD_INDEX_BINDING] : null;
}

export function requireCloudIndexBinding(env) {
  return assertBinding(getCloudIndexBinding(env));
}

/**
 * Thin, namespaced KV boundary for later Cloud services. It intentionally has
 * no document CRUD or object-storage semantics; Phase 2+ owns those services.
 */
export function createCloudIndexStore(env, { binding = getCloudIndexBinding(env) } = {}) {
  const kv = assertBinding(binding);

  function key(namespace, ...segments) {
    return cloudIndexKey(namespace, ...segments);
  }

  async function getJson(namespace, ...segments) {
    return parseStoredJson(await kv.get(key(namespace, ...segments)));
  }

  async function putJson(namespace, segments, value, options = {}) {
    const { serialized } = serializeJsonDocument(value);
    await kv.put(key(namespace, ...normalizeSegments(segments)), serialized, options);
  }

  async function remove(namespace, ...segments) {
    await kv.delete(key(namespace, ...segments));
  }

  async function list(namespace, { prefixSegments = [], limit, cursor } = {}) {
    const safeNamespace = assertNamespace(namespace);
    const safePrefixSegments = normalizeSegments(prefixSegments).map(assertSegment);
    const prefix = [CLOUD_INDEX_PREFIX, safeNamespace, ...safePrefixSegments].join(':') + ':';
    const options = { prefix };
    if (limit !== undefined) options.limit = limit;
    if (cursor !== undefined) options.cursor = cursor;
    return kv.list(options);
  }

  return Object.freeze({
    bindingName: CLOUD_INDEX_BINDING,
    key,
    getJson,
    putJson,
    remove,
    list,
  });
}
