// End-to-end checks for sequential Push and MIME-aware output, against a
// running dev server.
//
//   npm start                     # terminal 1 (wrangler pages dev on :8080)
//   npm run test:e2e:push         # terminal 2
//
// Env: E2E_BASE_URL (default http://localhost:8080), E2E_CHROMIUM, E2E_OUT.
//
// The deterministic parts of this behaviour are covered by `npm test`
// (test/push-queue.test.js, test/mime.test.js, test/workspace-push.test.js);
// this script exists to confirm the same behaviour in a real browser against
// the real upload endpoint.
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  console.error('Playwright is not installed. Run:\n');
  console.error('  npm install --no-save playwright && npx playwright install chromium\n');
  process.exit(2);
}
const path = require('path');
const fs = require('fs');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:8080';
const USER = process.env.E2E_USER || 'admin';
const PASS = process.env.E2E_PASS || '123';
const OUT = process.env.E2E_OUT || path.join(__dirname, 'output-push');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function openDashboard(page) {
  await page.goto(BASE + '/admin-legacy', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  if (await page.locator('#username').count()) {
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await page.click('#submit-btn');
  }
  await page.waitForURL(/\/admin-legacy(?:[?#]|$)/, { timeout: 10000 });
  await page.locator('#file-stage').waitFor({ state: 'attached', timeout: 10000 });
  await page.waitForTimeout(700);
}

function writeFixtures() {
  const zlib = require('zlib');
  const png = path.join(OUT, 'e2e-image.png');
  const raw = Buffer.from([0, 12, 200, 90]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const table = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (const b of body) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(png, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]));

  const pdf = path.join(OUT, 'e2e-doc.pdf');
  fs.writeFileSync(pdf, Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'));
  const mp3 = path.join(OUT, 'e2e-audio.mp3');
  fs.writeFileSync(mp3, Buffer.concat([Buffer.from('ID3\u0003\u0000\u0000\u0000'), Buffer.alloc(256, 7)]));
  const txt = path.join(OUT, 'e2e-notes.txt');
  fs.writeFileSync(txt, 'plain text fixture');
  const zip = path.join(OUT, 'e2e-bundle.zip');
  fs.writeFileSync(zip, Buffer.from('PK\u0005\u0006' + '\u0000'.repeat(18), 'binary'));
  return { png, pdf, mp3, txt, zip };
}

(async () => {
  const files = writeFixtures();
  const browser = await chromium.launch(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {});
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) consoleErrors.push(m.text());
  });

  // Record every /upload request with its start and end time so sequencing and
  // spacing can be asserted from the outside.
  const uploads = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/upload') && req.method() === 'POST') uploads.push({ start: Date.now(), end: null });
  });
  page.on('requestfinished', (req) => {
    if (!req.url().endsWith('/upload')) return;
    const open = [...uploads].reverse().find((u) => u.end === null);
    if (open) open.end = Date.now();
  });

  await openDashboard(page);
  // Make the inter-file gap easy to measure without slowing the run down.
  await page.evaluate(() => {
    const prefs = JSON.parse(localStorage.getItem('ti.prefs') || '{}');
    localStorage.setItem('ti.prefs', JSON.stringify({ ...prefs, pushDelayMs: 700, pushRetryBaseMs: 500 }));
  });
  await page.reload({ waitUntil: 'networkidle' });

  // --- 1. staging never uploads
  await page.setInputFiles('#file-input', [files.png, files.mp3, files.pdf, files.txt, files.zip]);
  await page.waitForTimeout(600);
  check('选择文件后不会立即上传', uploads.length === 0, `${uploads.length} 次请求`);
  await page.screenshot({ path: path.join(OUT, 'push-1-staged.png'), fullPage: true });

  // --- 2. push is sequential and spaced
  await page.click('#push-changes');
  await page.waitForTimeout(400);
  const midPhase = await page.textContent('#push-phase');
  const midProgress = await page.textContent('#push-progress-text');
  check('推送时显示队列进度面板', /Uploading|Waiting|Mengunggah|Menunggu/.test(midPhase), `${midPhase} · ${midProgress}`);
  await page.screenshot({ path: path.join(OUT, 'push-2-inflight.png'), fullPage: true });

  await page.waitForFunction(
    () => /Completed|Selesai/.test(document.getElementById('push-phase').textContent),
    { timeout: 60000 },
  );

  const overlapping = uploads.some((u, i) => i > 0 && uploads[i - 1].end && u.start < uploads[i - 1].end);
  check('同一时间只有一个上传请求', !overlapping && uploads.length === 5, `${uploads.length} 次请求`);
  const gaps = uploads.slice(1).map((u, i) => u.start - (uploads[i].end || u.start));
  check('文件之间存在间隔', gaps.every((g) => g >= 300), gaps.join('ms, ') + 'ms');
  const summary = await page.textContent('#push-note');
  check('完成后给出真实汇总', /5/.test(summary), summary);
  await page.screenshot({ path: path.join(OUT, 'push-3-complete.png'), fullPage: true });

  // --- 3. MIME-aware snippets
  const snippets = {};
  for (const format of ['url', 'html', 'markdown', 'bbcode']) {
    await page.click(`#format-tabs button[data-format="${format}"]`);
    await page.waitForTimeout(150);
    snippets[format] = await page.inputValue('#link-output');
  }
  const htmlLines = snippets.html.split('\n');
  check('HTML 片段按类型生成', 
    htmlLines.some((l) => l.startsWith('<img'))
    && htmlLines.some((l) => l.startsWith('<audio'))
    && htmlLines.some((l) => l.startsWith('<iframe'))
    && htmlLines.some((l) => l.startsWith('<a ')),
    htmlLines.join(' | ').slice(0, 200));
  check('非图片不会生成 <img>', htmlLines.filter((l) => l.startsWith('<img')).length === 1);
  check('Markdown 仅图片使用图片语法', snippets.markdown.split('\n').filter((l) => l.startsWith('![')).length === 1);
  check('BBCode 仅图片使用 [img]', snippets.bbcode.split('\n').filter((l) => l.startsWith('[img]')).length === 1);
  check('URL 输出保持公开链接原样', snippets.url.split('\n').every((l) => /^https?:\/\/[^\s]+\/file\//.test(l)));

  // --- 4. MIME-aware previews
  const previews = {};
  for (const [label, needle] of [['image', 'e2e-image.png'], ['audio', 'e2e-audio.mp3'], ['pdf', 'e2e-doc.pdf'], ['generic', 'e2e-bundle.zip']]) {
    const card = page.locator('.file-card, .list-row[data-id]').filter({ hasText: needle }).first();
    if (!(await card.count())) { previews[label] = 'missing'; continue; }
    await card.click();
    await page.waitForTimeout(350);
    previews[label] = await page.evaluate(() => {
      const stage = document.getElementById('preview-stage');
      if (stage.querySelector('img')) return 'image';
      if (stage.querySelector('audio')) return 'audio';
      if (stage.querySelector('video')) return 'video';
      if (stage.querySelector('iframe')) return 'pdf';
      return 'generic';
    });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }
  check('预览按真实类型渲染', previews.image === 'image' && previews.audio === 'audio'
    && previews.pdf === 'pdf' && previews.generic === 'generic', JSON.stringify(previews));
  await page.screenshot({ path: path.join(OUT, 'push-4-previews.png'), fullPage: true });

  // --- 5. cancel keeps staged work
  await page.setInputFiles('#file-input', [files.png, files.mp3, files.pdf]);
  await page.waitForTimeout(400);
  const before = uploads.length;
  await page.click('#push-changes');
  await page.waitForTimeout(500);
  await page.click('#push-cancel');
  await page.waitForTimeout(800);
  const cancelledPhase = await page.textContent('#push-phase');
  const staged = await page.evaluate(() => document.querySelectorAll('.file-card, .list-row[data-id]').length);
  check('取消后不再发起新的上传并保留暂存文件',
    /Cancelled|Dibatalkan/.test(cancelledPhase) && uploads.length - before < 3 && staged >= 8,
    `${cancelledPhase}, 新增请求 ${uploads.length - before}, 仍有 ${staged} 个对象`);

  check('无 JS 脚本错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || 'none');

  await browser.close();
  const failed = results.filter((r) => !r.passed);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
  fs.writeFileSync(path.join(OUT, 'push-results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('E2E CRASHED:', e); process.exit(2); });
