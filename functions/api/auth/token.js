import { authenticateDeveloperBearer } from '../../cloud/developer-auth.js';
import { createJwtAuthService, resolveJwtIssuer } from '../../cloud/jwt-auth.js';
import { isTelegraphCloudError } from '../../cloud/errors.js';
import { jsonResponse } from '../../utils/http.js';

// Exchange a verified developer credential (API key today, or an unexpired
// JWT) for a short-lived ES256 JWT. The token inherits the credential's
// project scope and scopes — a token can never exceed the authority of the
// credential used to obtain it. The request body is optional and may only
// shorten (within bounds) the lifetime.
export async function onRequestPost(context) {
  const { request, env = {} } = context;
  try {
    const authentication = await authenticateDeveloperBearer(context, {});
    if (!authentication) {
      return jsonResponse({ error: 'invalid_api_key' }, {
        status: 401,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    let expiresIn;
    const contentType = request.headers.get('Content-Type') || '';
    if (contentType.includes('application/json')) {
      const text = await request.text();
      if (text.trim()) {
        let body;
        try {
          body = JSON.parse(text);
        } catch (_) {
          return jsonResponse({ error: 'malformed_json' }, {
            status: 400,
            headers: { 'Cache-Control': 'no-store' },
          });
        }
        if (body && typeof body === 'object' && !Array.isArray(body)) {
          if (body.expires_in !== undefined) expiresIn = body.expires_in;
          const unknown = Object.keys(body).filter((key) => key !== 'expires_in');
          if (unknown.length > 0) {
            return jsonResponse({ error: 'invalid_token_request' }, {
              status: 400,
              headers: { 'Cache-Control': 'no-store' },
            });
          }
        }
      }
    }

    // Internal composition/test seam: a prebuilt service (fixed clock in
    // tests) or the production service over the deployment KV binding.
    const jwtAuth = context?.data?.jwtAuth || createJwtAuthService(env);
    const issuer = resolveJwtIssuer(env, request);
    const token = await jwtAuth.issueToken({
      project_id: authentication.project_id,
      key_id: authentication.key_id,
      scopes: authentication.scopes,
      issuer,
      expiresIn,
    });
    return jsonResponse(token, {
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
    console.error('Telegraph Cloud token exchange failed.');
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
