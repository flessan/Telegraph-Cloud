import { llmsFull } from './cloud/developer-docs.js';

// Complete plain-text documentation for coding agents: the digest plus every
// documentation topic (getting started … self-hosting) in one document.
// Same generated source as the human /docs pages, rooted at the request origin.
function serve(context) {
  const url = new URL(context.request.url);
  const origin = `${url.protocol}//${url.host}`;
  return new Response(llmsFull({ origin }), {
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
