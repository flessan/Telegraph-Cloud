import { isEmptyBinding } from '../utils/http.js';
import { S3_CREDENTIAL_PEPPER_ENV } from './s3-config.js';
import { resolveS3ClockSkewSeconds, resolveS3EndpointHost } from './s3-sigv4.js';
import { validateTelegramConfig, probeTelegramApi } from './telegram-client.js';

// This is a fixed, read-only lookup key. It is never written and its returned
// value is deliberately ignored, so the check cannot expose or alter operator
// state. The complete Cloud control-plane binding is still checked for the
// methods the application needs before reporting it as readable.
const CLOUD_KV_READINESS_KEY = 'tc:v1:operator-readiness:probe';
const MIN_PEPPER_BYTES = 32;
const MAX_PEPPER_BYTES = 4096;
const encoder = new TextEncoder();

function hasCloudKvShape(value) {
  return !!value
    && typeof value.get === 'function'
    && typeof value.put === 'function'
    && typeof value.delete === 'function'
    && typeof value.list === 'function';
}

function pairedConfigurationStatus(env, first, second) {
  const firstPresent = !isEmptyBinding(env?.[first]);
  const secondPresent = !isEmptyBinding(env?.[second]);
  if (firstPresent && secondPresent) return 'configured';
  if (!firstPresent && !secondPresent) return 'missing';
  return 'incomplete';
}

function pepperStatus(env, name) {
  const value = env?.[name];
  if (typeof value !== 'string') return 'missing_or_invalid';
  const length = encoder.encode(value).byteLength;
  return length >= MIN_PEPPER_BYTES && length <= MAX_PEPPER_BYTES
    ? 'configured'
    : 'missing_or_invalid';
}

function telegramConfigurationStatus(env) {
  try {
    validateTelegramConfig(env);
    return 'configured';
  } catch (_) {
    // Do not surface the configuration exception: its text is not a public
    // diagnostics contract and future implementations could add detail.
    return 'missing_or_invalid';
  }
}

function legacyStorageStatus(env, telegramStatus) {
  const provider = typeof env?.STORAGE_PROVIDER === 'string'
    ? env.STORAGE_PROVIDER.toLowerCase()
    : 'telegram';
  if (provider === 'telegram') return telegramStatus === 'configured' ? 'configured' : 'missing_or_invalid';
  if (provider === 'r2') return env?.img_r2 ? 'configured' : 'missing_or_invalid';
  // Never reflect an arbitrary configured provider string in a response.
  return 'unsupported';
}

function s3EndpointStatus(env) {
  try {
    // Both calls deliberately validate without returning their values. The
    // hostname and configured clock window are operational configuration, not
    // information this endpoint needs to reveal.
    resolveS3EndpointHost(env);
    resolveS3ClockSkewSeconds(env);
    return 'configured';
  } catch (_) {
    return 'missing_or_invalid';
  }
}

async function cloudKvStatus(env) {
  const binding = env?.TELEGRAPH_CLOUD_KV;
  if (!hasCloudKvShape(binding)) return 'missing_or_invalid';
  try {
    await binding.get(CLOUD_KV_READINESS_KEY);
    return 'readable';
  } catch (_) {
    // A non-mutating read failure is enough to prevent a readiness claim. Do
    // not return provider errors, names, or values.
    return 'unreachable';
  }
}

/**
 * Build an operator-only configuration/readiness report without returning a
 * secret, an identifier, binding value, raw provider error, or project state.
 * `probeTelegram` is opt-in because it calls Bot API getMe; it verifies only
 * Bot API reachability/token acceptance, not channel permissions or writes.
 */
export async function getOperatorReadiness(env = {}, { probeTelegram = false } = {}) {
  const dashboardAuth = pairedConfigurationStatus(env, 'BASIC_USER', 'BASIC_PASS');
  const telegram = telegramConfigurationStatus(env);
  const cloudKv = await cloudKvStatus(env);
  const apiKeyVerifier = pepperStatus(env, 'API_KEY_PEPPER');
  const s3CredentialVerifier = pepperStatus(env, S3_CREDENTIAL_PEPPER_ENV);
  const s3Endpoint = s3EndpointStatus(env);
  const legacyStorage = legacyStorageStatus(env, telegram);
  const cloudObjectEngine = cloudKv === 'readable' && telegram === 'configured'
    ? 'ready_for_smoke'
    : 'not_ready';
  const s3Adapter = cloudObjectEngine === 'ready_for_smoke'
    && s3CredentialVerifier === 'configured'
    && s3Endpoint === 'configured'
    ? 'ready_for_smoke'
    : 'not_ready';

  let telegramApi = 'not_probed';
  if (probeTelegram) {
    telegramApi = await probeTelegramApi(env) ? 'reachable' : 'unreachable';
  }

  // "ready_for_smoke" is intentionally weaker than "healthy": a read-only
  // KV probe and optional getMe cannot prove Telegram channel authorization,
  // Cloudflare KV write/list behavior, object persistence, or SigV4 traffic.
  const status = dashboardAuth === 'configured'
    && apiKeyVerifier === 'configured'
    && cloudObjectEngine === 'ready_for_smoke'
    && s3Adapter === 'ready_for_smoke'
    && (!probeTelegram || telegramApi === 'reachable')
    ? 'ready_for_smoke'
    : 'degraded';

  return Object.freeze({
    status,
    checks: Object.freeze({
      dashboard_auth: dashboardAuth,
      legacy_storage: legacyStorage,
      cloud_kv: cloudKv,
      telegram_configuration: telegram,
      telegram_api: telegramApi,
      api_key_verifier: apiKeyVerifier,
      s3_credential_verifier: s3CredentialVerifier,
      s3_endpoint: s3Endpoint,
      cloud_object_engine: cloudObjectEngine,
      s3_adapter: s3Adapter,
    }),
  });
}
