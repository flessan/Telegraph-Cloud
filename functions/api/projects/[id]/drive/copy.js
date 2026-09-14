import { readControlJson } from '../../../../cloud/control-http.js';
import { driveForContext, driveJsonResponse } from '../../../../cloud/drive-http.js';

// Rename, move, duplicate, and folder moves are one server-side copy within the
// same project (optionally deleting the source). The object engine stays the
// single source of truth; no byte-level duplication survives a move.
export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return driveJsonResponse({ error: 'method_not_allowed' }, {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }
  const body = await readControlJson(context.request, { maxBytes: 16 * 1024 });
  const result = await driveForContext(context).copyObject(body);
  return driveJsonResponse(result, { status: 200 });
}
