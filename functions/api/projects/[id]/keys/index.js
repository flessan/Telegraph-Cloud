import { parseApiKeyListQuery, readControlJson } from '../../../../cloud/control-http.js';
import { createDeveloperApiKeyService } from '../../../../cloud/developer-api-keys.js';
import { jsonResponse } from '../../../../utils/http.js';

function keysForContext(context) {
  return context.data?.developerApiKeys || createDeveloperApiKeyService(context.env);
}

function response(body, init = {}) {
  return jsonResponse(body, {
    ...init,
    headers: { ...(init.headers || {}), 'Cache-Control': 'no-store' },
  });
}

export async function onRequest(context) {
  const { request, params } = context;

  if (request.method === 'GET') {
    return response(await keysForContext(context).listKeys(params.id, parseApiKeyListQuery(new URL(request.url).searchParams)));
  }
  if (request.method === 'POST') {
    const created = await keysForContext(context).createKey(params.id, await readControlJson(request));
    return response(created, {
      status: 201,
      headers: { Location: `/api/projects/${encodeURIComponent(params.id)}/keys/${encodeURIComponent(created.key.key_id)}` },
    });
  }
  return response({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET, POST' },
  });
}
