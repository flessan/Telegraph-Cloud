const assert = require('assert');
const { boot, teardown, click, fire, tick } = require('./dom-harness');

/**
 * Behaviour of Push in the real workspace page: nothing uploads before Push,
 * files go up strictly one at a time with a gap between them, transient
 * failures back off and retry, permanent failures do not block the batch, and
 * cancel/pause keep staged work intact.
 *
 * Timing is made deterministic by configuring the (real, user-facing) push
 * intervals down to a few milliseconds through the workspace preferences.
 */
describe('workspace push queue (DOM)', function () {
  this.timeout(20000);

  let ctx;
  const routes = {
    '/api/config': () => ({ body: { siteName: 'Telegraph-Image', problems: [] } }),
    '/api/manage/albums/assign': () => ({ body: { updated: [], missing: [] } }),
    '/api/manage/albums': () => ({ body: { albums: [], list_complete: true } }),
  };
  const prefs = { pushDelayMs: 60, pushRetryBaseMs: 80 };

  async function start(options = {}) {
    ctx = await boot({
      page: 'admin-legacy.html',
      module: 'js/workspace.js',
      routes,
      prefs: { ...prefs, ...(options.prefs || {}) },
      ...options,
    });
    return ctx;
  }

  async function stage(names) {
    const input = ctx.$('file-input');
    const files = names.map((n) => ctx.file(n, n.endsWith('.png') ? 'image/png' : 'text/plain', 'x'.repeat(10)));
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    fire(input, 'change');
    await tick(40);
  }

  /** Waits until the push button is enabled again (queue idle). */
  async function settle(ms = 1500) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      await tick(25);
      const panel = ctx.$('push-panel');
      const phase = ctx.$('push-phase').textContent;
      if (!panel.hidden && (phase === 'Completed' || phase === 'Cancelled' || phase === 'Paused')) return;
    }
  }

  afterEach(function () {
    teardown();
    ctx = null;
  });

  it('uploads nothing until Push is pressed', async function () {
    await start();
    await stage(['a.png', 'b.png', 'c.png']);
    assert.strictEqual(ctx.uploads.length, 0, 'staging is local only');
    assert.ok(!ctx.calls.some((c) => c.url.includes('/upload')));
    assert.strictEqual(ctx.$('push-panel').hidden, true, 'no queue surface before Push');
    assert.strictEqual(ctx.all('.file-card').length, 3);
  });

  it('uploads one file at a time, in order, spaced by the configured delay', async function () {
    await start();
    await stage(['a.png', 'b.png', 'c.png']);
    click(ctx.$('push-changes'));
    await settle();

    assert.strictEqual(ctx.uploads.length, 3);
    assert.deepStrictEqual(ctx.uploads.map((u) => u.name), ['a.png', 'b.png', 'c.png'], 'deterministic order');

    // Strictly sequential: each request starts only after the previous one
    // finished, and only after the configured gap.
    for (let i = 1; i < ctx.uploads.length; i++) {
      const previous = ctx.uploads[i - 1];
      const current = ctx.uploads[i];
      assert.ok(previous.finishedAt != null, 'previous request completed');
      assert.ok(current.at >= previous.finishedAt, `request ${i} started before request ${i - 1} finished`);
      const gap = current.at - previous.finishedAt;
      assert.ok(gap >= 30, `expected a pause between uploads, got ${gap}ms`);
    }
  });

  it('shows a truthful progress surface and a completion summary', async function () {
    await start();
    await stage(['a.png', 'b.png']);
    click(ctx.$('push-changes'));
    await tick(20);

    const panel = ctx.$('push-panel');
    assert.strictEqual(panel.hidden, false, 'the queue surface appears');
    assert.match(ctx.$('push-progress-text').textContent, /\d of 2/);

    await settle();
    assert.strictEqual(ctx.$('push-phase').textContent, 'Completed');
    assert.strictEqual(ctx.$('push-note').textContent, '2 uploaded · 0 failed · 0 skipped');
    assert.strictEqual(ctx.$('push-pause').hidden, true, 'controls collapse when finished');
    assert.strictEqual(ctx.$('push-dismiss').hidden, false);

    click(ctx.$('push-dismiss'));
    await tick(20);
    assert.strictEqual(ctx.$('push-panel').hidden, true, 'the surface can be dismissed');
  });

  it('shows the waiting countdown between files', async function () {
    await start({ prefs: { pushDelayMs: 400 } });
    await stage(['a.png', 'b.png']);
    click(ctx.$('push-changes'));
    // Somewhere inside the 400ms gap after the first upload.
    await tick(120);
    assert.strictEqual(ctx.$('push-phase').textContent, 'Waiting');
    assert.match(ctx.$('push-note').textContent, /Waiting \d+\.\ds before next upload/);
    await settle();
    assert.strictEqual(ctx.uploads.length, 2);
  });

  it('retries a transient failure with backoff, then succeeds', async function () {
    let attempts = 0;
    await start({
      xhrScript: (call) => {
        if (call.name !== 'a.png') return {};
        attempts += 1;
        if (attempts === 1) return { status: 429, body: { error: 'slow down' }, headers: { 'Retry-After': '0' } };
        return {};
      },
    });
    await stage(['a.png', 'b.png']);
    click(ctx.$('push-changes'));
    await settle();

    const first = ctx.uploads.filter((u) => u.name === 'a.png');
    assert.strictEqual(first.length, 2, 'the rate-limited file was retried once');
    assert.ok(first[1].at - first[0].finishedAt >= 0, 'the retry waited for the backoff');
    assert.strictEqual(ctx.$('push-note').textContent, '2 uploaded · 0 failed · 0 skipped');
    assert.strictEqual(ctx.uploads.filter((u) => u.name === 'b.png').length, 1);
  });

  it('gives up after the bounded retry count and keeps the file retryable', async function () {
    await start({
      xhrScript: (call) => (call.name === 'a.png' ? { networkError: true } : {}),
    });
    await stage(['a.png']);
    click(ctx.$('push-changes'));
    await settle(3000);

    assert.strictEqual(ctx.uploads.length, 4, 'one attempt plus three retries');
    assert.strictEqual(ctx.$('push-note').textContent, '0 uploaded · 1 failed · 0 skipped');
    assert.strictEqual(ctx.$('push-retry-failed').hidden, false, 'a manual retry is offered');
    // The staged file survives with its local data so it can be retried.
    assert.match(ctx.text(), /Failed/);
    assert.strictEqual(ctx.all('.file-card').length, 1);
  });

  it('does not retry a permanent failure and continues with later files', async function () {
    await start({
      xhrScript: (call) => (call.name === 'b.png'
        ? { status: 400, body: { error: 'bad file' } }
        : {}),
    });
    await stage(['a.png', 'b.png', 'c.png']);
    click(ctx.$('push-changes'));
    await settle(3000);

    assert.deepStrictEqual(ctx.uploads.map((u) => u.name), ['a.png', 'b.png', 'c.png'], 'no retry, no blocking');
    assert.strictEqual(ctx.$('push-note').textContent, '2 uploaded · 1 failed · 0 skipped');
  });

  it('retries only the failed file when asked, keeping successful ones synced', async function () {
    let failB = true;
    await start({
      xhrScript: (call) => (call.name === 'b.png' && failB ? { status: 500 } : {}),
      prefs: { pushDelayMs: 20, pushRetryBaseMs: 20 },
    });
    await stage(['a.png', 'b.png']);
    click(ctx.$('push-changes'));
    await settle(4000);
    assert.strictEqual(ctx.$('push-note').textContent, '1 uploaded · 1 failed · 0 skipped');

    failB = false;
    const before = ctx.uploads.length;
    click(ctx.$('push-retry-failed'));
    await tick(120);
    await settle(3000);
    const retried = ctx.uploads.slice(before);
    assert.ok(retried.length >= 1);
    assert.ok(retried.every((u) => u.name === 'b.png'), 'only the failed file is sent again');
    assert.match(ctx.$('push-note').textContent, /2 uploaded · 0 failed/);
  });

  it('cancel stops new uploads and preserves the remaining staged files', async function () {
    await start({ prefs: { pushDelayMs: 300 }, xhrScript: () => ({ delayMs: 30 }) });
    await stage(['a.png', 'b.png', 'c.png', 'd.png']);
    click(ctx.$('push-changes'));
    await tick(60);
    click(ctx.$('push-cancel'));
    await settle();

    assert.ok(ctx.uploads.length <= 2, `expected the batch to stop early, saw ${ctx.uploads.length}`);
    assert.strictEqual(ctx.$('push-phase').textContent, 'Cancelled');
    assert.match(ctx.$('push-note').textContent, /skipped/);
    // Nothing is discarded: the untouched files are still staged locally.
    assert.strictEqual(ctx.all('.file-card').length, 4);
    const pendingChips = ctx.all('[data-role="status"]').map((el) => el.textContent);
    assert.ok(pendingChips.some((label) => /Pending|Not sent/.test(label)), pendingChips.join('|'));
  });

  it('pause lets the active upload finish, then resumes the rest', async function () {
    await start({ prefs: { pushDelayMs: 250 }, xhrScript: () => ({ delayMs: 25 }) });
    await stage(['a.png', 'b.png', 'c.png']);
    click(ctx.$('push-changes'));
    await tick(60);
    click(ctx.$('push-pause'));
    await settle();

    assert.strictEqual(ctx.$('push-phase').textContent, 'Paused');
    const uploadedWhilePaused = ctx.uploads.length;
    assert.ok(uploadedWhilePaused >= 1 && uploadedWhilePaused < 3, String(uploadedWhilePaused));
    assert.ok(ctx.uploads.every((u) => u.finishedAt != null), 'the in-flight request was not killed');
    assert.strictEqual(ctx.$('push-pause').textContent, 'Resume');

    click(ctx.$('push-pause'));
    await settle(3000);
    assert.strictEqual(ctx.uploads.length, 3);
    assert.strictEqual(ctx.$('push-phase').textContent, 'Completed');
  });

  it('blocks Push while offline and keeps every staged file', async function () {
    await start();
    await stage(['a.png', 'b.png']);
    ctx.win.dispatchEvent(new ctx.win.Event('offline'));
    await tick(20);
    click(ctx.$('push-changes'));
    await tick(60);
    assert.strictEqual(ctx.uploads.length, 0, 'offline never reaches the network');
    assert.strictEqual(ctx.all('.file-card').length, 2);
    assert.match(ctx.$('offline-banner').textContent, /offline/i);
  });

  it('keeps a stable public URL for the files it uploaded', async function () {
    await start();
    await stage(['a.png', 'b.png']);
    click(ctx.$('push-changes'));
    await settle();
    const urls = ctx.$('link-output').value.trim().split('\n');
    assert.strictEqual(urls.length, 2);
    for (const url of urls) assert.match(url, /^http:\/\/localhost:8788\/file\/r2-\d+\.png$/);
  });

  it('translates the queue surface into Bahasa Indonesia', async function () {
    await start({ language: 'id', xhrScript: () => ({ delayMs: 200 }) });
    await stage(['a.png']);
    click(ctx.$('push-changes'));
    await tick(20);
    assert.strictEqual(ctx.$('push-phase').textContent, 'Mengunggah');
    await settle();
    assert.strictEqual(ctx.$('push-phase').textContent, 'Selesai');
    assert.match(ctx.$('push-note').textContent, /1 terkirim · 0 gagal · 0 dilewati/);
    assert.strictEqual(ctx.$('push-dismiss').textContent, 'Selesai');
  });
});

/**
 * The workspace must present each object as what it actually is: previews and
 * the generated URL/Markdown/BBCode/HTML snippets all follow the MIME type.
 */
describe('workspace MIME-aware output (DOM)', function () {
  this.timeout(20000);

  let ctx;
  const routes = {
    '/api/config': () => ({ body: { siteName: 'T', problems: [] } }),
    '/api/manage/albums': () => ({ body: { albums: [], list_complete: true } }),
  };

  async function start(language = 'en') {
    ctx = await boot({
      page: 'admin-legacy.html',
      module: 'js/workspace.js',
      routes,
      language,
      prefs: { pushDelayMs: 10, pushRetryBaseMs: 10 },
    });
    return ctx;
  }

  async function stageTyped(specs) {
    const input = ctx.$('file-input');
    const files = specs.map(([name, type]) => ctx.file(name, type, 'data'));
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    fire(input, 'change');
    await tick(60);
  }

  async function pushAll() {
    click(ctx.$('push-changes'));
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      await tick(25);
      if (ctx.$('push-phase').textContent === 'Completed') break;
    }
    await tick(40);
  }

  function outputFor(format) {
    const tab = ctx.all('#format-tabs button').find((b) => b.dataset.format === format);
    click(tab);
    return ctx.$('link-output').value.trim().split('\n');
  }

  afterEach(function () {
    teardown();
    ctx = null;
  });

  it('generates a semantic snippet per file type', async function () {
    await start();
    await stageTyped([
      ['photo.png', 'image/png'],
      ['song.mp3', 'audio/mpeg'],
      ['clip.mp4', 'video/mp4'],
      ['manual.pdf', 'application/pdf'],
      ['bundle.zip', 'application/zip'],
    ]);
    await pushAll();

    const urls = outputFor('url');
    assert.strictEqual(urls.length, 5);
    for (const url of urls) assert.match(url, /^http:\/\/localhost:8788\/file\//, 'URL output is the raw public URL');

    const html = outputFor('html').join('\n');
    assert.match(html, /<img src="[^"]+" alt="photo\.png" loading="lazy">/);
    assert.match(html, /<audio controls preload="metadata" src="[^"]+">song\.mp3<\/audio>/);
    assert.match(html, /<video controls preload="metadata" src="[^"]+">clip\.mp4<\/video>/);
    assert.match(html, /<iframe src="[^"]+" title="manual\.pdf"/);
    assert.match(html, /<a href="[^"]+" download>bundle\.zip<\/a>/);
    assert.strictEqual((html.match(/<img/g) || []).length, 1, 'only the image gets <img>');

    const markdown = outputFor('markdown').join('\n');
    assert.strictEqual((markdown.match(/^!\[/gm) || []).length, 1, 'only the image gets image syntax');
    assert.match(markdown, /^\[song\\\.mp3\]\(/m);

    const bbcode = outputFor('bbcode').join('\n');
    assert.strictEqual((bbcode.match(/\[img\]/g) || []).length, 1);
    assert.match(bbcode, /\[url=[^\]]+\]manual\.pdf\[\/url\]/);
  });

  it('escapes hostile filenames in every snippet format', async function () {
    await start();
    await stageTyped([['"><script>x</script>[a](b).png', 'image/png']]);
    await pushAll();

    const html = outputFor('html').join('\n');
    assert.ok(!html.includes('<script'), html);
    assert.ok(html.includes('&lt;script&gt;'), html);

    const markdown = outputFor('markdown').join('\n');
    assert.ok(markdown.includes('\\[a\\]\\(b\\)'), markdown);

    const bbcode = outputFor('bbcode').join('\n');
    assert.ok(!/\[a\]\(b\)/.test(bbcode.replace('[img]', '')), bbcode);
  });

  it('renders the matching preview surface for each category', async function () {
    await start();
    await stageTyped([
      ['photo.png', 'image/png'],
      ['song.mp3', 'audio/mpeg'],
      ['clip.mp4', 'video/mp4'],
      ['manual.pdf', 'application/pdf'],
      ['data.bin', 'application/x-thing'],
    ]);

    const open = async (name) => {
      const card = ctx.all('.file-card').find((c) => c.textContent.includes(name));
      click(card);
      await tick(40);
      return ctx.$('preview-stage');
    };

    assert.ok((await open('photo.png')).querySelector('img'), 'image → <img>');
    click(ctx.$('preview-close'));
    assert.ok((await open('song.mp3')).querySelector('audio[controls]'), 'audio → <audio controls>');
    click(ctx.$('preview-close'));
    assert.ok((await open('clip.mp4')).querySelector('video[controls]'), 'video → <video controls>');
    click(ctx.$('preview-close'));
    assert.ok((await open('manual.pdf')).querySelector('iframe'), 'pdf → embedded viewer');
    click(ctx.$('preview-close'));

    const generic = await open('data.bin');
    assert.strictEqual(generic.querySelector('img'), null, 'a binary is never shown as an image');
    assert.ok(generic.querySelector('.preview-generic'), 'generic file surface');
    assert.match(generic.textContent, /No inline preview/);
    click(ctx.$('preview-close'));
  });

  it('trusts the MIME type over a misleading filename', async function () {
    await start();
    await stageTyped([['not-really.png', 'audio/mpeg']]);
    const card = ctx.all('.file-card')[0];
    click(card);
    await tick(40);
    const stage = ctx.$('preview-stage');
    assert.ok(stage.querySelector('audio'), 'audio/mpeg wins over the .png filename');
    assert.strictEqual(stage.querySelector('img'), null);
  });

  it('labels an unknown type honestly in Bahasa Indonesia', async function () {
    await start('id');
    await stageTyped([['arsip.zip', 'application/zip']]);
    click(ctx.all('.file-card')[0]);
    await tick(40);
    assert.match(ctx.$('preview-stage').textContent, /Arsip · Tidak ada pratinjau langsung/);
  });
});
