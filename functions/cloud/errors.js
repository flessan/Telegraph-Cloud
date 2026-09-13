// Telegraph Cloud errors are intentionally safe to expose from future API
// handlers. They carry a stable code and status, never a raw upstream error,
// environment value, Telegram identifier, or stack trace.

export class TelegraphCloudError extends Error {
  constructor(code, message, { status = 500, details } = {}) {
    super(message);
    this.name = 'TelegraphCloudError';
    this.code = code;
    this.status = status;
    // Callers may attach only deliberately selected, public-safe fields here
    // (for example the current public record version on a conflict). Raw
    // binding, Telegram, request, or Error data must never be attached.
    if (details !== undefined) this.details = details;
  }
}

export class CloudConfigurationError extends TelegraphCloudError {
  constructor(code, message) {
    super(code, message, { status: 503 });
    this.name = 'CloudConfigurationError';
  }
}

export class CloudValidationError extends TelegraphCloudError {
  constructor(code, message) {
    super(code, message, { status: 400 });
    this.name = 'CloudValidationError';
  }
}

export class CloudUnauthorizedError extends TelegraphCloudError {
  constructor(code = 'invalid_api_key', message = 'A valid developer API key is required.') {
    super(code, message, { status: 401 });
    this.name = 'CloudUnauthorizedError';
  }
}

export class CloudRequestError extends TelegraphCloudError {
  constructor(code, message, { status = 400, details } = {}) {
    super(code, message, { status, details });
    this.name = 'CloudRequestError';
  }
}

export class CloudNotFoundError extends TelegraphCloudError {
  constructor(code = 'record_not_found', message = 'The requested record was not found.') {
    super(code, message, { status: 404 });
    this.name = 'CloudNotFoundError';
  }
}

export class CloudConflictError extends TelegraphCloudError {
  constructor(code, message, { details } = {}) {
    super(code, message, { status: 409, details });
    this.name = 'CloudConflictError';
  }
}

export class CloudForbiddenError extends TelegraphCloudError {
  constructor(code = 'forbidden', message = 'The authenticated credential cannot perform this operation.') {
    super(code, message, { status: 403 });
    this.name = 'CloudForbiddenError';
  }
}

export class CloudRecoveryError extends TelegraphCloudError {
  constructor(code = 'mutation_pending', message = 'The mutation is pending index recovery.') {
    super(code, message, { status: 503 });
    this.name = 'CloudRecoveryError';
  }
}

export class CloudAdapterError extends TelegraphCloudError {
  constructor(code, message, { status = 502 } = {}) {
    super(code, message, { status });
    this.name = 'CloudAdapterError';
  }
}

export function isTelegraphCloudError(error) {
  return error instanceof TelegraphCloudError;
}
