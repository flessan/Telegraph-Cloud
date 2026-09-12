// Telegraph Cloud errors are intentionally safe to expose from future API
// handlers. They carry a stable code and status, never a raw upstream error,
// environment value, Telegram identifier, or stack trace.

export class TelegraphCloudError extends Error {
  constructor(code, message, { status = 500 } = {}) {
    super(message);
    this.name = 'TelegraphCloudError';
    this.code = code;
    this.status = status;
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

export class CloudAdapterError extends TelegraphCloudError {
  constructor(code, message, { status = 502 } = {}) {
    super(code, message, { status });
    this.name = 'CloudAdapterError';
  }
}

export function isTelegraphCloudError(error) {
  return error instanceof TelegraphCloudError;
}
