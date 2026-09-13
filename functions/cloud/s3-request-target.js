// Raw S3 request-target utilities shared by the protocol mapper and SigV4
// authentication layer. It intentionally has no credential, KV, Telegram,
// object-engine, or HMAC dependency.
const MAX_RAW_URI_BYTES = 16 * 1024;
const MAX_RAW_QUERY_BYTES = 16 * 1024;
const MAX_QUERY_COMPONENT_BYTES = 8 * 1024;
const MAX_QUERY_PAIRS = 100;
const HEX_PAIR = /^[0-9A-Fa-f]{2}$/;
const encoder = new TextEncoder();
// Keep a UTF-8 BOM as data rather than silently erasing it, so protocol
// controls cannot acquire a second spelling after percent decoding.
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export class S3RequestTargetError extends Error {
  constructor() {
    super('invalid_s3_request_target');
    this.name = 'S3RequestTargetError';
  }
}

function fail() {
  throw new S3RequestTargetError();
}

function byteLength(value) {
  return encoder.encode(String(value)).byteLength;
}

function isAsciiUnreserved(byte) {
  return (byte >= 0x41 && byte <= 0x5a)
    || (byte >= 0x61 && byte <= 0x7a)
    || (byte >= 0x30 && byte <= 0x39)
    || byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e;
}

function hexByte(value) {
  return Number.parseInt(value, 16);
}

/** Return the HTTP(S) URL representation made available to a Pages Function. */
export function s3RequestUrl(value) {
  try {
    const url = value instanceof URL ? value : new URL(typeof value === 'string' ? value : value?.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') fail();
    return url;
  } catch (error) {
    if (error instanceof S3RequestTargetError) throw error;
    fail();
  }
}

/**
 * Amazon S3's SigV4 path mode keeps the supplied path rather than applying a
 * second dot/slash normalization or another escaping pass. URL.pathname is the
 * request-target representation visible to Pages; valid percent escapes retain
 * their exact case and repeated/trailing slash form.
 */
export function canonicalS3Uri(value) {
  const url = s3RequestUrl(value);
  const pathname = url.pathname || '/';
  if (!pathname.startsWith('/') || byteLength(pathname) > MAX_RAW_URI_BYTES) fail();
  for (let index = 0; index < pathname.length; index += 1) {
    const code = pathname.charCodeAt(index);
    if (code === 0x25) {
      if (!HEX_PAIR.test(pathname.slice(index + 1, index + 3))) fail();
      index += 2;
    } else if (code <= 0x1f || code === 0x7f) {
      fail();
    }
  }
  // The narrow Telegraph object grammar is UTF-8 text, not arbitrary S3 byte
  // keys. Validate encoded path components here as well as at routing so an
  // invalid byte sequence cannot authenticate under one representation and
  // fail under another later stage. Preserve the original spelling for S3's
  // no-second-normalization canonical URI policy.
  for (const segment of pathname.split('/')) decodeRawComponent(segment);
  return pathname;
}

function appendLiteralUtf8(bytes, raw, index) {
  const code = raw.charCodeAt(index);
  if (code <= 0x7f) {
    bytes.push(code);
    return index;
  }
  const point = raw.codePointAt(index);
  if (point === undefined || (point >= 0xd800 && point <= 0xdfff)) fail();
  for (const byte of encoder.encode(String.fromCodePoint(point))) bytes.push(byte);
  return point > 0xffff ? index + 1 : index;
}

function decodeRawComponent(raw) {
  const bytes = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] === '%') {
      const pair = raw.slice(index + 1, index + 3);
      if (!HEX_PAIR.test(pair)) fail();
      bytes.push(hexByte(pair));
      index += 2;
    } else {
      index = appendLiteralUtf8(bytes, raw, index);
    }
    if (bytes.length > MAX_QUERY_COMPONENT_BYTES) fail();
  }
  const value = new Uint8Array(bytes);
  try {
    // `+` stays a literal plus unlike application/x-www-form-urlencoded.
    return Object.freeze({ bytes: value, text: decoder.decode(value) });
  } catch (_) {
    fail();
  }
}

function uriEncodeBytes(bytes) {
  let output = '';
  for (const byte of bytes) {
    output += isAsciiUnreserved(byte) ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return output;
}

/**
 * Parses a received S3 query without URLSearchParams, preserving repeats,
 * empty values, percent bytes, and literal pluses before canonical encoding.
 */
export function parseS3RawQuery(value) {
  const url = s3RequestUrl(value);
  const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  if (byteLength(rawQuery) > MAX_RAW_QUERY_BYTES) fail();
  if (!rawQuery) return Object.freeze([]);
  const rawPairs = rawQuery.split('&');
  if (rawPairs.length > MAX_QUERY_PAIRS || rawPairs.some((pair) => pair.length === 0)) fail();
  const pairs = rawPairs.map((pair) => {
    const separator = pair.indexOf('=');
    const rawName = separator < 0 ? pair : pair.slice(0, separator);
    const rawValue = separator < 0 ? '' : pair.slice(separator + 1);
    const name = decodeRawComponent(rawName);
    const entryValue = decodeRawComponent(rawValue);
    if (name.bytes.byteLength === 0) fail();
    return Object.freeze({
      name: name.text,
      value: entryValue.text,
      nameBytes: name.bytes,
      valueBytes: entryValue.bytes,
    });
  });
  return Object.freeze(pairs);
}

/** Canonical query sorting is after byte-wise S3 URI encoding, including repeats. */
export function canonicalS3Query(value) {
  const entries = Array.isArray(value) ? value : parseS3RawQuery(value);
  const encoded = entries.map((entry) => {
    if (!(entry?.nameBytes instanceof Uint8Array) || !(entry?.valueBytes instanceof Uint8Array)) fail();
    return {
      name: uriEncodeBytes(entry.nameBytes),
      value: uriEncodeBytes(entry.valueBytes),
    };
  });
  encoded.sort((left, right) => {
    if (left.name < right.name) return -1;
    if (left.name > right.name) return 1;
    if (left.value < right.value) return -1;
    if (left.value > right.value) return 1;
    return 0;
  });
  return encoded.map((entry) => `${entry.name}=${entry.value}`).join('&');
}
