import {
  dashboardDisabledResponse,
} from "../../utils/auth.js";
import { isEmptyBinding, jsonResponse } from "../../utils/http.js";
import { authenticateRequest, authConfigured } from "../../utils/session.js";

// Management handlers must never expose an exception message or stack: errors
// can contain binding details, Telegram response data, or user-controlled input.
// A future correlation id can be added without changing this stable response.
export async function errorHandling(context) {
  try {
    return await context.next();
  } catch (_) {
    console.error('Management API request failed.');
    return jsonResponse({ error: 'internal_error' }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}

  async function authentication(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    if (isEmptyBinding(context.env.img_url)) {
        return dashboardDisabledResponse();
    }

    // Session plumbing endpoints handle their own authentication and must be
    // reachable before a session exists.
    const publicAuthPaths = ['/api/manage/login', '/api/manage/logout', '/api/manage/session'];
    if (publicAuthPaths.some(p => url.pathname === p || url.pathname.startsWith(p + '/'))) {
      return context.next();
    }

    if (!authConfigured(env)) {
        // No credentials configured — same open behavior as before.
        return context.next();
    }

    const identity = await authenticateRequest(request, env);
    if (identity) {
      context.data.session = identity;
      return context.next();
    }

    const accepts = request.headers.get('Accept') || '';
    const wantsJson = accepts.includes('application/json') ||
      url.pathname.startsWith('/api/');

    // Deliberately do NOT send WWW-Authenticate: a challenge would force the
    // browser's native Basic dialog. The admin GUI handles 401 itself.
    if (wantsJson) {
      return jsonResponse({ error: 'unauthenticated' }, {
        status: 401,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    // Browser navigation to a protected page without a session bounces to the
    // GUI login rather than showing the native credential prompt.
    return Response.redirect(`${url.origin}/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  }

  export const onRequest = [errorHandling, authentication];
