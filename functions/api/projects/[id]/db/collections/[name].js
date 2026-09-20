import { projectDatabaseForContext, driveJsonResponse } from '../../../../../cloud/drive-http.js';
import { readControlJson } from '../../../../../cloud/control-http.js';

// Dashboard-only per-collection management (get / patch / delete). The
// collection name comes from the path; the body of PATCH carries
// { description?, fields? } only. Sibling data routes ([collection]/) remain
// the record CRUD surface, so "collections" is reserved as the management
// namespace within a project's project-scoped API (the legacy unscoped
// /api/db surface is unaffected).
export async function onRequestGet(context) {
  const { projects, projectId, database } = projectDatabaseForContext(context);
  await projects.requireActiveProject(projectId);
  const definition = await database.getCollection(context.params.name);
  return driveJsonResponse(definition);
}

export async function onRequestPatch(context) {
  const { projects, projectId, database } = projectDatabaseForContext(context);
  await projects.requireActiveProject(projectId);
  const body = await readControlJson(context.request);
  const definition = await database.patchCollection(context.params.name, body);
  return driveJsonResponse(definition);
}

export async function onRequestDelete(context) {
  const { projects, projectId, database } = projectDatabaseForContext(context);
  await projects.requireActiveProject(projectId);
  const result = await database.deleteCollection(context.params.name);
  return driveJsonResponse(result);
}
