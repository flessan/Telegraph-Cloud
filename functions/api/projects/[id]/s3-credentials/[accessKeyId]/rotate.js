import { readControlJson } from '../../../../../cloud/control-http.js';
import { createS3CredentialService } from '../../../../../cloud/s3-credentials.js';
import { jsonResponse } from '../../../../../utils/http.js';

function credentialsForContext(context) {
  return context.data?.s3Credentials || createS3CredentialService(context.env, {
    projects: context.data?.projectRegistry,
  });
}

/** Dashboard-only one-time replacement secret endpoint. */
export async function onRequest(context) {
  if (context.request.method === 'POST') {
    const replacement = await credentialsForContext(context).rotateCredential(
      context.params.id,
      context.params.accessKeyId,
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
