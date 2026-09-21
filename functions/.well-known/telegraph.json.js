import { telegraphServiceDocument } from '../cloud/developer-docs.js';

// Public service metadata for discovery: endpoints, authentication summary,
// capability flags (including honest "false" entries), and limits. Contains
// configuration names and capability booleans only — never secret values.
export function onRequestGet(context) {
  const url = new URL(context.request.url);
  const origin = `${url.protocol}//${url.host}`;
  return new Response(JSON.stringify(telegraphServiceDocument({ origin }), null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

export function onRequest(context) {
  if (context.request.method === 'GET' || context.request.method === 'HEAD') {
    return onRequestGet(context);
  }
  return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
    status: 405,
    headers: {
      Allow: 'GET, HEAD',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
