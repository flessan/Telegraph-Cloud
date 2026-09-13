// Dependency-light S3 protocol error marker shared by authentication,
// middleware, and the protocol adapter. Keeping this type independent avoids
// loading object/Telegram code merely to translate a strict SigV4 failure.
export class S3ProtocolError extends Error {
  constructor(code, { retryAfter = null, allow = null } = {}) {
    super(code);
    this.name = 'S3ProtocolError';
    this.s3Code = code;
    this.retryAfter = retryAfter;
    this.allow = allow;
  }
}

export function s3ProtocolError(code, options) {
  return new S3ProtocolError(code, options);
}
