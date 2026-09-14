import { projectDatabaseForContext, driveJsonResponse } from '../../../../cloud/drive-http.js';

// Dashboard-only collection discovery for the project-scoped Database console.
// The legacy unscoped /api/db surface remains unchanged; this route is always
// scoped to the path project after registry verification.
export async function onRequestGet(context) {
  const { projects, projectId, database } = projectDatabaseForContext(context);
  await projects.requireActiveProject(projectId);
  const url = new URL(context.request.url);
  const maxKeys = url.searchParams.get('maxKeys');
  const result = await database.listCollections(maxKeys === null ? {} : { maxKeys: Number(maxKeys) });
  return driveJsonResponse(result);
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return driveJsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET' },
  });
}
