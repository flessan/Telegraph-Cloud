import { buildOpenApiDocument } from './cloud/openapi.js';
import { jsonResponse } from './utils/http.js';

// Public machine-readable API description. Generated from the actual
// supported surface (functions/cloud/openapi.js); see the accuracy test for
// the documented-path-to-function-file mapping.
export function onRequest(context) {
  const url = new URL(context.request.url);
  const origin = `${url.protocol}//${url.host}`;
  const document = buildOpenApiDocument({ origin });
  return jsonResponse(document, {
    headers: {
      'Cache-Control': 'public, max-age=300',
      'Content-Type': 'application/openapi+json; charset=utf-8',
    },
  });
}
