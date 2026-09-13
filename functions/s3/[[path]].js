import { requiredS3ScopeForMethod } from '../cloud/s3-auth.js';
import { createTelegramObjectStorage } from '../cloud/object-storage.js';
import { S3ProtocolError } from '../cloud/s3-errors.js';
import {
  createS3ProtocolAdapter,
  dispatchS3Request,
  s3TargetFromRequest,
} from '../cloud/s3-protocol.js';

// `/s3/*` remains isolated from `/api/storage/*`. SigV4 middleware supplies a
// credential-derived project scope, and this adapter invokes only the existing
// project-bound object facade. It never accepts a client project selector.
export async function onRequest(context) {
  const authentication = context?.data?.s3Authentication;
  const requiredScope = requiredS3ScopeForMethod(context?.request?.method);
  if (authentication?.authentication !== 's3_sigv4' || typeof authentication.projectId !== 'string'
    || (requiredScope && (!Array.isArray(authentication.scopes) || !authentication.scopes.includes(requiredScope)))) {
    throw new S3ProtocolError('AccessDenied');
  }

  const target = s3TargetFromRequest(context.request);
  const storage = createTelegramObjectStorage(context.env, { projectId: authentication.projectId });
  const adapter = createS3ProtocolAdapter({
    storage,
    projectId: authentication.projectId,
    env: context.env,
    requestId: context.data.s3RequestId,
  });
  return dispatchS3Request({ request: context.request, target, adapter });
}
