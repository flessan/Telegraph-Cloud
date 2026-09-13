// Compatibility facade for the established legacy upload/storage modules.
// Telegram Bot API mechanics now live in ../cloud/telegram-client.js so new
// Telegraph Cloud services and legacy media providers share one safe boundary.

import { createTelegramClient } from '../cloud/telegram-client.js';

export {
  createTelegramFormData,
  getFileId,
  getTelegramMessageId,
  getUploadTarget,
  validateTelegramConfig,
} from '../cloud/telegram-client.js';

export async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
  return createTelegramClient(env).sendFormData(formData, apiEndpoint, { retryCount });
}

export async function getTelegramFilePath(env, fileId) {
  return createTelegramClient(env).getFilePath(fileId);
}
