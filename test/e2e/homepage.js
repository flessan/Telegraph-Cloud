// End-to-end check of the landing page and unified dashboard against a running dev server.
//
//   npm start                 # terminal 1 (wrangler pages dev on :8080)
//   npm run test:e2e          # terminal 2
//
// Env: E2E_BASE_URL (default http://localhost:8080), E2E_CHROMIUM (path to a
// chromium binary when playwright's bundled download is unavailable),
// E2E_OUT (screenshot directory, default test/e2e/output).
//
// Uploads go through whatever STORAGE_PROVIDER the server runs with; use
// STORAGE_PROVIDER=r2 to exercise the whole flow without Telegram credentials.
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch (error) {
  // Playwright is intentionally not a project dependency — see README
  // ("Local Development and Testing"), since this suite is optional.
  console.error('Playwright is not installed. Run:\n');
  console.error('  npm install --no-save playwright && npx playwright install chromium\n');
  process.exit(2);
}
const path = require('path');
const fs = require('fs');

const BASE = process.env.E2E_BASE_URL || 'http://localhost:8080';
const USER = process.env.E2E_USER || 'admin';
const PASS = process.env.E2E_PASS || '123';
const OUT = process.env.E2E_OUT || path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });
const results = [];

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// Environment cannot exercise this check (e.g. no outbound network). Reported
// but not counted as a failure, so an offline run still ends green.
function skip(name, detail = '') {
  results.push({ name, passed: true, skipped: true, detail });
  console.log(`SKIP  ${name}${detail ? ' — ' + detail : ''}`);
}

function makePng(file, rgb) {
  // Minimal valid 1x1 PNG per colour so each upload is a distinct file.
  const zlib = require('zlib');
  const raw = Buffer.from([0, ...rgb]);
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crcTable = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
    let crc = 0xffffffff;
    for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit truecolour
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
  return file;
}

async function collectFileLinks(page) {
  return page.evaluate(() => {
    const found = new Set();
    document.querySelectorAll('input,textarea').forEach(el => {
      const v = el.value || '';
      const m = v.match(/\/file\/[A-Za-z0-9_.\-]+/g);
      if (m) m.forEach(x => found.add(x));
    });
    document.querySelectorAll('a[href*="/file/"], img[src*="/file/"]').forEach(el => {
      const v = el.getAttribute('href') || el.getAttribute('src');
      const m = v && v.match(/\/file\/[A-Za-z0-9_.\-]+/);
      if (m) found.add(m[0]);
    });
    const text = document.body.innerText.match(/\/file\/[A-Za-z0-9_.\-]+/g);
    if (text) text.forEach(x => found.add(x));
    return [...found];
  });
}

async function finishDashboardLogin(page) {
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

async function clickPush(page) {
  const push = page.locator('#push-changes');
  await push.waitFor({ state: 'visible', timeout: 5000 });
  await page.waitForFunction(() => {
    const btn = document.getElementById('push-changes');
    return btn && !btn.disabled;
  }, { timeout: 8000 });
  await push.click();
}

(async () => {
  const browser = await chromium.launch(
    process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}
  );
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
  const page = await context.newPage();

  // Script errors are defects; a blocked image/CDN host is the sandbox, not the
  // code (external dashboard CDNs are skipped separately below).
  const consoleErrors = [];
  const resourceErrors = [];
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/Failed to load resource|net::ERR_/.test(text)) resourceErrors.push(text);
    else consoleErrors.push(text);
  });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

  // --- 1. the canonical root is content-first, then opens the authenticated dashboard
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const title = await page.title();
  const bodyText = await page.textContent('body');
  check('落地页加载', /Telegraph Storage/.test(title), `title="${title}"`);
  check('落地页不是上传器', await page.locator('input[type=file]').count() === 0);
  check('SITE_NAME 经 /api/config 生效', bodyText.includes('E2E Test Host') || title.includes('E2E Test Host'),
    `title="${title}"`);
  check('落地页说明本地审阅和顺序推送', /review|审阅|tinjau/i.test(bodyText) && /sequential|顺序|berurutan/i.test(bodyText));

  await page.screenshot({ path: path.join(OUT, 'shot-1-home.png'), fullPage: true });
  // The landing's dashboard CTA targets the canonical console; the staging and
  // push flows under test live in the legacy workspace (/admin-legacy).
  check('落地页指向 /console', await page.locator('a[href="/console"]').count() > 0);
  await page.goto(BASE + '/admin-legacy', { waitUntil: 'networkidle' });
  await finishDashboardLogin(page);

  // --- 2. dashboard file input exists and accepts multiple files
  const fileInput = page.locator('#file-input');
  const inputCount = await page.locator('input[type=file]').count();
  const isMultiple = inputCount ? await fileInput.evaluate(el => el.hasAttribute('multiple')) : false;
  check('存在文件选择输入', inputCount > 0);
  check('支持多文件选择 (multiple)', isMultiple);

  // --- 3. stage two files locally, then push through the existing /upload API
  const f1 = makePng(path.join(OUT, 'e2e-a.png'), [255, 0, 0]);
  const f2 = makePng(path.join(OUT, 'e2e-b.png'), [0, 128, 255]);
  await fileInput.setInputFiles([f1, f2]);

  await page.waitForTimeout(400);
  const stagedBeforePush = await collectFileLinks(page);
  check('选择文件后不会立即上传', stagedBeforePush.length === 0,
    `选择后立刻找到 ${stagedBeforePush.length} 条远程链接`);

  const pendingVisible = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('[data-role="status"]')].map(el => el.textContent || '');
    const changes = document.getElementById('changes-panel');
    const listCount = document.querySelectorAll('#changes-list .change-row, .file-card').length;
    return {
      listCount,
      changesOpen: !!(changes && !changes.hidden),
      hasPendingChip: chips.some(text => /pending|menunggu|waiting/i.test(text)),
    };
  });
  check('待发送变更在推送前可见', pendingVisible.listCount >= 2 && (pendingVisible.changesOpen || pendingVisible.hasPendingChip),
    JSON.stringify(pendingVisible));

  const checkboxCount = await page.locator('.file-card input[type=checkbox], .list-row input[type=checkbox]').count();
  check('文件可选中', checkboxCount >= 2, `${checkboxCount} 个复选框`);

  await clickPush(page);

  let links = [];
  for (let i = 0; i < 60; i++) {
    links = await collectFileLinks(page);
    if (links.length >= 2) break;
    await page.waitForTimeout(500);
  }
  check('批量上传两个文件后出现两条结果链接', links.length >= 2, `找到 ${links.length} 条: ${links.join(', ')}`);

  const afterPushState = await page.evaluate(() => {
    const chips = [...document.querySelectorAll('[data-role="status"]')].map(el => (el.textContent || '').toLowerCase());
    return {
      cards: document.querySelectorAll('.file-card, .list-row[data-id]').length,
      synced: chips.filter(text => /synced|tersimpan/.test(text)).length,
    };
  });
  check('推送成功后文件仍可见且标记为已同步', afterPushState.cards >= 2 && afterPushState.synced >= 1,
    JSON.stringify(afterPushState));

  const firstCard = page.locator('.file-card, .list-row[data-id]').first();
  if (await firstCard.count()) {
    await firstCard.click();
    const previewOpen = await page.locator('#preview-dialog.open, #preview-dialog:not([hidden])').count();
    check('点击文件打开预览', previewOpen > 0);
    const copyBtn = page.locator('#preview-copy');
    if (await copyBtn.count()) {
      await copyBtn.click({ timeout: 2000 }).catch(() => {});
    }
    await page.keyboard.press('Escape');
  }

  await page.screenshot({ path: path.join(OUT, 'shot-2-uploaded.png'), fullPage: true });

  // --- 4. uploaded files are really retrievable and are the bytes we sent
  let retrievable = 0, correctType = 0;
  for (const l of links.slice(0, 2)) {
    const res = await page.request.get(BASE + l);
    if (res.ok()) retrievable++;
    if ((res.headers()['content-type'] || '').startsWith('image/')) correctType++;
  }
  check('结果链接可访问', retrievable === Math.min(2, links.length), `${retrievable}/${Math.min(2, links.length)}`);
  check('返回 image/* Content-Type', correctType === Math.min(2, links.length), `${correctType}/${Math.min(2, links.length)}`);

  // --- 5. output format switching (URL / Markdown / HTML / BBCode)
  const formats = await page.evaluate(() => {
    const out = {};
    const all = document.body.innerText;
    const labels = [...document.querySelectorAll('button,[role=tab],label,a,select option')]
      .map(el => (el.innerText || el.value || '').trim()).filter(Boolean);
    out.labels = labels;
    out.hasMarkdown = /markdown/i.test(all) || labels.some(l => /markdown/i.test(l));
    out.hasBBCode = /bbcode|ubb/i.test(all) || labels.some(l => /bbcode|ubb/i.test(l));
    out.hasHtml = /\bhtml\b/i.test(all) || labels.some(l => /^html$/i.test(l));
    return out;
  });
  check('提供 Markdown 格式', formats.hasMarkdown);
  check('提供 BBCode 格式', formats.hasBBCode);
  check('提供 HTML 格式', formats.hasHtml);

  const formatSamples = {};
  for (const name of ['markdown', 'bbcode', 'html', 'url']) {
    const btn = page.locator(`button:has-text("${name}"), [role=tab]:has-text("${name}")`).first();
    const alt = page.locator(`button, [role=tab]`).filter({ hasText: new RegExp(name, 'i') }).first();
    const target = (await btn.count()) ? btn : ((await alt.count()) ? alt : null);
    if (target) {
      try {
        await target.click({ timeout: 2000 });
        await page.waitForTimeout(300);
        formatSamples[name] = await page.evaluate(() => {
          const vals = [...document.querySelectorAll('input,textarea')].map(e => e.value).filter(v => v && v.includes('/file/'));
          return vals[0] || '';
        });
      } catch (e) { formatSamples[name] = 'CLICK_FAILED: ' + e.message.split('\n')[0]; }
    }
  }
  const mdOk = /!\[.*\]\(.*\/file\/.*\)/.test(formatSamples.markdown || '');
  const bbOk = /\[img\].*\/file\/.*\[\/img\]/i.test(formatSamples.bbcode || '');
  const htmlOk = /<img\s+src=.*\/file\/.*>/i.test(formatSamples.html || '');
  check('Markdown 输出格式正确', mdOk, formatSamples.markdown || '(未取到)');
  check('BBCode 输出格式正确', bbOk, formatSamples.bbcode || '(未取到)');
  check('HTML 输出格式正确', htmlOk, formatSamples.html || '(未取到)');

  await page.screenshot({ path: path.join(OUT, 'shot-3-formats.png'), fullPage: true });

  // --- 6. drag & drop stages a file; push sends it
  const f3 = makePng(path.join(OUT, 'e2e-c.png'), [0, 200, 0]);
  const b64 = fs.readFileSync(f3).toString('base64');
  const beforeDrop = links.length;
  const dropTarget = await page.evaluate(() => {
    const cands = ['#dropzone', '#drop-zone', '.drop-zone', '[data-drop]', '.upload-area', 'main', 'body'];
    for (const c of cands) if (document.querySelector(c)) return c;
    return 'body';
  });
  await page.evaluate(async ({ b64, sel }) => {
    const bin = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const file = new File([bin], 'dropped.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const el = document.querySelector(sel);
    for (const type of ['dragenter', 'dragover', 'drop']) {
      el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }
  }, { b64, sel: dropTarget });

  await page.waitForTimeout(400);
  const afterDropBeforePush = (await collectFileLinks(page)).length;
  check('拖拽后不会立即上传', afterDropBeforePush === beforeDrop,
    `拖拽前 ${beforeDrop} 条 → 拖拽后立刻 ${afterDropBeforePush} 条`);
  await clickPush(page);

  let afterDrop = beforeDrop;
  for (let i = 0; i < 40; i++) {
    const now = (await collectFileLinks(page)).length;
    if (now > beforeDrop) { afterDrop = now; break; }
    await page.waitForTimeout(500);
  }
  check('拖拽上传生效', afterDrop > beforeDrop, `拖拽前 ${beforeDrop} 条 → 拖拽后 ${afterDrop} 条 (drop target: ${dropTarget})`);
  await page.screenshot({ path: path.join(OUT, 'shot-4-dragdrop.png'), fullPage: true });

  // --- 7. the unified workspace keeps a clear route back to the landing page
  const homeLink = await page.locator('#home-link[href="/"]').count();
  check('工作区显示首页入口', homeLink === 1, `${homeLink} 个链接`);

  // --- 8. the same dependency-free dashboard lists the uploaded objects
  const adminRows = await page.locator('.file-card, .list-row[data-id]').count();
  const adminText = await page.textContent('body');
  check('统一后台显示上传记录', adminRows >= 2 || /r2-/.test(adminText), `对象元素 ${adminRows} 个`);
  await page.screenshot({ path: path.join(OUT, 'shot-5-admin.png'), fullPage: true });

  // --- 9. no console errors
  check('无 JS 脚本错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || 'none');
  if (resourceErrors.length) {
    console.log(`INFO  ${resourceErrors.length} 个外部资源未加载（壁纸/CDN，属环境限制）`);
  }

  await browser.close();

  const failed = results.filter(r => !r.passed);
  const skipped = results.filter(r => r.skipped);
  console.log(`\n===== ${results.length - failed.length - skipped.length}/${results.length - skipped.length} 通过` +
    (skipped.length ? `，${skipped.length} 项跳过` : '') + ' =====');
  if (failed.length) {
    console.log('失败项:');
    failed.forEach(f => console.log(`  - ${f.name}: ${f.detail}`));
  }
  fs.writeFileSync(path.join(OUT, 'e2e-results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('E2E CRASHED:', e); process.exit(2); });
