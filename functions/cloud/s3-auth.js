import { CloudUnauthorizedError } from './errors.js';
import { assertProjectId } from './validation.js';
import { isEmptyBinding } from '../utils/http.js';
import { authenticateRequest } from '../utils/session.js';

// This is intentionally a temporary, operator-configured bridge rather than
// an S3 credential system. It must be removed/replaced by a real SigV4
// credential-to-project resolver before this route can be offered externally.
export const S3_TEST_PROJECT_ID_ENV = 'TELEGRAPH_CLOUD_S3_TEST_PROJECT_ID';

function accessDenied() {
  // Deliberately use one indistinguishable failure for a missing configuration,
  // malformed configured project, disabled dashboard auth, and bad credentials.
  // That prevents this development-only endpoint from becoming a configuration
  // or project-existence oracle.
  return new CloudUnauthorizedError('s3_access_denied', 'S3 access is denied.');
}

function dashboardAuthenticationIsConfigured(env) {
  // authenticateRequest intentionally supports a legacy “dashboard auth is
  // disabled” mode. That mode is never sufficient for S3, even with a server
  // project id, because the compatibility route must fail closed.
  return !isEmptyBinding(env?.BASIC_USER) && !isEmptyBinding(env?.BASIC_PASS);
}

/**
 * Resolves the sole Phase 6A project scope. No request field participates in
 * this decision: query/path/header/body values cannot choose or override it.
 *
 * The returned credentials marker intentionally contains no dashboard username,
 * Basic value, session value, or secret. It is server-only middleware state.
 */
export async function authenticateS3Request(request, env = {}) {
  if (!dashboardAuthenticationIsConfigured(env)) throw accessDenied();

  let projectId;
  try {
    projectId = assertProjectId(env?.[S3_TEST_PROJECT_ID_ENV]);
  } catch (_) {
    throw accessDenied();
  }

  let identity;
  try {
    identity = await authenticateRequest(request, env);
  } catch (_) {
    throw accessDenied();
  }
  if (!identity) throw accessDenied();

  return Object.freeze({
    authentication: 's3_admin_test',
    projectId,
    credentials: Object.freeze({ kind: 'dashboard_basic_or_session' }),
    permissions: Object.freeze({ read: true, write: true }),
  });
}
