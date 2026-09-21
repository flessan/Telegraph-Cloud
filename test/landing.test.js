const assert = require('assert');
const { boot, teardown, click, tick } = require('./dom-harness');

describe('Telegraph Storage landing page (DOM)', function () {
  this.timeout(8000);
  let ctx;

  afterEach(function () {
    teardown();
    ctx = null;
  });

  async function start(options = {}) {
    ctx = await boot({ page: 'index.html', module: 'js/landing.js', ...options });
    await tick(35);
    return ctx;
  }

  it('renders useful static defaults when the public config endpoint is unavailable', async function () {
    await start();
    assert.deepStrictEqual(ctx.errors, []);
    assert.strictEqual(ctx.$('site-name').textContent, 'Telegraph Storage');
    assert.strictEqual(ctx.doc.title, 'Telegraph Storage');
    assert.strictEqual(ctx.doc.body.classList.contains('has-custom-background'), false);
    assert.ok(ctx.doc.querySelector('a.landing-primary[href="/console"]'));
    assert.strictEqual(ctx.doc.querySelector('#file-input'), null, 'the landing page is not an uploader');
  });

  it('applies the existing public branding contract without replacing product content', async function () {
    await start({
      routes: {
        '/api/config': () => ({
          body: {
            siteName: 'Team Archive',
            siteTitle: 'Team Archive · Storage',
            backgroundImage: '/assets/archive.jpg',
          },
        }),
      },
    });
    assert.strictEqual(ctx.$('site-name').textContent, 'Team Archive');
    assert.strictEqual(ctx.doc.title, 'Team Archive · Storage');
    assert.ok(ctx.doc.body.classList.contains('has-custom-background'));
    assert.match(ctx.doc.body.style.getPropertyValue('--landing-background-image'), /http:\/\/localhost:8788\/assets\/archive\.jpg/);
    assert.ok(ctx.doc.querySelector('[data-i18n="landingWorkflowTitle"]'));
  });

  it('rejects non-HTTP background schemes and CSS delimiter injection', async function () {
    await start({
      routes: {
        '/api/config': () => ({
          body: {
            backgroundImage: 'javascript:alert(1)',
          },
        }),
      },
    });
    assert.strictEqual(ctx.doc.body.classList.contains('has-custom-background'), false);
    assert.strictEqual(ctx.doc.body.style.getPropertyValue('--landing-background-image'), '');
  });

  it('progressively enables motion while keeping reveal content available without IntersectionObserver', async function () {
    await start();
    assert.ok(ctx.doc.body.classList.contains('landing-ready'));
    assert.ok(ctx.doc.body.classList.contains('motion-ready'));
    const reveals = Array.from(ctx.doc.querySelectorAll('.reveal-on-scroll'));
    assert.ok(reveals.length >= 8);
    assert.ok(reveals.every((node) => node.classList.contains('is-visible')));
    assert.match(ctx.$('scroll-progress-bar').style.transform, /^scaleX\(/);
  });

  it('restores and persists theme through the shared ti.prefs record', async function () {
    await start({ prefs: { theme: 'dark', layout: 'masonry' } });
    assert.strictEqual(ctx.doc.documentElement.dataset.theme, 'dark');
    assert.strictEqual(ctx.$('theme-btn').getAttribute('aria-pressed'), 'true');
    click(ctx.$('theme-btn'));
    const stored = JSON.parse(ctx.win.localStorage.getItem('ti.prefs'));
    assert.strictEqual(stored.theme, 'light');
    assert.strictEqual(stored.layout, 'masonry', 'landing must not discard dashboard preferences');
  });

  it('switches the one shared language system to natural Indonesian', async function () {
    await start({ language: 'en' });
    click(ctx.$('lang-btn'));
    await tick(15);
    assert.strictEqual(ctx.doc.documentElement.lang, 'id');
    assert.strictEqual(ctx.win.localStorage.getItem('ti.lang'), 'id');
    assert.strictEqual(ctx.$('lang-code').textContent, 'ID');
    assert.match(ctx.$('hero-title').textContent, /Berkas sebaiknya ditinjau/);
    assert.match(ctx.doc.querySelector('.landing-primary').textContent, /Buka Dasbor/);
  });
});
