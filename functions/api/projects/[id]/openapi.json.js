import { buildOpenApiDocument } from '../../../cloud/openapi.js';
import { projectDatabaseForContext } from '../../../cloud/drive-http.js';
import { driveJsonResponse } from '../../../cloud/drive-http.js';

// Project-aware OpenAPI document (dashboard session). Adds x-project and
// x-collections, with example request bodies derived from the project's
// stored collection schemas. The project comes from the path the projects
// middleware authenticated — never from the request body.
export async function onRequest(context) {
  const { projects, projectId, database } = projectDatabaseForContext(context);
  await projects.requireActiveProject(projectId);
  const page = await database.listCollections({ maxKeys: 1000 });
  const url = new URL(context.request.url);
  const origin = `${url.protocol}//${url.host}`;
  const document = buildOpenApiDocument({
    origin,
    project: { project_id: projectId, collections: page.data },
  });
  return driveJsonResponse(document);
}
