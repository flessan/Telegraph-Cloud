import { DOC_PAGES, docPage, renderDocsPage, aiAgentOnboardingText } from '../cloud/developer-docs.js';

// Human-readable developer documentation. One page per slug
// (/docs/getting-started … /docs/self-hosting), the landing page /docs shows
// "Getting started", /docs/ai is the AI-agent integration guide, and
// /docs/ai-agent is a copy-ready plain-text onboarding brief.
//
// Unknown paths fall back to static-asset serving (context.env.ASSETS) so
// pre-existing files under /docs/*.md keep working; with no ASSETS binding
// (unit tests) they fail closed with a 404.

function notFound(origin) {
  return new Response(`<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Not found — Telegraph Cloud docs</title></head>
<body style="font-family: system-ui, sans-serif; margin: 4rem auto; max-width: 40rem;">
<h1>404 — no such documentation page</h1>
<p><a href="/docs">Back to the documentation index</a> · <a href="${origin}/console">Console</a></p>
</body></html>`, {
    status: 404,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function servePage(context, slug) {
  const url = new URL(context.request.url);
  const origin = `${url.protocol}//${url.host}`;

  if (slug === 'ai-agent') {
    return new Response(aiAgentOnboardingText({ origin }), {
      status: 200,
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  }

  const page = docPage(slug);
  if (!page) {
    if (context.env && context.env.ASSETS && typeof context.env.ASSETS.fetch === 'function') {
      // Preserve serving of pre-existing static files (e.g. phase reports).
      return context.env.ASSETS.fetch(context.request);
    }
    return notFound(origin);
  }
  return new Response(renderDocsPage(slug, { origin }), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
}

export function onRequestGet(context) {
  const raw = context.params?.page;
  const slug = Array.isArray(raw) ? raw.join('/') : (raw || 'getting-started');
  return servePage(context, slug);
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

// DOC_PAGES is re-exported for the route-level accuracy test only; the page
// set is authored in the cloud module.
export { DOC_PAGES };
