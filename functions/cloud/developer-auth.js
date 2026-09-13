import { createDeveloperApiKeyService } from './developer-api-keys.js';
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

function developerApiKeysForContext(context) {
  // Internal composition/test seam only. Browser request data never selects a
  // service or a project; production resolves the service from environment
  // bindings and verifies the complete Bearer credential.
  return context?.data?.developerApiKeys || createDeveloperApiKeyService(context?.env);
}

/**
 * Authenticate an attempted Bearer request and enforce exactly one declared
 * developer scope. Returns null when no Bearer scheme was supplied, allowing a
 * caller such as the Phase 2/3 database middleware to retain its separate
 * dashboard-legacy mode. A storage route treats that null as 401 instead.
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
  const authentication = await developerApiKeysForContext(context).authenticate(bearer.credential);
  if (scope && !authentication.scopes.includes(scope)) {
    throw new CloudForbiddenError(forbiddenCode, forbiddenMessage);
  }
  return authentication;
}
