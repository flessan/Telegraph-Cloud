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
