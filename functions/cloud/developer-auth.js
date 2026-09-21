import { createDeveloperApiKeyService } from './developer-api-keys.js';
import { createJwtAuthService, resolveJwtIssuer } from './jwt-auth.js';
import { CloudForbiddenError, CloudUnauthorizedError } from './errors.js';

/**
 * Parse only the standard Bearer authorization form. Callers deliberately do
 * not inspect URL parameters, cookies, or alternate API-key headers. A
 * malformed Bearer attempt is still considered an attempted developer login so
 * it cannot fall through to a different authentication mode.
 */
export function bearerDeveloperCredential(request) {
  const authorization = request?.headers?.get('Authorization');
  if (authorization === null || authorization === undefined) {
    return { supplied: false, credential: null };
  }
  if (/^Bearer(?:\s|$)/i.test(authorization)) {
    const match = /^Bearer\s+([^\s]+)\s*$/i.exec(authorization);
    return { supplied: true, credential: match ? match[1] : null };
  }
  return { supplied: false, credential: null };
}

// A compact JWS with three base64url segments. `tg_live_…` keys never contain
// a dot, so the two credential forms cannot be confused.
const JWT_COMPACT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function developerApiKeysForContext(context) {
  // Internal composition/test seam only. Browser request data never selects a
  // service or a project; production resolves the service from environment
  // bindings and verifies the complete Bearer credential.
  return context?.data?.developerApiKeys || createDeveloperApiKeyService(context?.env);
}

function jwtAuthForContext(context) {
  return context?.data?.jwtAuth || createJwtAuthService(context?.env);
}

function assertDeveloperScope(authentication, scope, forbiddenCode, forbiddenMessage) {
  if (scope && !authentication.scopes.includes(scope)) {
    throw new CloudForbiddenError(forbiddenCode, forbiddenMessage);
  }
  return authentication;
}

/**
 * Authenticate an attempted Bearer request and enforce exactly one declared
 * developer scope. Accepts two credential forms, verified independently:
 *
 *   - `tg_live_…` developer API keys (unchanged behavior), and
 *   - short-lived JWTs (ES256) issued by POST /api/auth/token, verified
 *     against the deployment's published signing keys with iss/aud/exp and
 *     the project + scopes claims.
 *
 * Returns null when no Bearer scheme was supplied, allowing a caller such as
 * the Phase 2/3 database middleware to retain its separate dashboard-legacy
 * mode. A storage route treats that null as 401 instead.
 */
export async function authenticateDeveloperBearer(context, {
  scope = null,
  forbiddenCode = 'api_key_scope_forbidden',
  forbiddenMessage = 'This API key does not have permission for this operation.',
} = {}) {
  const bearer = bearerDeveloperCredential(context?.request);
  if (!bearer.supplied) return null;
  if (!bearer.credential) {
    throw new CloudUnauthorizedError('invalid_api_key', 'A valid developer API key is required.');
  }

  if (JWT_COMPACT_SHAPE.test(bearer.credential)) {
    const issuer = resolveJwtIssuer(context?.env, context.request);
    const authentication = await jwtAuthForContext(context).verifyToken(bearer.credential, { issuer });
    return assertDeveloperScope(authentication, scope, forbiddenCode, forbiddenMessage);
  }

  const authentication = await developerApiKeysForContext(context).authenticate(bearer.credential);
  return assertDeveloperScope(authentication, scope, forbiddenCode, forbiddenMessage);
}
