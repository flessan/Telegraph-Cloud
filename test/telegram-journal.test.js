const assert = require('assert');

describe('Telegram journal foundation', function () {
  let createTelegramJournalAdapter;

  before(async function () {
    ({ createTelegramJournalAdapter } = await import('../functions/cloud/telegram-journal.js'));
  });

  it('appends immutable JSON as a Telegram document with an internal pointer', async function () {
    const calls = [];
    const client = {
      validateConfig() { calls.push({ type: 'validate' }); },
      async sendFormData(formData, endpoint) {
        calls.push({ type: 'send', endpoint, formData });
        return {
          success: true,
          data: {
            ok: true,
            result: {
              message_id: 101,
              document: { file_id: 'AgACAgEAAxkDAA_1-2' },
            },
          },
        };
      },
      async getFilePath() { return 'documents/journal.json'; },
      getFileDownloadUrl() { return 'https://api.telegram.org/file/botsecret/documents/journal.json'; },
      async fetchDownload() { return Response.json({}); },
    };
    const journal = createTelegramJournalAdapter({ TG_Chat_ID: '-100123' }, { client });

    const pointer = await journal.appendJson({
      schema: 'telegraph-cloud.record.v1',
      event_id: 'evt_123',
      document: { id: 'usr_123', role: 'member' },
    });

    assert.deepStrictEqual(pointer.provider, 'telegram-journal');
    assert.strictEqual(pointer.fileId, 'AgACAgEAAxkDAA_1-2');
    assert.strictEqual(pointer.messageId, 101);
    assert.ok(pointer.byteLength > 0);
    assert.ok(Object.isFrozen(pointer));
    assert.deepStrictEqual(calls.map((call) => call.type), ['validate', 'send']);
    assert.strictEqual(calls[1].endpoint, 'sendDocument');
    assert.strictEqual(calls[1].formData.get('chat_id'), '-100123');

    const document = calls[1].formData.get('document');
    assert.strictEqual(document.type, 'application/json');
    assert.strictEqual(document.name, 'telegraph-cloud-revision.json');
    assert.deepStrictEqual(JSON.parse(await document.text()), {
      schema: 'telegraph-cloud.record.v1',
      event_id: 'evt_123',
      document: { id: 'usr_123', role: 'member' },
    });
  });

  it('reads a journal payload only through the injected Telegram client boundary', async function () {
    const calls = [];
    const client = {
      validateConfig() {},
      async sendFormData() { throw new Error('not used'); },
      async getFilePath(fileId) {
        calls.push({ type: 'getFilePath', fileId });
        return 'documents/journal.json';
      },
      getFileDownloadUrl(filePath) {
        calls.push({ type: 'getFileDownloadUrl', filePath });
        return 'https://telegram.invalid/journal';
      },
      async fetchDownload(url, request) {
        calls.push({ type: 'fetchDownload', url, method: request.method });
        return Response.json({ id: 'usr_123', role: 'member' });
      },
    };
    const journal = createTelegramJournalAdapter({}, { client });

    const value = await journal.readJson({
      provider: 'telegram-journal',
      fileId: 'AgACAgEAAxkDAA_1-2',
      messageId: 101,
    });

    assert.deepStrictEqual(value, { id: 'usr_123', role: 'member' });
    assert.deepStrictEqual(calls, [
      { type: 'getFilePath', fileId: 'AgACAgEAAxkDAA_1-2' },
      { type: 'getFileDownloadUrl', filePath: 'documents/journal.json' },
      { type: 'fetchDownload', url: 'https://telegram.invalid/journal', method: 'GET' },
    ]);
  });

  it('returns safe adapter failures instead of an upstream error payload', async function () {
    const unsafeUpstreamMessage = 'bot-token-should-not-escape';
    const client = {
      validateConfig() {},
      async sendFormData() {
        return { success: false, error: unsafeUpstreamMessage };
      },
      async getFilePath() { return null; },
      getFileDownloadUrl() { return null; },
      async fetchDownload() { return new Response('', { status: 500 }); },
    };
    const journal = createTelegramJournalAdapter({ TG_Chat_ID: '-100123' }, { client });

    await assert.rejects(
      () => journal.appendJson({ id: 'usr_123' }),
      (error) => error && error.code === 'telegram_journal_append_failed' && !error.message.includes(unsafeUpstreamMessage),
    );
  });
});
