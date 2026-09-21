const assert = require('assert');
const { createMockKV, installFetchMock, makeContext, muteConsole } = require('./helpers');

describe('upload function', function () {
  let restoreConsole;
  let fetchMock;

  beforeEach(function () {
    restoreConsole = muteConsole();
  });

  afterEach(function () {
    if (fetchMock) {
      fetchMock.restore();
      fetchMock = null;
    }
    restoreConsole();
  });

  async function createUploadRequest(file) {
    const formData = new FormData();
    formData.append('file', file);

    return new Request('https://example.com/upload', {
      method: 'POST',
      body: formData,
    });
  }

  it('uploads images with sendPhoto and stores metadata in KV', async function () {
    const { onRequestPost } = await import('../functions/upload.js');
    const img_url = createMockKV();

    fetchMock = installFetchMock(async (input, init) => {
      assert.strictEqual(String(input), 'https://api.telegram.org/botbot-token/sendPhoto');
      assert.strictEqual(init.method, 'POST');
      assert.strictEqual(init.body.get('chat_id'), '-100123');
      assert.ok(init.body.get('photo') instanceof File);

      return Response.json({
        ok: true,
        result: {
          photo: [
            { file_id: 'small-id', file_size: 10 },
            { file_id: 'large-id', file_size: 20 },
          ],
        },
      });
    });

    const request = await createUploadRequest(new File(['image-bytes'], 'cat.png', { type: 'image/png' }));
    const res = await onRequestPost(makeContext({
      request,
      env: {
        disable_telemetry: 'true',
        TG_Bot_Token: 'bot-token',
        TG_Chat_ID: '-100123',
        img_url,
      },
    }));

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(await res.text()), [{ src: '/file/large-id.png' }]);
    assert.strictEqual(fetchMock.calls.length, 1);

    const stored = img_url.snapshot('large-id.png');
    assert.strictEqual(stored.value, '');
    assert.strictEqual(stored.metadata.ListType, 'None');
    assert.strictEqual(stored.metadata.Label, 'None');
    assert.strictEqual(stored.metadata.fileName, 'cat.png');
    assert.strictEqual(stored.metadata.fileSize, 11);
    assert.strictEqual(stored.metadata.liked, false);
    assert.ok(Number.isFinite(stored.metadata.TimeStamp));
  });

  it('retries failed image uploads as documents', async function () {
    const { onRequestPost } = await import('../functions/upload.js');

    fetchMock = installFetchMock(async (input, init, calls) => {
      if (calls.length === 1) {
        assert.strictEqual(String(input), 'https://api.telegram.org/botbot-token/sendPhoto');
        assert.ok(init.body.get('photo') instanceof File);
        return Response.json({ ok: false, description: 'Bad Request: wrong file identifier' }, { status: 400 });
      }

      assert.strictEqual(String(input), 'https://api.telegram.org/botbot-token/sendDocument');
      assert.ok(init.body.get('document') instanceof File);
      return Response.json({
        ok: true,
        result: {
          document: { file_id: 'doc-id' },
        },
      });
    });

    const request = await createUploadRequest(new File(['image-bytes'], 'cat.webp', { type: 'image/webp' }));
    const res = await onRequestPost(makeContext({
      request,
      env: {
        disable_telemetry: 'true',
        TG_Bot_Token: 'bot-token',
        TG_Chat_ID: '-100123',
      },
    }));

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(await res.text()), [{ src: '/file/doc-id.webp' }]);
    assert.strictEqual(fetchMock.calls.length, 2);
  });

  it('uploads non-media files with sendDocument', async function () {
    const { onRequestPost } = await import('../functions/upload.js');

    fetchMock = installFetchMock(async (input, init) => {
      assert.strictEqual(String(input), 'https://api.telegram.org/botbot-token/sendDocument');
      assert.strictEqual(init.body.get('chat_id'), '-100123');
      assert.ok(init.body.get('document') instanceof File);
      return Response.json({
        ok: true,
        result: {
          document: { file_id: 'doc-id' },
        },
      });
    });

    const request = await createUploadRequest(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    const res = await onRequestPost(makeContext({
      request,
      env: {
        disable_telemetry: 'true',
        TG_Bot_Token: 'bot-token',
        TG_Chat_ID: '-100123',
      },
    }));

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(await res.text()), [{ src: '/file/doc-id.txt' }]);
  });

  it('returns a JSON error when the upload form has no file field', async function () {
    const { onRequestPost } = await import('../functions/upload.js');
    const request = new Request('https://example.com/upload', {
      method: 'POST',
      body: new FormData(),
    });

    const res = await onRequestPost(makeContext({
      request,
      env: {
        disable_telemetry: 'true',
        TG_Bot_Token: 'bot-token',
        TG_Chat_ID: '-100123',
      },
    }));

    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(JSON.parse(await res.text()), { error: 'no_file' });
  });

  it('requires basic auth when upload credentials are configured', async function () {
    const { onRequestPost } = await import('../functions/upload.js');
    const request = await createUploadRequest(new File(['hello'], 'notes.txt', { type: 'text/plain' }));

    const res = await onRequestPost(makeContext({
      request,
      env: {
        disable_telemetry: 'true',
        UPLOAD_BASIC_USER: 'uploader',
        UPLOAD_BASIC_PASS: 'secret',
        TG_Bot_Token: 'bot-token',
        TG_Chat_ID: '-100123',
      },
    }));

    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.headers.get('WWW-Authenticate'), 'Basic realm="my scope", charset="UTF-8"');
    assert.strictEqual(await res.text(), 'You need to login.');
  });

  it('rejects invalid upload basic auth credentials', async function () {
    const { onRequestPost } = await import('../functions/upload.js');
    const request = await createUploadRequest(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    request.headers.set('Authorization', `Basic ${btoa('uploader:wrong')}`);

    const res = await onRequestPost(makeContext({
      request,
      env: {
        disable_telemetry: 'true',
        UPLOAD_BASIC_USER: 'uploader',
        UPLOAD_BASIC_PASS: 'secret',
        TG_Bot_Token: 'bot-token',
        TG_Chat_ID: '-100123',
      },
    }));

    assert.strictEqual(res.status, 401);
    assert.strictEqual(await res.text(), 'Invalid upload credentials.');
  });

  it('allows uploads with valid basic auth credentials', async function () {
    const { onRequestPost } = await import('../functions/upload.js');
    const img_url = createMockKV();

    fetchMock = installFetchMock(async input => {
      assert.strictEqual(String(input), 'https://api.telegram.org/botbot-token/sendDocument');
      return Response.json({
        ok: true,
        result: {
          document: { file_id: 'doc-id' },
        },
      });
    });

    const request = await createUploadRequest(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    request.headers.set('Authorization', `Basic ${btoa('uploader:secret')}`);

    const res = await onRequestPost(makeContext({
      request,
      env: {
        disable_telemetry: 'true',
        UPLOAD_BASIC_USER: 'uploader',
        UPLOAD_BASIC_PASS: 'secret',
        TG_Bot_Token: 'bot-token',
        TG_Chat_ID: '-100123',
        img_url,
      },
    }));

    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(JSON.parse(await res.text()), [{ src: '/file/doc-id.txt' }]);
    assert.strictEqual(img_url.operations.put.length, 1);
    assert.strictEqual(img_url.operations.put[0].key, 'doc-id.txt');
  });

  it('returns a short link and stores the mapping when short URLs are enabled', async function () {
    const { onRequestPost } = await import('../functions/upload.js');
    const img_url = createMockKV();

    fetchMock = installFetchMock(async () => Response.json({
      ok: true,
      result: { document: { file_id: 'doc-id' } },
    }));

    const request = await createUploadRequest(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    const res = await onRequestPost(makeContext({
      request,
      env: {
        disable_telemetry: 'true',
        ENABLE_SHORT_URLS: 'true',
        TG_Bot_Token: 'bot-token',
        TG_Chat_ID: '-100123',
        img_url,
      },
    }));

    assert.strictEqual(res.status, 200);
    const [entry] = JSON.parse(await res.text());
    const match = entry.src.match(/^\/file\/([A-Za-z0-9]{6})$/);
    assert.ok(match, `expected a short link, got ${entry.src}`);

    const shortId = match[1];
    assert.strictEqual(img_url.snapshot('doc-id.txt').metadata.shortId, shortId);
    assert.strictEqual(img_url.snapshot(`short:${shortId}`).metadata.target, 'doc-id.txt');
  });

  it('returns a generic safe error when Telegram responds with non-JSON text', async function () {
    const { onRequestPost } = await import('../functions/upload.js');

    fetchMock = installFetchMock(async input => {
      assert.strictEqual(String(input), 'https://api.telegram.org/botbot-token/sendDocument');
      return new Response('error code: 502', {
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
      });
    });

    const request = await createUploadRequest(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    const res = await onRequestPost(makeContext({
      request,
      env: {
        disable_telemetry: 'true',
        TG_Bot_Token: 'bot-token',
        TG_Chat_ID: '-100123',
      },
    }));

    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(JSON.parse(await res.text()), {
      error: 'telegram_upstream_unavailable',
    });
  });

  it('never echoes or logs an upstream Telegram detail, Bot token, or chat identifier', async function () {
    const { onRequestPost } = await import('../functions/upload.js');
    const botToken = '123456:bot-token-that-must-not-be-logged';
    const chatId = '-1001234567890';
    const upstreamDetail = `request failed for https://api.telegram.org/bot${botToken}/sendDocument chat=${chatId}`;
    const logged = [];
    const mutedError = console.error;
    console.error = (...args) => logged.push(args);
    try {
      fetchMock = installFetchMock(async () => Response.json({ ok: false, description: upstreamDetail }, { status: 502 }));
      const request = await createUploadRequest(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
      const res = await onRequestPost(makeContext({
        request,
        env: {
          disable_telemetry: 'true',
          TG_Bot_Token: botToken,
          TG_Chat_ID: chatId,
        },
      }));

      assert.strictEqual(res.status, 503);
      assert.strictEqual(res.headers.get('Cache-Control'), 'no-store');
      const serialized = `${await res.text()} ${JSON.stringify(logged)}`;
      assert.strictEqual(serialized.includes(upstreamDetail), false, serialized);
      assert.strictEqual(serialized.includes(botToken), false, serialized);
      assert.strictEqual(serialized.includes(chatId), false, serialized);
      assert.ok(serialized.includes('telegram_upstream_unavailable'), serialized);
    } finally {
      console.error = mutedError;
    }
  });

  it('classifies Telegram authentication failure without exposing the provider response', async function () {
    const { onRequestPost } = await import('../functions/upload.js');
    fetchMock = installFetchMock(async input => {
      assert.strictEqual(String(input), 'https://api.telegram.org/botbot-token/sendDocument');
      return Response.json({ ok: false, error_code: 401, description: 'Unauthorized: bot token is invalid' }, { status: 401 });
    });

    const request = await createUploadRequest(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    const res = await onRequestPost(makeContext({
      request,
      env: { disable_telemetry: 'true', TG_Bot_Token: 'bot-token', TG_Chat_ID: '-100123' },
    }));

    assert.strictEqual(res.status, 502);
    assert.deepStrictEqual(JSON.parse(await res.text()), { error: 'telegram_auth_failed' });
  });

  it('classifies exhausted Telegram network failure as temporarily unavailable', async function () {
    const { onRequestPost } = await import('../functions/upload.js');
    fetchMock = installFetchMock(async () => {
      throw new Error('connect ECONNRESET');
    });

    const request = await createUploadRequest(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    const res = await onRequestPost(makeContext({
      request,
      env: { disable_telemetry: 'true', TG_Bot_Token: 'bot-token', TG_Chat_ID: '-100123' },
    }));

    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(JSON.parse(await res.text()), { error: 'telegram_network_error' });
  });

  it('returns a clear value-free configuration error when Telegram environment variables are missing', async function () {
    const { onRequestPost } = await import('../functions/upload.js');
    const request = await createUploadRequest(new File(['hello'], 'notes.txt', { type: 'text/plain' }));

    const res = await onRequestPost(makeContext({
      request,
      env: { disable_telemetry: 'true' },
    }));

    assert.strictEqual(res.status, 503);
    assert.deepStrictEqual(JSON.parse(await res.text()), {
      error: 'telegram_not_configured',
    });
  });
});
