import { h } from '../util.js';
import { pageHead } from '../ui.js';
import { loadPrefs, savePrefs } from '../store.js';
import { setLanguage, getLanguage, t } from '../../i18n.js';
import { ct } from '../i18n.js';

export function renderSettings(container) {
  const prefs = loadPrefs();
  container.append(pageHead(ct('Settings'), ct('Console preferences and compatibility links.')));

  const theme = prefs.theme
    || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  container.append(h('div', { class: 'c-grid cols-2' }, [
    h('div', { class: 'c-card' }, [
      h('h2', { class: 'c-card-title' }, ct('Appearance')),
      h('p', { class: 'c-card-sub' }, ct('Preference is stored in this browser only.')),
      h('div', { class: 'c-segmented', role: 'group' }, [
        themeButton(ct('Light'), theme === 'light', () => chooseTheme('light')),
        themeButton(ct('Dark'), theme === 'dark', () => chooseTheme('dark')),
      ]),
    ]),
    h('div', { class: 'c-card' }, [
      h('h2', { class: 'c-card-title' }, ct('Language')),
      h('p', { class: 'c-card-sub' }, ct('The console follows the shared i18n system.')),
      h('div', { class: 'c-check-group' }, [
        languageOption(t('langEn'), 'en'),
        languageOption(t('langZh'), 'zh'),
        languageOption(t('langId'), 'id'),
      ]),
    ]),
  ]));

  container.append(h('div', { class: 'c-card', style: { marginTop: '14px' } }, [
    h('h2', { class: 'c-card-title' }, ct('Compatibility')),
    h('p', { class: 'c-card-sub', style: { margin: 0 } }, ct('The legacy Telegraph-Image workspace (staged uploads, albums, whitelist/blacklist, moderation) is preserved as the compatibility entry at /admin-legacy. /admin now redirects here; legacy files and API contracts are unchanged.')),
    h('div', { style: { marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' } }, [
      h('a', { class: 'c-btn outlined', href: '/admin-legacy.html' }, ct('Open Legacy Media')),
      h('a', { class: 'c-btn outlined', href: '/' }, ct('Landing page')),
    ]),
  ]));

  function chooseTheme(next) {
    document.documentElement.dataset.theme = next;
    savePrefs({ theme: next });
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }
}

function themeButton(label, active, onClick) {
  return h('button', {
    type: 'button',
    ...(active ? { 'aria-pressed': 'true', class: 'is-keyboard' } : {}),
    onClick,
  }, label);
}

function languageOption(label, code) {
  return h('label', { class: 'c-check' }, [
    h('input', {
      type: 'radio', name: 'c-language', value: code,
      ...(getLanguage() === code ? { checked: true } : {}),
      onchange: () => setLanguage(code),
    }),
    h('span', { class: 'c-check-label' }, label),
  ]);
}
