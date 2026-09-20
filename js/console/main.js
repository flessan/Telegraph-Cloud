import { h, $, clear } from './util.js';
import { initI18n, setLanguage, detectLanguage, getLanguage, onLanguageChange, applyStaticI18n, t } from '../i18n.js';
import { ct } from './i18n.js';
import {
  store, ensureSession, loadConfig, loadProjects, loadPrefs, savePrefs, setCurrentProject, projectById,
} from './store.js';
import { parseHash, navigate, projectPath } from './router.js';
import { toast } from './ui.js';

import { renderOverview } from './views/global-overview.js';
import { renderProjects } from './views/projects.js';
import { renderProjectOverview } from './views/project-overview.js';
import { renderData } from './views/data.js';
import { renderFiles } from './views/files.js';
import { renderApi } from './views/api.js';
import { renderConnect } from './views/connect.js';
import { renderProjectSettings } from './views/project-settings.js';
import { renderDocs } from './views/docs.js';
import { renderSettings } from './views/settings.js';

const svg = {
  overview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
  projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
  drive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h3.1l1.8 1.8h7.7A2.2 2.2 0 0 1 20.5 10v7.3a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/></svg>',
  database: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6M4.5 11.5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6"/></svg>',
  s3: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="8" cy="7" rx="5" ry="2.5"/><path d="M3 7v5c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V7"/><path d="M13 8.2c2.9.3 5 1.4 5 2.8v5c0 1.4-2.1 2.5-5 2.5-1.2 0-2.3-.2-3.2-.6"/><ellipse cx="16" cy="14" rx="5" ry="2.5"/></svg>',
  key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="3.5"/><path d="M10.6 12.4 20 3M17 6l2.5 2.5M14.5 8.5 17 11"/></svg>',
  shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
  connect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/></svg>',
  docs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-3"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 4.6 15H4.5a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 6 7l-.1-.1a2 2 0 1 1 8.7-4.1l.1.1A1.7 1.7 0 0 0 12 4.6V4.5a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.4 1.9v.1a1.7 1.7 0 0 0 1.6 1H22a2 2 0 1 1 0 4z"/></svg>',
  legacy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M3.5 9h17"/><circle cx="7" cy="7" r=".5" fill="currentColor"/></svg>',
};

// Labels are thunks so their literal source messages stay statically
// extractable (the i18n coverage test scans for ct calls with literal
// first arguments) and language switches retranslate the chrome on re-render.
const GLOBAL_ITEMS = [
  { route: 'overview', hash: '#/overview', label: () => ct('Overview'), icon: svg.overview },
  { route: 'projects', hash: '#/projects', label: () => ct('Projects'), icon: svg.projects },
  { route: 'docs', hash: '#/docs', label: () => ct('Documentation'), icon: svg.docs },
  { route: 'settings', hash: '#/settings', label: () => ct('Settings'), icon: svg.settings },
];

// Canonical project information architecture:
//   Overview | Data | Files | API | Connect | Settings
// (Data = collections + records + schemas; Files = Drive + Objects + S3;
//  API = endpoints + API keys + explorer + documentation.)
const PROJECT_ITEMS = [
  { section: 'overview', label: () => ct('Overview'), icon: svg.overview },
  { section: 'data', label: () => ct('Data'), icon: svg.database },
  { section: 'files', label: () => ct('Files'), icon: svg.drive },
  { section: 'api', label: () => ct('API'), icon: svg.key },
  { section: 'connect', label: () => ct('Connect'), icon: svg.connect },
  { section: 'settings', label: () => ct('Settings'), icon: svg.settings },
];

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('#c-theme-btn');
  if (btn) {
    btn.setAttribute('aria-pressed', String(theme === 'dark'));
    btn.title = theme === 'dark' ? ct('Switch to light theme') : ct('Switch to dark theme');
  }
}

function renderNav() {
  const globalNav = $('#c-global-nav');
  const route = parseHash();
  clear(globalNav);
  for (const item of GLOBAL_ITEMS) {
    const active = route.name === item.route
      || (item.route === 'projects' && route.name === 'project');
    globalNav.append(h('a', {
      class: 'c-nav-item',
      href: item.hash,
      ...(active ? { 'aria-current': 'page' } : {}),
    }, [h('span', { 'aria-hidden': 'true', html: item.icon }), h('span', {}, item.label())]));
  }

  // Project quick switcher list under global nav.
  const projectGroup = $('#c-project-nav-group');
  const projectNav = $('#c-project-nav');
  clear(projectNav);
  const projectId = route.params.id || null;
  if (projectId) setCurrentProject(projectId);

  if (route.name === 'project' && projectId) {
    projectGroup.hidden = false;
    $('#c-project-nav-title').textContent = projectById(projectId)?.name || ct('Project');
    for (const item of PROJECT_ITEMS) {
      projectNav.append(h('a', {
        class: 'c-nav-item',
        href: projectPath(projectId, item.section),
        ...(route.params.section === item.section ? { 'aria-current': 'page' } : {}),
      }, [h('span', { 'aria-hidden': 'true', html: item.icon }), h('span', {}, item.label())]));
    }
  } else if (store.projectsLoaded) {
    projectGroup.hidden = false;
    $('#c-project-nav-title').textContent = ct('Projects ({n})', { n: store.projects.length });
    for (const project of store.projects.slice(0, 8)) {
      projectNav.append(h('a', {
        class: 'c-nav-project',
        href: projectPath(project.project_id, 'overview'),
        ...(projectId === project.project_id ? { 'aria-current': 'page' } : {}),
      }, [
        h('span', { class: 'c-proj-dot' }),
        h('span', { class: 'c-proj-name' }, project.name),
      ]));
    }
    if (store.projects.length > 8) {
      projectNav.append(h('a', { class: 'c-nav-project', href: '#/projects' }, [
        h('span', { class: 'c-proj-name', style: { color: 'var(--c-primary)', fontWeight: '600' } }, ct('All projects…')),
      ]));
    }
  } else {
    projectGroup.hidden = true;
  }

  // Topbar project switcher.
  const switcher = $('#c-project-switch');
  const current = projectId ? projectById(projectId) : null;
  if (current) {
    switcher.hidden = false;
    $('#c-project-switch-text').textContent = current.name;
    switcher.querySelector('.c-project-dot').classList.toggle('is-disabled', current.status !== 'active');
  } else {
    switcher.hidden = true;
  }
}

function switcherMenu() {
  import('./ui.js').then(({ popupMenu }) => {
    const items = store.projects.slice(0, 20).map((project) => ({
      title: project.name,
      icon: `<span class="c-proj-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${project.status === 'active' ? 'var(--c-success)' : 'var(--c-warning)'}"></span>`,
      onClick: () => navigate(projectPath(project.project_id, 'overview')),
    }));
    items.push('sep', {
      title: ct('All projects'),
      icon: svg.projects,
      onClick: () => navigate('#/projects'),
    }, {
      title: ct('New project'),
      icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
      onClick: () => navigate('#/projects?new=1'),
    });
    popupMenu($('#c-project-switch'), items);
  });
}

const viewCache = new Map();

async function route() {
  renderNav();
  const main = $('#console-main');
  try { main._viewCleanup?.(); } catch (_) { /* isolate teardown errors */ }
  main._viewCleanup = null;
  clear(main);
  document.getElementById('c-app').classList.remove('nav-open');

  const parsed = parseHash();
  if (parsed.name === 'project' && !projectById(parsed.params.id)) {
    // Project list may not be hydrated yet.
    try { await loadProjects(); renderNav(); } catch (_) { /* session view handles errors */ }
  }

  try {
    switch (parsed.name) {
      case 'overview': return renderOverview(main);
      case 'projects': return renderProjects(main);
      case 'docs': return renderDocs(main);
      case 'settings': return renderSettings(main);
      case 'project': {
        const { id, section } = parsed.params;
        switch (section) {
          case 'data': return renderData(main, id, parsed.query);
          case 'files': return renderFiles(main, id, parsed.query);
          case 'api': return renderApi(main, id, parsed.query);
          case 'connect': return renderConnect(main, id);
          case 'settings': return renderProjectSettings(main, id);
          default: return renderProjectOverview(main, id);
        }
      }
      default: return renderOverview(main);
    }
  } catch (error) {
    if (error?.status === 401) return; // redirect already triggered
    console.error('Route render failed', error);
    clear(main);
    main.append(h('div', { class: 'c-error-state', role: 'alert' }, [
      h('h3', {}, ct('This view could not be opened')),
      h('p', {}, error?.message || error?.code || ct('Unknown error')),
    ]));
  }
}

function setupChrome() {
  const prefs = loadPrefs();
  const theme = prefs.theme || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  applyTheme(theme);

  $('#c-theme-btn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    savePrefs({ theme: next });
  });

  $('#c-lang-btn').addEventListener('click', (event) => {
    import('./ui.js').then(({ popupMenu }) => {
      popupMenu(event.currentTarget, [
        { title: t('langEn'), onClick: () => setLanguage('en') },
        { title: t('langZh'), onClick: () => setLanguage('zh') },
        { title: t('langId'), onClick: () => setLanguage('id') },
      ]);
    });
  });

  $('#c-menu-toggle').addEventListener('click', () => {
    const app = document.getElementById('c-app');
    const open = app.classList.toggle('nav-open');
    $('#c-menu-toggle').setAttribute('aria-expanded', String(open));
  });
  $('#c-scrim').addEventListener('click', () => {
    document.getElementById('c-app').classList.remove('nav-open');
    $('#c-menu-toggle').setAttribute('aria-expanded', 'false');
  });

  $('#c-project-switch').addEventListener('click', switcherMenu);

  $('#c-sidebar-signout').addEventListener('click', async () => {
    try {
      await fetch('/api/manage/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (_) { /* session ends locally regardless */ }
    window.location.replace('/login');
  });

  onLanguageChange(() => { applyStaticI18n(document); renderNav(); route(); });

  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      document.getElementById('c-app').classList.remove('nav-open');
    }
  });
}

async function boot() {
  initI18n();
  setupChrome();

  try {
    await ensureSession();
    await loadConfig();
    await loadProjects();
  } catch (error) {
    if (error?.status === 401) return;
    // Continue: project views show their own errors.
    toast(ct('Some console data could not be loaded'), { kind: 'error' });
  }

  renderNav();
  route();
}

boot();
