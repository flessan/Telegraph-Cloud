import {
  CloudForbiddenError,
  CloudNotFoundError,
  CloudValidationError,
  isTelegraphCloudError,
} from './errors.js';
import { createProjectRegistry } from './project-registry.js';
import { createS3CredentialService } from './s3-credentials.js';
import {
  S3SigV4Error,
  parseS3SigV4Authorization,
  verifyS3SigV4Request,
} from './s3-sigv4.js';
import { s3ProtocolError } from './s3-errors.js';

/** Map only supported object operation methods to their credential scope. */
export function requiredS3ScopeForMethod(method) {
  if (method === 'GET' || method === 'HEAD') return 's3:read';
  if (method === 'PUT' || method === 'DELETE') return 's3:write';
  return null;
}

function mappedSigV4Error(error) {
  if (error instanceof S3SigV4Error) return s3ProtocolError(error.s3Code);
  return error;
}

function inactiveProject(error) {
  return error instanceof CloudNotFoundError || error instanceof CloudForbiddenError
    || (isTelegraphCloudError(error) && (error.code === 'project_not_found' || error.code === 'project_inactive'));
}

/**
 * Resolves a real header-form SigV4 credential to one active project. Neither
 * dashboard Basic/session identity, `tg_live_…` Bearer credentials, request
 * project hints, nor the retired Phase 6A test-project binding participate.
 */
export async function authenticateS3Request(request, env = {}, {
  credentials = null,
  projects = null,
  cryptoApi = globalThis.crypto,
  now = () => Date.now(),
} = {}) {
  let authorization;
  try {
    authorization = parseS3SigV4Authorization(request?.headers?.get?.('Authorization'));
  } catch (error) {
    throw mappedSigV4Error(error);
  }
  const projectRegistry = projects || createProjectRegistry(env);
  const credentialService = credentials || createS3CredentialService(env, {
    projects: projectRegistry,
    cryptoApi,
  });

  let credential;
  try {
    credential = await credentialService.resolveSigningCredential(authorization.accessKeyId);
  } catch (error) {
    // A malformed local access-key grammar is indistinguishable from an absent
    // direct record on this external S3 surface.
    if ((error instanceof CloudValidationError && error.code === 'invalid_s3_access_key_id')
      || (isTelegraphCloudError(error) && error.code === 'cloud_s3_credential_invalid_record')) {
      // A corrupt/tampered primary verifier must fail closed without becoming a
      // public control-plane/configuration oracle. Dashboard management still
      // receives the underlying safe 503 for operator repair.
      throw s3ProtocolError('InvalidAccessKeyId');
    }
    throw error;
  }
  if (!credential) throw s3ProtocolError('InvalidAccessKeyId');

  try {
    await verifyS3SigV4Request(request, {
      accessKeyId: credential.accessKeyId,
      secretAccessKey: credential.secretAccessKey,
      env,
      cryptoApi,
      now,
    });
  } catch (error) {
    throw mappedSigV4Error(error);
  }

  try {
    await projectRegistry.requireActiveProject(credential.projectId);
  } catch (error) {
    // Do not disclose a disabled/deleted project through a valid credential.
    if (inactiveProject(error)) throw s3ProtocolError('AccessDenied');
    throw error;
  }

  return Object.freeze({
    authentication: 's3_sigv4',
    accessKeyId: credential.accessKeyId,
    projectId: credential.projectId,
    scopes: Object.freeze([...credential.scopes]),
    credentialStatus: 'active',
  });
}
