import sentryPlugin from "@cloudflare/pages-plugin-sentry";
import '@sentry/tracing';

const REDACTED = '[redacted]';
const SAFE_REQUEST_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-length',
  'content-type',
  'origin',
  'user-agent',
]);
const SENSITIVE_HEADER_NAME = /(authorization|cookie|api[-_]?key|token|secret|password|credential|signature|session|csrf)/i;
const TELEGRAM_BOT_PATH = /(https?:\/\/api\.telegram\.org\/(?:file\/)?bot)[^/?\s]+/gi;
const SENSITIVE_QUERY_VALUE = /([?&](?:api[-_]?key|token|secret|password|credential|signature|session)=)[^&#\s]*/gi;
// Developer keys are Bearer-only, but scrub an accidentally interpolated key
// from telemetry messages/breadcrumbs as a defense in depth as well.
const DEVELOPER_API_KEY = /\btg_live_[A-Za-z0-9_-]+\b/g;
const SAFE_CF_FIELDS = ['asn', 'colo', 'country', 'httpProtocol', 'tlsCipher', 'tlsVersion'];
const SENTRY_DSN = 'https://219f636ac7bde5edab2c3e16885cb535@o4507041519108096.ingest.us.sentry.io/4507541492727808';

function telemetryEnabled(env) {
  return typeof env?.disable_telemetry === 'undefined'
    || env.disable_telemetry === null
    || env.disable_telemetry === '';
}

function truncate(value, max = 256) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function headerEntries(headers) {
  if (!headers) return [];
  if (typeof headers.forEach === 'function') {
    const entries = [];
    headers.forEach((value, key) => entries.push([key, value]));
    return entries;
  }
  if (Array.isArray(headers)) {
    return headers.filter((entry) => Array.isArray(entry) && entry.length >= 2);
  }
  if (typeof headers === 'object') return Object.entries(headers);
  return [];
}

function isSensitiveHeader(name) {
  return SENSITIVE_HEADER_NAME.test(name);
}

/**
 * Returns a deliberately small request-header context. Sensitive headers are
 * represented as `[redacted]`; unrecognised headers are omitted entirely.
 */
export function redactTelemetryHeaders(headers) {
  const safe = {};
  for (const [rawName, rawValue] of headerEntries(headers)) {
    const name = String(rawName).toLowerCase();
    if (isSensitiveHeader(name)) {
      safe[name] = REDACTED;
    } else if (SAFE_REQUEST_HEADERS.has(name)) {
      safe[name] = truncate(rawValue);
    }
  }
  return safe;
}

/**
 * Drops request queries/fragments and masks Bot API path tokens before data is
 * sent to telemetry. A query might contain a future API key or a legacy token.
 */
export function sanitizeTelemetryUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    // Redact after recombining origin + path: Telegram tokens live in the path
    // (`/bot<token>`), while the URL parser intentionally separates the host.
    return redactSensitiveText(`${url.origin}${url.pathname}`);
  } catch (_) {
    return redactSensitiveText(value.split(/[?#]/, 1)[0]);
  }
}

export function redactSensitiveText(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(TELEGRAM_BOT_PATH, '$1[redacted]')
    .replace(SENSITIVE_QUERY_VALUE, '$1[redacted]')
    .replace(DEVELOPER_API_KEY, 'tg_live_[redacted]');
}

function safeCfContext(cf) {
  if (!cf || typeof cf !== 'object') return {};
  const safe = {};
  for (const field of SAFE_CF_FIELDS) {
    const value = cf[field];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      safe[field] = truncate(value);
    }
  }
  return safe;
}

export function buildSafeRequestTelemetry(request) {
  const rawUrl = request?.url || '';
  let path = '';
  let hostname = '';
  try {
    const url = new URL(rawUrl);
    path = redactSensitiveText(url.pathname);
    hostname = url.hostname;
  } catch (_) {
    path = redactSensitiveText(String(rawUrl).split(/[?#]/, 1)[0]);
  }

  return {
    headers: redactTelemetryHeaders(request?.headers),
    cf: safeCfContext(request?.cf),
    url: sanitizeTelemetryUrl(rawUrl),
    method: request?.method || '',
    path,
    hostname,
  };
}

/**
 * Sentry may collect a request automatically as well as through telemetryData.
 * Scrub that event at the integration boundary so credentials never reach the
 * remote telemetry service through either route.
 */
export function redactTelemetryEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const safeEvent = { ...event };

  if (event.request && typeof event.request === 'object') {
    const request = { ...event.request };
    request.headers = redactTelemetryHeaders(event.request.headers);
    if (request.url) request.url = sanitizeTelemetryUrl(String(request.url));
    // Request bodies can include credentials, multipart data, or documents.
    delete request.data;
    delete request.cookies;
    safeEvent.request = request;
  }

  if (typeof event.message === 'string') {
    safeEvent.message = redactSensitiveText(event.message);
  }

  if (event.exception?.values && Array.isArray(event.exception.values)) {
    safeEvent.exception = {
      ...event.exception,
      values: event.exception.values.map((exception) => ({
        ...exception,
        ...(typeof exception?.value === 'string' ? { value: redactSensitiveText(exception.value) } : {}),
      })),
    };
  }

  if (Array.isArray(event.breadcrumbs)) {
    safeEvent.breadcrumbs = event.breadcrumbs.map((breadcrumb) => redactBreadcrumb(breadcrumb));
  }

  return safeEvent;
}

function redactBreadcrumb(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== 'object') return breadcrumb;
  const safe = { ...breadcrumb };
  if (typeof safe.message === 'string') safe.message = redactSensitiveText(safe.message);
  if (safe.data && typeof safe.data === 'object') {
    const data = { ...safe.data };
    if (data.headers) data.headers = redactTelemetryHeaders(data.headers);
    if (typeof data.url === 'string') data.url = sanitizeTelemetryUrl(data.url);
    for (const key of Object.keys(data)) {
      if (isSensitiveHeader(key)) data[key] = REDACTED;
    }
    safe.data = data;
  }
  return safe;
}

export function createTelemetryOptions(sampleRate) {
  return {
    dsn: SENTRY_DSN,
    tracesSampleRate: sampleRate,
    // Sentry processes error events and transaction events through different
    // callbacks. Both must scrub automatic request/breadcrumb capture.
    beforeSend: redactTelemetryEvent,
    beforeSendTransaction: redactTelemetryEvent,
  };
}

export async function errorHandling(context) {
  const env = context.env || {};
  if (!telemetryEnabled(env)) return context.next();

  context.data = context.data || {};
  context.data.telemetry = true;
  const sampleRate = await resolveSampleRate(env);
  return sentryPlugin(createTelemetryOptions(sampleRate))(context);
}

export async function telemetryData(context) {
  const env = context.env || {};
  if (!telemetryEnabled(env)) return context.next();

  const sentry = context.data?.sentry;
  let transaction = null;
  if (sentry) {
    try {
      const data = buildSafeRequestTelemetry(context.request);
      if (typeof sentry.setTag === 'function') {
        sentry.setTag('path', data.path);
        sentry.setTag('host', data.hostname);
        sentry.setTag('method', data.method);
      }
      if (typeof sentry.setContext === 'function') sentry.setContext('request', data);
      if (typeof sentry.startTransaction === 'function') {
        transaction = sentry.startTransaction({ name: `${data.method} ${data.hostname}`.trim() });
        context.data.transaction = transaction;
      }
    } catch (_) {
      // Never log an error object here: fetch errors can contain a Bot API URL.
      console.error('Telemetry request context could not be recorded.');
    }
  }

  try {
    return await context.next();
  } finally {
    try {
      if (transaction && typeof transaction.finish === 'function') transaction.finish();
    } catch (_) {
      // Telemetry must never turn a completed request into an application error.
    }
  }
}

export async function traceData(context, span, op, name) {
  if (!context?.data?.telemetry) return span;
  if (span) {
    if (typeof span.finish === 'function') span.finish();
    return null;
  }

  const transaction = context.data.transaction;
  if (!transaction || typeof transaction.startChild !== 'function') return null;
  return transaction.startChild({ op, name });
}

async function resolveSampleRate(env) {
  const configured = normalizeSampleRate(env.sampleRate);
  if (configured !== null) return configured;

  try {
    const response = await fetch("https://frozen-sentinel.pages.dev/signal/sampleRate.json");
    if (!response.ok) return 0.001;
    const data = await response.json();
    return normalizeSampleRate(data?.rate) ?? 0.001;
  } catch (_) {
    return 0.001;
  }
}

function normalizeSampleRate(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}
