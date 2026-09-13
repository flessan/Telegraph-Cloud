const { createHash, createHmac } = require('crypto');

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

function bytes(value) {
  if (value === undefined || value === null) return Buffer.alloc(0);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  return Buffer.from(value);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key, value, encoding) {
  return createHmac('sha256', key).update(value, 'utf8').digest(encoding);
}

function awsEncode(value) {
  return Array.from(Buffer.from(value, 'utf8'), (byte) => {
    const character = String.fromCharCode(byte);
    return /[A-Za-z0-9\-_.~]/.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }).join('');
}

function strictDecode(raw) {
  return decodeURIComponent(raw);
}

function canonicalQuery(url) {
  const raw = new URL(url).search.slice(1);
  if (!raw) return '';
  return raw.split('&').map((part) => {
    const split = part.indexOf('=');
    const rawName = split < 0 ? part : part.slice(0, split);
    const rawValue = split < 0 ? '' : part.slice(split + 1);
    return [awsEncode(strictDecode(rawName)), awsEncode(strictDecode(rawValue))];
  }).sort((left, right) => (
    left[0] === right[0] ? (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0) : left[0] < right[0] ? -1 : 1
  )).map(([name, value]) => `${name}=${value}`).join('&');
}

function normalizeHeader(value) {
  return String(value).trim().replace(/[ \t]+/g, ' ');
}

/**
 * Independent test-only header-form S3 SigV4 signer. It deliberately uses
 * Node's crypto HMAC implementation rather than the Worker verifier helpers.
 */
function signS3Request({
  url,
  method = 'GET',
  accessKeyId,
  secretAccessKey,
  body,
  headers = {},
  amzDate = '20260913T080000Z',
  region = 'us-east-1',
  service = 's3',
} = {}) {
  const target = new URL(url);
  const payload = bytes(body);
  const signed = new Headers(headers);
  signed.set('host', target.host);
  signed.set('x-amz-date', amzDate);
  signed.set('x-amz-content-sha256', sha256(payload));
  const signedHeaderNames = Array.from(signed.keys()).map((name) => name.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames.map((name) => `${name}:${normalizeHeader(signed.get(name))}\n`).join('');
  const methodName = method.toUpperCase();
  const canonicalRequest = `${methodName}\n${target.pathname}\n${canonicalQuery(target)}\n${canonicalHeaders}\n${signedHeaderNames.join(';')}\n${sha256(payload)}`;
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonicalRequest)}`;
  let signingKey = hmac(Buffer.from(`AWS4${secretAccessKey}`, 'utf8'), dateStamp);
  signingKey = hmac(signingKey, region);
  signingKey = hmac(signingKey, service);
  signingKey = hmac(signingKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');
  signed.set('authorization', `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames.join(';')}, Signature=${signature}`);
  return new Request(target, {
    method: methodName,
    headers: signed,
    ...(body === undefined ? {} : { body: payload }),
  });
}

function cloneWithBody(request, body) {
  return new Request(request.url, {
    method: request.method,
    headers: new Headers(request.headers),
    body,
  });
}

module.exports = {
  EMPTY_SHA256,
  canonicalQuery,
  signS3Request,
  cloneWithBody,
};
