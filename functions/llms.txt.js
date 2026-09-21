import { llmsDigest } from './cloud/developer-docs.js';

// Concise machine-readable digest for coding agents (llms.txt convention):
// what the service is, how to authenticate, the real endpoint list, and the
// hard rules. Rooted at the requesting origin; public and cacheable.
function serve(context) {
  const url = new URL(context.request.url);
  const origin = `${url.protocol}//${url.host}`;
  return new Response(llmsDigest({ origin }), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

export function onRequestGet(context) {
  return serve(context);
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
