import { authenticateS3Request } from '../cloud/s3-auth.js';
import {
  S3ProtocolError,
  createS3RequestId,
  s3ErrorResponse,
  safeS3ResourceFromContext,
} from '../cloud/s3-protocol.js';

// This is intentionally a practical in-isolate burst guard, not billing,
// distributed quota enforcement, or a replacement for future S3 credentials.
const MUTATION_WINDOW_MS = 60 * 1000;
const MAX_MUTATIONS_PER_WINDOW = 20;
const mutationBuckets = new Map();

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

/** Establish one opaque request id before auth/error handling; no credentials are logged. */
export async function s3RequestContext(context) {
  context.data = context.data || {};
  context.data.s3RequestId = createS3RequestId();
  return context.next();
}

/**
 * The only Phase 6A authority path is server-configured project + existing
 * dashboard Basic/session authentication. Developer Bearer keys deliberately
 * do not become S3 credentials and no caller project hint is considered.
 */
export async function s3Authentication(context) {
  const authentication = await authenticateS3Request(context.request, context.env);
  context.data = context.data || {};
  context.data.s3Authentication = authentication;
  return context.next();
}

export async function s3MutationRateLimit(context) {
  if (!['PUT', 'DELETE'].includes(context.request.method)) return context.next();
  const projectId = context.data?.s3Authentication?.projectId;
  const result = consumeMutationSlot(typeof projectId === 'string' ? projectId : 'unknown');
  if (result.allowed) return context.next();
  return s3ErrorResponse(new S3ProtocolError('SlowDown', { retryAfter: result.retryAfter }), {
    requestId: context.data?.s3RequestId,
    resource: safeS3ResourceFromContext(context),
  });
}

/**
 * S3 has its own XML envelope and deliberately performs no console/Sentry
 * logging here. Request URLs, Basic/session headers, and future S3 signature
 * material must never be serialized or emitted to telemetry by this surface.
 */
export async function s3ErrorHandling(context) {
  try {
    return await context.next();
  } catch (error) {
    return s3ErrorResponse(error, {
      requestId: context.data?.s3RequestId,
      resource: safeS3ResourceFromContext(context),
    });
  }
}

export const onRequest = [s3ErrorHandling, s3RequestContext, s3Authentication, s3MutationRateLimit];
