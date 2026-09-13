const assert = require('assert');
const { makeContext } = require('./helpers');

describe('telemetry security boundaries', function () {
  let middleware;

  before(async function () {
    middleware = await import('../functions/utils/middleware.js');
  });

  it('redacts credential-bearing headers and omits unknown headers from telemetry', function () {
    const secret = 'tg_live_this-must-not-be-recorded';
    const headers = new Headers({
      Authorization: `Bearer ${secret}`,
      Cookie: `ti_session=${secret}`,
      'X-API-Key': secret,
      'X-Telegram-Bot-Api-Secret-Token': secret,
      'Content-Type': 'application/json',
      'X-Unrelated-Debug': secret,
    });

    const safe = middleware.redactTelemetryHeaders(headers);
    assert.deepStrictEqual(safe, {
      authorization: '[redacted]',
      cookie: '[redacted]',
      'x-api-key': '[redacted]',
      'x-telegram-bot-api-secret-token': '[redacted]',
      'content-type': 'application/json',
    });
    assert.ok(!JSON.stringify(safe).includes(secret));
    assert.strictEqual(Object.prototype.hasOwnProperty.call(safe, 'x-unrelated-debug'), false);
  });

  it('drops query values and masks Telegram Bot API path tokens in telemetry URLs', function () {
    const secret = '12345:telegram-bot-token';
    assert.strictEqual(
      middleware.sanitizeTelemetryUrl(`https://example.com/api/db/users?api_key=${secret}#ignored`),
      'https://example.com/api/db/users',
    );
    assert.strictEqual(
      middleware.sanitizeTelemetryUrl(`https://api.telegram.org/file/bot${secret}/documents/file.json?token=${secret}`),
      'https://api.telegram.org/file/bot[redacted]/documents/file.json',
    );
    assert.strictEqual(
      middleware.sanitizeTelemetryUrl('https://example.com/api/storage/assets/customer-secret/report.json?ignored=yes'),
      'https://example.com/api/storage/assets/[object-key]',
    );
    assert.strictEqual(
      middleware.sanitizeTelemetryUrl('https://s3.example.test/s3/assets/customer-secret/report.json?X-Amz-Signature=secret'),
      'https://s3.example.test/s3/assets/[object-key]',
    );
    assert.strictEqual(
      middleware.redactSensitiveText(`request failed at https://api.telegram.org/bot${secret}/sendDocument?api_key=${secret}`),
      'request failed at https://api.telegram.org/bot[redacted]/sendDocument?api_key=[redacted]',
    );
  });

  it('redacts a full developer key if application text accidentally interpolates it', function () {
    const secret = `tg_live_key_${'a'.repeat(22)}_${'b'.repeat(43)}`;
    const safe = middleware.redactTelemetryEvent({
      message: `developer request failed for ${secret}`,
      exception: { values: [{ value: `Bearer ${secret}` }] },
      breadcrumbs: [{ message: `retry ${secret}` }],
    });
    const serialized = JSON.stringify(safe);
    assert.ok(!serialized.includes(secret), serialized);
    assert.ok(serialized.includes('tg_live_[redacted]'), serialized);
  });

  it('redacts S3 access-key identifiers and S3 object paths if application text interpolates them', function () {
    const accessKeyId = `tgsk_live_${'a'.repeat(22)}`;
    const safe = middleware.redactTelemetryEvent({
      message: `SigV4 failure for ${accessKeyId}`,
      request: {
        url: `https://s3.example.test/s3/assets/customer-secret/file.txt?credential=${accessKeyId}`,
        headers: { authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/20260913/us-east-1/s3/aws4_request` },
      },
    });
    const serialized = JSON.stringify(safe);
    assert.ok(!serialized.includes(accessKeyId), serialized);
    assert.ok(serialized.includes('tgsk_live_[redacted]'), serialized);
    assert.strictEqual(safe.request.url, 'https://s3.example.test/s3/assets/[object-key]');
    assert.strictEqual(safe.request.headers.authorization, '[redacted]');
  });

  it('registers the same scrubber for Sentry error and transaction events', function () {
    const options = middleware.createTelemetryOptions(0.01);
    assert.strictEqual(options.beforeSend, middleware.redactTelemetryEvent);
    assert.strictEqual(options.beforeSendTransaction, middleware.redactTelemetryEvent);
  });

  it('scrubs automatically captured Sentry events as a defense in depth', function () {
    const secret = 'top-secret-value';
    const event = {
      request: {
        headers: {
          authorization: `Bearer ${secret}`,
          cookie: `session=${secret}`,
          'content-type': 'application/json',
        },
        url: `https://example.com/api/db/users?token=${secret}`,
        data: { password: secret },
        cookies: `session=${secret}`,
      },
      message: `https://api.telegram.org/bot${secret}/sendDocument?api_key=${secret}`,
      exception: { values: [{ value: `fetch failed https://api.telegram.org/file/bot${secret}/x` }] },
      breadcrumbs: [{
        message: `GET https://api.telegram.org/bot${secret}/getFile`,
        data: {
          headers: { 'x-api-key': secret },
          url: `https://example.com/path?signature=${secret}`,
          api_key: secret,
        },
      }],
    };

    const safe = middleware.redactTelemetryEvent(event);
    const serialized = JSON.stringify(safe);
    assert.ok(!serialized.includes(secret), serialized);
    assert.deepStrictEqual(safe.request.headers, {
      authorization: '[redacted]',
      cookie: '[redacted]',
      'content-type': 'application/json',
    });
    assert.strictEqual(safe.request.data, undefined);
    assert.strictEqual(safe.request.cookies, undefined);
    assert.strictEqual(safe.request.url, 'https://example.com/api/db/users');
    assert.strictEqual(safe.breadcrumbs[0].data.headers['x-api-key'], '[redacted]');
    assert.strictEqual(safe.breadcrumbs[0].data.api_key, '[redacted]');
  });

  it('records only safe telemetry context and always finishes the transaction', async function () {
    const secret = 'never-send-this-to-sentry';
    const tags = [];
    const contexts = [];
    let finishes = 0;
    const sentry = {
      setTag(key, value) { tags.push([key, value]); },
      setContext(key, value) { contexts.push([key, value]); },
      startTransaction() {
        return { finish() { finishes += 1; } };
      },
    };
    const context = makeContext({
      env: {},
      data: { sentry },
      request: new Request(`https://example.com/api/db/users?token=${secret}`, {
        headers: {
          Authorization: `Bearer ${secret}`,
          Cookie: `ti_session=${secret}`,
          'X-API-Key': secret,
          'Content-Type': 'application/json',
        },
      }),
      next: async () => new Response('ok'),
    });

    const response = await middleware.telemetryData(context);
    const serialized = JSON.stringify({ tags, contexts });
    assert.strictEqual(await response.text(), 'ok');
    assert.strictEqual(finishes, 1);
    assert.ok(!serialized.includes(secret), serialized);
    assert.deepStrictEqual(contexts[0][1].headers, {
      authorization: '[redacted]',
      cookie: '[redacted]',
      'x-api-key': '[redacted]',
      'content-type': 'application/json',
    });
    assert.strictEqual(contexts[0][1].url, 'https://example.com/api/db/users');
  });
});
