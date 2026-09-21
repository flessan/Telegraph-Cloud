const assert = require('assert');
const { boot, teardown, click, fire, tick } = require('./dom-harness');

/**
 * Behavioural tests for the public workspace album layer, driven through the
 * real page and the real module. They cover the promises the feature makes:
 * local-first staging, deliberate Push, stable public URLs, non-destructive
 * album deletion and honest local counts.
 */
describe('workspace albums (DOM)', function () {
  this.timeout(10000);

  let ctx;
  const routes = {
    '/api/config': () => ({ body: { siteName: 'Telegraph-Image', problems: [] } }),
    '/api/manage/albums/assign': () => ({ body: { updated: [], missing: [] } }),
    '/api/manage/albums': () => ({ body: { albums: [], list_complete: true } }),
  };

  async function start(options = {}) {
    ctx = await boot({ page: 'admin-legacy.html', module: 'js/workspace.js', routes, ...options });
    return ctx;
  }

  async function createAlbum(name) {
    click(ctx.$('album-new'));
    await tick();
    ctx.$('album-name-input').value = name;
    click(ctx.$('album-save'));
    await tick(25);
  }

  async function openAlbumsView() {
    click(ctx.doc.querySelector('.side-nav [data-view="albums"]'));
    await tick(20);
  }

  async function stageFiles(files) {
    const input = ctx.$('file-input');
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    fire(input, 'change');
    await tick(30);
  }

  function treeNames() {
    // The first row is the always-present "Root" node of the tree.
    return ctx.all('#album-tree .album-row:not([data-album-id="root"]) .album-row-name').map((el) => el.textContent);
  }
  function cardNames() {
    return ctx.all('.album-card-name').map((el) => el.textContent);
  }
  function crumbText() {
    // Breadcrumb separators are rendered as their own nodes; normalize them.
    return Array.from(ctx.$('crumbs').children)
      .map((li) => li.textContent.replace(/\s+/g, ' ').replace(/\/$/, '').trim())
      .filter(Boolean)
      .join(' / ');
  }

  afterEach(function () {
    teardown();
    ctx = null;
  });

  it('boots the album surfaces without script errors', async function () {
    await start();
    assert.deepStrictEqual(ctx.errors, []);
    assert.ok(ctx.doc.querySelector('.side-nav [data-view="albums"]'), 'sidebar has an Albums entry');
    assert.ok(ctx.doc.querySelector('.bottom-nav [data-view="albums"]'), 'mobile nav has an Albums entry');
    assert.deepStrictEqual(treeNames(), [], 'no albums yet');
    assert.strictEqual(ctx.all('#album-tree .album-row').length, 1, 'only the root node is listed');
    assert.strictEqual(ctx.$('album-nav-empty').hidden, false);
  });

  it('creates nested albums and navigates them through breadcrumbs', async function () {
    await start();
    await openAlbumsView();
    await createAlbum('Projects');
    assert.deepStrictEqual(treeNames(), ['Projects']);
    assert.deepStrictEqual(cardNames(), ['Projects']);

    // Open it, then create a child inside — the breadcrumb grows.
    click(ctx.doc.querySelector('.album-card'));
    await tick(20);
    assert.strictEqual(crumbText(), 'Storage / Projects');
    await createAlbum('Website');
    click(ctx.doc.querySelector('.album-card'));
    await tick(20);
    await createAlbum('Screenshots');
    click(ctx.doc.querySelector('.album-card'));
    await tick(20);
    assert.strictEqual(crumbText(), 'Storage / Projects / Website / Screenshots');
    assert.deepStrictEqual(treeNames(), ['Projects', 'Website', 'Screenshots']);

    // Breadcrumbs are the primary way back out.
    const links = ctx.all('#crumbs .crumb-link');
    click(links[1]);
    await tick(20);
    assert.strictEqual(crumbText(), 'Storage / Projects');
    click(ctx.all('#crumbs .crumb-link')[0]);
    await tick(20);
    assert.strictEqual(crumbText(), 'Storage');
  });

  it('refuses a duplicate sibling name with an explicit message', async function () {
    await start();
    await openAlbumsView();
    await createAlbum('Projects');
    click(ctx.$('album-new'));
    await tick();
    ctx.$('album-name-input').value = 'projects';
    click(ctx.$('album-save'));
    await tick();
    assert.match(ctx.$('album-name-error').textContent, /already exists/i);
    assert.strictEqual(ctx.$('album-dialog').hidden, false, 'the dialog stays open on an invalid name');
    assert.deepStrictEqual(treeNames(), ['Projects']);
  });

  it('stages files into the open album without any upload request', async function () {
    await start();
    await openAlbumsView();
    await createAlbum('Projects');
    click(ctx.doc.querySelector('.album-card'));
    await tick(20);

    await stageFiles([ctx.file('notes.txt', 'text/plain'), ctx.file('logo.svg', 'image/svg+xml')]);

    assert.strictEqual(ctx.uploads.length, 0, 'nothing is uploaded before Push');
    assert.ok(!ctx.calls.some((c) => c.url.includes('/upload')), 'no /upload fetch either');
    assert.strictEqual(ctx.all('.file-card').length, 2, 'both files show inside the album');
    assert.match(ctx.text(), /Pending/);
    // The status bar counts them as local work.
    assert.match(ctx.$('status-pending').textContent, /1|2/);
  });

  it('pushes staged files and keeps the album membership afterwards', async function () {
    await start();
    await openAlbumsView();
    await createAlbum('Projects');
    click(ctx.doc.querySelector('.album-card'));
    await tick(20);
    await stageFiles([ctx.file('a.txt', 'text/plain')]);

    click(ctx.$('push-changes'));
    await tick(80);

    assert.strictEqual(ctx.uploads.length, 1, 'Push is what uploads');
    assert.strictEqual(ctx.uploads[0].url, '/upload', 'the existing upload contract is used');
    assert.match(ctx.text(), /Synced/);
    // The object keeps its album and gained a stable public URL.
    assert.match(ctx.$('link-output').value, /^http:\/\/localhost:8788\/file\/r2-\d+\.png$/m);
    assert.strictEqual(ctx.all('.file-card').length, 1, 'still filed in the open album');
    // Membership persistence goes through the album API, not the upload path.
    const assign = ctx.calls.find((c) => c.url.includes('/api/manage/albums/assign'));
    assert.ok(assign, 'album membership is persisted after the object exists');
    assert.strictEqual(assign.method, 'POST');
    assert.ok(assign.body.albumId, 'assigned to the album the file was staged in');
  });

  it('moves objects between albums with the move dialog and keeps their URL', async function () {
    await start();
    await openAlbumsView();
    await createAlbum('Projects');
    await createAlbum('Archive');
    await stageFiles([ctx.file('a.txt', 'text/plain')]);
    click(ctx.$('push-changes'));
    await tick(80);
    const url = ctx.$('link-output').value;

    // Select the object, then use the bulk "Move to album" action.
    const check = ctx.doc.querySelector('.file-card input[type="checkbox"]');
    check.checked = true;
    fire(check, 'change');
    await tick();
    click(ctx.$('bulk-move'));
    await tick(20);

    const rows = ctx.all('#move-picker .album-picker-row');
    assert.ok(rows.length >= 3, 'root plus both albums are offered');
    const archive = rows.find((r) => r.textContent.includes('Archive'));
    click(archive);
    await tick();
    click(ctx.$('move-confirm'));
    await tick(40);

    assert.strictEqual(ctx.$('link-output').value, url, 'the public URL never changes when filing an object');
    click(ctx.all('#album-tree .album-row-btn').find((b) => b.textContent.includes('Archive')));
    await tick(20);
    assert.strictEqual(ctx.all('.file-card').length, 1, 'the object now lives in Archive');
  });

  it('supports drag and drop onto albums and refuses invalid destinations', async function () {
    await start();
    await openAlbumsView();
    await createAlbum('Projects');
    click(ctx.doc.querySelector('.album-card'));
    await tick(20);
    await createAlbum('Website');
    click(ctx.all('#crumbs .crumb-link')[0]);
    await tick(20);
    await stageFiles([ctx.file('a.txt', 'text/plain')]);

    // Drag the staged object onto the Projects album card.
    const card = ctx.doc.querySelector('.file-card');
    const albumCard = ctx.doc.querySelector('.album-card');
    fire(card, 'dragstart', { dataTransfer: ctx.dataTransfer() });
    const over = fire(albumCard, 'dragover', { dataTransfer: ctx.dataTransfer() });
    assert.ok(over.defaultPrevented, 'a valid destination accepts the drag');
    assert.ok(albumCard.classList.contains('drop-target'));
    assert.match(ctx.$('drag-hint').textContent, /Move to Projects/);
    fire(albumCard, 'drop', { dataTransfer: ctx.dataTransfer() });
    await tick(30);
    assert.strictEqual(ctx.$('drag-hint').hidden, true);

    click(ctx.all('#album-tree .album-row-btn').find((b) => b.textContent.includes('Projects')));
    await tick(20);
    assert.strictEqual(ctx.all('.file-card').length, 1, 'the object moved into Projects');

    // Dragging Projects into its own descendant is refused, non-destructively.
    click(ctx.all('#crumbs .crumb-link')[0]);
    await tick(20);
    const projectsRow = ctx.all('#album-tree .album-row').find((r) => r.textContent.includes('Projects'));
    const websiteRow = ctx.all('#album-tree .album-row').find((r) => r.textContent.includes('Website'));
    fire(projectsRow, 'dragstart', { dataTransfer: ctx.dataTransfer() });
    fire(websiteRow, 'dragover', { dataTransfer: ctx.dataTransfer() });
    assert.ok(websiteRow.classList.contains('drop-invalid'), 'invalid targets say so explicitly');
    assert.match(ctx.$('drag-hint').textContent, /sub-albums/i);
    fire(websiteRow, 'drop', { dataTransfer: ctx.dataTransfer() });
    await tick(20);
    assert.deepStrictEqual(treeNames(), ['Projects', 'Website'], 'the tree is unchanged after an invalid drop');
  });

  it('re-parents an album by dropping it on another album', async function () {
    await start();
    await openAlbumsView();
    await createAlbum('Projects');
    await createAlbum('Archive');
    const cards = ctx.all('.album-card');
    const archiveCard = cards.find((c) => c.textContent.includes('Archive'));
    const projectsCard = cards.find((c) => c.textContent.includes('Projects'));
    fire(archiveCard, 'dragstart', { dataTransfer: ctx.dataTransfer() });
    fire(projectsCard, 'dragover', { dataTransfer: ctx.dataTransfer() });
    assert.match(ctx.$('drag-hint').textContent, /sub-album of Projects/);
    fire(projectsCard, 'drop', { dataTransfer: ctx.dataTransfer() });
    await tick(30);
    assert.deepStrictEqual(cardNames(), ['Projects'], 'Archive is nested now');
    click(ctx.doc.querySelector('.album-card'));
    await tick(20);
    assert.deepStrictEqual(cardNames(), ['Archive']);
  });

  it('stages dropped OS files into the album they are dropped on', async function () {
    await start();
    await openAlbumsView();
    await createAlbum('Projects');
    const albumCard = ctx.doc.querySelector('.album-card');
    const dt = ctx.dataTransfer({ files: [ctx.file('dropped.txt', 'text/plain')] });
    const over = fire(albumCard, 'dragover', { dataTransfer: dt });
    assert.ok(over.defaultPrevented);
    assert.match(ctx.$('drag-hint').textContent, /stay on this device until Push/i);
    fire(albumCard, 'drop', { dataTransfer: dt });
    await tick(40);
    assert.strictEqual(ctx.uploads.length, 0, 'dropping files never uploads them');
    click(ctx.doc.querySelector('.album-card'));
    await tick(20);
    assert.strictEqual(ctx.all('.file-card').length, 1);
  });

  it('renames an album without detaching children or objects', async function () {
    await start();
    await openAlbumsView();
    await createAlbum('Projects');
    click(ctx.doc.querySelector('.album-card'));
    await tick(20);
    await createAlbum('Website');
    await stageFiles([ctx.file('inside.txt', 'text/plain')]);

    // Rename the open album through the tree context action (F2).
    const row = ctx.all('#album-tree .album-row').find((r) => r.textContent.includes('Projects'));
    fire(row, 'keydown', { key: 'F2' });
    await tick();
    ctx.$('album-name-input').value = 'Client work';
    click(ctx.$('album-save'));
    await tick(30);

    assert.deepStrictEqual(treeNames(), ['Client work', 'Website']);
    assert.strictEqual(crumbText(), 'Storage / Client work');
    assert.strictEqual(ctx.all('.file-card').length, 1, 'contained object is still there');
    assert.deepStrictEqual(cardNames(), ['Website'], 'the child album is still nested');
  });

  it('deleting an album removes organization only and keeps every object', async function () {
    await start();
    await openAlbumsView();
    await createAlbum('Projects');
    click(ctx.doc.querySelector('.album-card'));
    await tick(20);
    await stageFiles([ctx.file('keep.txt', 'text/plain')]);
    click(ctx.all('#crumbs .crumb-link')[0]);
    await tick(20);

    const menuBtn = ctx.doc.querySelector('.album-card-actions .icon-btn');
    click(menuBtn);
    await tick(20);
    const del = ctx.all('#context-menu button').find((b) => b.textContent === 'Delete album');
    assert.ok(del, 'the album menu offers a delete action');
    click(del);
    await tick(20);

    assert.match(ctx.$('confirm-body').textContent, /Only the album is removed/);
    assert.match(ctx.$('confirm-body').textContent, /keep their public URLs/);
    assert.strictEqual(ctx.$('confirm-ok').textContent, 'Delete album only');
    click(ctx.$('confirm-ok'));
    await tick(40);

    assert.deepStrictEqual(treeNames(), [], 'the album is gone');
    click(ctx.doc.querySelector('.side-nav [data-view="files"]'));
    await tick(20);
    assert.strictEqual(ctx.all('.file-card').length, 1, 'the object survived the album deletion');
    assert.match(ctx.text(), /keep\.txt/);
  });

  it('searches the local catalog by album name and path', async function () {
    await start();
    await openAlbumsView();
    await createAlbum('Projects');
    click(ctx.doc.querySelector('.album-card'));
    await tick(20);
    await stageFiles([ctx.file('inside.txt', 'text/plain')]);
    click(ctx.doc.querySelector('.side-nav [data-view="files"]'));
    await tick(20);
    await stageFiles([ctx.file('loose.txt', 'text/plain')]);

    const search = ctx.$('search');
    search.value = 'album:projects';
    fire(search, 'input');
    await tick(20);
    const names = ctx.all('.card-name').map((el) => el.textContent);
    assert.deepStrictEqual(names, ['inside.txt']);

    search.value = 'album:root';
    fire(search, 'input');
    await tick(20);
    assert.deepStrictEqual(ctx.all('.card-name').map((el) => el.textContent), ['loose.txt']);
  });

  it('exposes album commands in the palette only when they apply', async function () {
    await start();
    fire(ctx.doc, 'keydown', { key: 'k', ctrlKey: true, metaKey: false });
    await tick(20);
    const labels = ctx.all('#command-list .command-item').map((b) => b.textContent);
    assert.ok(labels.some((l) => l.includes('New album')));
    const parent = ctx.all('#command-list .command-item').find((b) => b.textContent.includes('parent album'));
    assert.ok(parent.disabled, 'going to a parent album is disabled at the root');
  });

  it('keeps album controls translated in Bahasa Indonesia', async function () {
    await start({ language: 'id' });
    await openAlbumsView();
    assert.match(ctx.doc.querySelector('.side-nav [data-view="albums"]').textContent, /Album/);
    await createAlbum('Proyek');
    const menuBtn = ctx.doc.querySelector('.album-card-actions .icon-btn');
    click(menuBtn);
    await tick(20);
    const labels = ctx.all('#context-menu button').map((b) => b.textContent);
    assert.ok(labels.includes('Ganti nama album'), labels.join('|'));
    assert.ok(labels.includes('Hapus album'));
    click(labels.includes('Hapus album') && ctx.all('#context-menu button').find((b) => b.textContent === 'Hapus album'));
    await tick(20);
    assert.match(ctx.$('confirm-body').textContent, /Hanya albumnya yang dihapus/);
    click(ctx.$('confirm-cancel'));
    await tick();
  });

  it('says album changes are local when the album API is not available', async function () {
    await start({
      routes: {
        ...routes,
        '/api/manage/albums': () => ({ status: 401, body: { error: 'unauthenticated' } }),
      },
    });
    await openAlbumsView();
    await createAlbum('Projects');
    assert.match(ctx.doc.querySelector('.album-card').textContent, /Local only/);
    const dot = ctx.doc.querySelector('#album-tree .album-unsynced-dot');
    assert.ok(dot, 'the tree marks unsynced albums');
    assert.strictEqual(dot.getAttribute('aria-label'), 'Local only');
  });

  it('surfaces unsynced album work with a deliberate sync action', async function () {
    await start({
      routes: {
        ...routes,
        '/api/manage/albums': () => ({ status: 401, body: { error: 'unauthenticated' } }),
      },
    });
    await openAlbumsView();
    assert.strictEqual(ctx.$('album-sync-row').hidden, true, 'nothing to sync at first');
    await createAlbum('Projects');
    assert.strictEqual(ctx.$('album-sync-row').hidden, false);
    assert.match(ctx.$('album-sync-note').textContent, /1 album changes stay on this device/);

    click(ctx.$('album-sync-btn'));
    await tick(40);
    // Syncing is refused politely; the album is still there and still local.
    assert.match(ctx.text(), /Local only/);
    assert.deepStrictEqual(treeNames(), ['Projects']);
  });

  it('returns focus to the trigger after a dialog closes', async function () {
    await start();
    await openAlbumsView();
    const trigger = ctx.$('album-new');
    trigger.focus();
    click(trigger);
    await tick(20);
    fire(ctx.doc, 'keydown', { key: 'Escape' });
    await tick(20);
    assert.strictEqual(ctx.doc.activeElement, trigger);
  });
});
