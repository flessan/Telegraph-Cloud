import {
  CloudAdapterError,
  CloudNotFoundError,
  CloudValidationError,
} from './errors.js';
import { createCloudIndexStore } from './index-store.js';
import { assertCollectionName, assertProjectId } from './validation.js';

export const PUBLIC_COLLECTION_SHARE_SCHEMA = 'telegraph-cloud.public-collection-share.v1';
export const PUBLIC_COLLECTION_SHARE_NAMESPACE = 'public-share';
export const PUBLIC_COLLECTION_SHARE_COLLECTION_NAMESPACE = 'public-share-by-collection';

const TOKEN_BYTES = 24;
const TOKEN_PATTERN = /^pub_[A-Za-z0-9_-]{32}$/;

function bytesToBase64url(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomShareId() {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return 'pub_' + bytesToBase64url(bytes);
}

async function shareLookupId(shareId) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(shareId));
  return bytesToBase64url(new Uint8Array(digest));
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : new Date();
  return value instanceof Date ? value.toISOString() : value;
}

function normalizeStored(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== PUBLIC_COLLECTION_SHARE_SCHEMA
    || !TOKEN_PATTERN.test(value.share_id)) {
    throw new CloudAdapterError('public_share_invalid_record', 'Public share state is invalid.', { status: 500 });
  }
  let projectId;
  let collection;
  try {
    projectId = assertProjectId(value.project_id);
    collection = assertCollectionName(value.collection);
  } catch (_) {
    throw new CloudAdapterError('public_share_invalid_record', 'Public share state is invalid.', { status: 500 });
  }
  if (value.revoked === true) {
    throw new CloudAdapterError('public_share_invalid_record', 'Public share state is invalid.', { status: 500 });
  }
  return {
    schema: PUBLIC_COLLECTION_SHARE_SCHEMA,
    share_id: value.share_id,
    project_id: projectId,
    collection,
    created_at: value.created_at,
    created_by: typeof value.created_by === 'string' && value.created_by ? value.created_by : 'dashboard',
    revoked: false,
  };
}

function publicShare(value, origin) {
  const base = origin.replace(/\/$/, '');
  const encoded = encodeURIComponent(value.share_id);
  return {
    share_id: value.share_id,
    project_id: value.project_id,
    collection: value.collection,
    created_at: value.created_at,
    url: base + '/p/' + encoded + '.json',
    raw_url: base + '/p/' + encoded + '.json?raw=1',
  };
}

export function createPublicCollectionShareService(env, {
  index = createCloudIndexStore(env),
  now = () => new Date(),
  createShareId = randomShareId,
} = {}) {
  if (!index || typeof index.getJson !== 'function' || typeof index.putJson !== 'function' || typeof index.remove !== 'function') {
    throw new CloudAdapterError('public_share_unavailable', 'Public share storage is unavailable.', { status: 503 });
  }

  async function readByShareId(shareId) {
    if (typeof shareId !== 'string' || !TOKEN_PATTERN.test(shareId)) return null;
    const lookup = await shareLookupId(shareId);
    const stored = await index.getJson(PUBLIC_COLLECTION_SHARE_NAMESPACE, lookup);
    if (stored === null) return null;
    const normalized = normalizeStored(stored);
    if (normalized.share_id !== shareId) {
      throw new CloudAdapterError('public_share_invalid_record', 'Public share state is invalid.', { status: 500 });
    }
    return normalized;
  }

  async function readByCollection(projectId, collection) {
    const project = assertProjectId(projectId);
    const name = assertCollectionName(collection);
    const stored = await index.getJson(PUBLIC_COLLECTION_SHARE_COLLECTION_NAMESPACE, project, name);
    if (stored === null) return null;
    if (!stored || typeof stored !== 'object'
      || stored.schema !== PUBLIC_COLLECTION_SHARE_SCHEMA
      || stored.project_id !== project
      || stored.collection !== name
      || !TOKEN_PATTERN.test(stored.share_id)) {
      throw new CloudAdapterError('public_share_invalid_record', 'Public share state is invalid.', { status: 500 });
    }
    return readByShareId(stored.share_id);
  }

  async function publish({ projectId, collection, createdBy = 'dashboard', origin }) {
    const project = assertProjectId(projectId);
    const name = assertCollectionName(collection);
    if (typeof origin !== 'string' || !/^https?:\/\/[^/?#]+$/i.test(origin)) {
      throw new CloudValidationError('invalid_share_origin', 'Public share origin is invalid.');
    }

    const existing = await readByCollection(project, name);
    if (existing) return publicShare(existing, origin);

    let shareId = null;
    let lookup = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = createShareId();
      if (!TOKEN_PATTERN.test(candidate)) {
        throw new CloudAdapterError('public_share_id_unavailable', 'A public share identifier could not be generated.', { status: 503 });
      }
      const candidateLookup = await shareLookupId(candidate);
      if (!(await index.getJson(PUBLIC_COLLECTION_SHARE_NAMESPACE, candidateLookup))) {
        shareId = candidate;
        lookup = candidateLookup;
        break;
      }
    }
    if (!shareId || !lookup) {
      throw new CloudAdapterError('public_share_id_unavailable', 'A public share identifier could not be generated.', { status: 503 });
    }

    const record = {
      schema: PUBLIC_COLLECTION_SHARE_SCHEMA,
      share_id: shareId,
      project_id: project,
      collection: name,
      created_at: timestamp(now),
      created_by: typeof createdBy === 'string' && createdBy ? createdBy : 'dashboard',
      revoked: false,
    };

    await index.putJson(PUBLIC_COLLECTION_SHARE_NAMESPACE, [lookup], record);
    try {
      await index.putJson(PUBLIC_COLLECTION_SHARE_COLLECTION_NAMESPACE, [project, name], record);
    } catch (error) {
      try { await index.remove(PUBLIC_COLLECTION_SHARE_NAMESPACE, lookup); } catch (_) {}
      throw error;
    }

    return publicShare(record, origin);
  }

  async function getStatus({ projectId, collection, origin }) {
    const existing = await readByCollection(projectId, collection);
    return existing ? publicShare(existing, origin) : null;
  }

  async function revoke({ projectId, collection }) {
    const existing = await readByCollection(projectId, collection);
    if (!existing) throw new CloudNotFoundError('public_share_not_found', 'The collection is not publicly published.');
    const lookup = await shareLookupId(existing.share_id);
    await index.remove(PUBLIC_COLLECTION_SHARE_NAMESPACE, lookup);
    await index.remove(PUBLIC_COLLECTION_SHARE_COLLECTION_NAMESPACE, existing.project_id, existing.collection);
    return { revoked: true, share_id: existing.share_id };
  }

  async function resolve(shareId) {
    const share = await readByShareId(shareId);
    if (!share) throw new CloudNotFoundError('public_share_not_found', 'The public collection link was not found.');
    return share;
  }

  return Object.freeze({ publish, getStatus, revoke, resolve });
}
