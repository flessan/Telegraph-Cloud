import { authenticateS3Request, requiredS3ScopeForMethod } from '../cloud/s3-auth.js';
import { createProjectRegistry } from '../cloud/project-registry.js';
import { createS3CredentialService } from '../cloud/s3-credentials.js';
import { S3ProtocolError } from '../cloud/s3-errors.js';
import {
  createS3RequestId,
  s3ErrorResponse,
  safeS3ResourceFromContext,
} from '../cloud/s3-protocol.js';

// This is intentionally a practical in-isolate burst guard, not billing,
// distributed quota enforcement, or a substitute for verified credentials.
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

function s3ServicesForContext(context) {
  // `context.data` is an internal composition/test seam only. Browser request
  // data never selects a credential service, project, or signing authority.
  const projects = context.data?.projectRegistry || createProjectRegistry(context.env);
  const credentials = context.data?.s3Credentials || createS3CredentialService(context.env, { projects });
  return { projects, credentials };
}

/** Establish one opaque request id before auth/error handling; no credentials are logged. */
export async function s3RequestContext(context) {
  context.data = context.data || {};
  context.data.s3RequestId = createS3RequestId();
  return context.next();
}

/** Verify header-form AWS SigV4 and derive project/scopes only from credential metadata. */
export async function s3Authentication(context) {
  context.data = context.data || {};
  const { projects, credentials } = s3ServicesForContext(context);
  const authentication = await authenticateS3Request(context.request, context.env, {
    projects,
    credentials,
  });
  context.data.s3Authentication = authentication;

  // Last-use information is intentionally non-authoritative. It is stored in a
  // separate record so an asynchronous usage write can never restore a revoked
  // primary credential. A failed marker is not allowed to fail a valid request.
  const usage = credentials.markUsed(authentication.accessKeyId).catch(() => {});
  if (typeof context.waitUntil === 'function') context.waitUntil(usage);
  return context.next();
}

/** Enforce the narrow read/write scopes only after a complete signature check. */
export async function s3ScopeAuthorization(context) {
  const requiredScope = requiredS3ScopeForMethod(context.request.method);
  if (!requiredScope) return context.next();
  const authentication = context.data?.s3Authentication;
  if (authentication?.authentication !== 's3_sigv4' || !Array.isArray(authentication.scopes)
    || !authentication.scopes.includes(requiredScope)) {
    throw new S3ProtocolError('AccessDenied');
  }
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
 * logging here. Request URLs and SigV4 Authorization material must never be
 * serialized or emitted to telemetry by this surface.
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

export const onRequest = [s3ErrorHandling, s3RequestContext, s3Authentication, s3ScopeAuthorization, s3MutationRateLimit];
