import { CloudRequestError } from '../../../cloud/errors.js';
import { createProjectRegistry } from '../../../cloud/project-registry.js';
import { createPublicCollectionShareService } from '../../../cloud/public-collection-share.js';
import { documentDatabaseForContext } from '../../../cloud/document-http.js';
import { driveJsonResponse } from '../../../cloud/drive-http.js';
import { readControlJson } from '../../../cloud/control-http.js';

function developerProjectId(context) {
  const authentication = context.data?.databaseAuthentication;
  if (!['developer_api_key', 'jwt'].includes(authentication?.authentication)
    || typeof authentication.project_id !== 'string') {
    throw new CloudRequestError(
      'developer_auth_required',
      'Public collection publishing requires developer project authentication.',
      { status: 403 },
    );
  }
  return authentication.project_id;
}

function shareService(context) {
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

function projectRegistry(context) {
  return context.data?.projectRegistry || createProjectRegistry(context.env);
}

async function assertProjectAndCollection(context) {
  const projectId = developerProjectId(context);
  await projectRegistry(context).requireActiveProject(projectId);
  const database = documentDatabaseForContext(context);
  await database.getCollection(context.params.collection);
  return { projectId, database };
}

export async function onRequestGet(context) {
  const { projectId } = await assertProjectAndCollection(context);
  const current = await shareService(context).getStatus({
    projectId,
    collection: context.params.collection,
    origin: originFor(context.request),
  });
  return driveJsonResponse({ published: Boolean(current), ...(current || {}) });
}

export async function onRequestPost(context) {
  const { projectId } = await assertProjectAndCollection(context);
  const body = await readControlJson(context.request, { allowEmpty: true });
  if (!bodyIsValid(body)) {
    return driveJsonResponse({ error: 'invalid_public_share_request' }, { status: 400 });
  }

  const shares = shareService(context);
  if (body?.force === true) {
    try { await shares.revoke({ projectId, collection: context.params.collection }); } catch (error) {
      if (error.code !== 'public_share_not_found') throw error;
    }
  }

  const result = await shares.publish({
    projectId,
    collection: context.params.collection,
    createdBy: context.data?.databaseAuthentication?.key_id || 'developer-api',
    origin: originFor(context.request),
  });
  return driveJsonResponse(result, { status: 201 });
}

export async function onRequestDelete(context) {
  const { projectId } = await assertProjectAndCollection(context);
  return driveJsonResponse(await shareService(context).revoke({
    projectId,
    collection: context.params.collection,
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
