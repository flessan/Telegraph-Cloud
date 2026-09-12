import { authenticateDeveloperBearer } from '../../cloud/developer-auth.js';
import { CloudUnauthorizedError, isTelegraphCloudError } from '../../cloud/errors.js';
import { jsonResponse } from '../../utils/http.js';

// This is an intentionally local burst guard, not a distributed quota, billing
// meter, or durable rate limiter. API-key project scope remains the authority.
const MUTATION_WINDOW_MS = 60 * 1000;
const MAX_MUTATIONS_PER_WINDOW = 20;
const mutationBuckets = new Map();

function requiredScope(method) {
  if (method === 'GET' || method === 'HEAD') return 'storage:read';
  if (method === 'PUT' || method === 'DELETE') return 'storage:write';
  return null;
}

function consumeMutationSlot(projectId, timestamp = Date.now()) {
  const cutoff = timestamp - MUTATION_WINDOW_MS;
  const recent = (mutationBuckets.get(projectId) || []).filter((entry) => entry > cutoff);
  if (recent.length >= MAX_MUTATIONS_PER_WINDOW) {
    mutationBuckets.set(projectId, recent);
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((recent[0] + MUTATION_WINDOW_MS - timestamp) / 1000)) };
  }
  recent.push(timestamp);
  mutationBuckets.set(projectId, recent);
  if (mutationBuckets.size > 256) mutationBuckets.delete(mutationBuckets.keys().next().value);
  return { allowed: true };
}

/**
 * Storage has no dashboard/unscoped compatibility mode. Every successful
 * request gets its project identity exclusively from a verified Bearer key.
 */
export async function storageAuthentication(context) {
  const authentication = await authenticateDeveloperBearer(context, {
    scope: requiredScope(context.request.method),
    forbiddenCode: 'api_key_scope_forbidden',
    forbiddenMessage: 'This API key does not have permission for this storage operation.',
  });
  if (!authentication) {
    throw new CloudUnauthorizedError('invalid_api_key', 'A valid developer API key is required.');
  }
  context.data = context.data || {};
  context.data.storageAuthentication = authentication;
  return context.next();
}

export async function storageMutationRateLimit(context) {
  if (!['PUT', 'DELETE'].includes(context.request.method)) return context.next();
  const projectId = context.data?.storageAuthentication?.project_id;
  const result = consumeMutationSlot(typeof projectId === 'string' ? projectId : 'unknown');
  if (result.allowed) return context.next();
  return jsonResponse({ error: 'rate_limited' }, {
    status: 429,
    headers: {
      'Cache-Control': 'no-store',
      'Retry-After': String(result.retryAfter),
    },
  });
}

export async function storageErrorHandling(context) {
  try {
    return await context.next();
  } catch (error) {
    if (isTelegraphCloudError(error)) {
      // Only the predeclared stable error code is exposed. Never serialize
      // error details: they may include internal provider/KV diagnostics.
      return jsonResponse({ error: error.code }, {
        status: error.status,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    console.error('Telegraph Cloud object storage request failed.');
    return jsonResponse({ error: 'internal_error' }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

export const onRequest = [storageErrorHandling, storageAuthentication, storageMutationRateLimit];
