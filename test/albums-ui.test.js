const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Static guards for the album layer's visual and structural contract. These
// cover the things a unit test cannot click: layout constraints at small
// widths, truncation of long names/paths, and the fact that albums reuse the
// shared Material 3 primitives instead of introducing another design language.

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const appCss = read('css/app.css');
const adminCss = read('css/admin.css');
const workspaceCss = read('css/workspace.css');
const indexHtml = read('index.html');
const adminHtml = read('admin-legacy.html');
const workspaceJs = read('js/workspace.js');

const albumsJs = read('js/albums.js');

function rule(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(^|\\n)${escaped}\\s*\\{[^}]*\\}`));
  assert.ok(match, `expected a rule for ${selector}`);
  return match[0];
}

describe('album layer — shared design system', () => {
  it('defines album primitives once, in the shared foundation', () => {
    for (const selector of ['.album-tree', '.album-card', '.album-picker', '.album-badge', '.drag-hint']) {
      assert.ok(appCss.includes(selector + ' {') || appCss.includes(selector + ',') || appCss.includes(selector + '\n'),
        `${selector} must live in css/app.css so both surfaces share it`);
    }
    // The console must not fork the primitives.
    assert.ok(!/^\.album-card\s*\{/m.test(adminCss), 'admin.css must not redefine .album-card');
    assert.ok(!/^\.album-picker\s*\{/m.test(adminCss), 'admin.css must not redefine .album-picker');
  });

  it('uses design tokens rather than hard-coded colors', () => {
    const start = appCss.indexOf('Albums — shared primitives');
    const section = appCss.slice(start);
    const literals = section.match(/:\s*#[0-9a-f]{3,8}\b/gi) || [];
    assert.deepStrictEqual(literals, [], 'album styles must use --md-sys-color tokens');
    assert.ok(section.includes('var(--md-sys-color-primary-container)'));
    assert.ok(section.includes('var(--radius-md)'));
  });

  it('keeps the layering scale intact', () => {
    assert.ok(rule(appCss, '.drag-hint').includes('var(--z-snackbar)'),
      'the drag hint must use a layering token');
    const values = [...appCss.matchAll(/z-index:\s*(-?\d+)/g)].map((m) => Number(m[1]));
    for (const value of values) assert.ok(value <= 3, `raw z-index found: ${value}`);
  });

  it('avoids decorative effects in the album layer', () => {
    const section = appCss.slice(appCss.indexOf('Albums — shared primitives'));
    assert.ok(!/gradient|blur\(|backdrop-filter|text-shadow/.test(section),
      'no gradients, glow or glassmorphism in the album layer');
  });
});

describe('album layer — layout resilience', () => {
  it('truncates long album names everywhere they are rendered', () => {
    for (const selector of ['.album-row-name', '.album-card-name', '.album-picker-name', '.album-badge']) {
      assert.ok(rule(appCss, selector).includes('text-overflow: ellipsis'), `${selector} must truncate`);
    }
    assert.ok(rule(workspaceCss, '.crumb-link').includes('text-overflow: ellipsis'));
  });

  it('lets deep breadcrumbs wrap instead of overflowing the toolbar', () => {
    assert.ok(rule(workspaceCss, '.crumbs ol').includes('flex-wrap: wrap'));
  });

  it('caps the album tree so it cannot swallow the sidebar', () => {
    const tree = rule(appCss, '.album-tree');
    assert.ok(/max-height:\s*\d+vh/.test(tree), 'the tree needs a max height');
    assert.ok(tree.includes('overflow: auto'));
  });

  it('keeps the move dialog inside the viewport', () => {
    const picker = rule(appCss, '.album-picker');
    assert.ok(picker.includes('max-height: min(46vh, 320px)'));
    assert.ok(picker.includes('overflow: auto'));
    assert.ok(appCss.includes('.album-picker { max-height: 50vh; }'), 'phones get a taller picker inside a full-screen dialog');
  });

  it('adapts the album grid on small screens and hides the tree on the rail', () => {
    assert.ok(/@media \(max-width: 600px\)[\s\S]*?\.album-grid\s*\{[^}]*minmax\(140px/.test(appCss));
    assert.ok(/@media \(max-width: 1100px\)[\s\S]*?\.album-nav\s*\{\s*display: none/.test(workspaceCss),
      'the icon rail is too narrow for a tree; the Albums view covers it');
    assert.ok(/@media \(max-width: 640px\)[\s\S]*?\.drag-hint\s*\{[^}]*bottom/.test(workspaceCss),
      'the drag hint must clear the mobile bottom navigation');
  });
});

describe('album layer — markup and accessibility', () => {
  it('adds Albums to both the desktop and mobile navigation', () => {
    assert.ok(/class="nav-item" data-view="albums"/.test(adminHtml));
    assert.ok(/<button type="button" data-view="albums">/.test(adminHtml), 'bottom nav entry');
  });

  it('marks the trees and pickers up as trees with labels', () => {
    assert.ok(adminHtml.includes('id="album-tree" role="tree"'));
    assert.ok(adminHtml.includes('data-i18n-aria="albumTreeAria"'));
    assert.ok(adminHtml.includes('id="move-picker" role="tree"'));
    assert.ok(workspaceJs.includes("setAttribute('role', 'treeitem')"));
    assert.ok(workspaceJs.includes("setAttribute('aria-expanded'"));
  });

  it('gives every album dialog a modal role and a labelled title', () => {
    for (const id of ['album-dialog', 'move-dialog']) {
      const re = new RegExp(`id="${id}"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="${id}-title"`);
      assert.ok(re.test(adminHtml), `${id} must be a labelled modal`);
    }
  });

  it('signals drop targets with more than hover', () => {
    assert.ok(appCss.includes('body.dragging-internal .album-card'),
      'a drag in progress marks all destinations');
    assert.ok(rule(appCss, '.drop-target').includes('outline'));
    assert.ok(rule(appCss, '.drop-invalid').includes('dashed'), 'invalid drops have an explicit state');
    assert.ok(workspaceJs.includes("dropEffect = verdict.ok ? 'move' : 'none'"));
  });

  it('offers a touch-friendly alternative to dragging', () => {
    assert.ok(adminHtml.includes('id="bulk-move"'), 'bulk Move to album is a button, not only a drag');
    assert.ok(workspaceJs.includes("t('moveToAlbum')"), 'object menu offers Move to album');
  });
});

describe('album layer — safety of the object store', () => {
  it('never touches upload, storage or file-serving code', () => {
    const upload = read('functions/upload.js');
    const fileRoute = read('functions/file/[id].js');
    assert.ok(!/album/i.test(upload), 'upload.js must stay album-free');
    assert.ok(!/album/i.test(fileRoute), 'file serving must stay album-free');
    for (const rel of ['functions/storage/index.js', 'functions/storage/r2.js', 'functions/storage/telegram.js']) {
      assert.ok(!/album/i.test(read(rel)), `${rel} must stay album-free`);
    }
  });

  it('confines album metadata writes to the album API', () => {
    const assign = read('functions/api/manage/albums/assign.js');
    assert.ok(assign.includes('putMetadata'));
    assert.ok(!/img_url\.delete/.test(assign), 'assignment never deletes anything');
    const detail = read('functions/api/manage/albums/[id].js');
    assert.ok(detail.includes('objectsDeleted: false'));
    assert.ok(!/img_url\.delete\(params\.id\)/.test(detail), 'deleting an album must not delete objects');
  });

  it('documents that no new binding is required', () => {
    const utils = read('functions/utils/albums.js');
    assert.ok(/No new binding is required/i.test(utils));
    assert.ok(utils.includes("ALBUM_PREFIX = 'album:'"));
    const readme = read('README.md');
    assert.ok(/Albums/.test(readme), 'the README documents the album layer');
  });

  it('keeps album ids stable and name-independent', () => {
    assert.ok(albumsJs.includes("'alb_' + hex"));
    assert.ok(albumsJs.includes('resolveAlbumId'), 'memberships resolve through ids');
    assert.ok(!/parentName|albumName\s*=/.test(albumsJs), 'names are never used as references');
  });
});
