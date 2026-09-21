import { createJwtAuthService } from '../../../cloud/jwt-auth.js';
import { isTelegraphCloudError } from '../../../cloud/errors.js';
import { isEmptyBinding, jsonResponse } from '../../../utils/http.js';
import { authenticateRequest } from '../../../utils/session.js';

// Rotate the deployment's JWT signing keys (dashboard operation). The current
// key becomes retired for verification of outstanding tokens, its private
// material is purged immediately, and a fresh key signs new tokens. The
// response carries only key ids — never key material.
export async function onRequestPost(context) {
  const { request, env = {} } = context;
  try {
    if (isEmptyBinding(env.BASIC_USER) || isEmptyBinding(env.BASIC_PASS)) {
      return jsonResponse({ error: 'dashboard_auth_not_configured' }, {
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
    const jwt = createJwtAuthService(env);
    const result = await jwt.rotateSigningKeys();
    return jsonResponse(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (isTelegraphCloudError(error)) {
      return jsonResponse({ error: error.code }, {
        status: error.status,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    console.error('Telegraph Cloud JWT key rotation failed.');
    return jsonResponse({ error: 'internal_error' }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

export async function onRequest(context) {
  if (context.request.method === 'POST') return onRequestPost(context);
  return jsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
  });
}
