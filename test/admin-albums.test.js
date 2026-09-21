const assert = require('assert');
const { boot, teardown, click, fire, tick } = require('./dom-harness');

/**
 * Remote fixtures for the canonical /admin workspace. These tests make sure
 * consolidating the former console did not turn remote objects into local
 * duplicates or lose Albums, moderation, pagination, public identities, and
 * MIME-aware output.
 */
describe('unified remote workspace (DOM)', function () {
  this.timeout(12000);

  let ctx;
  let albums;
  let objects;

  const album = (id, name, parentId = null) => ({
    id, name, parentId, createdAt: 1, updatedAt: 1,
  });
  const object = (name, extra = {}) => ({
    name,
    metadata: {
      TimeStamp: 1710000000000,
      ListType: 'None',
      Label: 'None',
      liked: false,
      fileName: name,
      fileSize: 1024,
      ...extra,
    },
  });

  function routes(overrides = {}) {
    return {
      '/api/manage/session': () => ({ body: { authenticated: true, authEnabled: true, user: 'admin' } }),
      '/api/config': () => ({ body: { siteName: 'Fixture Storage', problems: [] } }),
      '/api/manage/albums/assign': ({ init }) => {
        const body = JSON.parse(init.body);
        for (const id of body.ids) {
          const entry = objects.find((candidate) => candidate.name === id);
          if (!entry) continue;
          if (body.albumId) entry.metadata.albumId = body.albumId;
          else delete entry.metadata.albumId;
        }
        return { body: { updated: body.ids, missing: [] } };
      },
      '/api/manage/albums': () => ({ body: { albums, list_complete: true } }),
      '/api/manage/list': () => ({ body: { keys: objects, list_complete: true } }),
      '/api/manage/white/': ({ url }) => {
        const id = decodeURIComponent(url.split('/').pop());
        const entry = objects.find((candidate) => candidate.name === id);
        if (entry) entry.metadata.ListType = 'White';
        return { body: entry ? entry.metadata : {} };
      },
      ...overrides,
    };
  }

  async function start(options = {}) {
    ctx = await boot({
      page: 'admin-legacy.html',
      module: 'js/workspace.js',
      routes: routes(options.routes),
      language: options.language || 'en',
      prefs: options.prefs || {},
    });
    await tick(80);
    return ctx;
  }

  function card(name) {
    return ctx.all('.file-card').find((entry) => entry.querySelector('.card-name')?.textContent === name);
  }

  async function view(name) {
    click(ctx.doc.querySelector(`.side-nav [data-view="${name}"]`));
    await tick(35);
  }

  async function openAlbum(name) {
    await view('albums');
    const target = ctx.all('.album-card').find((entry) => entry.querySelector('.album-card-name')?.textContent === name);
    assert.ok(target, `missing Album card ${name}`);
    click(target);
    await tick(35);
  }

  beforeEach(function () {
    albums = [
      album('alb_projects', 'Projects'),
      album('alb_website', 'Website', 'alb_projects'),
      album('alb_archive', 'Archive'),
    ];
    objects = [
      object('r2-one.png', { fileName: 'one.png', mimeType: 'image/png', albumId: 'alb_website' }),
      object('r2-two.pdf', { fileName: 'two.pdf', mimeType: 'application/pdf', albumId: 'alb_projects' }),
      object('r2-three.mp3', { fileName: 'three.mp3', mimeType: 'audio/mpeg' }),
    ];
  });

  afterEach(function () {
    teardown();
    ctx = null;
  });

  it('authenticates, loads remote Albums and merges remote objects by backend identity', async function () {
    await start();
    assert.deepStrictEqual(ctx.errors, []);
    assert.ok(ctx.calls[0].url.includes('/api/manage/session'), 'session gate runs before remote hydration');
    assert.ok(ctx.calls.some((call) => call.url.includes('/api/manage/list')));
    assert.ok(ctx.calls.some((call) => call.url.includes('/api/manage/albums')));
    assert.deepStrictEqual(ctx.all('.card-name').map((node) => node.textContent).sort(), ['one.png', 'three.mp3', 'two.pdf']);
    assert.deepStrictEqual(ctx.all('.file-card').map((node) => node.dataset.id).sort(),
      ['remote:r2-one.png', 'remote:r2-three.mp3', 'remote:r2-two.pdf']);
    assert.strictEqual(ctx.$('site-name').textContent, 'Fixture Storage');
  });

  it('scopes objects to the current nested Album and builds an honest breadcrumb', async function () {
    await start();
    await openAlbum('Projects');
    assert.deepStrictEqual(ctx.all('.card-name').map((node) => node.textContent), ['two.pdf']);
    assert.match(ctx.$('crumbs').textContent.replace(/\s+/g, ' '), /Storage.*Projects/);
    const nested = ctx.all('.album-card').find((entry) => entry.textContent.includes('Website'));
    assert.ok(nested);
    click(nested);
    await tick(35);
    assert.deepStrictEqual(ctx.all('.card-name').map((node) => node.textContent), ['one.png']);
    assert.match(ctx.$('crumbs').textContent.replace(/\s+/g, ' '), /Storage.*Projects.*Website/);
  });

  it('moves a remote object locally, then persists membership only on explicit Album sync', async function () {
    await start();
    await openAlbum('Projects');
    const target = card('two.pdf');
    click(target.querySelector('.card-actions button:last-child'));
    await tick(15);
    click(ctx.all('#context-menu button').find((button) => button.textContent.includes('Move to album')));
    await tick(20);
    click(ctx.all('#move-picker .album-picker-row').find((row) => row.textContent.includes('Archive')));
    click(ctx.$('move-confirm'));
    await tick(35);
    assert.ok(!ctx.calls.some((call) => call.url.includes('/albums/assign')), 'move remains deliberate local work');
    assert.strictEqual(objects.find((entry) => entry.name === 'r2-two.pdf').metadata.albumId, 'alb_projects');

    click(ctx.$('album-sync-btn'));
    await tick(80);
    const assign = ctx.calls.find((call) => call.url.includes('/albums/assign'));
    assert.deepStrictEqual(assign.body, { albumId: 'alb_archive', ids: ['r2-two.pdf'] });
    assert.strictEqual(objects.find((entry) => entry.name === 'r2-two.pdf').metadata.albumId, 'alb_archive');
  });

  it('keeps moderation independent from Album placement', async function () {
    await start();
    const target = card('two.pdf');
    click(target.querySelector('.card-actions button:last-child'));
    await tick(15);
    click(ctx.all('#context-menu button').find((button) => button.textContent === 'Whitelist'));
    await tick(60);
    assert.ok(ctx.calls.some((call) => call.url.includes('/api/manage/white/r2-two.pdf')));
    assert.strictEqual(objects.find((entry) => entry.name === 'r2-two.pdf').metadata.albumId, 'alb_projects');
    await view('whitelist');
    assert.deepStrictEqual(ctx.all('.card-name').map((node) => node.textContent), ['two.pdf']);
  });

  it('loads additional remote pages without changing object identities', async function () {
    const pageOne = [object('r2-first.png', { fileName: 'first.png', mimeType: 'image/png' })];
    const pageTwo = [object('r2-second.pdf', { fileName: 'second.pdf', mimeType: 'application/pdf' })];
    await start({
      routes: {
        '/api/manage/list': ({ url }) => url.includes('cursor=next')
          ? { body: { keys: pageTwo, list_complete: true } }
          : { body: { keys: pageOne, list_complete: false, cursor: 'next' } },
      },
    });
    assert.deepStrictEqual(ctx.all('.card-name').map((node) => node.textContent), ['first.png']);
    assert.strictEqual(ctx.$('load-more').hidden, false);
    click(ctx.$('load-more'));
    await tick(70);
    assert.deepStrictEqual(ctx.all('.card-name').map((node) => node.textContent).sort(), ['first.png', 'second.pdf']);
    assert.deepStrictEqual(ctx.all('.file-card').map((node) => node.dataset.id).sort(), ['remote:r2-first.png', 'remote:r2-second.pdf']);
  });

  it('renders the same remote hierarchy with natural Indonesian controls', async function () {
    await start({ language: 'id' });
    await view('albums');
    assert.match(ctx.$('crumbs').textContent, /Penyimpanan/);
    assert.deepStrictEqual(ctx.all('.album-card-name').map((node) => node.textContent), ['Archive', 'Projects']);
    assert.match(ctx.$('new-album-btn').textContent, /Album baru/);
  });
});

describe('unified remote MIME output and previews (DOM)', function () {
  this.timeout(12000);

  let ctx;
  const records = [
    { name: 'r2-photo.png', metadata: { fileName: 'photo.png', mimeType: 'image/png', fileSize: 10, TimeStamp: 5 } },
    { name: 'r2-song.mp3', metadata: { fileName: 'song.mp3', mimeType: 'audio/mpeg', fileSize: 20, TimeStamp: 4 } },
    { name: 'r2-clip.mp4', metadata: { fileName: 'clip.mp4', mimeType: 'video/mp4', fileSize: 30, TimeStamp: 3 } },
    { name: 'r2-manual.pdf', metadata: { fileName: 'manual.pdf', mimeType: 'application/pdf', fileSize: 40, TimeStamp: 2 } },
    { name: 'r2-bundle.zip', metadata: { fileName: 'pack[v2].zip', mimeType: 'application/zip', fileSize: 50, TimeStamp: 1 } },
  ];

  async function start(language = 'en') {
    ctx = await boot({
      page: 'admin-legacy.html',
      module: 'js/workspace.js',
      language,
      routes: {
        '/api/manage/session': () => ({ body: { authenticated: true, authEnabled: true } }),
        '/api/manage/albums': () => ({ body: { albums: [], list_complete: true } }),
        '/api/manage/list': () => ({ body: { keys: records, list_complete: true } }),
        '/api/config': () => ({ body: { problems: [] } }),
      },
    });
    await tick(90);
    return ctx;
  }

  function card(name) {
    return ctx.all('.file-card').find((entry) => entry.querySelector('.card-name')?.textContent === name);
  }

  async function copy(name, format) {
    click(ctx.doc.querySelector(`#format-tabs [data-format="${format}"]`));
    const target = card(name);
    click(target.querySelector('.card-actions button:first-child'));
    await tick(20);
    return ctx.copied();
  }

  async function preview(name) {
    click(card(name));
    await tick(25);
    return ctx.$('preview-stage');
  }

  afterEach(function () {
    teardown();
    ctx = null;
  });

  it('generates semantic and escaped link formats instead of treating every object as an image', async function () {
    await start();
    assert.match(await copy('photo.png', 'html'), /^<img src="http:\/\/localhost:8788\/file\/r2-photo\.png"/);
    assert.match(await copy('song.mp3', 'html'), /^<audio controls/);
    assert.match(await copy('clip.mp4', 'html'), /^<video controls/);
    assert.match(await copy('manual.pdf', 'html'), /^<iframe /);
    assert.match(await copy('pack[v2].zip', 'html'), /^<a href=/);
    assert.ok(!(await copy('manual.pdf', 'markdown')).startsWith('!['));
    assert.ok(!(await copy('song.mp3', 'bbcode')).includes('[img]'));
    assert.ok((await copy('pack[v2].zip', 'bbcode')).includes('pack&#91;v2&#93;.zip'));
    assert.strictEqual(await copy('song.mp3', 'url'), 'http://localhost:8788/file/r2-song.mp3');
  });

  it('uses matching image, audio, video, PDF, and generic preview surfaces', async function () {
    await start();
    assert.ok((await preview('photo.png')).querySelector('img'));
    click(ctx.$('preview-close'));
    assert.ok((await preview('song.mp3')).querySelector('audio[controls]'));
    click(ctx.$('preview-close'));
    assert.ok((await preview('clip.mp4')).querySelector('video[controls]'));
    click(ctx.$('preview-close'));
    assert.ok((await preview('manual.pdf')).querySelector('iframe'));
    click(ctx.$('preview-close'));
    const generic = await preview('pack[v2].zip');
    assert.strictEqual(generic.querySelector('img'), null);
    assert.match(generic.textContent, /ZIP|Archive/i);
  });

  it('steps through the current sorted preview ordering', async function () {
    await start();
    await preview('photo.png');
    assert.strictEqual(ctx.$('preview-title').textContent, 'photo.png');
    click(ctx.$('preview-next'));
    assert.strictEqual(ctx.$('preview-title').textContent, 'song.mp3');
    click(ctx.$('preview-next'));
    assert.strictEqual(ctx.$('preview-title').textContent, 'clip.mp4');
    click(ctx.$('preview-prev'));
    assert.strictEqual(ctx.$('preview-title').textContent, 'song.mp3');
  });

  it('localizes category descriptions without translating filenames or MIME values', async function () {
    await start('id');
    await preview('manual.pdf');
    assert.strictEqual(ctx.$('preview-title').textContent, 'manual.pdf');
    assert.strictEqual(ctx.$('meta-mime').textContent, 'application/pdf');
    click(ctx.$('preview-close'));
    const generic = await preview('pack[v2].zip');
    assert.match(generic.textContent, /Arsip/);
    assert.strictEqual(ctx.$('preview-title').textContent, 'pack[v2].zip');
  });
});
