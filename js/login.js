import { applyStaticI18n, detectLanguage, getLanguage, initI18n, onLanguageChange, setLanguage, t } from './i18n.js';

const PREFS_KEY = 'ti.prefs';
const $ = (id) => document.getElementById(id);

let state = { submitting: false };

function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (_) { return {}; }
}
function savePrefs(patch) {
  try {
    const cur = loadPrefs();
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...cur, ...patch }));
  } catch (_) { /* ignore */ }
}
function detectTheme(prefs) {
  if (prefs.theme === 'light' || prefs.theme === 'dark') return prefs.theme;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
let theme = detectTheme(loadPrefs());
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  const btn = $('theme-btn');
  if (btn) {
    btn.setAttribute('aria-pressed', theme === 'dark' ? 'true' : 'false');
    btn.setAttribute('aria-label', t(theme === 'dark' ? 'themeDark' : 'themeLight'));
    btn.setAttribute('title', t(theme === 'dark' ? 'themeDark' : 'themeLight'));
  }
}

function cycleLanguage() {
  const next = getLanguage() === 'en' ? 'id' : 'en';
  setLanguage(next);
}

function setError(key) {
  const box = $('login-error');
  const text = $('login-error-text');
  if (!key) { box.hidden = true; text.textContent = ''; return; }
  text.textContent = t(key);
  box.hidden = false;
}

function setSubmitting(on) {
  state.submitting = on;
  $('submit-spinner').hidden = !on;
  $('submit-label').textContent = t(on ? 'signingIn' : 'signIn');
  $('submit-btn').disabled = on;
  $('username').disabled = on;
  $('password').disabled = on;
}

async function handleSubmit(event) {
  event.preventDefault();
  if (state.submitting) return;

  const user = $('username').value.trim();
  const pass = $('password').value;
  setError(null);

  if (!user || !pass) {
    setError('loginErrorRequired');
    if (!user) $('username').focus(); else $('password').focus();
    return;
  }

  setSubmitting(true);
  try {
    const res = await fetch('/api/manage/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ user, password: pass }),
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      if (data.authEnabled === false) {
        // Auth disabled — go straight to the canonical dashboard route.
        window.location.href = '/console';
        return;
      }
      const params = new URLSearchParams(window.location.search);
      const requested = params.get('next');
      const next = requested && requested.startsWith('/') && !requested.startsWith('//')
        && requested.indexOf('\\') === -1 && !requested.startsWith('/login')
        ? requested
        : '/console';
      window.location.href = next === '/admin-legacy.html' ? '/admin-legacy' : next;
      return;
    }
    if (res.status === 401) {
      setError('loginErrorInvalid');
      $('password').select();
    } else {
      setError('loginErrorNetwork');
    }
  } catch (err) {
    setError('loginErrorNetwork');
  } finally {
    setSubmitting(false);
  }
}

function togglePassword() {
  const input = $('password');
  const btn = $('toggle-pass');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.setAttribute('aria-pressed', String(!showing));
  btn.setAttribute('aria-label', t(showing ? 'showPassword' : 'hidePassword'));
}

function init() {
  initI18n();
  setLanguage(detectLanguage());
  applyTheme();
  applyStaticI18n(document);

  onLanguageChange(() => {
    applyStaticI18n(document);
    applyTheme();
    document.documentElement.lang = getLanguage();
  });
  document.documentElement.lang = getLanguage();

  $('login-form').addEventListener('submit', handleSubmit);
  $('toggle-pass').addEventListener('click', togglePassword);
  $('theme-btn').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    savePrefs({ theme });
    applyTheme();
  });
  $('lang-btn').addEventListener('click', cycleLanguage);

  // Autofocus username; password-manager friendly.
  setTimeout(() => $('username').focus(), 0);
}

init();
