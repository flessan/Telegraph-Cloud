import { readControlJson } from '../../../../cloud/control-http.js';
import { createObjectIndexRepairService } from '../../../../cloud/object-index-repair.js';
import { createProjectRegistry } from '../../../../cloud/project-registry.js';
import { jsonResponse } from '../../../../utils/http.js';

function projectsForContext(context) {
  return context.data?.projectRegistry || createProjectRegistry(context.env);
}

function response(body, init = {}) {
  return jsonResponse(body, {
    ...init,
    headers: { ...(init.headers || {}), 'Cache-Control': 'no-store' },
  });
}

/**
 * This route inherits /api/projects/_middleware.js. It is intentionally a
 * dashboard/operator maintenance action, never a developer-key storage route.
 */
export async function onRequest(context) {
  if (context.request.method !== 'POST') {
    return response({ error: 'method_not_allowed' }, {
      status: 405,
      headers: { Allow: 'POST' },
    });
  }

  // Dashboard administrators may repair active or disabled projects, but a
  // logically deleted project remains unavailable just like other management
  // routes. The path project is the sole maintenance scope selector.
  await projectsForContext(context).getProject(context.params.id);
  const service = createObjectIndexRepairService(context.env, { projectId: context.params.id });
  const result = await service.run(await readControlJson(context.request, { maxBytes: 16 * 1024 }));
  return response(result);
}
