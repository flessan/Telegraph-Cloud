import { CloudAdapterError } from './errors.js';
import {
  assertTelegramFileId,
  assertTelegramMessageId,
  serializeJsonDocument,
} from './validation.js';
import {
  createTelegramClient,
  getFileId,
  getTelegramMessageId,
} from './telegram-client.js';

export const TELEGRAM_JOURNAL_PROVIDER = 'telegram-journal';
const JOURNAL_FILENAME = 'telegraph-cloud-revision.json';

function assertJournalClient(client) {
  const required = ['validateConfig', 'sendFormData', 'getFilePath', 'getFileDownloadUrl', 'fetchDownload'];
  for (const method of required) {
    if (!client || typeof client[method] !== 'function') {
      throw new CloudAdapterError('telegram_journal_client_invalid', 'Telegram journal client is unavailable.', { status: 500 });
    }
  }
  return client;
}

function normalizePointer(pointer) {
  if (!pointer || typeof pointer !== 'object') {
    throw new CloudAdapterError('telegram_journal_pointer_invalid', 'Telegram journal pointer is invalid.', { status: 500 });
  }
  return {
    provider: TELEGRAM_JOURNAL_PROVIDER,
    fileId: assertTelegramFileId(pointer.fileId),
    messageId: assertTelegramMessageId(pointer.messageId),
  };
}

/**
 * Immutable JSON transport for future record revisions. It has append/read
 * primitives only—no Telegram message editing—and is not a public database API.
 * Phase 2 will pair it with an outbox and materialized index to implement CRUD.
 */
export function createTelegramJournalAdapter(env, {
  client = createTelegramClient(env),
} = {}) {
  const telegram = assertJournalClient(client);

  async function appendJson(payload) {
    telegram.validateConfig();
    const { serialized, byteLength } = serializeJsonDocument(payload);
    const formData = new FormData();
    formData.append('chat_id', String(env?.TG_Chat_ID || ''));
    formData.append('document', new Blob([serialized], { type: 'application/json' }), JOURNAL_FILENAME);

    const result = await telegram.sendFormData(formData, 'sendDocument');
    if (!result || !result.success) {
      throw new CloudAdapterError('telegram_journal_append_failed', 'Telegram journal append failed.');
    }

    const fileId = getFileId(result.data);
    const messageId = getTelegramMessageId(result.data);
    if (!fileId || !messageId) {
      throw new CloudAdapterError('telegram_journal_append_invalid_response', 'Telegram journal append returned an invalid response.');
    }

    return Object.freeze({
      provider: TELEGRAM_JOURNAL_PROVIDER,
      fileId: assertTelegramFileId(fileId),
      messageId: assertTelegramMessageId(messageId),
      byteLength,
    });
  }

  async function readJson(pointer) {
    const normalized = normalizePointer(pointer);
    const filePath = await telegram.getFilePath(normalized.fileId);
    const fileUrl = telegram.getFileDownloadUrl(filePath);
    if (!fileUrl) {
      throw new CloudAdapterError('telegram_journal_read_unavailable', 'Telegram journal entry could not be read.');
    }

    const response = await telegram.fetchDownload(fileUrl, new Request('https://telegraph-cloud.invalid/journal'));
    if (!response || !response.ok) {
      throw new CloudAdapterError('telegram_journal_read_failed', 'Telegram journal entry could not be read.');
    }

    let payload;
    try {
      payload = JSON.parse(await response.text());
    } catch (_) {
      throw new CloudAdapterError('telegram_journal_invalid_json', 'Telegram journal entry is not valid JSON.', { status: 500 });
    }
    return serializeJsonDocument(payload).value;
  }

  return Object.freeze({
    key: TELEGRAM_JOURNAL_PROVIDER,
    validateConfig: () => telegram.validateConfig(),
    appendJson,
    readJson,
  });
}
