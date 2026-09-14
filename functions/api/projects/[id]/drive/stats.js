import { driveForContext, driveJsonResponse } from '../../../../cloud/drive-http.js';

// Bounded, truthful project storage numbers for the project overview.
export async function onRequestGet(context) {
  return driveJsonResponse(await driveForContext(context).stats());
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return driveJsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET' },
  });
}
