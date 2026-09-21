import { isEmptyBinding } from '../utils/http.js';

// All Bot API URLs and fetches live here. Storage, document-journal, and future
// API services use this client rather than constructing Telegram URLs directly.
export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
export const MAX_TELEGRAM_RETRIES = 3;
export const MAX_TELEGRAM_RETRY_DELAY_MS = 60 * 1000;

const SEND_ENDPOINTS = new Set(['sendPhoto', 'sendAudio', 'sendVideo', 'sendDocument']);
const MEDIA_SEND_ENDPOINTS = new Set(['sendPhoto', 'sendAudio', 'sendVideo']);
const RETRYABLE_STATUS = new Set([408, 429]);
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
  const token = String(env.TG_Bot_Token).trim();
  return `${TELEGRAM_API_ORIGIN}/bot${token}/${endpoint}`;
}

function telegramChatId(env) {
  return String(env.TG_Chat_ID ?? '').trim();
}

function isSafeTelegramFilePath(filePath) {
  return typeof filePath === 'string'
    && filePath.length > 0
    && filePath.split('/').every((segment) => (
      SAFE_FILE_PATH_SEGMENT.test(segment) && segment !== '.' && segment !== '..'
    ));
}

function isRetryableStatus(status) {
  return RETRYABLE_STATUS.has(status) || (status >= 500 && status <= 599);
}

function retryAfterMilliseconds(response, responseData, retryCount, randomImpl = Math.random) {
  const candidates = [];
  const header = response?.headers?.get?.('Retry-After');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) candidates.push(seconds * 1000);
    else {
      const retryDate = Date.parse(header);
      if (Number.isFinite(retryDate)) candidates.push(retryDate - Date.now());
    }
  }
  const telegramRetryAfter = responseData?.parameters?.retry_after;
  if (Number.isFinite(telegramRetryAfter) && telegramRetryAfter >= 0) {
    candidates.push(Number(telegramRetryAfter) * 1000);
  }
  const explicit = candidates.find((value) => Number.isFinite(value) && value >= 0);
  const exponential = Math.min(1000 * (2 ** retryCount), 10 * 1000);
  const jitter = Math.floor(Math.max(0, Math.min(1, Number(randomImpl()) || 0)) * 500);
  const delay = explicit === undefined ? exponential + jitter : explicit;
  return Math.max(250, Math.min(MAX_TELEGRAM_RETRY_DELAY_MS, Math.round(delay)));
}

function retryableNetworkDelay(retryCount, randomImpl = Math.random) {
  return Math.max(250, Math.min(
    MAX_TELEGRAM_RETRY_DELAY_MS,
    Math.round(Math.min(1000 * (2 ** retryCount), 10 * 1000)
      + Math.floor(Math.max(0, Math.min(1, Number(randomImpl()) || 0)) * 500)),
  ));
}

function telegramFailureKind(status, responseData = null) {
  if (status === 401) return 'auth_failed';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limited';

  const description = typeof responseData?.description === 'string'
    ? responseData.description.toLowerCase()
    : '';

  if (status === 400) {
    if (/chat not found|chat_id.*(?:not found|invalid)|peer.*(?:not found|invalid)|chat_id is empty|bad peer|peer_id_invalid|chat_id_invalid/.test(description)) {
      return 'chat_not_found';
    }
    if (/bot .*not (?:a )?member|bot was kicked|not enough rights|have no rights to send|administrator rights|can't write in this chat|cannot send messages|not enough rights to send messages/.test(description)) {
      return 'forbidden';
    }
    if (/file is too big|request entity too large/.test(description)) {
      return 'payload_too_large';
    }
    if (/wrong file identifier|invalid file/.test(description)) {
      return 'invalid_file';
    }
  }

  if (Number.isInteger(status) && status >= 500 && status <= 599) return 'upstream_unavailable';
  if (Number.isInteger(status) && status >= 400 && status <= 499) return 'api_rejected';
  return 'network_error';
}

export async function classifyTelegramApiFailure(response, responseData = null) {
  const status = Number(response?.status);
  return telegramFailureKind(Number.isFinite(status) ? status : null, responseData);
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
export async function probeTelegramApiDetailed(env, { fetchImpl = globalThis.fetch } = {}) {
  try {
    validateTelegramConfig(env);
    if (typeof fetchImpl !== 'function') return { status: 'unreachable', reason: 'network_error' };

    const response = await fetchImpl(botApiUrl(env, 'getMe'), { method: 'GET' });
    if (!response.ok) {
      const payload = await parseTelegramResponse(response);
      return {
        status: 'unreachable',
        reason: telegramFailureKind(response.status, payload),
      };
    }

    const chatResponse = await fetchImpl(
      botApiUrl(env, 'getChat') + `?chat_id=${encodeURIComponent(telegramChatId(env))}`,
      { method: 'GET' },
    );
    if (chatResponse.ok) return { status: 'reachable', reason: 'ok' };

    const chatPayload = await parseTelegramResponse(chatResponse);
    return {
      status: 'unreachable',
      reason: telegramFailureKind(chatResponse.status, chatPayload),
    };
  } catch (_) {
    return { status: 'unreachable', reason: 'network_error' };
  }
}

export async function probeTelegramApi(env, options = {}) {
  const result = await probeTelegramApiDetailed(env, options);
  return result.status === 'reachable';
}

export function getUploadTarget(file) {
  const mime = typeof file?.type === 'string' ? file.type : '';
  if (mime.startsWith('image/')) {
    return { endpoint: 'sendPhoto', field: 'photo' };
  }

  if (mime.startsWith('audio/')) {
    return { endpoint: 'sendAudio', field: 'audio' };
  }

  if (mime.startsWith('video/')) {
    return { endpoint: 'sendVideo', field: 'video' };
  }

  return { endpoint: 'sendDocument', field: 'document' };
}

export function createTelegramFormData(chatId, field, file) {
  const formData = new FormData();
  formData.append('chat_id', String(chatId).trim());
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
    // compatibility without forwarding unrelated caller data.
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
  randomImpl = Math.random,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('Telegram fetch implementation is unavailable');
  }

  async function sendFormData(formData, apiEndpoint, {
    retryCount = 0,
    fallbackUsed = false,
  } = {}) {
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

      if (isRetryableStatus(response.status)) {
        if (retryCount < MAX_TELEGRAM_RETRIES) {
          await sleepImpl(retryAfterMilliseconds(response, responseData, retryCount, randomImpl));
          return sendFormData(formData, apiEndpoint, {
            retryCount: retryCount + 1,
            fallbackUsed,
          });
        }
        return {
          success: false,
          error: formatTelegramError(apiEndpoint, response, responseData),
        };
      }

      if (MEDIA_SEND_ENDPOINTS.has(apiEndpoint) && !fallbackUsed) {
        const fallback = new FormData();
        fallback.append('chat_id', formData.get('chat_id'));
        fallback.append(
          'document',
          formData.get(apiEndpoint === 'sendPhoto' ? 'photo' : apiEndpoint === 'sendAudio' ? 'audio' : 'video'),
        );
        return sendFormData(fallback, 'sendDocument', { retryCount: 0, fallbackUsed: true });
      }

      return {
        success: false,
        error: formatTelegramError(apiEndpoint, response, responseData),
      };
    } catch (_) {
      if (retryCount < MAX_TELEGRAM_RETRIES) {
        await sleepImpl(retryAfterMilliseconds(null, null, retryCount, randomImpl));
        return sendFormData(formData, apiEndpoint, {
          retryCount: retryCount + 1,
          fallbackUsed,
        });
      }
      console.error('Telegram network request failed after bounded retries.');
      return { success: false, error: 'Network error occurred' };
    }
  }

  async function getFilePath(fileId) {
    if (!hasBotToken(env) || typeof fileId !== 'string' || !fileId) return null;

    for (let retryCount = 0; retryCount <= 2; retryCount += 1) {
      try {
        const url = `${botApiUrl(env, 'getFile')}?file_id=${encodeURIComponent(fileId)}`;
        const response = await fetchImpl(url, { method: 'GET' });
        if (response.ok) {
          const data = await response.json();
          const filePath = data?.ok && typeof data?.result?.file_path === 'string'
            ? data.result.file_path
            : null;
          if (!isSafeTelegramFilePath(filePath)) {
            console.error('Telegram getFile response did not include a safe file path.');
            return null;
          }
          return filePath;
        }

        if (isRetryableStatus(response.status) && retryCount < 2) {
          await sleepImpl(retryAfterMilliseconds(response, null, retryCount, randomImpl));
          continue;
        }
        console.error('Telegram getFile request failed.');
        return null;
      } catch (_) {
        if (retryCount < 2) {
          await sleepImpl(retryableNetworkDelay(retryCount, randomImpl));
          continue;
        }
        console.error('Telegram getFile request failed.');
        return null;
      }
    }
    return null;
  }

  async function fetchDownload(fileUrl, request) {
    for (let retryCount = 0; retryCount <= 2; retryCount += 1) {
      try {
        const response = await fetchImpl(fileUrl, createTelegramDownloadRequestInit(request));
        if (!isRetryableStatus(response.status) || retryCount >= 2) {
          return response;
        }
        await sleepImpl(retryAfterMilliseconds(response, null, retryCount, randomImpl));
      } catch (error) {
        if (retryCount >= 2) {
          throw error;
        }
        await sleepImpl(retryableNetworkDelay(retryCount, randomImpl));
      }
    }
    throw new Error('Telegram download failed');
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
  const contentType = response?.headers?.get?.('Content-Type') || '';
  if (contentType.includes('application/json')) {
    return response.json();
  }
  return { description: await response.text() };
}

function formatTelegramError(apiEndpoint, response, responseData) {
  const status = Number(response?.status);
  const kind = telegramFailureKind(
    Number.isFinite(status) ? status : null,
    responseData,
  );
  const details = responseData?.description || responseData?.error_code || 'Upload to Telegram failed';
  return `Telegram ${apiEndpoint} failed: ${Number.isFinite(status) ? status : 'network'} [${kind}] ${details}`;
}
