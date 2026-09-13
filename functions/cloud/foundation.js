import { createCloudIndexStore } from './index-store.js';
import { createTelegramClient } from './telegram-client.js';
import { createTelegramJournalAdapter } from './telegram-journal.js';

/**
 * Composition root for persistence pieces shared by Cloud services. It creates
 * no HTTP route itself: Phase 2's document adapter composes `{ index, journal }`
 * from here, while Phase 4 can compose an object adapter from the same index
 * plus a Telegram object transport.
 */
export function createCloudPersistenceFoundation(env, {
  index = null,
  telegram = null,
  journal = null,
  telegramOptions,
} = {}) {
  const resolvedIndex = index || createCloudIndexStore(env);
  const resolvedTelegram = telegram || createTelegramClient(env, telegramOptions);
  const resolvedJournal = journal || createTelegramJournalAdapter(env, { client: resolvedTelegram });

  return Object.freeze({
    index: resolvedIndex,
    telegram: resolvedTelegram,
    journal: resolvedJournal,
  });
}
