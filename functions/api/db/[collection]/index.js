import { jsonResponse } from '../../../utils/http.js';
import {
  databaseListResponse,
  databaseResultResponse,
  documentDatabaseForContext,
  idempotencyKeyForRequest,
  readDatabaseJson,
} from '../../../cloud/document-http.js';
import { parseDocumentListQuery } from '../../../cloud/document-database.js';

export async function onRequest(context) {
  const { request, params, env } = context;
  const collection = params.collection;

  if (request.method === 'GET') {
    const query = parseDocumentListQuery(new URL(request.url).searchParams, env);
    const database = documentDatabaseForContext(context);
    return databaseListResponse(await database.listDocuments(collection, query));
  }

  if (request.method === 'POST') {
    const body = await readDatabaseJson(request, env);
    const database = documentDatabaseForContext(context);
    const result = await database.createDocument(collection, body, {
      idempotencyKey: idempotencyKeyForRequest(request),
    });
    const recordId = result.body?.data?.id;
    return databaseResultResponse(result, {
      location: `${new URL(request.url).pathname.replace(/\/$/, '')}/${encodeURIComponent(recordId)}`,
    });
  }

  return jsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: {
      Allow: 'GET, POST',
      'Cache-Control': 'no-store',
    },
  });
}
