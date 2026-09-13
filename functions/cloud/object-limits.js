import { CloudConfigurationError } from './errors.js';
import { CLOUD_LIMITS } from './validation.js';

// The hard ceiling is the known Telegram getFile compatibility boundary. The
// lower default is intentional: the current object adapter needs a bounded
// buffer for SHA-256 and multipart Telegram document work.
export const DEFAULT_OBJECT_STORAGE_MAX_BYTES = 10 * 1024 * 1024;
export const OBJECT_STORAGE_LIMIT_ENV = 'TELEGRAPH_CLOUD_MAX_OBJECT_BYTES';

function normalizeLimit(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_OBJECT_STORAGE_MAX_BYTES;
  const parsed = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > CLOUD_LIMITS.MAX_OBJECT_BYTES) {
    throw new CloudConfigurationError('invalid_object_storage_limit', 'Object storage size limit is invalid.');
  }
  return parsed;
}

/** Returns the bounded request-body limit shared by object HTTP and SigV4. */
export function resolveObjectStorageLimits(env = {}) {
  return Object.freeze({ maxObjectBytes: normalizeLimit(env?.[OBJECT_STORAGE_LIMIT_ENV]) });
}
