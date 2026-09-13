import { readBoundedObjectBody } from './bounded-body.js';
import { resolveObjectStorageLimits } from './object-limits.js';
import {
  S3_CLOCK_SKEW_ENV,
  S3_CREDENTIAL_PEPPER_ENV,
  S3_ENDPOINT_HOST_ENV,
} from './s3-config.js';
import {
  S3RequestTargetError,
  canonicalS3Query as canonicalS3QueryFromTarget,
  canonicalS3Uri as canonicalS3UriFromTarget,
  parseS3RawQuery as parseS3RawQueryFromTarget,
  s3RequestUrl,
} from './s3-request-target.js';

// Preserve these small configuration/target exports for focused verifier use,
// while keeping the protocol mapper dependent only on target utilities.
export { S3_CLOCK_SKEW_ENV, S3_CREDENTIAL_PEPPER_ENV, S3_ENDPOINT_HOST_ENV } from './s3-config.js';

// This module contains only deterministic SigV4 parsing, canonicalization, and
// Web Crypto work. It deliberately has no credential, project, Telegram, KV,
// or S3 protocol-adapter dependency so it can be exercised with known signing
// fixtures without widening the protocol boundary.
export const S3_SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';
export const S3_SIGV4_REGION = 'us-east-1';
export const S3_SIGV4_SERVICE = 's3';
export const DEFAULT_S3_CLOCK_SKEW_SECONDS = 300;
export const MAX_S3_CLOCK_SKEW_SECONDS = 900;
export const EMPTY_SHA256_HEX = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

const MAX_SIGNED_HEADERS = 32;
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SIGNED_HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9a-z-]+$/;
const ACCESS_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;
const REQUEST_METHOD_PATTERN = /^[A-Z]{1,16}$/;
const FORBIDDEN_SIGNED_HEADERS = new Set([
  'authorization',
  'connection',
  'cookie',
  'expect',
  'forwarded',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'x-amzn-trace-id',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
]);
const SEMANTIC_HEADERS = new Set([
  'content-type',
  'idempotency-key',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'range',
]);
const FORBIDDEN_QUERY_NAMES = new Set([
  'access_key',
  'access-key',
  'api_key',
  'api-key',
  'authorization',
  'credential',
  'project_id',
  'project-id',
  'secret',
  'signature',
  'token',
]);
const encoder = new TextEncoder();

/**
 * A deliberately data-free failure marker. The S3 middleware converts only its
 * fixed `s3Code` to XML; neither raw Authorization data nor canonical strings
 * are ever attached to an error object.
 */
export class S3SigV4Error extends Error {
  constructor(s3Code) {
    super(s3Code);
    this.name = 'S3SigV4Error';
    this.s3Code = s3Code;
  }
}

function fail(s3Code) {
  throw new S3SigV4Error(s3Code);
}

function targetResult(callback) {
  try {
    return callback();
  } catch (error) {
    if (error instanceof S3RequestTargetError) fail('InvalidRequest');
    throw error;
  }
}

/** Re-exported verifier-facing target helpers map invalid target syntax safely. */
export function canonicalS3Uri(value) {
  return targetResult(() => canonicalS3UriFromTarget(value));
}

export function parseS3RawQuery(value) {
  return targetResult(() => parseS3RawQueryFromTarget(value));
}

export function canonicalS3Query(value) {
  return targetResult(() => canonicalS3QueryFromTarget(value));
}

function s3UrlForVerification(value) {
  return targetResult(() => s3RequestUrl(value));
}

function hexByte(value) {
  return Number.parseInt(value, 16);
}

function hexToBytes(value) {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-f]+$/.test(value)) {
    fail('AuthorizationHeaderMalformed');
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) bytes[index / 2] = hexByte(value.slice(index, index + 2));
  return bytes;
}

function bytesToHex(bytes) {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}

/** Fixed-work byte comparison for fixed-size digests, never string equality. */
export function constantTimeEqualBytes(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array)) return false;
  const length = Math.max(left.byteLength, right.byteLength);
  let difference = left.byteLength ^ right.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] || 0) ^ (right[index] || 0);
  }
  return difference === 0;
}

function requireCrypto(cryptoApi) {
  if (!cryptoApi?.subtle || typeof cryptoApi.subtle.digest !== 'function'
    || typeof cryptoApi.subtle.importKey !== 'function'
    || typeof cryptoApi.subtle.sign !== 'function'
    || typeof cryptoApi.subtle.verify !== 'function') {
    fail('ServiceUnavailable');
  }
  return cryptoApi;
}

async function sha256(bytes, cryptoApi) {
  try {
    return new Uint8Array(await requireCrypto(cryptoApi).subtle.digest('SHA-256', bytes));
  } catch (error) {
    if (error instanceof S3SigV4Error) throw error;
    fail('ServiceUnavailable');
  }
}

async function hmacKey(bytes, cryptoApi, usages) {
  try {
    return await requireCrypto(cryptoApi).subtle.importKey(
      'raw',
      bytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      usages,
    );
  } catch (_) {
    fail('ServiceUnavailable');
  }
}

async function hmacBytes(keyBytes, data, cryptoApi) {
  try {
    const signature = await requireCrypto(cryptoApi).subtle.sign(
      'HMAC',
      await hmacKey(keyBytes, cryptoApi, ['sign']),
      typeof data === 'string' ? encoder.encode(data) : data,
    );
    return new Uint8Array(signature);
  } catch (error) {
    if (error instanceof S3SigV4Error) throw error;
    fail('ServiceUnavailable');
  }
}


/** Header/query authentication is intentionally the only supported SigV4 form. */
export function assertNoForbiddenS3Query(value) {
  for (const entry of (Array.isArray(value) ? value : parseS3RawQuery(value))) {
    const name = entry.name.toLowerCase();
    if (name.startsWith('x-amz-') || FORBIDDEN_QUERY_NAMES.has(name)) fail('InvalidRequest');
  }
}

function parseSignedHeaders(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) fail('AuthorizationHeaderMalformed');
  const names = value.split(';');
  if (names.length > MAX_SIGNED_HEADERS) fail('AuthorizationHeaderMalformed');
  let previous = '';
  for (const name of names) {
    if (!SIGNED_HEADER_NAME_PATTERN.test(name) || name <= previous) fail('AuthorizationHeaderMalformed');
    if (FORBIDDEN_SIGNED_HEADERS.has(name)) fail('InvalidRequest');
    previous = name;
  }
  if (!names.includes('host') || !names.includes('x-amz-date') || !names.includes('x-amz-content-sha256')) {
    fail('AuthorizationHeaderMalformed');
  }
  return Object.freeze(names);
}

/** Parse one exact header-form AWS4-HMAC-SHA256 Authorization value. */
export function parseS3SigV4Authorization(value) {
  if (value === null || value === undefined || value === '') fail('AccessDenied');
  if (typeof value !== 'string' || /[\r\n\u0000]/.test(value)) fail('AuthorizationHeaderMalformed');
  // Accept the normal AWS comma separator with zero or one ASCII space, while
  // still rejecting tabs, repeated whitespace, and a coalesced duplicate
  // Authorization value instead of giving it an alternate interpretation.
  const match = /^AWS4-HMAC-SHA256 Credential=([A-Za-z0-9_-]+)\/(\d{8})\/([a-z0-9-]+)\/([a-z0-9-]+)\/aws4_request, ?SignedHeaders=([^,\s]+), ?Signature=([^,\s]+)$/.exec(value);
  if (!match) fail('AuthorizationHeaderMalformed');
  const [, accessKeyId, dateStamp, region, service, rawSignedHeaders, signature] = match;
  if (!ACCESS_KEY_ID_PATTERN.test(accessKeyId) || !SIGNATURE_PATTERN.test(signature)
    || region !== S3_SIGV4_REGION || service !== S3_SIGV4_SERVICE) {
    fail('AuthorizationHeaderMalformed');
  }
  return Object.freeze({
    algorithm: S3_SIGV4_ALGORITHM,
    accessKeyId,
    dateStamp,
    region,
    service,
    signedHeaders: parseSignedHeaders(rawSignedHeaders),
    signature,
  });
}

function normalizeHeaderValue(value) {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) {
    fail('AuthorizationHeaderMalformed');
  }
  return value.replace(/^[ \t]+|[ \t]+$/g, '').replace(/[ \t]+/g, ' ');
}

function requestMethod(request) {
  const method = request?.method;
  if (typeof method !== 'string' || !REQUEST_METHOD_PATTERN.test(method)) fail('InvalidRequest');
  return method;
}

function requestHeaders(request) {
  if (!request?.headers || typeof request.headers.entries !== 'function') fail('InvalidRequest');
  const headers = new Map();
  for (const [rawName, rawValue] of request.headers.entries()) {
    const name = String(rawName).toLowerCase();
    if (!HEADER_NAME_PATTERN.test(name) || headers.has(name) || typeof rawValue !== 'string') {
      fail('AuthorizationHeaderMalformed');
    }
    headers.set(name, rawValue);
  }
  return headers;
}

function parseHost(value, errorCode) {
  if (typeof value !== 'string' || value !== value.trim() || value.length === 0 || value.length > 253 || value.includes(',')) {
    fail(errorCode);
  }
  const lower = value.toLowerCase();
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::([1-9][0-9]{0,4}))?$/.exec(lower);
  if (!match || match[1].includes('..')) fail(errorCode);
  if (match[2] !== undefined && Number(match[2]) > 65535) fail(errorCode);
  if (match[1].split('.').some((label) => label.length === 0 || label.length > 63 || label.startsWith('-') || label.endsWith('-'))) {
    fail(errorCode);
  }
  return lower;
}

function canonicalHostForProtocol(value, protocol, errorCode) {
  const safeHost = parseHost(value, errorCode);
  if (protocol !== 'http:' && protocol !== 'https:') fail(errorCode);
  try {
    return new URL(`${protocol}//${safeHost}`).host;
  } catch (_) {
    fail(errorCode);
  }
}

/** Resolve a fixed, server-configured path-style endpoint host; no wildcards. */
export function resolveS3EndpointHost(env = {}) {
  return parseHost(env?.[S3_ENDPOINT_HOST_ENV], 'ServiceUnavailable');
}

/** Resolve the small bounded UTC signing-window policy. */
export function resolveS3ClockSkewSeconds(env = {}) {
  const raw = env?.[S3_CLOCK_SKEW_ENV];
  if (raw === undefined || raw === null || raw === '') return DEFAULT_S3_CLOCK_SKEW_SECONDS;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,3}$/.test(raw)) fail('ServiceUnavailable');
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds > MAX_S3_CLOCK_SKEW_SECONDS) fail('ServiceUnavailable');
  return seconds;
}

function parseAmzDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) fail('AuthorizationHeaderMalformed');
  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const hour = Number(rawHour);
  const minute = Number(rawMinute);
  const second = Number(rawSecond);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second) {
    fail('AuthorizationHeaderMalformed');
  }
  return Object.freeze({ value, dateStamp: `${rawYear}${rawMonth}${rawDay}`, milliseconds: date.getTime() });
}

function nowMilliseconds(now) {
  const value = typeof now === 'function' ? now() : now;
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds) || milliseconds < 0) fail('ServiceUnavailable');
  return milliseconds;
}

function canonicalHeaders(headers, signedHeaders) {
  const rows = [];
  const signed = new Set(signedHeaders);
  for (const name of signedHeaders) {
    if (!headers.has(name)) fail('AuthorizationHeaderMalformed');
    const rawValue = headers.get(name);
    // Fetch coalesces repeated field values. Rejecting a comma in a signed
    // field gives the endpoint one unambiguous canonical representation rather
    // than attempting to distinguish a single comma value from duplicates.
    if (rawValue.includes(',')) fail('AuthorizationHeaderMalformed');
    rows.push(`${name}:${normalizeHeaderValue(rawValue)}\n`);
  }
  for (const [name] of headers.entries()) {
    if (name.startsWith('x-amz-') && !signed.has(name)) fail('AuthorizationHeaderMalformed');
    if (SEMANTIC_HEADERS.has(name) && !signed.has(name)) fail('InvalidRequest');
  }
  return rows.join('');
}

function assertEndpointHost(headers, requestUrl, endpointHost) {
  if (!headers.has('host')) fail('AuthorizationHeaderMalformed');
  // Normalize only an explicit default port in the context of the received
  // scheme. Non-default alternate ports remain part of both signature and
  // endpoint policy, while `:443` on HTTPS is the same endpoint as no port.
  const host = canonicalHostForProtocol(
    normalizeHeaderValue(headers.get('host')),
    requestUrl.protocol,
    'AuthorizationHeaderMalformed',
  );
  const observed = canonicalHostForProtocol(requestUrl.host, requestUrl.protocol, 'AuthorizationHeaderMalformed');
  const expected = canonicalHostForProtocol(endpointHost, requestUrl.protocol, 'ServiceUnavailable');
  if (host !== expected || observed !== expected) fail('AuthorizationHeaderMalformed');
}

async function payloadHash(request, headers, method, env, cryptoApi) {
  if (!headers.has('x-amz-content-sha256')) fail('AuthorizationHeaderMalformed');
  const supplied = normalizeHeaderValue(headers.get('x-amz-content-sha256'));
  // Header-form Telegraph S3 requests intentionally do not permit the relaxed
  // S3/HTTPS UNSIGNED-PAYLOAD variant or streaming/chunked SigV4 variants.
  if (supplied === 'UNSIGNED-PAYLOAD' || !/^[0-9a-f]{64}$/.test(supplied)) fail('InvalidRequest');
  let cloned;
  try {
    cloned = request.clone();
  } catch (_) {
    fail('InvalidRequest');
  }
  const bytes = await readBoundedObjectBody(cloned, resolveObjectStorageLimits(env));
  if (method !== 'PUT' && bytes.byteLength !== 0) fail('InvalidRequest');
  const calculated = await sha256(bytes, cryptoApi);
  // This compares fixed-size digest bytes in fixed work before the canonical
  // request can be authenticated; it intentionally never compares hash text.
  if (!constantTimeEqualBytes(calculated, hexToBytes(supplied))) fail('XAmzContentSHA256Mismatch');
  return supplied;
}

async function deriveSigningKey(secretAccessKey, dateStamp, cryptoApi) {
  if (typeof secretAccessKey !== 'string' || secretAccessKey.length < 1 || secretAccessKey.length > 256) {
    fail('ServiceUnavailable');
  }
  let key = await hmacBytes(encoder.encode(`AWS4${secretAccessKey}`), dateStamp, cryptoApi);
  key = await hmacBytes(key, S3_SIGV4_REGION, cryptoApi);
  key = await hmacBytes(key, S3_SIGV4_SERVICE, cryptoApi);
  return hmacBytes(key, 'aws4_request', cryptoApi);
}

async function verifyFinalSignature(signingKey, stringToSign, signature, cryptoApi) {
  try {
    const key = await hmacKey(signingKey, cryptoApi, ['verify']);
    // Web Crypto's HMAC verify operation performs the MAC comparison in the
    // cryptographic implementation. There is deliberately no JavaScript
    // `===`/string comparison of attacker-provided signature material here.
    return await requireCrypto(cryptoApi).subtle.verify(
      'HMAC',
      key,
      hexToBytes(signature),
      encoder.encode(stringToSign),
    );
  } catch (error) {
    if (error instanceof S3SigV4Error) throw error;
    fail('ServiceUnavailable');
  }
}

/**
 * Verifies an already-resolved credential's header-form SigV4 request. The
 * caller owns direct credential lookup and never receives a secret from this
 * function. Successful results intentionally omit canonical request details.
 */
export async function verifyS3SigV4Request(request, {
  accessKeyId,
  secretAccessKey,
  env = {},
  cryptoApi = globalThis.crypto,
  now = () => Date.now(),
} = {}) {
  const method = requestMethod(request);
  const headers = requestHeaders(request);
  // Parse the received header again after credential lookup. This makes the
  // verifier authoritative even if a caller accidentally retained stale parsed
  // data rather than trusting a pre-parsed Authorization object.
  const parsed = parseS3SigV4Authorization(headers.get('authorization'));
  if (typeof accessKeyId !== 'string' || parsed.accessKeyId !== accessKeyId) fail('InvalidAccessKeyId');

  // The narrow object facade stores and serves exact buffered bytes; it does
  // not preserve a Content-Encoding delivery contract. Reject it rather than
  // signing one representation and accidentally serving another.
  if (headers.has('content-encoding')) fail('InvalidRequest');

  const requestUrl = s3UrlForVerification(request);
  const endpointHost = resolveS3EndpointHost(env);
  assertEndpointHost(headers, requestUrl, endpointHost);
  const query = parseS3RawQuery(requestUrl);
  assertNoForbiddenS3Query(query);

  const amzDate = parseAmzDate(normalizeHeaderValue(headers.get('x-amz-date')));
  if (amzDate.dateStamp !== parsed.dateStamp) fail('AuthorizationHeaderMalformed');
  if (Math.abs(nowMilliseconds(now) - amzDate.milliseconds) > resolveS3ClockSkewSeconds(env) * 1000) {
    fail('RequestTimeTooSkewed');
  }

  const canonicalHeaderBlock = canonicalHeaders(headers, parsed.signedHeaders);
  const hash = await payloadHash(request, headers, method, env, cryptoApi);
  const canonicalRequest = `${method}\n${canonicalS3Uri(requestUrl)}\n${canonicalS3Query(query)}\n${canonicalHeaderBlock}\n${parsed.signedHeaders.join(';')}\n${hash}`;
  const credentialScope = `${parsed.dateStamp}/${S3_SIGV4_REGION}/${S3_SIGV4_SERVICE}/aws4_request`;
  const stringToSign = `${S3_SIGV4_ALGORITHM}\n${amzDate.value}\n${credentialScope}\n${bytesToHex(await sha256(encoder.encode(canonicalRequest), cryptoApi))}`;
  const signatureIsValid = await verifyFinalSignature(
    await deriveSigningKey(secretAccessKey, parsed.dateStamp, cryptoApi),
    stringToSign,
    parsed.signature,
    cryptoApi,
  );
  if (!signatureIsValid) fail('SignatureDoesNotMatch');

  return Object.freeze({
    accessKeyId: parsed.accessKeyId,
    signingDate: amzDate.value,
    credentialScope,
  });
}
