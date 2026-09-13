import {
  CloudAdapterError,
  CloudConfigurationError,
  CloudConflictError,
  CloudForbiddenError,
  CloudNotFoundError,
  CloudValidationError,
  isTelegraphCloudError,
} from './errors.js';
import { createCloudIndexStore } from './index-store.js';
import {
  CLOUD_LIMITS,
  assertProjectId,
  assertProjectName,
  assertProjectSlug,
  serializeJsonDocument,
  utf8ByteLength,
} from './validation.js';

// Project records are control-plane metadata. Unlike immutable document
// revisions, they intentionally live in the dedicated Cloud KV namespace and
// never contain Telegram pointers, bot credentials, or developer key secrets.
export const PROJECT_SCHEMA = 'telegraph-cloud.project.v1';
export const PROJECT_SLUG_INDEX_SCHEMA = 'telegraph-cloud.project-slug.v1';
export const PROJECT_INDEX_NAMESPACES = Object.freeze({
  project: 'project',
  slug: 'project-slug',
});

const PROJECT_STATUSES = new Set(['active', 'disabled', 'deleted']);
const LIST_LIMIT = 100;
const encoder = new TextEncoder();

function plainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function safeTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function toIsoTimestamp(clock) {
  const value = typeof clock === 'function' ? clock() : new Date();
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (!safeTimestamp(timestamp)) {
    throw new CloudConfigurationError('invalid_project_clock', 'Project clock configuration is invalid.');
  }
  return timestamp;
}

function bytesToBase64url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function defaultCreateId(prefix) {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}${bytesToBase64url(bytes)}`;
}

function normalizeControlPayload(value) {
  return serializeJsonDocument(value, { maxBytes: 8 * 1024 }).value;
}

function rejectUnknownFields(value, allowed, code = 'invalid_project_payload') {
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      throw new CloudValidationError(code, 'Project request contains an unsupported field.');
    }
  }
}

function normalizeCreatePayload(value) {
  const payload = normalizeControlPayload(value);
  rejectUnknownFields(payload, new Set(['slug', 'name']));
  return {
    slug: assertProjectSlug(payload.slug),
    name: payload.name === undefined ? assertProjectName(payload.slug) : assertProjectName(payload.name),
  };
}

function normalizePatchPayload(value) {
  const payload = normalizeControlPayload(value);
  rejectUnknownFields(payload, new Set(['slug', 'name', 'status']));
  if (Object.keys(payload).length === 0) {
    throw new CloudValidationError('empty_project_patch', 'Project update must contain at least one supported field.');
  }
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(payload, 'slug')) patch.slug = assertProjectSlug(payload.slug);
  if (Object.prototype.hasOwnProperty.call(payload, 'name')) patch.name = assertProjectName(payload.name);
  if (Object.prototype.hasOwnProperty.call(payload, 'status')) {
    if (payload.status !== 'active' && payload.status !== 'disabled') {
      throw new CloudValidationError('invalid_project_status', 'Project status is invalid.');
    }
    patch.status = payload.status;
  }
  return patch;
}

function normalizeStoredProject(value) {
  try {
    if (!plainObject(value) || value.schema !== PROJECT_SCHEMA) throw new Error('invalid project');
    const projectId = assertProjectId(value.project_id);
    const slug = assertProjectSlug(value.slug);
    const name = assertProjectName(value.name);
    if (!PROJECT_STATUSES.has(value.status)) throw new Error('invalid status');
    if (!safeTimestamp(value.created_at) || !safeTimestamp(value.updated_at)
      || Date.parse(value.updated_at) < Date.parse(value.created_at)) throw new Error('invalid timestamp');
    const deletedAt = value.deleted_at === undefined ? undefined : value.deleted_at;
    if (deletedAt !== undefined && !safeTimestamp(deletedAt)) throw new Error('invalid deletion timestamp');
    if ((value.status === 'deleted' && (!deletedAt || deletedAt !== value.updated_at))
      || (value.status !== 'deleted' && deletedAt !== undefined)) {
      throw new Error('invalid deletion state');
    }
    if (value.created_via !== 'dashboard') throw new Error('invalid creation metadata');
    return {
      schema: PROJECT_SCHEMA,
      project_id: projectId,
      slug,
      name,
      status: value.status,
      created_at: value.created_at,
      updated_at: value.updated_at,
      ...(deletedAt ? { deleted_at: deletedAt } : {}),
      created_via: 'dashboard',
    };
  } catch (_) {
    throw new CloudAdapterError('cloud_project_invalid_record', 'Project control-plane state is invalid.', { status: 500 });
  }
}

function normalizeSlugIndex(value) {
  try {
    if (!plainObject(value) || value.schema !== PROJECT_SLUG_INDEX_SCHEMA) throw new Error('invalid slug index');
    return {
      schema: PROJECT_SLUG_INDEX_SCHEMA,
      slug: assertProjectSlug(value.slug),
      project_id: assertProjectId(value.project_id),
    };
  } catch (_) {
    throw new CloudAdapterError('cloud_project_invalid_record', 'Project control-plane state is invalid.', { status: 500 });
  }
}

function publicProject(project) {
  return {
    project_id: project.project_id,
    slug: project.slug,
    name: project.name,
    status: project.status,
    created_at: project.created_at,
    updated_at: project.updated_at,
    ...(project.deleted_at ? { deleted_at: project.deleted_at } : {}),
  };
}

function indexFailure(operation, error) {
  if (isTelegraphCloudError(error)) return error;
  return new CloudAdapterError(
    `cloud_project_${operation}_failed`,
    'Project control-plane storage is temporarily unavailable.',
    { status: 503 },
  );
}

function generatedProjectId(createId) {
  try {
    return assertProjectId(createId('prj_'));
  } catch (_) {
    throw new CloudConfigurationError('invalid_project_id_generator', 'Project ID generation is unavailable.');
  }
}

function decodeListCursor(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || utf8ByteLength(value) > CLOUD_LIMITS.MAX_DOCUMENT_CURSOR_BYTES) {
    throw new CloudValidationError('invalid_project_cursor', 'Project pagination cursor is invalid.');
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(base64urlToBytes(value));
    const parsed = JSON.parse(decoded);
    if (!plainObject(parsed) || parsed.v !== 1 || typeof parsed.c !== 'string'
      || utf8ByteLength(parsed.c) > CLOUD_LIMITS.MAX_DOCUMENT_CURSOR_BYTES) {
      throw new Error('invalid cursor');
    }
    return parsed.c;
  } catch (_) {
    throw new CloudValidationError('invalid_project_cursor', 'Project pagination cursor is invalid.');
  }
}

function encodeListCursor(cursor) {
  return bytesToBase64url(encoder.encode(JSON.stringify({ v: 1, c: cursor })));
}

function base64urlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid cursor');
  let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function normalizeListOptions(value = {}) {
  if (!plainObject(value)) {
    throw new CloudValidationError('invalid_project_query', 'Project list query is invalid.');
  }
  const limit = value.limit === undefined ? 20 : value.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_LIMIT) {
    throw new CloudValidationError('invalid_project_limit', 'Project list limit is outside the supported range.');
  }
  return { limit, cursor: decodeListCursor(value.cursor) };
}

/**
 * KV-backed project control-plane registry. It is intentionally independent of
 * the Telegram journal: projects name authorization boundaries, while document
 * revisions remain immutable Telegram data-plane records.
 */
export function createProjectRegistry(env, {
  index = createCloudIndexStore(env),
  now = () => new Date(),
  createId = defaultCreateId,
} = {}) {
  if (!index || typeof index.getJson !== 'function' || typeof index.putJson !== 'function'
    || typeof index.remove !== 'function' || typeof index.list !== 'function') {
    throw new CloudConfigurationError('cloud_project_registry_unavailable', 'Project registry is unavailable.');
  }

  async function getIndex(namespace, ...segments) {
    try {
      return await index.getJson(namespace, ...segments);
    } catch (error) {
      throw indexFailure('read', error);
    }
  }

  async function putIndex(namespace, segments, value, options) {
    try {
      await index.putJson(namespace, segments, value, options);
    } catch (error) {
      throw indexFailure('write', error);
    }
  }

  async function removeIndex(namespace, ...segments) {
    try {
      await index.remove(namespace, ...segments);
    } catch (error) {
      throw indexFailure('delete', error);
    }
  }

  async function readProject(projectId) {
    const safeProjectId = assertProjectId(projectId);
    const value = await getIndex(PROJECT_INDEX_NAMESPACES.project, safeProjectId);
    if (value === null) return null;
    const project = normalizeStoredProject(value);
    if (project.project_id !== safeProjectId) {
      throw new CloudAdapterError('cloud_project_invalid_record', 'Project control-plane state is invalid.', { status: 500 });
    }
    return project;
  }

  async function readSlug(slug) {
    const safeSlug = assertProjectSlug(slug);
    const value = await getIndex(PROJECT_INDEX_NAMESPACES.slug, safeSlug);
    if (value === null) return null;
    const entry = normalizeSlugIndex(value);
    if (entry.slug !== safeSlug) {
      throw new CloudAdapterError('cloud_project_invalid_record', 'Project control-plane state is invalid.', { status: 500 });
    }
    return entry;
  }

  async function writeSlug(slug, projectId) {
    await putIndex(PROJECT_INDEX_NAMESPACES.slug, [slug], {
      schema: PROJECT_SLUG_INDEX_SCHEMA,
      slug,
      project_id: projectId,
    });
  }

  async function assertSlugAvailable(slug, projectId = null) {
    const existing = await readSlug(slug);
    if (existing && existing.project_id !== projectId) {
      throw new CloudConflictError('project_slug_taken', 'A project with this slug already exists.');
    }
  }

  async function createProject(input) {
    const payload = normalizeCreatePayload(input);
    await assertSlugAvailable(payload.slug);

    let projectId;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generatedProjectId(createId);
      if (!await readProject(candidate)) {
        projectId = candidate;
        break;
      }
    }
    if (!projectId) {
      throw new CloudAdapterError('project_id_allocation_failed', 'A project identifier could not be allocated.', { status: 503 });
    }

    const timestamp = toIsoTimestamp(now);
    const project = {
      schema: PROJECT_SCHEMA,
      project_id: projectId,
      slug: payload.slug,
      name: payload.name,
      status: 'active',
      created_at: timestamp,
      updated_at: timestamp,
      created_via: 'dashboard',
    };
    await putIndex(PROJECT_INDEX_NAMESPACES.project, [projectId], project);
    try {
      await writeSlug(payload.slug, projectId);
      const confirmed = await readSlug(payload.slug);
      if (!confirmed || confirmed.project_id !== projectId) {
        throw new CloudConflictError('project_slug_taken', 'A project with this slug already exists.');
      }
    } catch (error) {
      try { await removeIndex(PROJECT_INDEX_NAMESPACES.project, projectId); } catch (_) { /* best effort */ }
      throw error;
    }
    return publicProject(project);
  }

  async function getProject(projectId) {
    const project = await readProject(projectId);
    if (!project || project.status === 'deleted') {
      throw new CloudNotFoundError('project_not_found', 'The requested project was not found.');
    }
    return publicProject(project);
  }

  async function getProjectRecord(projectId, { includeDeleted = true } = {}) {
    const project = await readProject(projectId);
    if (!project || (!includeDeleted && project.status === 'deleted')) return null;
    return project;
  }

  async function requireActiveProject(projectId) {
    const project = await readProject(projectId);
    if (!project || project.status === 'deleted') {
      throw new CloudNotFoundError('project_not_found', 'The requested project was not found.');
    }
    if (project.status !== 'active') {
      throw new CloudForbiddenError('project_inactive', 'The project is not active.');
    }
    return project;
  }

  async function listProjects(options = {}) {
    const { limit, cursor } = normalizeListOptions(options);
    const page = await (async () => {
      try {
        return await index.list(PROJECT_INDEX_NAMESPACES.project, { limit, cursor });
      } catch (error) {
        throw indexFailure('list', error);
      }
    })();
    if (!page || !Array.isArray(page.keys) || typeof page.list_complete !== 'boolean') {
      throw new CloudAdapterError('cloud_project_invalid_page', 'Project list state is invalid.', { status: 500 });
    }

    const projectIds = page.keys.map((key) => String(key?.name || '').split(':').pop());
    const records = await Promise.all(projectIds.map(async (projectId) => {
      try {
        return await readProject(projectId);
      } catch (error) {
        if (error?.code === 'invalid_project_id') {
          throw new CloudAdapterError('cloud_project_invalid_page', 'Project list state is invalid.', { status: 500 });
        }
        throw error;
      }
    }));
    const data = records
      .filter((project) => project && project.status !== 'deleted')
      .sort((left, right) => left.project_id.localeCompare(right.project_id))
      .map(publicProject);
    const hasMore = !page.list_complete;
    if (hasMore && (typeof page.cursor !== 'string' || !page.cursor)) {
      throw new CloudAdapterError('cloud_project_invalid_page', 'Project list state is invalid.', { status: 500 });
    }
    return {
      data,
      limit,
      order: 'project_id:asc',
      ...(hasMore ? { next_cursor: encodeListCursor(page.cursor) } : {}),
      has_more: hasMore,
    };
  }

  async function updateProject(projectId, input) {
    const safeProjectId = assertProjectId(projectId);
    const patch = normalizePatchPayload(input);
    const current = await readProject(safeProjectId);
    if (!current || current.status === 'deleted') {
      throw new CloudNotFoundError('project_not_found', 'The requested project was not found.');
    }

    const next = {
      ...current,
      ...patch,
      updated_at: toIsoTimestamp(now),
    };
    if (patch.slug && patch.slug !== current.slug) {
      await assertSlugAvailable(patch.slug, safeProjectId);
      await writeSlug(patch.slug, safeProjectId);
      try {
        await putIndex(PROJECT_INDEX_NAMESPACES.project, [safeProjectId], next);
      } catch (error) {
        try { await removeIndex(PROJECT_INDEX_NAMESPACES.slug, patch.slug); } catch (_) { /* best effort */ }
        throw error;
      }
      const previousSlug = await readSlug(current.slug);
      if (previousSlug?.project_id === safeProjectId) {
        await removeIndex(PROJECT_INDEX_NAMESPACES.slug, current.slug);
      }
    } else {
      await putIndex(PROJECT_INDEX_NAMESPACES.project, [safeProjectId], next);
    }
    return publicProject(next);
  }

  async function deleteProject(projectId) {
    const safeProjectId = assertProjectId(projectId);
    const current = await readProject(safeProjectId);
    if (!current || current.status === 'deleted') {
      throw new CloudNotFoundError('project_not_found', 'The requested project was not found.');
    }
    const timestamp = toIsoTimestamp(now);
    const deleted = {
      ...current,
      status: 'deleted',
      updated_at: timestamp,
      deleted_at: timestamp,
    };
    await putIndex(PROJECT_INDEX_NAMESPACES.project, [safeProjectId], deleted);
    const slug = await readSlug(current.slug);
    if (slug?.project_id === safeProjectId) {
      await removeIndex(PROJECT_INDEX_NAMESPACES.slug, current.slug);
    }
    return publicProject(deleted);
  }

  return Object.freeze({
    createProject,
    getProject,
    getProjectRecord,
    requireActiveProject,
    listProjects,
    updateProject,
    deleteProject,
  });
}
