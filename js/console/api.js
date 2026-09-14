// Console API client. Every call goes to the real backend; the console keeps
// no browser-local persistence of projects, objects, or credentials. Secrets
// are only ever held in memory for the one-time creation dialogs.

export class ApiError extends Error {
  constructor(code, status, message) {
    super(message || code);
    this.code = code;
    this.status = status;
  }
}

class AuthError extends ApiError {
  constructor() {
    super('unauthenticated', 401, 'Session expired');
  }
}

async function request(method, path, body, { headers = {}, raw = false, signal } = {}) {
  const options = {
    method,
    credentials: 'same-origin',
    redirect: 'manual',
    headers: { Accept: 'application/json', ...headers },
    ...(signal ? { signal } : {}),
  };
  if (body !== undefined && body !== null) {
    if (body instanceof Uint8Array || body instanceof ArrayBuffer || (typeof FormData !== 'undefined' && body instanceof FormData)) {
      options.body = body;
    } else {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, options);
  if (res.type === 'opaqueredirect' || [301, 302, 303, 307, 308].includes(res.status)) {
    throw new AuthError();
  }
  if (res.status === 401) throw new AuthError();
  if (raw) return res;
  let payload = null;
  const text = await res.text();
  if (text) {
    try { payload = JSON.parse(text); } catch (_) { payload = { raw: text }; }
  }
  if (!res.ok) {
    throw new ApiError(payload?.error || 'request_failed', res.status, payload?.message);
  }
  return payload;
}

export const api = {
  get: (path, opts) => request('GET', path, null, opts),
  post: (path, body, opts) => request('POST', path, body, opts),
  patch: (path, body, opts) => request('PATCH', path, body, opts),
  put: (path, body, opts) => request('PUT', path, body, opts),
  del: (path, body, opts) => request('DELETE', path, body, opts),
  rawRequest: request,
};

export { AuthError };

export function apiPath(projectId, ...parts) {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  if (parts.length === 0) return base;
  return `${base}/${parts.map((p) => encodeURIComponent(String(p))).join('/')}`;
}

// Drive paths need slashes preserved inside the object key while the project
// id stays encoded. [[key]] route segments are joined unencoded for slashes.
export function driveObjectsUrl(projectId, { bucket, key = '', query = {} } = {}) {
  const base = `/api/projects/${encodeURIComponent(projectId)}/drive/objects`;
  let path = base;
  if (key) path = `${base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const params = new URLSearchParams();
  if (bucket) params.set('bucket', bucket);
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== '') params.set(name, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}
