const DEFAULT_ORIGINS = Object.freeze([
  'https://admin-panel-everywhere.pages.dev',
  'http://localhost:3214',
  'http://127.0.0.1:3214',
  'http://localhost:8788',
  'http://127.0.0.1:8788',
]);

const ALLOWED_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']);
const ALLOWED_HEADERS = new Set([
  'authorization',
  'content-type',
  'if-match',
  'if-none-match',
  'if-unmodified-since',
  'idempotency-key',
  'range',
]);
const EXPOSED_HEADERS = Object.freeze([
  'ETag',
  'Content-Range',
  'Content-Length',
  'Last-Modified',
  'X-Telegraph-Cloud-Object-Version',
  'Accept-Ranges',
]);

export function corsEnabledPath(pathname) {
  return pathname === '/openapi.json'
    || pathname === '/llms.txt'
    || pathname === '/llms-full.txt'
    || pathname === '/.well-known/jwks.json'
    || pathname === '/.well-known/telegraph.json'
    || pathname === '/api/health'
    || pathname === '/api/auth/token'
    || pathname === '/api/db'
    || pathname.startsWith('/api/db/')
    || pathname === '/api/storage'
    || pathname.startsWith('/api/storage/');
}

function normalizeOrigins(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return [...DEFAULT_ORIGINS];
  return raw.split(',').map((value) => value.trim()).filter(Boolean).filter((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:')
        && !url.username && !url.password && !url.pathname.replace(/\/$/, '')
        && !url.search && !url.hash;
    } catch (_) {
      return false;
    }
  });
}

export function corsAllowedOrigin(origin, env = {}) {
  if (typeof origin !== 'string' || origin === '') return null;
  return normalizeOrigins(env.TELEGRAPH_CORS_ORIGINS).includes(origin) ? origin : null;
}

function requestedHeaders(request) {
  return (request.headers.get('Access-Control-Request-Headers') || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function isAllowedRequestHeader(name) {
  return ALLOWED_HEADERS.has(name) || name.startsWith('x-amz-meta-');
}

function vary(headers, value) {
  const current = headers.get('Vary');
  const values = new Set((current || '').split(',').map((entry) => entry.trim()).filter(Boolean));
  values.add(value);
  headers.set('Vary', [...values].join(', '));
}

function applyAllowedHeaders(headers, requested) {
  for (const name of requested) {
    if (!isAllowedRequestHeader(name)) return false;
  }
  headers.set('Access-Control-Allow-Headers', requested.length
    ? requested.join(', ')
    : 'Authorization, Content-Type, If-Match, If-None-Match, If-Unmodified-Since, Idempotency-Key, Range');
  return true;
}

export function applyCors(response, request, env = {}) {
  const origin = request.headers.get('Origin');
  if (!origin || !corsEnabledPath(new URL(request.url).pathname)) return response;
  const allowed = corsAllowedOrigin(origin, env);
  if (!allowed) return response;

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowed);
  headers.set('Access-Control-Expose-Headers', EXPOSED_HEADERS.join(', '));
  vary(headers, 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function corsPreflight(request, env = {}) {
  const url = new URL(request.url);
  if (request.method !== 'OPTIONS' || !corsEnabledPath(url.pathname)) return null;

  const origin = request.headers.get('Origin');
  if (!origin) return null;

  const allowed = corsAllowedOrigin(origin, env);
  if (!allowed) {
    return new Response(JSON.stringify({ error: 'cors_origin_not_allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const requestedMethod = (request.headers.get('Access-Control-Request-Method') || '').toUpperCase();
  if (!ALLOWED_METHODS.includes(requestedMethod)) {
    return new Response(JSON.stringify({ error: 'cors_method_not_allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Allow': ALLOWED_METHODS.join(', ') },
    });
  }

  const headers = new Headers({
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': ALLOWED_METHODS.join(', '),
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
  });
  vary(headers, 'Origin');
  vary(headers, 'Access-Control-Request-Method');
  vary(headers, 'Access-Control-Request-Headers');

  if (!applyAllowedHeaders(headers, requestedHeaders(request))) {
    return new Response(JSON.stringify({ error: 'cors_header_not_allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  return new Response(null, { status: 204, headers });
}

export const CORS_DEFAULT_ORIGINS = DEFAULT_ORIGINS;
export const CORS_ALLOWED_METHODS = ALLOWED_METHODS;
export const CORS_EXPOSED_HEADERS = EXPOSED_HEADERS;
