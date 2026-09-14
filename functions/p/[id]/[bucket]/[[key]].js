import { driveForContext, withDriveErrorHandling } from '../../../cloud/drive-http.js';
import { objectBytesResponse } from '../../../cloud/object-bytes-response.js';
import { decodeRouteSegment, objectReadConditions } from '../../../cloud/object-request-input.js';

// Public, unauthenticated direct links for Drive objects:
//   GET/HEAD /p/:projectId/:bucket/*key
//
// This is the small public-delivery surface behind the console's Direct URL /
// Markdown / HTML / BBCode / CSS snippets. It deliberately exposes only
// read-only byte delivery of ACTIVE projects:
//   * only GET/HEAD (no listing, no mutation, no metadata JSON);
//   * the project id (22 random base64url characters) plus bucket and key form
//     an unlisted link in the same spirit as the legacy /file/:id route;
//   * trashed objects stop being served, so trashing revokes a direct link;
//   * no internal pointers, revisions, or messages are ever returned.
function notFound() {
  return new Response(JSON.stringify({ error: 'object_not_found' }), {
    status: 404,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  });
}

export async function onRequest(context) {
  const { request, params } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'Cache-Control': 'private, no-store' },
    });
  }
  const url = new URL(request.url);
  const bucket = decodeRouteSegment(params.bucket);
  const key = params.key === undefined || params.key === '' ? '' : decodeRouteSegment(params.key);
  if (bucket === null || key === null) return notFound();
  if (!bucket || !key) return notFound();
  return withDriveErrorHandling(async () => {
    const drive = driveForContext(context);
    // A trashed object is privately retained for restore, but its public
    // direct link must stop resolving immediately.
    const head = await drive.headObject(bucket, key);
    if (head.object?.flags?.trashed) {
      return new Response(JSON.stringify({ error: 'object_not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
      });
    }
    const result = await drive.getObject(bucket, key, objectReadConditions(request));
    return objectBytesResponse(result, {
      key,
      download: url.searchParams.get('download') === '1',
      publicView: true,
    });
  });
}
