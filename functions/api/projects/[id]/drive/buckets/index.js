import { driveForContext, driveJsonResponse } from '../../../../../cloud/drive-http.js';
import { CloudValidationError } from '../../../../../cloud/errors.js';

// Dashboard-only Drive bucket administration. Inherits the dashboard session
// middleware from /api/projects; the drive service re-verifies the path project
// against the registry and never trusts a client-supplied project selector.
export async function onRequest(context) {
  const { request } = context;
  const drive = driveForContext(context);

  if (request.method === 'GET') {
    const url = new URL(request.url);
    const limit = url.searchParams.get('limit') || undefined;
    return driveJsonResponse(await drive.listBuckets(limit === undefined ? {} : { limit: Number(limit) }));
  }

  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch (_) {
      throw new CloudValidationError('malformed_json', 'Request body must be valid JSON.');
    }
    const name = body?.name;
    if (typeof name !== 'string' || !name) {
      throw new CloudValidationError('invalid_bucket_name', 'Bucket name is required.');
    }
    const result = await drive.createBucket(name);
    return driveJsonResponse(result, { status: result.created ? 201 : 200 });
  }

  return driveJsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET, POST' },
  });
}
