const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Static guards for the canonical route split and the unified visual layer.
// Behavioural DOM suites exercise the same admin module; these checks cover
// responsive structure, accessibility metadata, and accidental entry-point
// regressions without requiring a browser binary.

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const appCss = read('css/app.css');
const landingCss = read('css/landing.css');
const workspaceCss = read('css/workspace.css');
const indexHtml = read('index.html');
const adminHtml = read('admin-legacy.html');
const loginHtml = read('login.html');
const nuxtHtml = read('index-nuxt.html');
const mdHtml = read('index-md.html');
const landingJs = read('js/landing.js');
const workspaceJs = read('js/workspace.js');
// The workspace surface is the entry module plus the js/workspace/* modules
// extracted from it; static guards that care about "the surface" should read
// the whole graph.
const workspaceGraphJs = [
  workspaceJs,
  ...fs.readdirSync(path.join(root, 'js/workspace'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => read(path.join('js/workspace', name))),
].join('\n');
const loginJs = read('js/login.js');

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = css.match(new RegExp(`(^|\\n)${escaped}\\s*\\{[^}]*\\}`));
  assert.ok(found, `expected a rule for ${selector}`);
  return found[0];
}

function canonical(html) {
  return (html.match(/<link rel="canonical" href="([^"]+)"/) || [])[1];
}

describe('canonical Telegraph Storage surfaces', () => {
  describe('route roles', () => {
    it('keeps / as a content-first landing page rather than an uploader', () => {
      assert.strictEqual(canonical(indexHtml), '/');
      assert.ok(indexHtml.includes('/css/landing.css'));
      assert.ok(indexHtml.includes('/js/landing.js'));
      assert.ok(!indexHtml.includes('id="file-input"'), 'landing must not stage files');
      assert.ok(!indexHtml.includes('/js/workspace.js'), 'landing must not boot the dashboard');
      assert.ok(!/drag.{0,20}drop|upload queue/i.test(indexHtml), 'landing is not disguised as an upload surface');
    });

    it('links the landing primary action to /console and identifies the source', () => {
      assert.ok(/class="btn landing-primary" href="\/console"[^>]*>[\s\S]*?data-i18n="openDashboard"/.test(indexHtml));
      assert.ok(/href="https:\/\/github\.com\/flessan\/Telegraph-Image"/.test(indexHtml));
      for (const key of ['landingStageTitle', 'landingReviewTitle', 'landingPushTitle', 'landingManageTitle']) {
        assert.ok(indexHtml.includes(`data-i18n="${key}"`), `landing is missing ${key}`);
      }
    });

    it('keeps /login focused on GUI authentication', () => {
      assert.strictEqual(canonical(loginHtml), '/login');
      assert.ok(loginHtml.includes('id="username"'));
      assert.ok(loginHtml.includes('id="password"'));
      assert.ok(loginHtml.includes('/js/login.js'));
      assert.ok(!loginHtml.includes('id="file-input"'));
      assert.ok(loginJs.includes(": '/console'"), 'successful login defaults to the canonical console');
      assert.ok(loginJs.includes("fetch('/api/manage/login'"), 'credentials use the existing session endpoint');
    });

    it('makes /admin the one complete storage workspace', () => {
      assert.strictEqual(canonical(adminHtml), '/admin-legacy');
      assert.ok(adminHtml.includes('/css/workspace.css'));
      assert.ok(adminHtml.includes('/js/workspace.js'));
      assert.ok(!adminHtml.includes('/js/admin.js'), 'the obsolete remote-only controller must not also boot');
      for (const view of ['overview', 'files', 'images', 'albums', 'recent', 'changes', 'whitelist', 'blacklist', 'tools']) {
        assert.ok(adminHtml.includes(`data-view="${view}"`), `admin is missing ${view}`);
      }
    });

    it('keeps compatibility pages noindex and loop-free', () => {
      for (const [name, html] of [['index-nuxt.html', nuxtHtml], ['index-md.html', mdHtml]]) {
        assert.ok(/name="robots" content="noindex/.test(html), `${name} must be noindex`);
        assert.ok(html.includes('location.replace(target)'), `${name} must bridge to /admin`);
        assert.ok(!html.includes('/index-nuxt.html') && !html.includes('/index-md.html'), `${name} must not redirect in a loop`);
      }
    });
  });

  describe('shared design and preferences', () => {
    it('loads the shared design foundation on every canonical page', () => {
      for (const [name, html] of [['index.html', indexHtml], ['login.html', loginHtml], ['admin-legacy.html', adminHtml]]) {
        assert.ok(html.includes('/css/app.css'), `${name} must load app.css`);
      }
      assert.ok(/^\.brand-mark\s*\{/m.test(appCss));
      assert.ok(/\.brand-mark svg\s*\{[^}]*width:/.test(appCss), 'brand SVGs need bounded dimensions');
    });

    it('uses one persisted language and theme preference system', () => {
      assert.ok(landingJs.includes("from './i18n.js'"));
      assert.ok(workspaceJs.includes("from './i18n.js'"));
      assert.ok(loginJs.includes("from './i18n.js'"));
      for (const source of [landingJs, workspaceGraphJs, loginJs]) {
        assert.ok(source.includes("ti.prefs"), 'all surfaces must share ti.prefs');
      }
    });

    it('honors reduced motion on landing and dashboard', () => {
      assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(landingCss));
      assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(workspaceCss));
    });

    it('uses progressive, product-led motion without a framework dependency', () => {
      for (const id of ['landing-header', 'scroll-progress-bar', 'storage-visual']) {
        assert.ok(indexHtml.includes(`id="${id}"`), `landing motion is missing ${id}`);
      }
      assert.ok(indexHtml.includes('class="motion-rail"'));
      assert.ok((indexHtml.match(/reveal-on-scroll/g) || []).length >= 8);
      for (const animation of ['packet-a', 'rail-motion', 'hub-breathe', 'route-dash', 'capability-reveal', 'hero-orbit']) {
        assert.ok(landingCss.includes(`@keyframes ${animation}`), `missing ${animation} motion`);
      }
      assert.ok(landingJs.includes("'(prefers-reduced-motion: reduce)'"));
      assert.ok(landingJs.includes("typeof window.IntersectionObserver !== 'function'"));
      assert.ok(!/gsap|anime\.js|framer-motion/i.test(indexHtml + landingJs), 'landing motion stays dependency-free');
    });

    it('keeps card motion composable and hover effects pointer-aware', () => {
      const finePointerGate = landingCss.indexOf('@media (hover: hover) and (pointer: fine)');
      assert.ok(finePointerGate >= 0, 'hover treatments need a fine-pointer gate');
      assert.doesNotMatch(
        landingCss.slice(0, finePointerGate),
        /(^|\n)\s*[^/*@\n][^{\n]*:hover[^{\n]*\{/,
        'hover selectors must not escape the fine-pointer gate',
      );
      assert.ok(landingCss.includes('@media (hover: none), (pointer: coarse)'), 'touch layouts need a coarse-pointer fallback');
      assert.match(
        landingCss,
        /\.motion-ready \.capability-card\.reveal-on-scroll\s*\{[^}]*transform[^}]*border-radius[^}]*background/,
        'card reveal transitions must retain all interactive properties',
      );
      assert.match(
        landingCss,
        /\.motion-ready \.capability-card\.reveal-on-scroll\.is-visible\s*\{[^}]*animation: capability-reveal[^}]*--reveal-delay/,
        'card reveal timing should be isolated from hover transitions',
      );
      assert.doesNotMatch(
        landingCss,
        /\.motion-ready \.capability-card[^{}]*\{[^}]*transition-delay/,
        'card hover transitions must not retain reveal delays',
      );
      assert.match(
        landingCss,
        /\.hero-actions \.landing-primary:hover\s*\{[^}]*color:[^}]*background:/,
        'the primary hover state must retain its filled inverse-color treatment',
      );
      assert.ok(landingCss.includes('@media (max-width: 420px)'), 'compact phones need a dedicated composition pass');
    });

    it('keeps hidden components reliably hidden', () => {
      assert.ok(/\[hidden\]\s*\{\s*display:\s*none\s*!important/.test(appCss));
    });

    it('uses one ordered overlay scale instead of arbitrary high z-indexes', () => {
      const tokens = ['--z-app-header', '--z-nav-drawer', '--z-sheet', '--z-dialog', '--z-menu', '--z-palette', '--z-snackbar'];
      const values = tokens.map((token) => {
        const match = appCss.match(new RegExp(`${token}:\\s*(\\d+)`));
        assert.ok(match, `missing ${token}`);
        return Number(match[1]);
      });
      assert.deepStrictEqual(values, [...values].sort((a, b) => a - b));
      for (const css of [appCss, landingCss, workspaceCss]) {
        for (const [, raw] of css.matchAll(/z-index:\s*(-?\d+)/g)) {
          assert.ok(Number(raw) <= 3, `raw z-index ${raw} should use a token`);
        }
      }
    });
  });

  describe('responsive and accessible admin shell', () => {
    it('provides a labelled responsive drawer and scrim', () => {
      assert.ok(adminHtml.includes('id="drawer-toggle"'));
      assert.ok(adminHtml.includes('aria-controls="workspace-sidebar"'));
      assert.ok(adminHtml.includes('id="drawer-scrim"'));
      assert.ok(adminHtml.includes('id="workspace-sidebar"'));
      assert.ok(/@media \(max-width: 820px\)[\s\S]*\.sidebar/.test(workspaceCss));
      assert.ok(workspaceJs.includes("classList.toggle('drawer-open'"));
    });

    it('provides desktop and touch navigation to core views', () => {
      assert.ok(/class="side-nav"/.test(adminHtml));
      assert.ok(/class="bottom-nav"/.test(adminHtml));
      for (const view of ['files', 'albums', 'recent', 'changes']) {
        const matches = adminHtml.match(new RegExp(`data-view="${view}"`, 'g')) || [];
        assert.ok(matches.length >= 2, `${view} needs sidebar and bottom-nav access`);
      }
    });

    it('has skip, live-region, dialog, and keyboard affordances', () => {
      assert.ok(/class="skip-link" href="#browser"/.test(adminHtml));
      assert.ok(adminHtml.includes('id="live"'));
      assert.ok(adminHtml.includes('aria-live="polite"'));
      for (const id of ['preview-dialog', 'confirm-dialog', 'album-dialog', 'move-dialog', 'command-dialog']) {
        assert.ok(new RegExp(`id="${id}"[^>]*role="dialog"[^>]*aria-modal="true"`).test(adminHtml), `${id} must be modal`);
      }
      assert.ok(workspaceJs.includes("event.key === 'Escape'"));
      assert.ok(workspaceJs.includes("event.key !== 'Tab'"), 'open dialogs trap focus');
    });

    it('exposes grid, list, and masonry layouts with selected state', () => {
      for (const id of ['view-grid', 'view-list', 'view-masonry']) assert.ok(adminHtml.includes(`id="${id}"`));
      assert.ok(workspaceCss.includes('.file-grid.masonry'));
      assert.ok(workspaceJs.includes("setAttribute('aria-pressed'"));
    });
  });

  describe('menus, previews, and management controls', () => {
    it('keeps object and Album actions reachable without right-click', () => {
      assert.ok(workspaceJs.includes('openItemMenu(item, event.currentTarget)'));
      assert.ok(workspaceJs.includes('openAlbumMenu(album, event.currentTarget)'));
      assert.ok(adminHtml.includes('id="context-menu"'));
      assert.ok(workspaceJs.includes("t('moveToAlbum')"));
      assert.ok(workspaceJs.includes("t('deleteObject')"));
    });

    it('preserves native context menus in typing and code/output surfaces', () => {
      assert.ok(workspaceJs.includes('function isTyping('));
      assert.ok(workspaceJs.includes("closest('pre, code, output"));
      assert.ok(workspaceJs.includes("tag === 'input' || tag === 'textarea'"));
    });

    it('provides an actionable empty-space menu', () => {
      const start = workspaceJs.indexOf('function openEmptyMenu(');
      const body = workspaceJs.slice(start, workspaceJs.indexOf('\n}', start) + 2);
      for (const key of ['addFiles', 'newAlbum', 'selectAllVisible', 'refresh']) {
        assert.ok(body.includes(`t('${key}')`), `empty menu needs ${key}`);
      }
    });

    it('chooses immersive preview elements from MIME-aware kinds', () => {
      assert.ok(adminHtml.includes('id="preview-prev"'));
      assert.ok(adminHtml.includes('id="preview-next"'));
      assert.ok(adminHtml.includes('id="preview-stage"'));
      for (const kind of ['image', 'audio', 'video', 'pdf']) {
        assert.ok(workspaceJs.includes(`kind === '${kind}'`), `preview is missing ${kind}`);
      }
      assert.ok(workspaceJs.includes('previewKind({ mime: item.type, name: item.name })'));
      assert.ok(workspaceJs.includes('function stepPreview('));
    });

    it('keeps remote management and bulk operations in the unified page', () => {
      for (const id of ['bulk-move', 'bulk-copy', 'bulk-download', 'bulk-whitelist', 'bulk-blacklist', 'bulk-delete']) {
        assert.ok(adminHtml.includes(`id="${id}"`), `missing ${id}`);
      }
      for (const action of ["'white'", "'block'", "'toggleLike'", "'delete'", '/api/manage/editName/']) {
        assert.ok(workspaceJs.includes(action), `workspace must retain remote action ${action}`);
      }
    });

    it('keeps sequential Push controls explicit', () => {
      for (const id of ['push-changes', 'push-pause', 'push-cancel', 'push-retry-failed', 'push-bar']) {
        assert.ok(adminHtml.includes(`id="${id}"`), `missing ${id}`);
      }
      assert.ok(workspaceJs.includes('createPushQueue({'));
    });
  });

  describe('landing deployment customization', () => {
    it('uses the existing public config fields with resilient defaults', () => {
      assert.ok(landingJs.includes("fetch('/api/config'"));
      for (const field of ['siteName', 'siteTitle', 'backgroundImage']) {
        assert.ok(landingJs.includes(field), `landing must support ${field}`);
      }
      assert.ok(/catch\s*\([^)]*\)\s*\{/.test(landingJs), 'config failure must be tolerated');
    });

    it('renders a configured background as restrained non-interactive content', () => {
      const background = landingCss.match(/body\.landing-body\.has-custom-background::before\s*\{[^}]*\}/)[0];
      assert.ok(background.includes('pointer-events: none'));
      assert.ok(/opacity:\s*\.\d+/.test(background));
      assert.ok(!/filter:\s*blur/.test(background));
    });
  });
});
