const assert = require('assert');
const { muteConsole } = require('./helpers');

describe('shared Telegram client boundary', function () {
  let telegram;

  before(async function () {
    telegram = await import('../functions/cloud/telegram-client.js');
  });

  it('forwards only cache and delivery headers and never forwards a caller body', function () {
    const secret = 'do-not-forward';
    const request = new Request('https://example.com/file/item', {
      method: 'POST',
      headers: {
        Accept: 'application/octet-stream',
        Range: 'bytes=10-20',
        'If-None-Match': '"etag"',
        Authorization: `Bearer ${secret}`,
        Cookie: `session=${secret}`,
        'X-API-Key': secret,
        Referer: 'https://other.example/',
        'X-Unrelated': secret,
      },
      body: `sensitive body ${secret}`,
    });

    const init = telegram.createTelegramDownloadRequestInit(request);
    assert.strictEqual(init.method, 'POST', 'legacy method behavior remains unchanged');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(init, 'body'), false);
    assert.strictEqual(init.headers.get('Accept'), 'application/octet-stream');
    assert.strictEqual(init.headers.get('Range'), 'bytes=10-20');
    assert.strictEqual(init.headers.get('If-None-Match'), '"etag"');
    for (const forbidden of ['Authorization', 'Cookie', 'X-API-Key', 'Referer', 'X-Unrelated']) {
      assert.strictEqual(init.headers.get(forbidden), null, `${forbidden} must not be forwarded`);
    }
  });

  it('accepts only safe Telegram file paths returned by getFile', async function () {
    const restoreConsole = muteConsole();
    try {
      const client = telegram.createTelegramClient(
        { TG_Bot_Token: '123:secret' },
        {
          fetchImpl: async () => Response.json({
            ok: true,
            result: { file_path: '../attempted-path-escape' },
          }),
        },
      );
      assert.strictEqual(await client.getFilePath('AgACAgEAAxkDAA_1-2'), null);
      assert.strictEqual(client.getFileDownloadUrl('../attempted-path-escape'), null);
    } finally {
      restoreConsole();
    }
  });
});


describe('Telegram upload resilience', function () {
  it('retries transient Telegram responses and honors Retry-After', async function () {
    const { createTelegramClient } = await import('../functions/cloud/telegram-client.js');
    const delays = [];
    let calls = 0;
    const client = createTelegramClient(
      { TG_Bot_Token: 'bot-token' },
      {
        fetchImpl: async () => {
          calls += 1;
          if (calls < 3) {
            return Response.json(
              { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 2 } },
              { status: 429, headers: { 'Retry-After': '2' } },
            );
          }
          return Response.json({ ok: true, result: { document: { file_id: 'doc-id' } } });
        },
        sleepImpl: async (ms) => delays.push(ms),
        randomImpl: () => 0,
      },
    );
    const form = new FormData();
    form.append('chat_id', '-100');
    form.append('document', new File(['hello'], 'a.txt', { type: 'text/plain' }));
    const result = await client.sendFormData(form, 'sendDocument');
    assert.strictEqual(result.success, true);
    assert.strictEqual(calls, 3);
    assert.deepStrictEqual(delays, [2000, 2000]);
  });

  it('retries network failures with bounded exponential backoff', async function () {
    const { createTelegramClient } = await import('../functions/cloud/telegram-client.js');
    const delays = [];
    let calls = 0;
    const client = createTelegramClient(
      { TG_Bot_Token: 'bot-token' },
      {
        fetchImpl: async () => {
          calls += 1;
          throw new Error('network');
        },
        sleepImpl: async (ms) => delays.push(ms),
        randomImpl: () => 0,
      },
    );
    const form = new FormData();
    form.append('chat_id', '-100');
    form.append('document', new File(['hello'], 'a.txt', { type: 'text/plain' }));
    const result = await client.sendFormData(form, 'sendDocument');
    assert.strictEqual(result.success, false);
    assert.strictEqual(result.error, 'Network error occurred');
    assert.strictEqual(calls, 4);
    assert.deepStrictEqual(delays, [1000, 2000, 4000]);
  });

  it('falls back media validation failures to sendDocument without duplicating retryable failures', async function () {
    const { createTelegramClient } = await import('../functions/cloud/telegram-client.js');
    const endpoints = [];
    const client = createTelegramClient(
      { TG_Bot_Token: 'bot-token' },
      {
        fetchImpl: async (input) => {
          const endpoint = String(input).split('/').pop();
          endpoints.push(endpoint);
          if (endpoint === 'sendPhoto') {
            return Response.json({ ok: false, error_code: 400, description: 'media rejected' }, { status: 400 });
          }
          return Response.json({ ok: true, result: { document: { file_id: 'doc-id' } } });
        },
        sleepImpl: async () => {},
      },
    );
    const form = new FormData();
    form.append('chat_id', '-100');
    form.append('photo', new File(['hello'], 'a.png', { type: 'image/png' }));
    const result = await client.sendFormData(form, 'sendPhoto');
    assert.strictEqual(result.success, true);
    assert.deepStrictEqual(endpoints, ['sendPhoto', 'sendDocument']);
  });
});


describe('Telegram failure classification', function () {
  it('classifies a 400 chat-not-found response safely', async function () {
    const { classifyTelegramApiFailure } = await import('../functions/cloud/telegram-client.js');
    const reason = await classifyTelegramApiFailure(
      new Response(null, { status: 400 }),
      { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
    );
    assert.strictEqual(reason, 'chat_not_found');
  });

  it('classifies a 400 permission response as forbidden', async function () {
    const { classifyTelegramApiFailure } = await import('../functions/cloud/telegram-client.js');
    const reason = await classifyTelegramApiFailure(
      new Response(null, { status: 400 }),
      { ok: false, error_code: 400, description: 'Bad Request: not enough rights to send messages' },
    );
    assert.strictEqual(reason, 'forbidden');
  });
});