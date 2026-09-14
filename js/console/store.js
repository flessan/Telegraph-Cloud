import { api, AuthError } from './api.js';

const PREFS_KEY = 'tc.prefs';
const listeners = new Set();

export const store = {
  ready: false,
  session: null,
  config: null,
  projects: [],
  projectsLoaded: false,
  currentProjectId: null,
};

export function onChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  listeners.forEach((fn) => { try { fn(); } catch (_) { /* listener isolation */ } });
}

export function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; } catch (_) { return {}; }
}

export function savePrefs(patch) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch (_) { /* private mode */ }
}

export async function ensureSession() {
  try {
    store.session = await api.get('/api/manage/session');
  } catch (error) {
    if (error instanceof AuthError) {
      const next = encodeURIComponent('/console' + window.location.hash);
      window.location.replace(`/login?next=${next}`);
      throw error;
    }
    throw error;
  }
  return store.session;
}

export async function loadConfig() {
  try {
    store.config = await api.get('/api/config');
  } catch (_) {
    store.config = {};
  }
  return store.config;
}

export async function loadProjects({ force = false } = {}) {
  if (store.projectsLoaded && !force) return store.projects;
  const all = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ limit: '100' });
    if (cursor) qs.set('cursor', cursor);
    const page = await api.get(`/api/projects?${qs}`);
    all.push(...(page.data || []));
    cursor = page.next_cursor;
  } while (cursor && all.length < 500);
  store.projects = all;
  store.projectsLoaded = true;
  emit();
  return store.projects;
}

export function currentProject() {
  return store.projects.find((p) => p.project_id === store.currentProjectId) || null;
}

export function setCurrentProject(id) {
  store.currentProjectId = id;
  emit();
}

export async function createProject(input) {
  const project = await api.post('/api/projects', input);
  store.projects = [...store.projects, project].sort((a, b) => a.name.localeCompare(b.name));
  store.projectsLoaded = true;
  emit();
  return project;
}

export async function updateProject(id, patch) {
  const updated = await api.patch(`/api/projects/${encodeURIComponent(id)}`, patch);
  store.projects = store.projects.map((p) => (p.project_id === id ? updated : p));
  emit();
  return updated;
}

export async function deleteProject(id) {
  await api.del(`/api/projects/${encodeURIComponent(id)}`);
  store.projects = store.projects.filter((p) => p.project_id !== id);
  if (store.currentProjectId === id) store.currentProjectId = null;
  emit();
}

export function projectById(id) {
  return store.projects.find((p) => p.project_id === id) || null;
}
