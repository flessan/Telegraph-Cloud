import {
  databaseListResponse,
  databaseResultResponse,
  idempotencyKeyForRequest,
  readDatabaseJson,
} from '../../../../../cloud/document-http.js';
import { parseDocumentListQuery } from '../../../../../cloud/document-database.js';
import { projectDatabaseForContext } from '../../../../../cloud/drive-http.js';
import { jsonResponse } from '../../../../../utils/http.js';

// Dashboard-session, project-scoped document collection route. The verified
// project comes from the path the projects middleware authenticated; the
// document provider is constructed with that trusted scope server-side.
export async function onRequest(context) {
  const { request, params, env } = context;
  const { projects, projectId, database } = projectDatabaseForContext(context);
  await projects.requireActiveProject(projectId);
  const collection = params.collection;

  if (request.method === 'GET') {
    const query = parseDocumentListQuery(new URL(request.url).searchParams, env);
    return databaseListResponse(await database.listDocuments(collection, query));
  }

  if (request.method === 'POST') {
    const body = await readDatabaseJson(request, env);
    const result = await database.createDocument(collection, body, {
      idempotencyKey: idempotencyKeyForRequest(request),
    });
    const recordId = result.body?.data?.id;
    return databaseResultResponse(result, {
      location: `/api/projects/${encodeURIComponent(projectId)}/db/${encodeURIComponent(collection)}/${encodeURIComponent(recordId)}`,
    });
  }

  return jsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET, POST', 'Cache-Control': 'no-store' },
  });
}
