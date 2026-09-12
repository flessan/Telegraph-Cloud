import {
  createTelegramClient,
  getFileId,
  getTelegramMessageId,
} from './telegram-client.js';
import {
  CloudAdapterError,
  CloudConfigurationError,
  isTelegraphCloudError,
} from './errors.js';
import {
  CLOUD_LIMITS,
  assertByteLength,
  assertMimeType,
} from './validation.js';

// This is intentionally a different adapter from functions/storage/telegram.js.
// The latter implements the historical public-media upload contract; this one
// only understands opaque Telegraph Cloud object pointers and sendDocument.
export const TELEGRAM_OBJECT_POINTER_PROVIDER = 'telegram-object';
export const TELEGRAM_OBJECT_EVENT_POINTER_PROVIDER = 'telegram-object-event';

const TELEGRAM_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;
const OBJECT_UPLOAD_FILENAME = 'telegraph-cloud-object.bin';

function safeBackendFailure() {
  return new CloudAdapterError(
    'storage_backend_failure',
    'Object storage is temporarily unavailable.',
    { status: 503 },
  );
}

function normalizePointer(value, provider = TELEGRAM_OBJECT_POINTER_PROVIDER) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.provider !== provider
    || typeof value.fileId !== 'string'
    || !TELEGRAM_FILE_ID_PATTERN.test(value.fileId)
    || !Number.isSafeInteger(value.messageId)
    || value.messageId < 1
  ) {
    throw safeBackendFailure();
  }
  return Object.freeze({
    provider,
    fileId: value.fileId,
    messageId: value.messageId,
  });
}

function objectBlob(body, contentType) {
  try {
    const blob = body instanceof Blob ? body : new Blob([body], { type: contentType });
    assertByteLength(blob.size, { maxBytes: CLOUD_LIMITS.MAX_OBJECT_BYTES });
    return blob;
  } catch (error) {
    if (isTelegraphCloudError(error)) throw error;
    throw new CloudAdapterError('invalid_object_body', 'Object body is invalid.', { status: 400 });
  }
}

function validateClient(client) {
  if (
    !client
    || typeof client.validateConfig !== 'function'
    || typeof client.sendFormData !== 'function'
    || typeof client.getFilePath !== 'function'
    || typeof client.getFileDownloadUrl !== 'function'
    || typeof client.fetchDownload !== 'function'
  ) {
    throw new CloudConfigurationError('telegram_object_adapter_unavailable', 'Object storage is not configured.');
  }
}

/**
 * Telegram byte transport for the generic object engine. It keeps Telegram
 * paths, file ids, message ids, response payloads, and bot-token-bearing URLs
 * inside this module. Its delete operation intentionally does not invoke
 * deleteMessage: deletion is a logical manifest tombstone and Telegram's
 * immutable uploaded bytes may remain retained by the provider.
 */
export function createTelegramObjectStorageAdapter(env, {
  client = createTelegramClient(env),
} = {}) {
  validateClient(client);

  function ensureConfigured() {
    try {
      client.validateConfig();
    } catch (_) {
      throw new CloudConfigurationError('telegram_object_unavailable', 'Object storage is not configured.');
    }
  }

  async function resolveDownload(pointer) {
    ensureConfigured();
    const safePointer = normalizePointer(pointer);
    let filePath;
    try {
      filePath = await client.getFilePath(safePointer.fileId);
    } catch (_) {
      throw safeBackendFailure();
    }
    if (!filePath) throw safeBackendFailure();

    let downloadUrl;
    try {
      downloadUrl = client.getFileDownloadUrl(filePath);
    } catch (_) {
      throw safeBackendFailure();
    }
    if (!downloadUrl) throw safeBackendFailure();
    return { safePointer, downloadUrl };
  }

  async function putObject({ body, contentType } = {}) {
    ensureConfigured();
    let safeContentType;
    try {
      safeContentType = assertMimeType(contentType);
    } catch (error) {
      if (isTelegraphCloudError(error)) throw error;
      throw new CloudAdapterError('invalid_object_body', 'Object body is invalid.', { status: 400 });
    }
    const blob = objectBlob(body, safeContentType);
    const formData = new FormData();
    formData.append('chat_id', String(env.TG_Chat_ID));
    // Do not include a client key, filename, metadata, or caption in Telegram.
    // Those values belong only to the bounded, project-scoped KV manifest.
    formData.append('document', blob, OBJECT_UPLOAD_FILENAME);

    let result;
    try {
      result = await client.sendFormData(formData, 'sendDocument');
    } catch (_) {
      throw safeBackendFailure();
    }
    if (!result || result.success !== true) throw safeBackendFailure();

    const fileId = getFileId(result.data);
    const messageId = getTelegramMessageId(result.data);
    if (typeof fileId !== 'string' || !TELEGRAM_FILE_ID_PATTERN.test(fileId) || !messageId) {
      throw safeBackendFailure();
    }
    return Object.freeze({
      provider: TELEGRAM_OBJECT_POINTER_PROVIDER,
      fileId,
      messageId,
    });
  }

  async function appendEvent(event) {
    ensureConfigured();
    let serialized;
    try {
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('event');
      serialized = JSON.stringify(event);
      if (!serialized || new TextEncoder().encode(serialized).byteLength > 64 * 1024) throw new Error('event');
    } catch (_) {
      throw new CloudAdapterError('invalid_object_event', 'Object revision event is invalid.', { status: 500 });
    }
    const formData = new FormData();
    formData.append('chat_id', String(env.TG_Chat_ID));
    formData.append('document', new Blob([serialized], { type: 'application/json' }), 'telegraph-cloud-object-event.json');
    let result;
    try {
      result = await client.sendFormData(formData, 'sendDocument');
    } catch (_) {
      throw safeBackendFailure();
    }
    if (!result || result.success !== true) throw safeBackendFailure();
    const fileId = getFileId(result.data);
    const messageId = getTelegramMessageId(result.data);
    if (typeof fileId !== 'string' || !TELEGRAM_FILE_ID_PATTERN.test(fileId) || !messageId) throw safeBackendFailure();
    return Object.freeze({
      provider: TELEGRAM_OBJECT_EVENT_POINTER_PROVIDER,
      fileId,
      messageId,
    });
  }

  async function getObject(pointer) {
    const { downloadUrl } = await resolveDownload(pointer);
    let response;
    try {
      // Object authorization and conditional handling happen before this call.
      // A synthetic request prevents developer credentials, ranges, cookies,
      // caller conditions, and arbitrary request headers from reaching Telegram.
      response = await client.fetchDownload(downloadUrl, new Request('https://telegraph-cloud.invalid/object', {
        method: 'GET',
      }));
    } catch (_) {
      throw safeBackendFailure();
    }
    // A zero-byte Telegram document may legitimately have a null body in a
    // mock/runtime response, so only the response status is authoritative.
    if (!response || !response.ok) throw safeBackendFailure();
    return response;
  }

  async function headObject(pointer) {
    // getFile verifies that Telegram can still resolve the internal file id but
    // does not download object bytes. This is deliberately not an HTTP HEAD to
    // the Telegram file URL because that would expose transport assumptions.
    await resolveDownload(pointer);
    return Object.freeze({ available: true });
  }

  async function deleteObject(pointer) {
    // Validate that callers are dealing with a real internal pointer while
    // making the retention policy explicit. Do not claim physical deletion.
    normalizePointer(pointer);
    return Object.freeze({ retained_by_provider: true });
  }

  return Object.freeze({
    putObject,
    appendEvent,
    getObject,
    headObject,
    deleteObject,
  });
}
