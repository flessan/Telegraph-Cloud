import { jsonResponse } from '../../../utils/http.js';
import {
  assertDeleteBody,
  databaseResultResponse,
  documentDatabaseForContext,
  expectedVersionForMutation,
  idempotencyKeyForRequest,
  patchBodyWithoutPrecondition,
  readDatabaseJson,
} from '../../../cloud/document-http.js';

export async function onRequest(context) {
  const { request, params, env } = context;
  const { collection, id } = params;

  if (request.method === 'GET') {
    const database = documentDatabaseForContext(context);
    return databaseResultResponse(await database.getDocument(collection, id));
  }

  if (request.method === 'PATCH') {
    const body = await readDatabaseJson(request, env);
    const expectedVersion = expectedVersionForMutation(request, body);
    const database = documentDatabaseForContext(context);
    return databaseResultResponse(await database.patchDocument(
      collection,
      id,
      patchBodyWithoutPrecondition(body),
      {
        expectedVersion,
        idempotencyKey: idempotencyKeyForRequest(request),
      },
    ));
  }

  if (request.method === 'DELETE') {
    const body = await readDatabaseJson(request, env, { allowEmpty: true });
    assertDeleteBody(body);
    const expectedVersion = expectedVersionForMutation(request, body);
    const database = documentDatabaseForContext(context);
    return databaseResultResponse(await database.deleteDocument(collection, id, {
      expectedVersion,
      idempotencyKey: idempotencyKeyForRequest(request),
    }));
  }

  return jsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: {
      Allow: 'GET, PATCH, DELETE',
      'Cache-Control': 'no-store',
    },
  });
}
