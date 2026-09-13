import { readControlJson } from '../../cloud/control-http.js';
import { createProjectRegistry } from '../../cloud/project-registry.js';
import { jsonResponse } from '../../utils/http.js';

function projectsForContext(context) {
  return context.data?.projectRegistry || createProjectRegistry(context.env);
}

function response(body, init = {}) {
  return jsonResponse(body, {
    ...init,
    headers: { ...(init.headers || {}), 'Cache-Control': 'no-store' },
  });
}

export async function onRequest(context) {
  const { request, params } = context;

  if (request.method === 'GET') return response(await projectsForContext(context).getProject(params.id));
  if (request.method === 'PATCH') {
    return response(await projectsForContext(context).updateProject(params.id, await readControlJson(request)));
  }
  if (request.method === 'DELETE') return response(await projectsForContext(context).deleteProject(params.id));

  return response({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET, PATCH, DELETE' },
  });
}
