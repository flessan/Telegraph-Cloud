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
      'https://example.com/api/db/[resource]',
    );
    assert.strictEqual(
      middleware.sanitizeTelemetryUrl(`https://api.telegram.org/file/bot${secret}/documents/file.json?token=${secret}`),
      'https://api.telegram.org/file/bot[redacted]/[telegram-resource]',
    );
    assert.strictEqual(
      middleware.sanitizeTelemetryUrl('https://example.com/api/storage/assets/customer-secret/report.json?ignored=yes'),
      'https://example.com/api/storage/[resource]',
    );
    assert.strictEqual(
      middleware.sanitizeTelemetryUrl('https://s3.example.test/s3/assets/customer-secret/report.json?X-Amz-Signature=secret'),
      'https://s3.example.test/s3/[resource]',
    );
    assert.strictEqual(
      middleware.redactSensitiveText(`request failed at https://api.telegram.org/bot${secret}/sendDocument?api_key=${secret}`),
      'request failed at https://api.telegram.org/bot[redacted]/[telegram-resource]?api_key=[redacted]',
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
    assert.strictEqual(safe.request.url, 'https://s3.example.test/s3/[resource]');
    assert.strictEqual(safe.request.headers.authorization, '[redacted]');
  });

  it('redacts canonical SigV4 material, payload hashes/bodies, and nested breadcrumb fields', function () {
    const botToken = '123456:telegram-bot-token';
    const secretAccessKey = 'this-is-a-one-time-s3-secret-that-must-not-be-recorded';
    const payloadHash = 'a'.repeat(64);
    const signature = 'b'.repeat(64);
    const canonicalRequest = `PUT\n/s3/assets/customer/private.txt\n\nhost:s3.example.test\nx-amz-content-sha256:${payloadHash}\n\nhost;x-amz-content-sha256\n${payloadHash}`;
    const safe = middleware.redactTelemetryEvent({
      message: `canonical request: ${canonicalRequest}`,
      transaction: '/s3/assets/customer/private.txt',
      extra: {
        secret_access_key: secretAccessKey,
        nested: {
          canonical_request: canonicalRequest,
          payloadHash,
          body: 'private upload body',
          signature,
          telegram: `https://api.telegram.org/bot${botToken}/getMe`,
        },
      },
      breadcrumbs: [{
        message: `Authorization: AWS4-HMAC-SHA256 Credential=tgsk_live_example, Signature=${signature}`,
        data: {
          headers: { 'x-amz-content-sha256': payloadHash },
          request_body: 'private upload body',
          nested: { payload_hash: payloadHash, url: `https://api.telegram.org/bot${botToken}/getMe` },
        },
      }],
      spans: [{
        description: `GET https://api.telegram.org/file/bot${botToken}/documents/private.bin`,
        data: 'private upload body',
      }],
    });
    const serialized = JSON.stringify(safe);
    for (const forbidden of [botToken, secretAccessKey, payloadHash, signature, canonicalRequest, 'private upload body']) {
      assert.ok(!serialized.includes(forbidden), serialized);
    }
    assert.strictEqual(safe.message, '[redacted sensitive SigV4 request material]');
    assert.strictEqual(safe.transaction, '/s3/[resource]');
    assert.strictEqual(safe.extra.secret_access_key, '[redacted]');
    assert.strictEqual(safe.extra.nested.canonical_request, '[redacted]');
    assert.strictEqual(safe.extra.nested.payloadHash, '[redacted]');
    assert.strictEqual(safe.extra.nested.body, '[redacted]');
    assert.strictEqual(safe.breadcrumbs[0].data.headers['x-amz-content-sha256'], undefined);
    assert.strictEqual(safe.breadcrumbs[0].data.request_body, '[redacted]');
    assert.strictEqual(safe.breadcrumbs[0].data.nested.payload_hash, '[redacted]');
    assert.strictEqual(safe.breadcrumbs[0].data.nested.url, 'https://api.telegram.org/bot[redacted]/[telegram-resource]');
    assert.strictEqual(safe.spans[0].description, 'GET https://api.telegram.org/file/[resource]');
    assert.strictEqual(safe.spans[0].data, '[redacted]');
  });

  it('scrubs embedded provider URLs, generic key fields, and external account paths in spans', function () {
    const moderationKey = 'moderation-key-must-not-leak';
    const rawFile = 'customer-private-file.png';
    const accountId = 'internal-cloudflare-account-id';
    const safe = middleware.redactTelemetryEvent({
      tags: { attempted_path: '/s3/assets/customer-secret/file.txt' },
      spans: [{
        description: `GET https://api.moderatecontent.com/moderate/?key=${moderationKey}&url=https://telegra.ph/file/${rawFile}`,
        data: { key: moderationKey },
      }, {
        description: `GET https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=100`,
      }],
    });

    const serialized = JSON.stringify(safe);
    for (const forbidden of [moderationKey, rawFile, accountId, 'customer-secret']) {
      assert.ok(!serialized.includes(forbidden), serialized);
    }
    assert.strictEqual(safe.tags.attempted_path, '/s3/[resource]');
    assert.strictEqual(safe.spans[0].description, 'GET https://api.moderatecontent.com/moderate/');
    assert.strictEqual(safe.spans[0].data.key, '[redacted]');
    assert.strictEqual(safe.spans[1].description, 'GET https://api.cloudflare.com/[provider-resource]');
  });

  it('redacts named Telegram chat/file identifiers from messages and nested telemetry fields', function () {
    const chatId = '-1001234567890';
    const fileId = 'AgACAgIAAxkBAAIBfakeTelegramFileIdentifier';
    const safe = middleware.redactTelemetryEvent({
      extra: { chatId, telegram_file_id: fileId },
      breadcrumbs: [{
        message: `Telegram delivery failed chat=${chatId} file_id=${fileId}`,
        data: { chat_id: chatId, filePath: `documents/${fileId}` },
      }],
    });

    const serialized = JSON.stringify(safe);
    assert.ok(!serialized.includes(chatId), serialized);
    assert.ok(!serialized.includes(fileId), serialized);
    assert.strictEqual(safe.extra.chatId, '[redacted]');
    assert.strictEqual(safe.extra.telegram_file_id, '[redacted]');
    assert.strictEqual(safe.breadcrumbs[0].data.chat_id, '[redacted]');
    assert.strictEqual(safe.breadcrumbs[0].data.filePath, '[redacted]');
    assert.strictEqual(safe.breadcrumbs[0].message, 'Telegram delivery failed chat=[redacted] file_id=[redacted]');
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
    assert.strictEqual(safe.request.url, 'https://example.com/api/db/[resource]');
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
    assert.strictEqual(contexts[0][1].url, 'https://example.com/api/db/[resource]');
    assert.ok(tags.some(([key, value]) => key === 'telegraph_cloud.route_family' && value === 'database'));
    assert.ok(tags.some(([key, value]) => key === 'telegraph_cloud.response_class' && value === '2xx'));
  });

  it('does not let a telemetry tag failure change a completed response or diagnostics result', async function () {
    let tagCalls = 0;
    const sentry = {
      setTag() {
        tagCalls += 1;
        // The first three tags are the existing request-context setup; fail
        // only when the new response-outcome tags are attempted.
        if (tagCalls > 3) throw new Error('telemetry provider detail must not affect a response');
      },
      setContext() {},
    };
    const context = makeContext({
      data: { sentry },
      request: new Request('https://example.com/api/projects/diagnostics'),
      next: async () => new Response('completed'),
    });

    const response = await middleware.telemetryData(context);
    assert.strictEqual(await response.text(), 'completed');
    assert.doesNotThrow(() => middleware.recordOperationalSignal(
      { data: { sentry: { setTag() { throw new Error('unavailable'); } } } },
      'operator_readiness',
      'ready_for_smoke',
    ));
  });

  it('allows only fixed operational diagnostic signal values', function () {
    const tags = [];
    const context = { data: { sentry: { setTag(key, value) { tags.push([key, value]); } } } };
    middleware.recordOperationalSignal(context, 'operator_readiness', 'ready_for_smoke');
    middleware.recordOperationalSignal(context, 'operator_readiness', 'https://example.test/private/path');
    middleware.recordOperationalSignal(context, 'unrecognised_signal', 'degraded');

    assert.deepStrictEqual(tags, [['telegraph_cloud.signal', 'operator_readiness:ready_for_smoke']]);
  });
});
