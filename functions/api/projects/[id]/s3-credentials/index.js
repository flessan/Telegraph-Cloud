import { parseS3CredentialListQuery, readControlJson } from '../../../../cloud/control-http.js';
import { createS3CredentialService } from '../../../../cloud/s3-credentials.js';
import { jsonResponse } from '../../../../utils/http.js';

function credentialsForContext(context) {
  return context.data?.s3Credentials || createS3CredentialService(context.env, {
    projects: context.data?.projectRegistry,
  });
}

function response(body, init = {}) {
  return jsonResponse(body, {
    ...init,
    headers: { ...(init.headers || {}), 'Cache-Control': 'no-store' },
  });
}

/** Inherits dashboard-only /api/projects/_middleware.js; no bearer/S3 management path exists. */
export async function onRequest(context) {
  const { request, params } = context;
  const credentials = credentialsForContext(context);
  if (request.method === 'GET') {
    return response(await credentials.listCredentials(
      params.id,
      parseS3CredentialListQuery(new URL(request.url).searchParams),
    ));
  }
  if (request.method === 'POST') {
    const created = await credentials.createCredential(params.id, await readControlJson(request));
    return response(created, {
      status: 201,
      headers: {
        Location: `/api/projects/${encodeURIComponent(params.id)}/s3-credentials/${encodeURIComponent(created.credential.access_key_id)}`,
      },
    });
  }
  return response({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET, POST' },
  });
}
