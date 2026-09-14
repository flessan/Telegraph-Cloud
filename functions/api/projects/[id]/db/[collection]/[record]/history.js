import { projectDatabaseForContext, driveJsonResponse } from '../../../../../../cloud/drive-http.js';

// Dashboard-session revision history for one project-scoped record.
export async function onRequestGet(context) {
  const { projects, projectId, database } = projectDatabaseForContext(context);
  await projects.requireActiveProject(projectId);
  const data = await database.listDocumentHistory(context.params.collection, context.params.record);
  return driveJsonResponse({ data });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return driveJsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET' },
  });
}
