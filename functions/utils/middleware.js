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
// Breadcrumb/context field names can hold SigV4 source material even where the
// header name itself is not secret-shaped (for example x-amz-content-sha256).
const SENSITIVE_TELEMETRY_FIELD_NAME = /(authorization|cookie|api[-_ ]?key|key|token|secret|password|credential|signature|session|csrf|query(?:[-_ ]?string)?|canonical(?:[-_ ]?request)?|string[-_ ]?to[-_ ]?sign|payload[-_ ]?hash|(?:request[-_ ]?)?body|x[-_ ]?amz[-_ ]?(?:content[-_ ]?)?sha256)/i;
const TELEGRAM_BOT_PATH = /(https?:\/\/api\.telegram\.org\/(?:file\/)?bot)[^/?\s]+(?:\/[^\s?#]*)?/gi;
const SENSITIVE_QUERY_VALUE = /([?&](?:(?:x-amz-)?(?:api[-_]?key|key|token|secret|password|credential|signature|session|chat[-_]?id|file[-_]?(?:id|path)))=)[^&#\s]*/gi;
// A complete canonical request/string-to-sign includes a payload hash and can
// include a signature. Preserve no fragment of it rather than attempting to
// parse a multiline format from a telemetry message.
const SENSITIVE_SIGV4_MATERIAL = /(?:\b(?:canonical(?:[-_ ]?request)?|string[-_ ]?to[-_ ]?sign|payload[-_ ]?hash|x-amz-(?:content-)?sha256|x-amz-signature)\b|\bAWS4-HMAC-SHA256\s+Credential\s*=)/i;
const SENSITIVE_INLINE_VALUE = /(\b(?:api[-_ ]?key|key|token|secret(?:[-_ ]?(?:access[-_ ]?key|key))?|password|credential|authorization|signature|session|canonical(?:[-_ ]?request)?|string[-_ ]?to[-_ ]?sign|payload[-_ ]?hash|chat(?:[-_ ]?id)?|file[-_ ]?(?:id|path)|telegram(?:[-_ ]?(?:id|file[-_ ]?(?:id|path)))?)\b\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
// Developer keys are Bearer-only, but scrub an accidentally interpolated key
// from telemetry messages/breadcrumbs as a defense in depth as well.
const DEVELOPER_API_KEY = /\btg_live_[A-Za-z0-9_-]+\b/g;
// SigV4 access-key IDs are not bearer secrets, but masking them keeps
// credential identifiers and failed Authorization material out of telemetry.
const S3_ACCESS_KEY_ID = /\btgsk_live_[A-Za-z0-9_-]+\b/g;
const SAFE_CF_FIELDS = ['asn', 'colo', 'country', 'httpProtocol', 'tlsCipher', 'tlsVersion'];
const SAFE_OPERATIONAL_SIGNALS = Object.freeze({
  operator_readiness: new Set(['ready_for_smoke', 'degraded']),
});
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

function isTelegramIdentifierField(name) {
  const compact = String(name).toLowerCase().replace(/[-_ ]/g, '');
  return compact.includes('telegram')
    || compact === 'chat'
    || compact.includes('chatid')
    || compact.includes('fileid')
    || compact.includes('filepath');
}

function isSensitiveTelemetryField(name) {
  return SENSITIVE_HEADER_NAME.test(name)
    || SENSITIVE_TELEMETRY_FIELD_NAME.test(name)
    || isTelegramIdentifierField(name);
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
 * Removes caller-selected application identifiers from known dynamic routes.
 * A route family remains useful for diagnostics, while object paths, project
 * IDs, collection/record IDs, legacy file IDs, and dashboard resource names
 * never reach remote telemetry.
 */
function redactSensitiveApplicationPath(value) {
  return String(value)
    .replace(/\/api\/storage(?:\/[^?#]*)?/g, '/api/storage/[resource]')
    .replace(/\/s3(?:\/[^?#]*)?/g, '/s3/[resource]')
    .replace(/\/api\/projects(?:\/[^?#]*)?/g, '/api/projects/[resource]')
    .replace(/\/api\/db(?:\/[^?#]*)?/g, '/api/db/[resource]')
    .replace(/\/api\/manage(?:\/[^?#]*)?/g, '/api/manage/[resource]')
    .replace(/\/file(?:\/[^?#]*)?/g, '/file/[resource]');
}

/**
 * Drops request queries/fragments and masks Bot API path tokens and dynamic
 * application resources before data is sent to telemetry.
 */
export function sanitizeTelemetryUrl(value) {
  if (typeof value !== 'string' || !value) return '';
  try {
    const url = new URL(value);
    // Work on pathname rather than the complete origin + path so an endpoint
    // hostname such as s3.example.test is not mistaken for a /s3 route. Bot
    // token redaction needs the complete Telegram URL because its token starts
    // immediately after /bot rather than in a query/header field.
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'api.telegram.org') {
      return redactSensitiveText(`${url.origin}${url.pathname}`);
    }
    // The model-discovery API contains an account identifier in its path. It
    // is outbound operational traffic, not useful request context, so retain
    // only the provider origin.
    if (hostname === 'api.cloudflare.com') {
      return `${url.origin}/[provider-resource]`;
    }
    return `${url.origin}${redactSensitiveApplicationPath(redactSensitiveText(url.pathname))}`;
  } catch (_) {
    return redactSensitiveApplicationPath(redactSensitiveText(value.split(/[?#]/, 1)[0]));
  }
}

export function redactSensitiveText(value) {
  if (typeof value !== 'string') return value;
  if (SENSITIVE_SIGV4_MATERIAL.test(value)) return '[redacted sensitive SigV4 request material]';
  // Global regular expressions retain lastIndex after a match in some runtime
  // paths. Reset them so a prior breadcrumb cannot make the next URL skip
  // redaction.
  TELEGRAM_BOT_PATH.lastIndex = 0;
  SENSITIVE_QUERY_VALUE.lastIndex = 0;
  SENSITIVE_INLINE_VALUE.lastIndex = 0;
  DEVELOPER_API_KEY.lastIndex = 0;
  S3_ACCESS_KEY_ID.lastIndex = 0;
  return value
    .replace(TELEGRAM_BOT_PATH, '$1[redacted]/[telegram-resource]')
    .replace(SENSITIVE_QUERY_VALUE, '$1[redacted]')
    .replace(SENSITIVE_INLINE_VALUE, '$1[redacted]')
    .replace(DEVELOPER_API_KEY, 'tg_live_[redacted]')
    .replace(S3_ACCESS_KEY_ID, 'tgsk_live_[redacted]');
}

function sanitizeEmbeddedTelemetryText(value) {
  if (typeof value !== 'string') return value;
  // Automatic spans often contain a method followed by a full URL rather than
  // an event.request.url field. Sanitize each URL before ordinary text
  // redaction so query values and dynamic paths cannot survive in a span.
  const urlsSanitized = value.replace(/https?:\/\/[^\s<>"']+/gi, (url) => sanitizeTelemetryUrl(url));
  return redactSensitiveApplicationPath(redactSensitiveText(urlsSanitized));
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
    path = redactSensitiveApplicationPath(redactSensitiveText(url.pathname));
    hostname = url.hostname;
  } catch (_) {
    path = redactSensitiveApplicationPath(redactSensitiveText(String(rawUrl).split(/[?#]/, 1)[0]));
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
 * Recursively scrubs values captured by automatic Sentry breadcrumbs/context.
 * This is intentionally defensive: code should never attach a body or SigV4
 * internals, but field-name redaction prevents an accidental future attachment
 * from bypassing the request/header scrubber.
 */
function redactTelemetryData(value, depth = 0) {
  if (typeof value === 'string') return sanitizeEmbeddedTelemetryText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 5) return REDACTED;
  if (Array.isArray(value)) return value.map((entry) => redactTelemetryData(entry, depth + 1));

  const safe = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = String(rawKey);
    const lower = key.toLowerCase();
    if (isSensitiveTelemetryField(lower)) {
      safe[key] = REDACTED;
    } else if (lower === 'headers') {
      safe[key] = redactTelemetryHeaders(rawValue);
    } else if (lower === 'url' || lower === 'uri') {
      safe[key] = typeof rawValue === 'string' ? sanitizeTelemetryUrl(rawValue) : REDACTED;
    } else if (lower === 'path') {
      safe[key] = typeof rawValue === 'string'
        ? redactSensitiveApplicationPath(redactSensitiveText(rawValue))
        : REDACTED;
    } else if (lower === 'data') {
      // A string data field is indistinguishable from a captured request body.
      // Structured data may retain only recursively scrubbed safe metadata.
      safe[key] = rawValue && typeof rawValue === 'object'
        ? redactTelemetryData(rawValue, depth + 1)
        : REDACTED;
    } else {
      safe[key] = redactTelemetryData(rawValue, depth + 1);
    }
  }
  return safe;
}

/**
 * Sentry may collect a request automatically as well as through telemetryData.
 * Scrub that event at the integration boundary so credentials, signatures,
 * payload hashes/bodies, and raw dynamic paths never reach the remote service.
 */
export function redactTelemetryEvent(event) {
  if (!event || typeof event !== 'object') return event;
  const safeEvent = { ...event };

  if (event.request && typeof event.request === 'object') {
    const request = redactTelemetryData(event.request);
    request.headers = redactTelemetryHeaders(event.request.headers);
    if (event.request.url) request.url = sanitizeTelemetryUrl(String(event.request.url));
    // Request bodies can include credentials, multipart data, or documents.
    delete request.data;
    delete request.cookies;
    delete request.body;
    safeEvent.request = request;
  }

  if (typeof event.message === 'string') {
    safeEvent.message = sanitizeEmbeddedTelemetryText(event.message);
  }
  if (typeof event.transaction === 'string') {
    safeEvent.transaction = redactSensitiveApplicationPath(redactSensitiveText(event.transaction));
  }

  if (event.exception?.values && Array.isArray(event.exception.values)) {
    safeEvent.exception = {
      ...event.exception,
      values: event.exception.values.map((exception) => redactTelemetryData(exception)),
    };
  }

  if (Array.isArray(event.breadcrumbs)) {
    safeEvent.breadcrumbs = event.breadcrumbs.map((breadcrumb) => redactBreadcrumb(breadcrumb));
  }

  for (const field of ['contexts', 'extra', 'tags', 'fingerprint', 'spans']) {
    if (event[field] && typeof event[field] === 'object') {
      safeEvent[field] = redactTelemetryData(event[field]);
    }
  }

  return safeEvent;
}

function redactBreadcrumb(breadcrumb) {
  if (!breadcrumb || typeof breadcrumb !== 'object') return breadcrumb;
  const safe = redactTelemetryData(breadcrumb);
  if (typeof breadcrumb.message === 'string') safe.message = sanitizeEmbeddedTelemetryText(breadcrumb.message);
  return safe;
}

function routeFamily(request) {
  try {
    const pathname = new URL(request?.url || '').pathname;
    if (pathname === '/api/health') return 'health';
    if (pathname === '/api/config') return 'configuration';
    if (pathname.startsWith('/api/projects')) return 'projects';
    if (pathname.startsWith('/api/storage')) return 'storage';
    if (pathname.startsWith('/api/db')) return 'database';
    if (pathname.startsWith('/api/manage')) return 'management';
    if (pathname.startsWith('/s3')) return 's3';
    if (pathname.startsWith('/upload')) return 'upload';
    if (pathname.startsWith('/file')) return 'file';
  } catch (_) {
    // A malformed telemetry URL gets the same bounded fallback as any unknown
    // route; it is never copied into a tag.
  }
  return 'other';
}

function responseClass(response, exception = false) {
  if (exception) return 'exception';
  const status = Number(response?.status);
  if (!Number.isInteger(status) || status < 100 || status > 599) return 'unknown';
  return `${Math.floor(status / 100)}xx`;
}

function setSafeTelemetryTag(sentry, key, value) {
  try {
    if (sentry && typeof sentry.setTag === 'function') sentry.setTag(key, value);
  } catch (_) {
    // Observability must not turn a completed application request into a 5xx.
  }
}

function recordRequestOutcome(sentry, request, response, exception = false) {
  setSafeTelemetryTag(sentry, 'telegraph_cloud.route_family', routeFamily(request));
  setSafeTelemetryTag(sentry, 'telegraph_cloud.response_class', responseClass(response, exception));
}

/**
 * Adds a fixed, allowlisted operational outcome to an already-sampled Sentry
 * transaction. It deliberately rejects arbitrary names/values so callers
 * cannot turn this helper into a path, identifier, credential, or body sink.
 */
export function recordOperationalSignal(context, signal, outcome) {
  if (!Object.prototype.hasOwnProperty.call(SAFE_OPERATIONAL_SIGNALS, signal)
    || !SAFE_OPERATIONAL_SIGNALS[signal].has(outcome)) return;
  setSafeTelemetryTag(context?.data?.sentry, 'telegraph_cloud.signal', `${signal}:${outcome}`);
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
    const response = await context.next();
    recordRequestOutcome(sentry, context.request, response);
    return response;
  } catch (error) {
    // The result is a fixed enum; never attach the caught Error, which can
    // contain a request URL or upstream implementation detail.
    recordRequestOutcome(sentry, context.request, null, true);
    throw error;
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
