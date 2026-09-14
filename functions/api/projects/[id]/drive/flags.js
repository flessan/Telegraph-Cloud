import { readControlJson } from '../../../../cloud/control-http.js';
import { driveForContext, driveJsonResponse } from '../../../../cloud/drive-http.js';
import { CloudValidationError } from '../../../../cloud/errors.js';

// Star / trash presentation state. Single object body:
// { bucket, key, starred?: bool, trashed?: bool }
// Bulk body: { items: [{bucket, key}], patch: {starred?, trashed?} }
export async function onRequest(context) {
  if (context.request.method !== 'PATCH' && context.request.method !== 'POST') {
    return driveJsonResponse({ error: 'method_not_allowed' }, {
      status: 405,
      headers: { Allow: 'PATCH, POST' },
    });
  }
  const body = await readControlJson(context.request, { maxBytes: 64 * 1024 });
  const drive = driveForContext(context);
  if (Array.isArray(body?.items)) {
    const patch = body.patch;
    if (!patch || typeof patch !== 'object') {
      throw new CloudValidationError('invalid_drive_flags', 'A flag patch object is required.');
    }
    return driveJsonResponse(await drive.bulkSetFlags(body.items, patch));
  }
  const { bucket, key, starred, trashed } = body || {};
  const patch = {};
  if (starred !== undefined) patch.starred = starred;
  if (trashed !== undefined) patch.trashed = trashed;
  if (typeof bucket !== 'string' || typeof key !== 'string' || Object.keys(patch).length === 0) {
    throw new CloudValidationError('invalid_drive_flags', 'bucket, key and at least one flag are required.');
  }
  return driveJsonResponse(await drive.setFlags(bucket, key, patch));
}
