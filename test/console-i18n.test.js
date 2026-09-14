const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function walkJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

// Replace // and /* */ comments with spaces (preserving newlines) while
// leaving quoted strings and template literals intact, so documentation
// comments that mention a ct call shape cannot be mistaken for real messages.
function maskComments(src) {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += src[i + 1] || ''; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i += 1; }
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      out += '  '; i += 1;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '; i += 1;
      }
      out += '  '; i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

// Extract the first string-literal argument of every static ct call.
// Dynamic ct(variable) calls are allowed only for labels whose literals are
// covered elsewhere (e.g. the snippet-label switch in drive-inspector.js).
function extractConsoleMessages() {
  const messages = new Set();
  const re = /\bct\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  for (const file of walkJs(path.join('js', 'console'))) {
    const src = maskComments(fs.readFileSync(path.join(root, file), 'utf8'));
    let match;
    while ((match = re.exec(src))) {
      messages.add(Function(`return ${match[1]}`)());
    }
  }
  return messages;
}

const placeholders = (value) => [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('Cloud console catalog (ct/gettext-style)', function () {
  let locales;
  let messages;

  before(async function () {
    locales = (await import('../js/i18n.js')).CONSOLE_LOCALES;
    messages = extractConsoleMessages();
  });

  it('extracts console messages from the sources', function () {
    assert.ok(messages.size > 100, `expected hundreds of messages, got ${messages.size}`);
  });

  it('translates every English message into Chinese', function () {
    const zh = locales.zh;
    assert.ok(zh, 'zh catalog exists');
    const missing = [...messages].filter((m) => !Object.prototype.hasOwnProperty.call(zh, m)).sort();
    assert.deepStrictEqual(missing, [], `missing zh translations:\n${missing.join('\n')}`);
  });

  it('keeps interpolation placeholders identical in Chinese', function () {
    const mismatches = [...messages].filter((m) => {
      const en = placeholders(m);
      const zh = placeholders(locales.zh[m]);
      return JSON.stringify(en) !== JSON.stringify(zh);
    });
    assert.deepStrictEqual(mismatches, [], `placeholder mismatches:\n${mismatches
      .map((m) => `${m} [${placeholders(m)}] -> [${placeholders(locales.zh[m])}]`).join('\n')}`);
  });

  it('has no stale catalog keys that no longer appear in the console', function () {
    const stale = Object.keys(locales.zh).filter((key) => !messages.has(key)).sort();
    assert.deepStrictEqual(stale, [], `stale zh keys:\n${stale.join('\n')}`);
  });

  it('contains no empty Chinese translations', function () {
    const empty = Object.entries(locales.zh).filter(([, value]) => !String(value).trim()).map(([key]) => key);
    assert.deepStrictEqual(empty, []);
  });

  it('never hard-codes Chinese text in console source files', function () {
    const cjk = /[㐀-䶿一-鿿　-ヿ＀-￯]/;
    const offenders = walkJs(path.join('js', 'console'))
      .filter((file) => cjk.test(fs.readFileSync(path.join(root, file), 'utf8')));
    assert.deepStrictEqual(offenders, [], `Chinese text outside the catalog: ${offenders.join(', ')}`);
  });
});
