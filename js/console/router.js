// Tiny hash router. Routes are deliberately explicit: project sections are
// the information architecture contract for the console.

const PROJECT_SECTIONS = new Set([
  'overview', 'drive', 'database', 's3', 'keys', 's3-credentials', 'connect', 'settings',
]);

export function parseHash() {
  const raw = window.location.hash.replace(/^#/, '') || '/overview';
  const path = raw.split('?')[0];
  const parts = path.split('/').filter(Boolean);
  const query = new URLSearchParams(raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '');

  if (parts[0] === 'overview' || parts.length === 0) return { name: 'overview', params: {}, query };
  if (parts[0] === 'projects') return { name: 'projects', params: {}, query };
  if (parts[0] === 'docs') return { name: 'docs', params: {}, query };
  if (parts[0] === 'settings') return { name: 'settings', params: {}, query };
  if (parts[0] === 'project' && parts[1]) {
    const section = parts[2] && PROJECT_SECTIONS.has(parts[2]) ? parts[2] : 'overview';
    return { name: 'project', params: { id: decodeURIComponent(parts[1]), section }, query };
  }
  return { name: 'overview', params: {}, query };
}

export function projectPath(id, section = 'overview') {
  return `#/project/${encodeURIComponent(id)}/${section}`;
}

export function navigate(hash) {
  if (window.location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = hash;
  }
}

export function currentQuery() {
  return parseHash().query;
}
