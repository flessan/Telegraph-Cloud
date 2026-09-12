import { isTelegraphCloudError } from '../../cloud/errors.js';
import { isEmptyBinding, jsonResponse } from '../../utils/http.js';
import { authenticateRequest } from '../../utils/session.js';

// This is a local abuse guard for dashboard-authorized project/key mutations.
// It is not distributed rate limiting, durable accounting, or a substitute for
// Cloudflare edge protections; project/key authorization remains the boundary.
const WINDOW_MS = 60 * 1000;
const MAX_MUTATIONS_PER_WINDOW = 30;
const mutationBuckets = new Map();

function mutationKey(context) {
  const identity = context.data?.projectSession;
  return typeof identity?.user === 'string' && identity.user ? `dashboard:${identity.user}` : 'dashboard:owner';
}

function consumeMutationSlot(key, timestamp = Date.now()) {
  const cutoff = timestamp - WINDOW_MS;
  const recent = (mutationBuckets.get(key) || []).filter((entry) => entry > cutoff);
  if (recent.length >= MAX_MUTATIONS_PER_WINDOW) {
    mutationBuckets.set(key, recent);
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((recent[0] + WINDOW_MS - timestamp) / 1000)) };
  }
  recent.push(timestamp);
  mutationBuckets.set(key, recent);
  if (mutationBuckets.size > 256) mutationBuckets.delete(mutationBuckets.keys().next().value);
  return { allowed: true };
}

function errorBody(error) {
  return { error: error.code };
}

/**
 * Projects and key management are dashboard administration APIs only. Unlike
 * historical /api/manage open-mode behavior, these endpoints fail closed when
 * BASIC_USER/BASIC_PASS are not configured. Developer Bearer keys cannot pass
 * `authenticateRequest` and are never treated as dashboard credentials.
 */
export async function projectAuthentication(context) {
  const { request, env = {} } = context;
  if (isEmptyBinding(env.BASIC_USER) || isEmptyBinding(env.BASIC_PASS)) {
    return jsonResponse({ error: 'project_auth_not_configured' }, {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  const identity = await authenticateRequest(request, env);
  if (!identity) {
    return jsonResponse({ error: 'unauthenticated' }, {
      status: 401,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  context.data = context.data || {};
  context.data.projectSession = identity;
  return context.next();
}

export async function projectMutationRateLimit(context) {
  if (!['POST', 'PATCH', 'DELETE'].includes(context.request.method)) return context.next();
  const result = consumeMutationSlot(mutationKey(context));
  if (result.allowed) return context.next();
  return jsonResponse({ error: 'rate_limited' }, {
    status: 429,
    headers: {
      'Cache-Control': 'no-store',
      'Retry-After': String(result.retryAfter),
    },
  });
}

export async function projectErrorHandling(context) {
  try {
    return await context.next();
  } catch (error) {
    if (isTelegraphCloudError(error)) {
      return jsonResponse(errorBody(error), {
        status: error.status,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    // No request/error object is emitted: headers can contain a developer key
    // and an error can contain a binding or upstream implementation detail.
    console.error('Telegraph Cloud project request failed.');
    return jsonResponse({ error: 'internal_error' }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

export const onRequest = [projectErrorHandling, projectAuthentication, projectMutationRateLimit];
