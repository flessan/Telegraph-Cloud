const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Static guards for the two behaviours that are easy to regress silently:
// the push path must stay strictly sequential and frontend-only, and no
// surface may go back to assuming every object is an image.

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const workspaceJs = read('js/workspace.js');
const adminJs = read('js/admin.js');
const mimeJs = read('js/mime.js');
const queueJs = read('js/push-queue.js');
const adminHtml = read('admin-legacy.html');
const workspaceCss = read('css/workspace.css');
const appCss = read('css/app.css');

describe('push queue — wiring guards', () => {
  it('has no parallel upload pump left', () => {
    assert.ok(!/MAX_CONCURRENT/.test(workspaceJs), 'the old concurrency constant must be gone');
    assert.ok(!/while \(active < /.test(workspaceJs), 'the old pump loop must be gone');
    assert.ok(workspaceJs.includes("from './push-queue.js'"), 'the workspace uses the shared queue');
  });

  it('keeps the queue state machine free of DOM and network globals', () => {
    assert.ok(!/document\.|window\.|fetch\(|XMLHttpRequest/.test(queueJs),
      'js/push-queue.js must stay a pure, injectable state machine');
    assert.ok(queueJs.includes('options.now'), 'the clock is injectable for deterministic tests');
    assert.ok(queueJs.includes('options.setTimeout'), 'timers are injectable');
  });

  it('still uses the existing upload contract, unchanged', () => {
    assert.ok(workspaceJs.includes("xhr.open('POST', '/upload')"), 'the upload endpoint is untouched');
    assert.ok(workspaceJs.includes("formData.append('file', item.file, item.name)"));
    assert.ok(workspaceJs.includes("data[0] && data[0].src"), 'the response contract is unchanged');
  });

  it('classifies transient failures instead of hammering the endpoint', () => {
    assert.ok(workspaceJs.includes('classifyFailure('));
    assert.ok(workspaceJs.includes("parseRetryAfter(xhr.getResponseHeader('Retry-After'))"));
    assert.ok(queueJs.includes('retryAfterCapMs'), 'Retry-After is bounded');
  });

  it('is implemented entirely in the frontend', () => {
    for (const rel of ['functions/upload.js', 'functions/file/[id].js', 'functions/storage/index.js']) {
      const source = read(rel);
      assert.ok(!/queue|retry-after|backoff/i.test(source), `${rel} must not know about the push queue`);
    }
  });

  it('exposes the queue surface with progress semantics and controls', () => {
    for (const id of ['push-panel', 'push-phase', 'push-progress-text', 'push-bar', 'push-current', 'push-note']) {
      assert.ok(adminHtml.includes(`id="${id}"`), `missing #${id}`);
    }
    for (const id of ['push-pause', 'push-cancel', 'push-retry-failed', 'push-dismiss']) {
      assert.ok(adminHtml.includes(`id="${id}"`), `missing control #${id}`);
    }
    assert.ok(adminHtml.includes('role="progressbar"'), 'the overall bar is a progressbar');
    assert.ok(/id="push-note"[^>]*role="status"/.test(adminHtml), 'status text is announced');
  });

  it('keeps the surface calm and reduced-motion friendly', () => {
    const panel = workspaceCss.match(/\.push-panel\s*\{[^}]*\}/)[0];
    assert.ok(!/animation|gradient|blur\(/.test(panel), 'no decorative motion on the queue panel');
    assert.ok(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.push-bar > i\s*\{\s*transition: none/.test(workspaceCss),
      'progress motion is disabled under reduced motion');
    const literals = (workspaceCss.slice(workspaceCss.indexOf('.push-panel')).match(/:\s*#[0-9a-f]{3,8}\b/gi) || [])
      .filter((v) => !/#000/.test(v));
    assert.deepStrictEqual(literals, [], 'the queue surface uses design tokens');
  });
});

describe('MIME awareness — wiring guards', () => {
  it('centralizes categorization and snippet building in one shared module', () => {
    assert.ok(workspaceJs.includes("from './mime.js'"));
    assert.ok(adminJs.includes("from './mime.js'"));
    assert.ok(!/document\.|window\./.test(mimeJs), 'js/mime.js stays pure');
  });

  it('no surface hand-builds copyable image markup any more', () => {
    for (const [name, source] of [['workspace.js', workspaceJs], ['admin.js', adminJs]]) {
      assert.ok(!/'!\[' \+/.test(source), `${name} must not hand-build Markdown image syntax`);
      assert.ok(!/\[img\]/.test(source), `${name} must not hand-build BBCode image syntax`);
    }
    // Both snippet builders delegate to the shared formatter and contain no
    // markup of their own.
    const workspaceLink = workspaceJs.match(/function formatLink\([\s\S]*?\n}/)[0];
    assert.ok(workspaceLink.includes('formatOutput('), 'the workspace delegates to the shared formatter');
    assert.ok(!/</.test(workspaceLink.replace(/[^<]*=>/g, '')), 'no inline markup in formatLink');
    const adminLink = adminJs.match(/function linkFor\([\s\S]*?\n}/)[0];
    assert.ok(adminLink.includes('formatOutput('), 'the console delegates to the shared formatter');
    assert.ok(!/<img|<a |\[url=/.test(adminLink), 'no inline markup in linkFor');
  });

  it('escapes values in the in-app preview markup as well', () => {
    const preview = adminJs.match(/function detailPreviewHtml\([\s\S]*?\n}/)[0];
    assert.ok(preview.includes('esc(o.metadata?.fileName || o.name)'), 'the label is escaped');
    assert.ok(preview.includes('esc(o.name)'), 'the URL segment is escaped');
    assert.ok(!/\$\{o\.name\}/.test(preview), 'no raw object id in preview markup');
  });

  it('drives previews from the category rather than the extension list', () => {
    assert.ok(workspaceJs.includes('previewKind('), 'the workspace preview is category driven');
    assert.ok(adminJs.includes('previewKind('), 'the console preview is category driven');
    assert.ok(adminJs.includes('storedMime('), 'stored MIME metadata wins when present');
    assert.ok(/fall back to the extension/i.test(adminJs), 'the fallback is documented where it is used');
  });

  it('escapes every interpolated value in generated snippets', () => {
    assert.ok(mimeJs.includes('escapeHtml('));
    assert.ok(mimeJs.includes('escapeMarkdown('));
    assert.ok(mimeJs.includes('escapeBbcode('));
    const htmlFor = mimeJs.match(/function htmlFor\([\s\S]*?\n}/)[0];
    assert.ok(!/\$\{name\}/.test(htmlFor), 'raw filenames never reach an HTML snippet');
    assert.ok(!/\$\{url\}/.test(htmlFor), 'raw URLs never reach an HTML attribute');
  });

  it('adds preview styles for the non-image surfaces', () => {
    assert.ok(/\.preview-media\.document iframe/.test(workspaceCss), 'PDF preview is styled');
    assert.ok(/\.preview-generic/.test(workspaceCss), 'generic file surface is styled');
    assert.ok(appCss.includes('--md-sys-color-primary'), 'shared tokens still drive the design layer');
  });
});
