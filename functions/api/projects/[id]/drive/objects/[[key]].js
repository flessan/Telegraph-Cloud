import { readBoundedObjectBody } from '../../../../../cloud/bounded-body.js';
import { driveForContext, driveJsonResponse } from '../../../../../cloud/drive-http.js';
import { resolveObjectStorageLimits } from '../../../../../cloud/object-limits.js';
import { decodeRouteSegment, objectReadConditions } from '../../../../../cloud/object-request-input.js';
import { CloudValidationError } from '../../../../../cloud/errors.js';
import { objectBytesResponse } from '../../../../../cloud/object-bytes-response.js';

export async function onRequest(context) {
  const { request, params } = context;
  const drive = driveForContext(context);
  const url = new URL(request.url);
  const bucket = url.searchParams.get('bucket');
  const key = params.key === undefined || params.key === '' ? '' : decodeRouteSegment(params.key);

  // Malformed percent encoding or an encoded path separator is a client error
  // rather than a missing object.
  if (key === null) {
    return driveJsonResponse({ error: 'invalid_object_key' }, { status: 400 });
  }

  // Collection-style listing (and special views) live at the collection root.
  if (!key) {
    if (request.method !== 'GET') {
      return driveJsonResponse({ error: 'method_not_allowed' }, { status: 405, headers: { Allow: 'GET' } });
    }
    const query = { bucket, prefix: url.searchParams.get('prefix') || '' };
    if (url.searchParams.get('cursor')) query.cursor = url.searchParams.get('cursor');
    if (url.searchParams.get('limit')) query.limit = url.searchParams.get('limit');
    if (url.searchParams.get('view')) query.view = url.searchParams.get('view');
    if (url.searchParams.get('search') !== null) query.search = url.searchParams.get('search') || '';
    return driveJsonResponse(await drive.listObjects(query));
  }

  if (request.method === 'HEAD') {
    const result = await drive.getObject(bucket, key, objectReadConditions(request));
    return objectBytesResponse(result, { key, download: false, publicView: false });
  }

  if (request.method === 'GET') {
    if (url.searchParams.get('meta') === '1') {
      return driveJsonResponse(await drive.headObject(bucket, key));
    }
    const result = await drive.getObject(bucket, key, objectReadConditions(request));
    return objectBytesResponse(result, {
      key,
      download: url.searchParams.get('download') === '1',
      publicView: false,
    });
  }

  if (request.method === 'PUT') {
    const limits = resolveObjectStorageLimits(context.env);
    const body = await readBoundedObjectBody(request, { maxObjectBytes: limits.maxObjectBytes });
    const result = await drive.putObject(bucket, key, {
      body,
      contentType: request.headers.get('Content-Type'),
    });
    return driveJsonResponse(result, { status: 200 });
  }

  if (request.method === 'DELETE') {
    const result = await drive.deleteObject(bucket, key);
    return driveJsonResponse({ data: result.deletion }, { status: 200 });
  }

  return driveJsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET, HEAD, PUT, DELETE' },
  });
}
