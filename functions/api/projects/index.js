import { readControlJson, parseProjectListQuery } from '../../cloud/control-http.js';
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
  const { request } = context;

  if (request.method === 'GET') {
    return response(await projectsForContext(context).listProjects(parseProjectListQuery(new URL(request.url).searchParams)));
  }
  if (request.method === 'POST') {
    const project = await projectsForContext(context).createProject(await readControlJson(request));
    return response(project, {
      status: 201,
      headers: { Location: `/api/projects/${encodeURIComponent(project.project_id)}` },
    });
  }
  return response({ error: 'method_not_allowed' }, {
    status: 405,
    headers: { Allow: 'GET, POST' },
  });
}
