// Shared Phase 6B server-side configuration names. This module deliberately
// contains no credentials, HMAC/SigV4 logic, KV, object, or protocol behavior.
export const S3_CREDENTIAL_PEPPER_ENV = 'TELEGRAPH_CLOUD_S3_CREDENTIAL_PEPPER';
export const S3_ENDPOINT_HOST_ENV = 'TELEGRAPH_CLOUD_S3_ENDPOINT_HOST';
export const S3_CLOCK_SKEW_ENV = 'TELEGRAPH_CLOUD_S3_MAX_CLOCK_SKEW_SECONDS';
