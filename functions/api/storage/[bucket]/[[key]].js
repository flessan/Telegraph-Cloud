import {
  ensureRangeIsNotRequested,
  methodNotAllowedResponse,
  objectDeleteResponse,
  objectLocationFromContext,
  objectPutInput,
  objectPutResponse,
  objectReadConditions,
  objectReadResponse,
  objectStorageForContext,
  objectWriteInput,
} from '../../../cloud/object-http.js';

// Project scope is captured by objectStorageForContext from the verified Bearer
// key. This route intentionally never reads project_id from a path, query, or
// request body.
export async function onRequest(context) {
  const { request } = context;
  const storage = objectStorageForContext(context);
  const { bucket, key } = objectLocationFromContext(context);

  if (request.method === 'PUT') {
    const result = await storage.putObject(bucket, key, await objectPutInput(request, context.env));
    return objectPutResponse(result);
  }

  if (request.method === 'GET') {
    ensureRangeIsNotRequested(request);
    const result = await storage.getObject(bucket, key, objectReadConditions(request));
    return objectReadResponse(result, { method: 'GET' });
  }

  if (request.method === 'HEAD') {
    ensureRangeIsNotRequested(request);
    const result = await storage.headObject(bucket, key, objectReadConditions(request));
    return objectReadResponse(result, { method: 'HEAD' });
  }

  if (request.method === 'DELETE') {
    const result = await storage.deleteObject(bucket, key, objectWriteInput(request));
    return objectDeleteResponse(result);
  }

  return methodNotAllowedResponse();
}
