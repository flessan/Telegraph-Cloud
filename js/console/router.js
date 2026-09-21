// Tiny hash router. Routes are deliberately explicit: project sections are
// the information architecture contract for the console.
//
// Canonical project sections (2026-09 rework):
//   overview | data | files | api | connect | settings
//
// Pre-rework section slugs (drive, database, s3, keys, s3-credentials) remain
// valid deep links: they resolve to the canonical section plus the matching
// sub-tab, so existing bookmarks and generated links keep working.

const PROJECT_SECTIONS = new Set([
  'overview', 'data', 'files', 'api', 'connect', 'settings',
]);

// legacy section slug -> [canonical section, default sub-tab]
const SECTION_ALIASES = {
  drive: ['files', 'drive'],
  database: ['data', 'collections'],
  s3: ['files', 's3'],
  's3-credentials': ['files', 's3'],
  keys: ['api', 'keys'],
};

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
    let section = parts[2] || 'overview';
    let aliasTab = null;
    if (SECTION_ALIASES[section]) {
      [section, aliasTab] = SECTION_ALIASES[section];
    }
    if (!PROJECT_SECTIONS.has(section)) section = 'overview';
    // An explicit ?tab= wins over the alias default; the alias default is
    // normalized into the query so section renderers (which read ?tab=) and
    // the back/forward history behave identically for both forms.
    const explicitTab = query.get('tab');
    if (aliasTab && !explicitTab) query.set('tab', aliasTab);
    const tab = explicitTab || aliasTab || null;
    return { name: 'project', params: { id: decodeURIComponent(parts[1]), section, tab }, query };
  }
  return { name: 'overview', params: {}, query };
}

export function projectPath(id, section = 'overview', tab = null) {
  const base = `#/project/${encodeURIComponent(id)}/${section}`;
  return tab ? `${base}?tab=${encodeURIComponent(tab)}` : base;
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
