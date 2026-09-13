import { createTelegramObjectStorage } from '../cloud/object-storage.js';
import {
  S3ProtocolError,
  createS3ProtocolAdapter,
  dispatchS3Request,
  s3TargetFromContext,
} from '../cloud/s3-protocol.js';

// `/s3/*` is intentionally isolated from `/api/storage/*`: authenticated
// middleware supplies this temporary server-configured project scope, then the
// protocol adapter calls the same project-bound object engine used by the REST
// route. It does not inspect Telegram/KV bindings or client project hints.
export async function onRequest(context) {
  const authentication = context?.data?.s3Authentication;
  if (authentication?.authentication !== 's3_admin_test' || typeof authentication.projectId !== 'string') {
    throw new S3ProtocolError('AccessDenied');
  }

  const target = s3TargetFromContext(context);
  const storage = createTelegramObjectStorage(context.env, { projectId: authentication.projectId });
  const adapter = createS3ProtocolAdapter({
    storage,
    projectId: authentication.projectId,
    env: context.env,
    requestId: context.data.s3RequestId,
  });
  return dispatchS3Request({ request: context.request, target, adapter });
}
