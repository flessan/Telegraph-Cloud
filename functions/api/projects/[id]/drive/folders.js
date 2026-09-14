import { readControlJson } from '../../../../cloud/control-http.js';
import { driveForContext, driveJsonResponse } from '../../../../cloud/drive-http.js';

// Explicit folder records make empty folders stable. Folders with content are
// already implied by object key prefixes and need no record.
export async function onRequest(context) {
  const { request } = context;
  const drive = driveForContext(context);

  if (request.method === 'POST') {
    const body = await readControlJson(request, { maxBytes: 8 * 1024 });
    const result = await drive.createFolder(body?.bucket, body?.prefix);
    return driveJsonResponse(result, { status: result.created ? 201 : 200 });
  }

  if (request.method === 'DELETE') {
    const url = new URL(request.url);
    const bucket = url.searchParams.get('bucket');
    const prefix = url.searchParams.get('prefix');
    const force = url.searchParams.get('force') === '1';
    const result = await drive.deleteFolder(bucket, prefix, { force });
    return driveJsonResponse(result);
  }

  return driveJsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'POST, DELETE' },
  });
}
