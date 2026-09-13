import { createDeveloperApiKeyService } from '../../../../cloud/developer-api-keys.js';
import { jsonResponse } from '../../../../utils/http.js';

function keysForContext(context) {
  return context.data?.developerApiKeys || createDeveloperApiKeyService(context.env);
}

export async function onRequest(context) {
  if (context.request.method === 'DELETE') {
    const key = await keysForContext(context).revokeKey(context.params.id, context.params.keyId);
    return jsonResponse(key, {
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  return jsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: {
      Allow: 'DELETE',
      'Cache-Control': 'no-store',
    },
  });
}
