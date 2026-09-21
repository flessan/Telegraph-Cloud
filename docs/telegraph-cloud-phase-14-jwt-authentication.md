# Telegraph Cloud — Phase 14: Application/service JWT authentication

Phase 14 adds short-lived, asymmetrically signed JWT authentication for
applications and services, alongside — never replacing — the existing
`tg_live_…` developer API keys. Every Bearer-protected developer route now
accepts both credential forms; keys remain the only dashboard-facing flow.

## Token model

- **Algorithm**: ES256 (ECDSA P-256 + SHA-256 via WebCrypto). The `alg`
  header is pinned — no algorithm negotiation, no `none`.
- **Claims**: `iss` (deployment issuer), `aud` (`telegraph-api`),
  `sub` (issuing API-key id), `project` (project scope), `scopes`,
  `iat`, `exp`, `jti` (token id). Header carries `kid`.
- **Lifetime**: 900 s by default, bounded to 60–3600 s (`expires_in` on
  `POST /api/auth/token` can only shorten within bounds). 30 s `iat` leeway;
  expired ⇒ `401 token_expired`; every other failure ⇒ `401 invalid_token`.
- **Issuer**: `TELEGRAPH_CLOUD_JWT_ISSUER` if configured, otherwise the
  request origin (absolute http(s), trailing slash stripped; otherwise
  `400 invalid_jwt_issuer`).
- **Size**: tokens over 16 KB are rejected.
- **Verification result**: the same frozen authentication shape the API-key
  path produces, plus `authentication: 'jwt'` and `token_id` (`jti`). Scopes
  are filtered to the four known API-key scopes; the project boundary comes
  only from the verified `project` claim.

## Routes added

| Route | Auth | Behavior |
| --- | --- | --- |
| `POST /api/auth/token` | Bearer (`tg_live_…` key or unexpired JWT) | Exchanges the credential for a short-lived JWT that inherits its project + scopes. Body (optional JSON): `expires_in` only — unknown fields ⇒ `400 invalid_token_request`. `no-store`. |
| `GET /HEAD /.well-known/jwks.json` | Public | JWKS with **public keys only** (`kty/crv/x/y/kid/alg/use/key_ops` — never `d`). `Cache-Control: public, max-age=300`; failure ⇒ `{keys:[]}` with `no-store`. |
| `POST /api/auth/keys/rotate` | Dashboard (Basic + session) | Rotates the signing key: `{rotated, current_kid, retired_kid}` — no key material. `503 dashboard_auth_not_configured` when dashboard auth is unconfigured. |

`POST /api/auth/keys/rotate` is an operator surface and is deliberately not
in the developer OpenAPI document; `POST /api/auth/token` and
`/.well-known/jwks.json` are.

## Key management

- Signing keys live only in the KV namespace `jwt-signing-key`
  (`tc:v1:jwt-signing-key:{kid}`), created lazily on first use. Records:
  `{schema, kid, status: current|retired, algorithm, private_jwk, public_jwk,
  created_at, retired_at}`; a `['current']` pointer names the signer.
- **Rotation**: the current key becomes `retired`, its `private_jwk` is set
  to `null` (purged from KV), and a fresh key signs new tokens. The retired
  public key stays in the JWKS so outstanding tokens keep verifying until
  they expire naturally.
- **Private keys never leave KV** and never appear in any response, error,
  log, or the JWKS. No secrets in URLs or web storage anywhere in the flow.

## Compatibility (unchanged)

- `tg_live_…` API keys keep working exactly as before and remain the only
  credential the console issues; the Connect credential-creation flow is
  untouched.
- Dispatch is shape-based: a 3-segment compact JWS routes to JWT
  verification, anything else to the API-key verifier — the two forms cannot
  collide because keys never contain dots.
- Dashboard-legacy database mode (no Bearer header) is unchanged; storage
  middleware funnels through the same shared
  `authenticateDeveloperBearer`, so it gains JWT support automatically.
- A token can never exceed the authority of the credential used to obtain
  it: it inherits project and scopes at issue time.

## OpenAPI / console documentation

- `functions/cloud/openapi.js` catalog adds `/api/auth/token` (POST,
  Bearer) and `/.well-known/jwks.json` (GET, public) with full schemas; the
  accuracy test still proves every documented path maps to a real function
  file and no undocumented data-plane route exists. The `bearerApi` scheme
  description now mentions both accepted credential forms; `x-service.jwks`
  points at the now-real endpoint.
- Console API table lists the token exchange, JWKS, and rotation routes;
  the zh locale catalog was extended accordingly.

## Tests (test/jwt-auth.test.js — 10 cases)

1. Issues and verifies a valid JWT with all required claims and scopes.
2. Authenticates a valid JWT through the shared developer middleware and
   serves the project scope (real project + real key id).
3. Exchanges an API key for a token through `POST /api/auth/token`; the key
   keeps authenticating directly afterwards (regression).
4. Rejects an expired JWT with `token_expired` (moving clock, direct and
   through the middleware).
5. Rejects a JWT whose issuer is not this deployment.
6. Rejects a foreign audience even when correctly signed (white-box forged
   token signed with the deployment's own key).
7. Rejects tampered payloads, foreign-key signatures with a deployed kid,
   and unknown kids.
8. Enforces middleware scope checks against the token scopes
   (`db:read` ⇒ GET 200, write ⇒ `403 api_key_scope_forbidden`).
9. Publishes public keys only through the JWKS (member set, no `d`, route
   served with the public cache header).
10. Rotates signing keys: old tokens verify, new tokens use the new kid,
    the retired record's private material is purged, both kids are
    published, and the rotate route fails closed (503) unconfigured.

Full suite: **560 passing / 0 failing** (phase 13 ended at 550; the delta is
the 10 new JWT cases — the OpenAPI accuracy test was extended in place).
