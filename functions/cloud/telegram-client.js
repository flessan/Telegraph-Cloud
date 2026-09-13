import { isEmptyBinding } from '../utils/http.js';

// All Bot API URLs and fetches live here. Storage, document-journal, and future
// API services use this client rather than constructing Telegram URLs directly.
export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
export const MAX_TELEGRAM_RETRIES = 2;

const SEND_ENDPOINTS = new Set(['sendPhoto', 'sendAudio', 'sendVideo', 'sendDocument']);
const DOWNLOAD_FORWARD_HEADERS = [
  'Accept',
  'If-Modified-Since',
  'If-None-Match',
  'If-Range',
  'Range',
];
const SAFE_FILE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasBotToken(env) {
  return !!env && !isEmptyBinding(env.TG_Bot_Token);
}

function botApiUrl(env, endpoint) {
  return `${TELEGRAM_API_ORIGIN}/bot${env.TG_Bot_Token}/${endpoint}`;
}

function isSafeTelegramFilePath(filePath) {
  return typeof filePath === 'string'
    && filePath.length > 0
    && filePath.split('/').every((segment) => (
      SAFE_FILE_PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..'
    ));
}

export function validateTelegramConfig(env) {
  if (!env || isEmptyBinding(env.TG_Bot_Token)) {
    throw new Error('Missing required environment variable: TG_Bot_Token');
  }

  if (isEmptyBinding(env.TG_Chat_ID)) {
    throw new Error('Missing required environment variable: TG_Chat_ID');
  }
}

/**
 * A deliberately narrow, opt-in Bot API liveness probe for authenticated
 * operator diagnostics. `getMe` checks that the configured token reaches the
 * API, but it does not expose the returned bot record, inspect the chat, or
 * prove channel permissions/write readiness. There is no retry here: a probe
 * must not turn one operator click into a Telegram request burst.
 */
export async function probeTelegramApi(env, { fetchImpl = globalThis.fetch } = {}) {
  try {
    validateTelegramConfig(env);
    if (typeof fetchImpl !== 'function') return false;
    const response = await fetchImpl(botApiUrl(env, 'getMe'), { method: 'GET' });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.ok === true;
  } catch (_) {
    // A failed probe is only an enum-valued diagnostic outcome. Never log an
    // exception here because it can include a Bot API URL containing the token.
    return false;
  }
}

export function getUploadTarget(file) {
  if (file.type.startsWith('image/')) {
    return { endpoint: 'sendPhoto', field: 'photo' };
  }

  if (file.type.startsWith('audio/')) {
    return { endpoint: 'sendAudio', field: 'audio' };
  }

  if (file.type.startsWith('video/')) {
    return { endpoint: 'sendVideo', field: 'video' };
  }

  return { endpoint: 'sendDocument', field: 'document' };
}

export function createTelegramFormData(chatId, field, file) {
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append(field, file);
  return formData;
}

export function getFileId(response) {
  if (!response.ok || !response.result) return null;

  const result = response.result;
  if (result.photo) {
    return result.photo.reduce((previous, current) =>
      (previous.file_size > current.file_size) ? previous : current
    ).file_id;
  }
  if (result.document) return result.document.file_id;
  if (result.video) return result.video.file_id;
  if (result.audio) return result.audio.file_id;

  return null;
}

export function getTelegramMessageId(response) {
  const messageId = response?.result?.message_id;
  return Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
}

/**
 * Only delivery/cache headers are forwarded to Telegram. In particular, caller
 * cookies, Authorization/Bearer credentials, API keys, host headers, and
 * browser identity headers never leave the Pages deployment.
 */
export function createTelegramDownloadHeaders(request) {
  const headers = new Headers();
  if (!request || !request.headers || typeof request.headers.get !== 'function') return headers;

  for (const name of DOWNLOAD_FORWARD_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null && value !== '') headers.set(name, value);
  }
  return headers;
}

export function createTelegramDownloadRequestInit(request) {
  return {
    method: request?.method || 'GET',
    headers: createTelegramDownloadHeaders(request),
    // Do not proxy request bodies to the Telegram file host. The documented
    // legacy file surface is GET/HEAD; retaining the requested method preserves
    // compatibility without forwarding unrelated caller data upstream.
  };
}

export function telegramFileDownloadUrl(env, filePath) {
  if (!hasBotToken(env) || !isSafeTelegramFilePath(filePath)) return null;
  const token = encodeURIComponent(String(env.TG_Bot_Token));
  const encodedPath = filePath.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${TELEGRAM_API_ORIGIN}/file/bot${token}/${encodedPath}`;
}

/**
 * Creates a narrow, injectable Telegram transport. It deliberately exposes no
 * mutation beyond upload/send and no message-edit operation, keeping later
 * database revisions append-only by design.
 */
export function createTelegramClient(env, {
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Telegram fetch implementation is unavailable');
  }

  async function sendFormData(formData, apiEndpoint, { retryCount = 0 } = {}) {
    if (!SEND_ENDPOINTS.has(apiEndpoint)) {
      throw new Error('Unsupported Telegram upload endpoint');
    }

    const apiUrl = botApiUrl(env, apiEndpoint);
    try {
      const response = await fetchImpl(apiUrl, { method: 'POST', body: formData });
      const responseData = await parseTelegramResponse(response);

      if (response.ok) {
        return { success: true, data: responseData };
      }

      if (retryCount < MAX_TELEGRAM_RETRIES && apiEndpoint === 'sendPhoto') {
        // This preserves the legacy fallback for Telegram media validation
        // failures while keeping the retry mechanics inside the client.
        const fallback = new FormData();
        fallback.append('chat_id', formData.get('chat_id'));
        fallback.append('document', formData.get('photo'));
        return sendFormData(fallback, 'sendDocument', { retryCount: retryCount + 1 });
      }

      return {
        success: false,
        error: formatTelegramError(apiEndpoint, response, responseData),
      };
    } catch (_) {
      // Error instances can include a requested URL. Never serialize them to
      // console/Sentry because that URL carries the bot token in its path.
      console.error('Telegram network request failed.');
      if (retryCount < MAX_TELEGRAM_RETRIES) {
        await sleepImpl(1000 * (retryCount + 1));
        return sendFormData(formData, apiEndpoint, { retryCount: retryCount + 1 });
      }
      return { success: false, error: 'Network error occurred' };
    }
  }

  async function getFilePath(fileId) {
    if (!hasBotToken(env) || typeof fileId !== 'string' || !fileId) return null;

    try {
      const url = `${botApiUrl(env, 'getFile')}?file_id=${encodeURIComponent(fileId)}`;
      const response = await fetchImpl(url, { method: 'GET' });
      if (!response.ok) {
        console.error('Telegram getFile request failed.');
        return null;
      }

      const data = await response.json();
      const filePath = data?.ok && typeof data?.result?.file_path === 'string'
        ? data.result.file_path
        : null;
      if (!isSafeTelegramFilePath(filePath)) {
        console.error('Telegram getFile response did not include a safe file path.');
        return null;
      }
      return filePath;
    } catch (_) {
      console.error('Telegram getFile request failed.');
      return null;
    }
  }

  async function fetchDownload(fileUrl, request) {
    return fetchImpl(fileUrl, createTelegramDownloadRequestInit(request));
  }

  return Object.freeze({
    validateConfig: () => validateTelegramConfig(env),
    sendFormData,
    getFilePath,
    getFileDownloadUrl: (filePath) => telegramFileDownloadUrl(env, filePath),
    fetchDownload,
  });
}

async function parseTelegramResponse(response) {
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return { description: await response.text() };
}

function formatTelegramError(apiEndpoint, response, responseData) {
  const details = responseData?.description || responseData?.error_code || 'Upload to Telegram failed';
  return `Telegram ${apiEndpoint} failed: ${response.status} ${details}`;
}
