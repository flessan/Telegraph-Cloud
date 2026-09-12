import { readControlJson } from '../../../../../cloud/control-http.js';
import { createDeveloperApiKeyService } from '../../../../../cloud/developer-api-keys.js';
import { jsonResponse } from '../../../../../utils/http.js';

function keysForContext(context) {
  return context.data?.developerApiKeys || createDeveloperApiKeyService(context.env);
}

export async function onRequest(context) {
  if (context.request.method === 'POST') {
    const replacement = await keysForContext(context).rotateKey(
      context.params.id,
      context.params.keyId,
      await readControlJson(context.request),
    );
    return jsonResponse(replacement, {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  return jsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: {
      Allow: 'POST',
      'Cache-Control': 'no-store',
    },
  });
}
