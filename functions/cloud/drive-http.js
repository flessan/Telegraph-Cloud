import { createDriveService } from './drive-service.js';
import { createProjectRegistry } from './project-registry.js';
import { createTelegramObjectStorage } from './object-storage.js';
import { createDriveStateService } from './drive-state.js';
import { createTelegramDocumentDatabase } from './document-database.js';
import { isTelegraphCloudError } from './errors.js';
import { jsonResponse } from '../utils/http.js';

const noStoreHeaders = () => ({ 'Cache-Control': 'private, no-store', 'Vary': 'Authorization' });

export function driveForContext(context) {
  // context.data is trusted server-side composition state (never request
  // input); tests and alternative bindings can pre-build the project-bound
  // service there. Production requests construct it from env and the path id.
  if (context.data?.drive) return context.data.drive;
  const projectId = context.params.id;
  const projects = context.data?.projectRegistry || createProjectRegistry(context.env);
  const storage = createTelegramObjectStorage(context.env, { projectId });
  const state = createDriveStateService(context.env);
  return createDriveService(context.env, { projectId, storage, state, projects });
}

export function projectDatabaseForContext(context) {
  const projectId = context.params.id;
  const projects = context.data?.projectRegistry || createProjectRegistry(context.env);
  const database = context.data?.projectDatabase
    || createTelegramDocumentDatabase(context.env, { projectId });
  return { projectId, projects, database };
}

export function driveJsonResponse(body, init = {}) {
  return jsonResponse(body, {
    ...init,
    headers: { ...noStoreHeaders(), ...(init.headers || {}) },
  });
}

export async function withDriveErrorHandling(handler) {
  try {
    return await handler();
  } catch (error) {
    if (isTelegraphCloudError(error)) {
      return jsonResponse({ error: error.code }, {
        status: error.status,
        headers: noStoreHeaders(),
      });
    }
    console.error('Telegraph Cloud drive request failed.');
    return jsonResponse({ error: 'internal_error' }, {
      status: 500,
      headers: noStoreHeaders(),
    });
  }
}
