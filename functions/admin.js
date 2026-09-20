// /admin is compatibility-only: the unified Telegraph Cloud console at
// /console is the canonical management surface. The legacy media workspace
// (staged uploads, albums, moderation) is preserved as the compatibility
// entry at /admin.html for existing users and bookmarks; its data and API
// contracts are unchanged. Redirecting rather than removing keeps deep links
// from dead-ending while making the canonical surface unambiguous.
export function onRequest() {
  return new Response(null, {
    status: 302,
    headers: {
      Location: '/console',
      'Cache-Control': 'no-store',
    },
  });
}
