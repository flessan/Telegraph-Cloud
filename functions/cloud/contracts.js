import { CloudConfigurationError } from './errors.js';

// These are service boundaries, not provider implementations. Phase 2 supplies
// a document adapter and Phase 4 supplies a Telegram object adapter. Both keep
// Telegram details out of HTTP handlers.
export const DOCUMENT_DATABASE_METHODS = Object.freeze([
  'createDocument',
  'getDocument',
  'listDocuments',
  'patchDocument',
  'deleteDocument',
  'listDocumentHistory',
]);

export const OBJECT_STORAGE_METHODS = Object.freeze([
  'putObject',
  'getObject',
  'headObject',
  'deleteObject',
  'listObjects',
]);

function assertAdapter(adapter, methods, name) {
  if (!adapter || typeof adapter !== 'object') {
    throw new CloudConfigurationError('cloud_adapter_unavailable', `${name} adapter is not configured.`);
  }
  for (const method of methods) {
    if (typeof adapter[method] !== 'function') {
      throw new CloudConfigurationError('cloud_adapter_incomplete', `${name} adapter is incomplete.`);
    }
  }
  return adapter;
}

/**
 * Gives database HTTP handlers one stable dependency. The wrapper is
 * deliberately thin: validation, versioning, journal/outbox sequencing, and
 * public response shaping remain in the concrete Phase 2 adapter/service.
 */
export function createDocumentDatabaseService(adapter) {
  const implementation = assertAdapter(adapter, DOCUMENT_DATABASE_METHODS, 'Document database');
  return Object.freeze({
    createDocument: (...args) => implementation.createDocument(...args),
    getDocument: (...args) => implementation.getDocument(...args),
    listDocuments: (...args) => implementation.listDocuments(...args),
    patchDocument: (...args) => implementation.patchDocument(...args),
    deleteDocument: (...args) => implementation.deleteDocument(...args),
    listDocumentHistory: (...args) => implementation.listDocumentHistory(...args),
  });
}

/**
 * Gives future storage HTTP handlers a provider-neutral object API. Legacy
 * `functions/storage/*` remains intentionally separate because it serves the
 * existing generated-id media upload and `/file/*` compatibility contract.
 */
export function createObjectStorageService(adapter) {
  const implementation = assertAdapter(adapter, OBJECT_STORAGE_METHODS, 'Object storage');
  return Object.freeze({
    putObject: (...args) => implementation.putObject(...args),
    getObject: (...args) => implementation.getObject(...args),
    headObject: (...args) => implementation.headObject(...args),
    deleteObject: (...args) => implementation.deleteObject(...args),
    listObjects: (...args) => implementation.listObjects(...args),
  });
}
