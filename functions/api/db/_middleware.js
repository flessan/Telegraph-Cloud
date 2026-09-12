import { createDeveloperApiKeyService } from '../../cloud/developer-api-keys.js';
import { CloudForbiddenError, CloudUnauthorizedError, isTelegraphCloudError } from '../../cloud/errors.js';
import { isEmptyBinding, jsonResponse } from '../../utils/http.js';
import { authenticateRequest } from '../../utils/session.js';

// This remains a deliberately local, in-isolate burst guard rather than an
// invented distributed quota service. It is not durable, global, or a billing
// meter. It merely reduces accidental Telegram mutation bursts per dashboard
// identity or authenticated project until a future dedicated limiter exists.
const MUTATION_WINDOW_MS = 60 * 1000;
const MAX_MUTATIONS_PER_WINDOW = 20;
const mutationBuckets = new Map();

function mutationBucketKey(context) {
  const authentication = context.data?.databaseAuthentication;
  if (authentication?.authentication === 'developer_api_key' && typeof authentication.project_id === 'string') {
    return `project:${authentication.project_id}`;
  }
  const identity = context.data?.databaseSession;
  return typeof identity?.user === 'string' && identity.user ? `dashboard:${identity.user}` : 'dashboard:owner';
}

function consumeMutationSlot(key, timestamp = Date.now()) {
  const cutoff = timestamp - MUTATION_WINDOW_MS;
  const recent = (mutationBuckets.get(key) || []).filter((entry) => entry > cutoff);
  if (recent.length >= MAX_MUTATIONS_PER_WINDOW) {
    mutationBuckets.set(key, recent);
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((recent[0] + MUTATION_WINDOW_MS - timestamp) / 1000)) };
  }
  recent.push(timestamp);
  mutationBuckets.set(key, recent);
  // Bound memory even if a long-lived isolate sees many distinct identities.
  // Eviction is safe because this is only a best-effort guard, never the
  // authoritative project/key authorization boundary.
  if (mutationBuckets.size > 256) {
    mutationBuckets.delete(mutationBuckets.keys().next().value);
  }
  return { allowed: true };
}

function databaseErrorBody(error) {
  const body = { error: error.code };
  // This is intentionally a strict allowlist rather than a generic error
  // serializer. Internal Telegram/KV pointers and caught Error data must never
  // become JSON merely because a future error instance carries extra fields.
  if (Number.isSafeInteger(error.details?.current_version) && error.details.current_version > 0) {
    body.current_version = error.details.current_version;
  }
  return body;
}

function bearerCredential(request) {
  const authorization = request.headers.get('Authorization');
  if (authorization === null) return { supplied: false, credential: null };
  // Treat any Bearer attempt as developer authentication, even when malformed.
  // It must never fall through to dashboard Basic/session auth or a query token.
  if (/^Bearer(?:\s|$)/i.test(authorization)) {
    const match = /^Bearer\s+([^\s]+)\s*$/i.exec(authorization);
    return { supplied: true, credential: match ? match[1] : null };
  }
  return { supplied: false, credential: null };
}

function requiredScope(method) {
  if (method === 'GET' || method === 'HEAD') return 'db:read';
  if (method === 'POST' || method === 'PATCH' || method === 'DELETE') return 'db:write';
  return null;
}

function developerApiKeysForContext(context) {
  // Internal test/composition seam only. Production obtains this service from
  // TELEGRAPH_CLOUD_KV and API_KEY_PEPPER for each request; it never accepts
  // caller input as service configuration.
  return context.data?.developerApiKeys || createDeveloperApiKeyService(context.env);
}

/**
 * Two explicitly separate modes share /api/db/*:
 *
 * - A `Bearer tg_live_…` header is verified as a developer API key and derives
 *   the project scope solely from the verified key.
 * - No Bearer attempt retains Phase 2 dashboard session/Basic behavior against
 *   the unscoped legacy namespace.
 *
 * A developer key is never a dashboard credential and this middleware is only
 * mounted under /api/db, never under the dashboard project-management routes.
 */
export async function databaseAuthentication(context) {
  const { request, env = {} } = context;
  const bearer = bearerCredential(request);

  if (bearer.supplied) {
    if (!bearer.credential) {
      throw new CloudUnauthorizedError('invalid_api_key', 'A valid developer API key is required.');
    }
    const authentication = await developerApiKeysForContext(context).authenticate(bearer.credential);
    const scope = requiredScope(request.method);
    if (scope && !authentication.scopes.includes(scope)) {
      throw new CloudForbiddenError('api_key_scope_forbidden', 'This API key does not have permission for this operation.');
    }
    context.data = context.data || {};
    context.data.databaseAuthentication = authentication;
    return context.next();
  }

  // Preserve the deployment-local Phase 2 dashboard boundary exactly for
  // requests that did not attempt Bearer developer authentication.
  if (isEmptyBinding(env.BASIC_USER) || isEmptyBinding(env.BASIC_PASS)) {
    return jsonResponse({ error: 'database_auth_not_configured' }, {
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
  // Retain this field for existing route/test integrations. The explicit mode
  // field below prevents a dashboard identity from being confused with a key.
  context.data.databaseSession = identity;
  context.data.databaseAuthentication = Object.freeze({
    authentication: 'dashboard_legacy',
    user: identity.user,
  });
  return context.next();
}

export async function databaseMutationRateLimit(context) {
  if (!['POST', 'PATCH', 'DELETE'].includes(context.request.method)) {
    return context.next();
  }
  const result = consumeMutationSlot(mutationBucketKey(context));
  if (result.allowed) return context.next();
  return jsonResponse({ error: 'rate_limited' }, {
    status: 429,
    headers: {
      'Cache-Control': 'no-store',
      'Retry-After': String(result.retryAfter),
    },
  });
}

export async function databaseErrorHandling(context) {
  try {
    return await context.next();
  } catch (error) {
    if (isTelegraphCloudError(error)) {
      return jsonResponse(databaseErrorBody(error), {
        status: error.status,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    // Never serialize a caught error: request URLs, Telegram endpoints, and
    // binding diagnostics can all carry sensitive data.
    console.error('Telegraph Cloud database request failed.');
    return jsonResponse({ error: 'internal_error' }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

export const onRequest = [databaseErrorHandling, databaseAuthentication, databaseMutationRateLimit];
