import { createJwtAuthService } from '../cloud/jwt-auth.js';
import { jsonResponse } from '../utils/http.js';

// Public JSON Web Key Set for verifying Telegraph Cloud access tokens.
// Exposes public members only (kty/crv/x/y plus kid/alg/use/key_ops) for the
// current and recently rotated signing keys; private key material never
// leaves the signing service. Public and cacheable.
export async function onRequestGet(context) {
  const jwt = createJwtAuthService(context.env);
  try {
    const jwks = await jwt.publicJwks();
    return jsonResponse(jwks, {
      headers: { 'Cache-Control': 'public, max-age=300' },
    });
  } catch (_) {
    // Fail closed without leaking configuration diagnostics. An empty set
    // simply means "no published keys yet".
    return jsonResponse({ keys: [] }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

export async function onRequest(context) {
  if (context.request.method === 'GET' || context.request.method === 'HEAD') {
    return onRequestGet(context);
  }
  return jsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' },
  });
}
