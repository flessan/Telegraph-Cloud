const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/i18n.js'), 'utf8');
const start = source.indexOf('const STRINGS =');
const end = source.indexOf('\n};', start) + 3;
const sandbox = {};
vm.runInNewContext(source.slice(start, end) + '\nthis.STRINGS = STRINGS;', sandbox);
const strings = sandbox.STRINGS;

function placeholders(value) {
  return [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
}

function walkJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

function referencedKeys() {
  const files = [
    'index.html', 'login.html', 'admin-legacy.html', 'console.html',
    'js/landing.js', 'js/login.js', 'js/workspace.js', 'js/admin.js',
    ...walkJs('js/console'),
  ];
  const keys = new Set();
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of text.matchAll(/data-i18n(?:-placeholder|-aria|-title)?=["']([A-Za-z0-9_]+)/g)) keys.add(match[1]);
    for (const match of text.matchAll(/\bt\(["']([A-Za-z0-9_]+)["']/g)) keys.add(match[1]);
  }
  return keys;
}

describe('single English/Chinese/Indonesian i18n system', () => {
  it('has exact key parity across en, zh, and id', () => {
    const en = Object.keys(strings.en).sort();
    const id = Object.keys(strings.id).sort();
    const zh = Object.keys(strings.zh).sort();
    assert.deepStrictEqual(id, en);
    assert.deepStrictEqual(zh, en);
  });

  it('defines every statically referenced UI key in all languages', () => {
    for (const lang of ['en', 'zh', 'id']) {
      const missing = [...referencedKeys()].filter((key) => strings[lang][key] == null).sort();
      assert.deepStrictEqual(missing, [], `undefined ${lang} i18n keys: ${missing.join(', ')}`);
    }
  });

  it('keeps interpolation placeholders equivalent in all languages', () => {
    for (const lang of ['zh', 'id']) {
      const mismatches = Object.keys(strings.en).filter((key) => (
        JSON.stringify(placeholders(strings.en[key])) !== JSON.stringify(placeholders(strings[lang][key]))
      ));
      assert.deepStrictEqual(mismatches, [], `${lang} placeholder mismatch: ${mismatches.join(', ')}`);
    }
  });

  it('contains no hard-coded Chinese fallback in canonical UI sources', () => {
    const cjk = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/;
    for (const file of ['index.html', 'login.html', 'admin-legacy.html', 'console.html',
      'js/landing.js', 'js/login.js', 'js/workspace.js', ...walkJs('js/console')]) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      assert.ok(!cjk.test(text), `${file} contains Chinese UI text`);
    }
  });

  it('persists language through only the established ti.lang key', () => {
    assert.ok(source.includes("const STORAGE_KEY = 'ti.lang'"));
    for (const file of ['js/landing.js', 'js/login.js', 'js/workspace.js']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      assert.ok(text.includes("from './i18n.js'"), `${file} must use the shared module`);
      assert.ok(!/localStorage\.(?:setItem|getItem)\(['\"](?:lang|language|locale)['\"]/.test(text), `${file} has a duplicate language store`);
    }
  });
});
