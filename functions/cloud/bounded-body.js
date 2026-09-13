import { CloudRequestError, isTelegraphCloudError } from './errors.js';
import { assertDeclaredContentLength } from './validation.js';

function contentLengthError(error) {
  if (error?.code === 'object_too_large') {
    throw new CloudRequestError('object_too_large', 'Object exceeds the supported size limit.', { status: 413 });
  }
  throw new CloudRequestError('invalid_content_length', 'Invalid Content-Length header.', { status: 400 });
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new CloudRequestError('invalid_object_body', 'Object request body is invalid.', { status: 400 });
}

/**
 * Consume a request body incrementally and stop once a caller-supplied bounded
 * byte limit is exceeded. It deliberately does not know about Telegram, KV,
 * object routing, or S3: callers retain ownership of their request branch and
 * representation semantics.
 */
export async function readBoundedObjectBody(request, { maxObjectBytes }) {
  let declared;
  try {
    declared = assertDeclaredContentLength(request.headers.get('Content-Length'), { maxBytes: maxObjectBytes });
  } catch (error) {
    contentLengthError(error);
  }

  if (!request.body) {
    if (declared !== null && declared !== 0) {
      throw new CloudRequestError('invalid_content_length', 'Content-Length does not match the object body.', { status: 400 });
    }
    return new Uint8Array(0);
  }

  const reader = typeof request.body.getReader === 'function' ? request.body.getReader() : null;
  if (!reader) {
    throw new CloudRequestError('invalid_object_body', 'Object request body is invalid.', { status: 400 });
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = toUint8Array(value);
      total += chunk.byteLength;
      if (total > maxObjectBytes) {
        try { await reader.cancel(); } catch (_) { /* best-effort stream cleanup */ }
        throw new CloudRequestError('object_too_large', 'Object exceeds the supported size limit.', { status: 413 });
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (isTelegraphCloudError(error)) throw error;
    throw new CloudRequestError('invalid_object_body', 'Object request body is invalid.', { status: 400 });
  }

  if (declared !== null && declared !== total) {
    throw new CloudRequestError('invalid_content_length', 'Content-Length does not match the object body.', { status: 400 });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
