import { isTelegraphCloudError } from '../../cloud/errors.js';
import { isEmptyBinding, jsonResponse } from '../../utils/http.js';
import { authenticateRequest } from '../../utils/session.js';

// This is deliberately a small in-isolate guard rather than an invented
// distributed quota service. Database mutations send Telegram documents, so it
// reduces accidental owner-side bursts and gives Telegram a second safety net.
// The API remains owner-authenticated; a future project/key system should use
// a durable per-project rate-limit backend.
const MUTATION_WINDOW_MS = 60 * 1000;
const MAX_MUTATIONS_PER_WINDOW = 20;
const mutationBuckets = new Map();

function mutationBucketKey(context) {
  const identity = context.data?.databaseSession;
  return typeof identity?.user === 'string' && identity.user ? identity.user : 'owner';
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
  // Bound memory even if a long-lived isolate sees many distinct authenticated
  // identities. Evicting the oldest bucket is safe because this is only a
  // best-effort guard, not the authoritative permission boundary.
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

/**
 * The database is not a public developer API yet. It fails closed until both
 * existing dashboard Basic credentials are configured, then accepts the same
 * HMAC dashboard session or Basic fallback used by /api/manage/*. Phase 3 will
 * replace this boundary with project/API-key authorization.
 */
export async function databaseAuthentication(context) {
  const { request, env = {} } = context;
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
  context.data.databaseSession = identity;
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
