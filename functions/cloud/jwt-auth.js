// JWT developer authentication (ES256) for the Telegraph Cloud data plane.
//
// Design:
//   - Asymmetric signing: ECDSA P-256 with SHA-256 ("ES256") via WebCrypto,
//     available identically in Workers and Node.
//   - Signing keys live only in TELEGRAPH_CLOUD_KV. The private JWK is used to
//     sign and is never returned by any list/JWKS/public surface. Rotation
//     purges the retired key's private material entirely — verification needs
//     only the public key.
//   - Tokens are short-lived by construction: the TTL is chosen by the caller
//     within a hard 60–3600 s window (default 900 s). Claims carry issuer,
//     audience, subject (the issuing API key id), the project scope, the
//     developer scopes, iat/exp, and a jti. The kid header selects the
//     verification key.
//   - Verification pins alg=ES256 (no algorithm negotiation), requires a known
//     kid, and checks iss/aud/exp/iat before accepting the project/scope
//     claims. The resulting authentication object mirrors the developer API
//     key shape so the existing middleware scoping applies unchanged.
//   - Existing `tg_live_…` API keys keep working; JWTs are an additional
//     credential form, not a replacement.
import {
  CloudConfigurationError,
  CloudUnauthorizedError,
  CloudValidationError,
} from './errors.js';
import { createCloudIndexStore } from './index-store.js';
import { API_KEY_SCOPES } from './developer-api-keys.js';
import { CLOUD_LIMITS, utf8ByteLength } from './validation.js';

export const JWT_SIGNING_KEY_SCHEMA = 'telegraph-cloud.jwt-signing-key.v1';
export const JWT_INDEX_NAMESPACES = Object.freeze({
  signingKey: 'jwt-signing-key',
});
export const JWT_ALGORITHM = 'ES256';
export const JWT_AUDIENCE = 'telegraph-api';
export const JWT_ISSUER_ENV = 'TELEGRAPH_CLOUD_JWT_ISSUER';
// Short-lived by construction. The maximum exists so a leaked token ages out
// quickly even when misconfigured upward.
export const JWT_TTL = Object.freeze({ default: 900, min: 60, max: 3600 });
// Issued-at tolerance for tiny clock drift between issuer and verifier.
const IAT_LEEWAY_SECONDS = 30;
const KID_RANDOM_BYTES = 12;

const encoder = new TextEncoder();
const SIGNING_KEY_STATUS = new Set(['current', 'retired']);

function b64urlEncode(value) {
  const bytes = value instanceof Uint8Array ? value : encoder.encode(String(value));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) {
    throw new Error('invalid base64url');
  }
  let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function b64urlJson(value) {
  return b64urlEncode(encoder.encode(JSON.stringify(value)));
}

function jsonValue(encoded) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(encoded));
}

function toUnixSeconds(date) {
  return Math.floor(date.getTime() / 1000);
}

function publicJwkFrom(privateJwk) {
  // Public JWKS members only. The private parameter `d` and signing
  // key_ops never leave this module.
  return {
    kty: privateJwk.kty,
    crv: privateJwk.crv,
    x: privateJwk.x,
    y: privateJwk.y,
  };
}

function assertIssuer(value) {
  if (typeof value !== 'string' || !/^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/.test(value)
    || utf8ByteLength(value) > 256) {
    throw new CloudValidationError('invalid_jwt_issuer', 'JWT issuer must be an absolute http(s) origin.');
  }
  return value.replace(/\/$/, '');
}

export function resolveJwtIssuer(env, request) {
  const configured = env?.[JWT_ISSUER_ENV];
  if (configured !== undefined && configured !== null && String(configured).trim() !== '') {
    return assertIssuer(String(configured).trim());
  }
  return assertIssuer(new URL(request.url).origin);
}

function normalizeExpiresIn(value) {
  if (value === undefined || value === null) return JWT_TTL.default;
  if (!Number.isSafeInteger(value) || value < JWT_TTL.min || value > JWT_TTL.max) {
    throw new CloudValidationError(
      'invalid_token_ttl',
      `Token lifetime must be between ${JWT_TTL.min} and ${JWT_TTL.max} seconds.`,
    );
  }
  return value;
}

function randomKid() {
  const bytes = new Uint8Array(KID_RANDOM_BYTES);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}

async function generateSigningKeyRecord({ kid, createdAt }) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  if (!privateJwk || typeof privateJwk.d !== 'string') {
    throw new CloudConfigurationError('jwt_keygen_failed', 'JWT signing key generation failed.');
  }
  return {
    schema: JWT_SIGNING_KEY_SCHEMA,
    kid,
    status: 'current',
    algorithm: JWT_ALGORITHM,
    private_jwk: {
      kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, d: privateJwk.d,
    },
    public_jwk: publicJwkFrom(privateJwk),
    created_at: createdAt,
    retired_at: null,
  };
}

function assertPublicJwk(value) {
  if (!value || typeof value !== 'object'
    || value.kty !== 'EC' || value.crv !== 'P-256'
    || typeof value.x !== 'string' || typeof value.y !== 'string') {
    throw new CloudConfigurationError('jwt_signing_key_invalid', 'The stored JWT signing key is invalid.');
  }
  return value;
}

export function createJwtAuthService(env, { index = null, now = () => new Date(), createId = randomKid } = {}) {
  const cloudIndex = index || createCloudIndexStore(env);
  if (!cloudIndex || typeof cloudIndex.getJson !== 'function' || typeof cloudIndex.putJson !== 'function'
    || typeof cloudIndex.list !== 'function') {
    throw new CloudConfigurationError('cloud_index_unavailable', 'The Telegraph Cloud index is unavailable.');
  }

  const namespace = JWT_INDEX_NAMESPACES.signingKey;
  const CURRENT_KEY_POINTER = ['current'];

  async function readKeyRecord(kid) {
    if (typeof kid !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(kid)) return null;
    const record = await cloudIndex.getJson(namespace, kid);
    if (!record || record.schema !== JWT_SIGNING_KEY_SCHEMA || record.kid !== kid
      || !SIGNING_KEY_STATUS.has(record.status) || record.algorithm !== JWT_ALGORITHM) {
      return null;
    }
    return record;
  }

  async function writeKeyRecord(record) {
    await cloudIndex.putJson(namespace, [record.kid], record);
  }

  // The current signing key, created on first use. The private JWK never
  // leaves this service; callers receive only the kid.
  async function currentSigningKey() {
    const pointer = await cloudIndex.getJson(namespace, CURRENT_KEY_POINTER);
    if (pointer && typeof pointer.kid === 'string') {
      const record = await readKeyRecord(pointer.kid);
      if (record && record.status === 'current' && record.private_jwk) return record;
    }
    const createdAt = now().toISOString();
    const record = await generateSigningKeyRecord({ kid: createId(), createdAt });
    await writeKeyRecord(record);
    await cloudIndex.putJson(namespace, CURRENT_KEY_POINTER, { kid: record.kid });
    return record;
  }

  async function importVerificationKey(publicJwk) {
    return crypto.subtle.importKey(
      'jwk',
      { ...publicJwk, key_ops: ['verify'], ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['verify'],
    );
  }

  /**
   * Issue a short-lived JWT for an already-authenticated developer identity
   * (the API-key authentication object). Never logs or returns private keys.
   */
  async function issueToken({ project_id, key_id, scopes, issuer, expiresIn } = {}) {
    if (typeof project_id !== 'string' || typeof key_id !== 'string' || !Array.isArray(scopes)) {
      throw new CloudValidationError('invalid_token_request', 'Token issuance requires a project, key id, and scopes.');
    }
    const issuerValue = assertIssuer(issuer);
    const ttl = normalizeExpiresIn(expiresIn);
    const allowed = new Set(API_KEY_SCOPES);
    const tokenScopes = scopes.filter((scope) => allowed.has(scope));
    if (!tokenScopes.length) {
      throw new CloudValidationError('invalid_token_request', 'Token issuance requires at least one known scope.');
    }

    const keyRecord = await currentSigningKey();
    const issuedAt = toUnixSeconds(now());
    const header = { alg: JWT_ALGORITHM, typ: 'JWT', kid: keyRecord.kid };
    const claims = {
      iss: issuerValue,
      aud: JWT_AUDIENCE,
      sub: key_id,
      project: project_id,
      scopes: [...tokenScopes],
      iat: issuedAt,
      exp: issuedAt + ttl,
      jti: createId(),
    };
    const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      { ...keyRecord.private_jwk, key_ops: ['sign'], ext: true },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    );
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      encoder.encode(signingInput),
    );
    return {
      access_token: `${signingInput}.${b64urlEncode(new Uint8Array(signature))}`,
      token_type: 'Bearer',
      expires_in: ttl,
      scope: tokenScopes.join(' '),
    };
  }

  /**
   * Verify a compact JWT and return the same authentication shape the API-key
   * path produces (plus `authentication: 'jwt'`). Every failure is a typed
   * 401; nothing about the failure leaks key or claim material.
   */
  async function verifyToken(token, { issuer } = {}) {
    if (typeof token !== 'string' || utf8ByteLength(token) > 16 * 1024) {
      throw new CloudUnauthorizedError('invalid_token', 'The access token is invalid.');
    }
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new CloudUnauthorizedError('invalid_token', 'The access token is invalid.');
    }
    let header;
    let claims;
    try {
      header = jsonValue(b64urlDecode(parts[0]));
      claims = jsonValue(b64urlDecode(parts[1]));
    } catch (_) {
      throw new CloudUnauthorizedError('invalid_token', 'The access token is invalid.');
    }
    if (!header || header.alg !== JWT_ALGORITHM || header.typ !== 'JWT' || typeof header.kid !== 'string') {
      throw new CloudUnauthorizedError('invalid_token', 'The access token is invalid.');
    }
    const issuerValue = assertIssuer(issuer);
    const keyRecord = await readKeyRecord(header.kid);
    if (!keyRecord) {
      throw new CloudUnauthorizedError('invalid_token', 'The access token is invalid.');
    }

    let valid = false;
    try {
      valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        await importVerificationKey(assertPublicJwk(keyRecord.public_jwk)),
        b64urlDecode(parts[2]),
        encoder.encode(`${parts[0]}.${parts[1]}`),
      );
    } catch (_) {
      valid = false;
    }
    if (!valid) {
      throw new CloudUnauthorizedError('invalid_token', 'The access token is invalid.');
    }

    const nowSeconds = toUnixSeconds(now());
    if (!claims || typeof claims !== 'object') {
      throw new CloudUnauthorizedError('invalid_token', 'The access token is invalid.');
    }
    if (claims.iss !== issuerValue) {
      throw new CloudUnauthorizedError('invalid_token', 'The access token was not issued for this deployment.');
    }
    if (claims.aud !== JWT_AUDIENCE) {
      throw new CloudUnauthorizedError('invalid_token', 'The access token was not issued for this API.');
    }
    if (!Number.isSafeInteger(claims.exp) || claims.exp <= nowSeconds) {
      throw new CloudUnauthorizedError('token_expired', 'The access token has expired.');
    }
    if (!Number.isSafeInteger(claims.iat) || claims.iat > nowSeconds + IAT_LEEWAY_SECONDS) {
      throw new CloudUnauthorizedError('invalid_token', 'The access token is invalid.');
    }
    if (typeof claims.sub !== 'string' || typeof claims.project !== 'string' || !claims.project
      || !Array.isArray(claims.scopes)) {
      throw new CloudUnauthorizedError('invalid_token', 'The access token is invalid.');
    }
    const allowed = new Set(API_KEY_SCOPES);
    const scopes = claims.scopes.filter((scope) => allowed.has(scope));

    return Object.freeze({
      authentication: 'jwt',
      project_id: claims.project,
      key_id: claims.sub,
      scopes,
      token_id: typeof claims.jti === 'string' ? claims.jti : null,
    });
  }

  /**
   * Public keys only, for /.well-known/jwks.json. Current and retired keys are
   * both published so tokens signed before a rotation stay verifiable. The
   * private JWK (`d`) is never part of this output.
   */
  async function publicJwks() {
    const page = await cloudIndex.list(namespace, { limit: CLOUD_LIMITS.MAX_COLLECTION_SCAN_KEYS || 1000 });
    const keys = [];
    for (const entry of page?.keys || []) {
      const kid = String(entry?.name || '').split(':').pop();
      const record = await readKeyRecord(kid);
      if (!record) continue;
      keys.push({
        ...assertPublicJwk(record.public_jwk),
        kid: record.kid,
        alg: JWT_ALGORITHM,
        use: 'sig',
        key_ops: ['verify'],
      });
    }
    return { keys };
  }

  /**
   * Rotate signing keys: the previous key becomes retired (kept for
   * verification of outstanding tokens) and its private material is purged
   * immediately. New tokens are signed by the new key.
   */
  async function rotateSigningKeys() {
    const previous = await currentSigningKey();
    const createdAt = now().toISOString();
    const next = await generateSigningKeyRecord({ kid: createId(), createdAt });
    await writeKeyRecord(next);
    await cloudIndex.putJson(namespace, CURRENT_KEY_POINTER, { kid: next.kid });

    const retired = {
      ...previous,
      status: 'retired',
      retired_at: createdAt,
      private_jwk: null,
    };
    await writeKeyRecord(retired);
    return {
      rotated: true,
      current_kid: next.kid,
      retired_kid: previous.kid,
    };
  }

  return Object.freeze({
    issueToken,
    verifyToken,
    publicJwks,
    rotateSigningKeys,
  });
}
