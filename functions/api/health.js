import { jsonResponse } from '../utils/http.js';
import { getSetupStatus } from '../utils/setup-status.js';

/**
 * Public health is intentionally a minimal legacy configuration signal. It
 * neither probes remote services nor reports bindings/variables, so it cannot
 * be used to enumerate Cloud control-plane or Telegram configuration.
 */
export async function onRequestGet(context) {
  const setup = getSetupStatus(context.env || {});
  return jsonResponse({ status: setup.ready ? 'ok' : 'degraded' }, {
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
