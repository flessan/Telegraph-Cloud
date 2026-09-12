import { createCloudIndexStore } from './index-store.js';
import { createTelegramClient } from './telegram-client.js';
import { createTelegramJournalAdapter } from './telegram-journal.js';

/**
 * Composition root for the persistence pieces shared by future Cloud services.
 * It intentionally creates no HTTP routes and no document/object CRUD surface.
 *
 * Phase 2 will build a document adapter from `{ index, journal }`; Phase 4 will
 * build an object adapter from the same index plus a Telegram object transport.
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
