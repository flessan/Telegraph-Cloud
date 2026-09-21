import { createPublicCollectionShareService } from '../cloud/public-collection-share.js';
import { createProjectRegistry } from '../cloud/project-registry.js';
import { createTelegramDocumentDatabase, parseDocumentListQuery } from '../cloud/document-database.js';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function queryFor(request) {
  const url = new URL(request.url);
  const allowed = new Set(['limit', 'cursor', 'raw']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) return { error: 'invalid_public_query' };
  }
  const query = new URLSearchParams();
  if (url.searchParams.has('limit')) query.set('limit', url.searchParams.get('limit'));
  if (url.searchParams.has('cursor')) query.set('cursor', url.searchParams.get('cursor'));
  return {
    raw: url.searchParams.get('raw') === '1' || url.searchParams.get('raw') === 'true',
    query,
  };
}

const PUBLIC_HEADERS = {
  'Cache-Control': 'public, max-age=30, s-maxage=60',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'ETag, Last-Modified',
};

export async function onRequest(context) {
  const { request, params, env = {}, data = {} } = context;

  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '600',
      },
    });
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return jsonResponse({ error: 'method_not_allowed' }, {
      status: 405,
      headers: { Allow: 'GET, HEAD, OPTIONS', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const shareId = typeof params.share === 'string' ? params.share : '';
    const shares = data.publicCollectionShares || createPublicCollectionShareService(env);
    const share = await shares.resolve(shareId);

    const projects = data.projectRegistry || createProjectRegistry(env);
    await projects.requireActiveProject(share.project_id);

    const database = data.projectDatabase || createTelegramDocumentDatabase(env, { projectId: share.project_id });
    await database.getCollection(share.collection);
    const parsedQuery = queryFor(request);
    if (parsedQuery.error) {
      return jsonResponse({ error: parsedQuery.error }, {
        status: 400,
        headers: { ...PUBLIC_HEADERS, 'Cache-Control': 'no-store' },
      });
    }

    const parsed = parseDocumentListQuery(parsedQuery.query, env);
    const page = await database.listDocuments(share.collection, parsed);
    const dataRows = page.data.map((record) => record.data);
    const payload = parsedQuery.raw
      ? dataRows
      : {
        collection: share.collection,
        data: dataRows,
        limit: page.limit,
        order: page.order,
        has_more: page.has_more,
        ...(page.next_cursor ? { next_cursor: page.next_cursor } : {}),
      };

    const body = JSON.stringify(payload);
    if (request.method === 'HEAD') {
      return new Response(null, {
        status: 200,
        headers: {
          ...PUBLIC_HEADERS,
          'Content-Length': String(new TextEncoder().encode(body).byteLength),
        },
      });
    }
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...PUBLIC_HEADERS } });
  } catch (error) {
    if (error?.code === 'public_share_not_found' || error?.code === 'project_not_found' || error?.code === 'project_inactive') {
      return jsonResponse({ error: 'public_share_not_found' }, {
        status: 404,
        headers: { ...PUBLIC_HEADERS, 'Cache-Control': 'no-store' },
      });
    }
    if (error?.code === 'invalid_public_query' || /^invalid_/.test(error?.code || '')) {
      return jsonResponse({ error: error.code }, {
        status: 400,
        headers: { ...PUBLIC_HEADERS, 'Cache-Control': 'no-store' },
      });
    }
    console.error('Telegraph Cloud public collection request failed.');
    return jsonResponse({ error: 'internal_error' }, {
      status: 500,
      headers: { ...PUBLIC_HEADERS, 'Cache-Control': 'no-store' },
    });
  }
}
