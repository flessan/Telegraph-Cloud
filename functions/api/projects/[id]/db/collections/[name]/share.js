import { projectDatabaseForContext, driveJsonResponse } from '../../../../../../cloud/drive-http.js';
import { createPublicCollectionShareService } from '../../../../../../cloud/public-collection-share.js';
import { readControlJson } from '../../../../../../cloud/control-http.js';

function sharesForContext(context) {
  return context.data?.publicCollectionShares || createPublicCollectionShareService(context.env);
}

function originFor(request) {
  const url = new URL(request.url);
  return url.protocol + '//' + url.host;
}

function bodyIsValid(body) {
  if (body === undefined || body === null) return true;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const keys = Object.keys(body);
  return keys.every((key) => key === 'force')
    && (body.force === undefined || body.force === true);
}

export async function onRequestGet(context) {
  const { projects, projectId } = projectDatabaseForContext(context);
  await projects.requireActiveProject(projectId);
  const current = await sharesForContext(context).getStatus({
    projectId,
    collection: context.params.name,
    origin: originFor(context.request),
  });
  return driveJsonResponse({ published: Boolean(current), ...(current || {}) });
}

export async function onRequestPost(context) {
  const { projects, projectId, database } = projectDatabaseForContext(context);
  await projects.requireActiveProject(projectId);
  const collection = context.params.name;
  await database.getCollection(collection);
  const body = await readControlJson(context.request, { allowEmpty: true });
  if (!bodyIsValid(body)) {
    return driveJsonResponse({ error: 'invalid_public_share_request' }, { status: 400 });
  }

  const shares = sharesForContext(context);
  if (body?.force === true) {
    try { await shares.revoke({ projectId, collection }); } catch (error) {
      if (error.code !== 'public_share_not_found') throw error;
    }
  }

  const result = await shares.publish({
    projectId,
    collection,
    createdBy: context.data?.projectSession?.user || 'dashboard',
    origin: originFor(context.request),
  });
  return driveJsonResponse(result, { status: 201 });
}

export async function onRequestDelete(context) {
  const { projects, projectId } = projectDatabaseForContext(context);
  await projects.requireActiveProject(projectId);
  return driveJsonResponse(await sharesForContext(context).revoke({
    projectId,
    collection: context.params.name,
  }));
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  if (context.request.method === 'POST') return onRequestPost(context);
  if (context.request.method === 'DELETE') return onRequestDelete(context);
  return driveJsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET, POST, DELETE' },
  });
}
