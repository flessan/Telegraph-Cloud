import { getOperatorReadiness } from '../../cloud/operational-readiness.js';
import { recordOperationalSignal } from '../../utils/middleware.js';
import { jsonResponse } from '../../utils/http.js';

function requestedTelegramProbe(request) {
  const values = new URL(request.url).searchParams.getAll('probe');
  if (values.length === 0) return { probeTelegram: false };
  if (values.length === 1 && values[0] === 'telegram') return { probeTelegram: true };
  return null;
}

/**
 * This route inherits the dashboard-only /api/projects middleware. It returns
 * enum states only: no secret values, binding identifiers, Telegram records,
 * project data, provider errors, or caller-supplied diagnostics are exposed.
 */
export async function onRequestGet(context) {
  const options = requestedTelegramProbe(context.request);
  if (!options) {
    return jsonResponse({ error: 'invalid_diagnostic_probe' }, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const report = await getOperatorReadiness(context.env || {}, options);
  // This only adds a fixed enum to an already-sampled API transaction. It is
  // not a counter, audit log, or analytics event; raw configuration and probe
  // details remain absent from telemetry.
  recordOperationalSignal(context, 'operator_readiness', report.status);
  return jsonResponse(report, {
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function onRequest(context) {
  if (context.request.method === 'GET') return onRequestGet(context);
  return jsonResponse({ error: 'method_not_allowed' }, {
    status: 405,
    headers: {
      Allow: 'GET',
      'Cache-Control': 'no-store',
    },
  });
}
