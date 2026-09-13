import { createS3CredentialService } from '../../../../cloud/s3-credentials.js';
import { jsonResponse } from '../../../../utils/http.js';

function credentialsForContext(context) {
  return context.data?.s3Credentials || createS3CredentialService(context.env, {
    projects: context.data?.projectRegistry,
  });
}

/** Dashboard-only revocation endpoint inherited from /api/projects/_middleware.js. */
export async function onRequest(context) {
  if (context.request.method === 'DELETE') {
    const credential = await credentialsForContext(context).revokeCredential(
      context.params.id,
      context.params.accessKeyId,
    );
    return jsonResponse(credential, {
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
