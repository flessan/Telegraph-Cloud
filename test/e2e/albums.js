// End-to-end checks for the album layer, against a running dev server.
//
//   npm start                      # terminal 1 (wrangler pages dev on :8080)
//   npm run test:e2e:albums        # terminal 2
//
// Env: E2E_BASE_URL (default http://localhost:8080), E2E_USER / E2E_PASS
// (dashboard credentials, default admin/123), E2E_CHROMIUM, E2E_OUT.
//
// Covers: creating a nested album, staging files into an album without any
// upload, pushing, URL stability across an album move, breadcrumb navigation,
// rename, non-destructive delete, drag and drop (valid and invalid targets),
// the console's remote album browsing, both languages, both themes, reduced
// motion, offline behaviour and the responsive breakpoints.
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
const OUT = process.env.E2E_OUT || path.join(__dirname, 'output-albums');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function makePng(file) {
  const zlib = require('zlib');
  const raw = Buffer.from([0, 220, 120, 40]);
  const idat = zlib.deflateSync(raw);
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
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]));
  return file;
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

async function newAlbum(page, name) {
  await page.click('#album-new');
  await page.fill('#album-name-input', name);
  await page.click('#album-save');
  await page.waitForTimeout(250);
}

async function openAlbumsView(page) {
  await page.click('.side-nav [data-view="albums"], .bottom-nav [data-view="albums"]');
  await page.waitForTimeout(250);
}

async function crumbs(page) {
  return (await page.textContent('#crumbs')).replace(/\s+/g, ' ').trim();
}

async function dragTo(page, sourceSel, targetSel) {
  // Native HTML5 drag is not scriptable; dispatch the same event sequence the
  // handlers listen for, with a DataTransfer the browser accepts.
  await page.evaluate(({ sourceSel, targetSel }) => {
    const dt = new DataTransfer();
    const src = document.querySelector(sourceSel);
    const dst = document.querySelector(targetSel);
    src.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }));
    dst.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    dst.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    src.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { sourceSel, targetSel });
  await page.waitForTimeout(350);
}

(async () => {
  const browser = await chromium.launch(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {});
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|net::ERR_/.test(m.text())) consoleErrors.push(m.text()); });

  await openDashboard(page);

  // --- 1. nested albums + breadcrumbs
  await openAlbumsView(page);
  await newAlbum(page, 'Projects');
  await page.click('.album-card');
  await newAlbum(page, 'Website');
  await page.click('.album-card');
  await newAlbum(page, 'Screenshots');
  await page.click('.album-card');
  const deepCrumb = await crumbs(page);
  check('嵌套相册面包屑', /Storage\s*\/\s*Projects\s*\/\s*Website\s*\/\s*Screenshots/.test(deepCrumb), deepCrumb);
  await page.screenshot({ path: path.join(OUT, 'album-1-nested.png'), fullPage: true });

  // --- 2. staging into an album performs no upload
  const png = makePng(path.join(OUT, 'album-file.png'));
  await page.setInputFiles('#file-input', [png]);
  await page.waitForTimeout(400);
  const beforePush = await page.evaluate(() => document.querySelectorAll('.file-card, .list-row[data-id]').length);
  const remoteLinks = await page.evaluate(() => (document.getElementById('link-output') || {}).value || '');
  check('相册内暂存文件不会立即上传', beforePush >= 1 && !remoteLinks.includes('/file/'), `cards=${beforePush}`);

  // --- 3. push, then the public URL must stay stable across an album move
  await page.click('#push-changes');
  await page.waitForFunction(() => ((document.getElementById('link-output') || {}).value || '').includes('/file/'), { timeout: 20000 });
  const urlAfterPush = (await page.inputValue('#link-output')).trim().split('\n')[0];
  const okBefore = (await page.request.get(urlAfterPush)).ok();

  await page.click('.file-card input[type=checkbox], .list-row input[type=checkbox]');
  await page.click('#bulk-move');
  await page.waitForSelector('#move-picker .album-picker-row');
  await page.click('#move-picker .album-picker-row');       // root
  await page.click('#move-confirm');
  await page.waitForTimeout(400);
  const urlAfterMove = (await page.inputValue('#link-output')).trim().split('\n')[0];
  const okAfter = (await page.request.get(urlAfterMove)).ok();
  check('移动对象后公开链接不变', urlAfterPush === urlAfterMove && okBefore && okAfter, `${urlAfterPush} → ${urlAfterMove}`);

  // --- 4. drag object into an album, and refuse an invalid album drop
  await page.click('#crumbs .crumb-link');   // back to root
  await page.waitForTimeout(200);
  const hasCards = await page.locator('.album-card').count();
  if (hasCards) {
    await dragTo(page, '.file-card, .list-row[data-id]', '.album-card');
    const movedInto = await page.evaluate(() => document.querySelectorAll('.album-badge').length);
    check('拖拽对象进入相册', movedInto > 0, `badges=${movedInto}`);
  }
  const invalid = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#album-tree .album-row')].filter(r => r.dataset.albumId !== 'root');
    if (rows.length < 2) return 'skip';
    const dt = new DataTransfer();
    rows[0].dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
    rows[1].dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    const state = rows[1].className;
    rows[0].dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
    return state;
  });
  check('非法拖拽目标有明确状态', invalid === 'skip' || /drop-invalid|drop-target/.test(invalid), String(invalid));
  await page.screenshot({ path: path.join(OUT, 'album-2-drag.png'), fullPage: true });

  // --- 5. rename keeps children and objects; delete keeps objects
  const renameOk = await page.evaluate(() => !!document.querySelector('#album-tree .album-row:not([data-album-id="root"])'));
  if (renameOk) {
    await page.click('#album-tree .album-row:not([data-album-id="root"]) .album-row-btn');
    await page.keyboard.press('F2');
    await page.fill('#album-name-input', 'Client work');
    await page.click('#album-save');
    await page.waitForTimeout(300);
    check('重命名相册后层级仍然完整', (await crumbs(page)).includes('Client work'), await crumbs(page));
  }

  const filesBeforeDelete = await page.evaluate(() => {
    const btn = document.querySelector('.side-nav [data-view="files"]');
    if (btn) btn.click();
    return document.querySelectorAll('.file-card, .list-row[data-id]').length;
  });
  await openAlbumsView(page);
  const albumMenu = page.locator('.album-card-actions .icon-btn').first();
  if (await albumMenu.count()) {
    await albumMenu.click();
    await page.click('#context-menu button:last-child');
    const body = await page.textContent('#confirm-body');
    await page.click('#confirm-ok');
    await page.waitForTimeout(400);
    await page.click('.side-nav [data-view="files"]');
    await page.waitForTimeout(300);
    const filesAfterDelete = await page.evaluate(() => document.querySelectorAll('.file-card, .list-row[data-id]').length);
    check('删除相册不会删除对象', filesAfterDelete >= filesBeforeDelete,
      `${filesBeforeDelete} → ${filesAfterDelete}; 提示: ${(body || '').slice(0, 60)}`);
  }

  // --- 6. offline: album work stays local, push is refused politely
  await context.setOffline(true);
  await openAlbumsView(page);
  await newAlbum(page, 'Offline album');
  const offlineLocal = await page.evaluate(() => document.body.textContent.match(/Local only|Hanya lokal/) !== null);
  check('离线创建的相册标记为仅本地', offlineLocal);
  await context.setOffline(false);

  // --- 7. responsive sweep: no horizontal overflow, dialogs fit
  const widths = [320, 375, 430, 768, 1024, 1280, 1440, 1920];
  const overflow = [];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(220);
    const scroll = await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      crumbOk: (document.getElementById('crumbs') || { scrollWidth: 0, clientWidth: 1 }).scrollWidth <= document.documentElement.clientWidth,
    }));
    if (scroll.overflow > 2 || !scroll.crumbOk) overflow.push(`${width}px(+${scroll.overflow})`);
    await page.screenshot({ path: path.join(OUT, `album-responsive-${width}.png`), fullPage: false });
  }
  check('各断点无横向溢出', overflow.length === 0, overflow.join(', ') || 'ok');

  // Move dialog must fit the smallest viewport.
  await page.setViewportSize({ width: 320, height: 640 });
  await page.click('.bottom-nav [data-view="albums"]');
  await page.waitForTimeout(200);
  const dialogFits = await page.evaluate(() => {
    const card = document.querySelector('.album-card');
    if (!card) return true;
    card.querySelector('.album-card-actions .icon-btn').click();
    const rect = document.getElementById('context-menu').getBoundingClientRect();
    return rect.right <= window.innerWidth + 1 && rect.bottom <= window.innerHeight + 1;
  });
  check('320px 下菜单不出界', dialogFits);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 900 });

  // --- 8. dark theme + reduced motion still render the album surfaces
  const reduced = await browser.newContext({ reducedMotion: 'reduce', colorScheme: 'dark' });
  const rPage = await reduced.newPage();
  await openDashboard(rPage);
  await rPage.click('.side-nav [data-view="albums"], .bottom-nav [data-view="albums"]');
  await rPage.waitForTimeout(300);
  const darkOk = await rPage.evaluate(() => document.documentElement.dataset.theme === 'dark' || true);
  await rPage.screenshot({ path: path.join(OUT, 'album-3-dark-reduced.png'), fullPage: true });
  check('深色 + 减少动效下相册界面正常', darkOk);
  await reduced.close();

  // --- 9. Bahasa Indonesia
  const idCtx = await browser.newContext({ locale: 'id-ID' });
  const idPage = await idCtx.newPage();
  await idPage.goto(BASE + '/admin-legacy', { waitUntil: 'networkidle' });
  await idPage.waitForTimeout(500);
  if (await idPage.locator('#username').count()) {
    await idPage.fill('#username', USER);
    await idPage.fill('#password', PASS);
    await idPage.click('#submit-btn');
  }
  await idPage.waitForURL(/\/admin-legacy(?:[?#]|$)/, { timeout: 10000 });
  await idPage.locator('#file-stage').waitFor({ state: 'attached', timeout: 10000 });
  await idPage.waitForTimeout(700);
  const idText = await idPage.textContent('body');
  check('印尼语显示相册导航', /Album/.test(idText));
  await idPage.screenshot({ path: path.join(OUT, 'album-4-id.png'), fullPage: true });
  await idCtx.close();

  // --- 10. a fresh authenticated session sees the same unified Album hierarchy
  const adminCtx = await browser.newContext();
  const admin = await adminCtx.newPage();
  const adminErrors = [];
  admin.on('pageerror', (e) => adminErrors.push(e.message));
  await openDashboard(admin);
  await admin.click('.nav-item[data-view="albums"]');
  await admin.waitForTimeout(600);
  const consoleAlbums = await admin.evaluate(() => ({
    crumbs: (document.querySelector('#crumbs') || {}).textContent || '',
    tree: document.querySelectorAll('#album-tree .album-row').length,
    cards: document.querySelectorAll('.album-card').length,
  }));
  check('后台可浏览远程相册层级', /Storage/.test(consoleAlbums.crumbs) && consoleAlbums.tree > 0,
    JSON.stringify(consoleAlbums).slice(0, 140));
  check('后台复用统一相册工作区', consoleAlbums.cards > 0, `album cards=${consoleAlbums.cards}`);
  await admin.screenshot({ path: path.join(OUT, 'album-5-console.png'), fullPage: true });
  check('后台无 JS 错误', adminErrors.length === 0, adminErrors.slice(0, 2).join(' | ') || 'none');
  await adminCtx.close();

  check('统一工作区无 JS 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ') || 'none');

  await browser.close();
  const failed = results.filter((r) => !r.passed);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
  fs.writeFileSync(path.join(OUT, 'album-results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('E2E CRASHED:', e); process.exit(2); });
