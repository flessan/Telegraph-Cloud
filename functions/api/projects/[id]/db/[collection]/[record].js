import {
  assertDeleteBody,
  databaseResultResponse,
  expectedVersionForMutation,
  idempotencyKeyForRequest,
  patchBodyWithoutPrecondition,
  readDatabaseJson,
} from '../../../../../cloud/document-http.js';
import { projectDatabaseForContext } from '../../../../../cloud/drive-http.js';
import { jsonResponse } from '../../../../../utils/http.js';

// Dashboard-session, project-scoped single-document route. PATCH and DELETE
// keep the established optimistic-version precondition contract.
export async function onRequest(context) {
  const { request, params, env } = context;
  const { projects, projectId, database } = projectDatabaseForContext(context);
  await projects.requireActiveProject(projectId);
  const collection = params.collection;
  const recordId = params.record;

  if (request.method === 'GET') {
    return databaseResultResponse(await database.getDocument(collection, recordId));
  }

  if (request.method === 'PATCH') {
    const body = await readDatabaseJson(request, env);
    const expectedVersion = expectedVersionForMutation(request, body);
    return databaseResultResponse(await database.patchDocument(
      collection,
      recordId,
      patchBodyWithoutPrecondition(body),
      { expectedVersion, idempotencyKey: idempotencyKeyForRequest(request) },
    ));
  }

  if (request.method === 'DELETE') {
    const body = await readDatabaseJson(request, env, { allowEmpty: true });
    assertDeleteBody(body);
    const expectedVersion = expectedVersionForMutation(request, body);
    return databaseResultResponse(await database.deleteDocument(collection, recordId, {
      expectedVersion,
      idempotencyKey: idempotencyKeyForRequest(request),
    }));
  }

  return jsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET, PATCH, DELETE', 'Cache-Control': 'no-store' },
  });
}
