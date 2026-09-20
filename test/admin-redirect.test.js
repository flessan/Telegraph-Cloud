const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..');

// /admin is a compatibility entry point: it must keep redirecting into the
// canonical /console management UI rather than dead-ending or rendering a
// second admin surface.
describe('/admin compatibility redirect', function () {
  let adminModule;

  before(async function () {
    adminModule = await import(path.join(root, 'functions', 'admin.js'));
  });

  it('responds 302 to /console with no caching', async function () {
    const response = adminModule.onRequest({
      request: new Request('https://example.com/admin'),
    });
    assert.ok(response instanceof Response);
    assert.strictEqual(response.status, 302);
    assert.strictEqual(response.headers.get('Location'), '/console');
    assert.strictEqual(response.headers.get('Cache-Control'), 'no-store');
  });

  it('returns an empty body so no legacy UI renders at /admin', async function () {
    const response = adminModule.onRequest({
      request: new Request('https://example.com/admin'),
    });
    const body = await response.text();
    assert.strictEqual(body, '');
  });
});

// Pre-rework project section slugs must keep resolving: each legacy slug maps
// to its canonical console section plus the matching sub-tab, so bookmarks and
// previously generated links keep working under the new IA.
describe('console router legacy deep-link aliases', function () {
  let router;

  before(async function () {
    // parseHash() reads window.location.hash at call time; a minimal shim is
    // enough in Node (URLSearchParams is a global).
    globalThis.window = { location: { hash: '' } };
    router = await import(path.join(root, 'js', 'console', 'router.js'));
  });

  after(function () {
    delete globalThis.window;
  });

  const cases = [
    ['#', 'overview', null],
    ['#/overview', 'overview', null],
    ['#/projects', 'projects', null],
    ['#/docs', 'docs', null],
    ['#/settings', 'settings', null],
    ['#/project/prj_1', 'overview', null],
    ['#/project/prj_1/overview', 'overview', null],
    ['#/project/prj_1/data', 'data', null],
    ['#/project/prj_1/files', 'files', null],
    ['#/project/prj_1/api', 'api', null],
    ['#/project/prj_1/connect', 'connect', null],
    ['#/project/prj_1/settings', 'settings', null],
    ['#/project/prj_1/drive', 'files', 'drive'],
    ['#/project/prj_1/database', 'data', 'collections'],
    ['#/project/prj_1/s3', 'files', 's3'],
    ['#/project/prj_1/s3-credentials', 'files', 's3'],
    ['#/project/prj_1/keys', 'api', 'keys'],
  ];

  for (const [hash, section, tab] of cases) {
    it(`resolves ${hash} -> section ${section}${tab ? `?tab=${tab}` : ''}`, function () {
      window.location.hash = hash;
      const parsed = router.parseHash();
      const expectedName = hash.startsWith('#/project/') ? 'project' : section;
      assert.strictEqual(parsed.name, expectedName);
      if (expectedName === 'project') {
        assert.strictEqual(parsed.params.section, section);
        assert.strictEqual(parsed.params.tab, tab);
      }
    });
  }

  it('builds canonical project paths with tabs', function () {
    assert.strictEqual(router.projectPath('prj_1', 'files', 'drive'), '#/project/prj_1/files?tab=drive');
    assert.strictEqual(router.projectPath('prj_1', 'data'), '#/project/prj_1/data');
  });
});
