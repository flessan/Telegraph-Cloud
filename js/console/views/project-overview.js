import { h, formatBytes, formatDate } from '../util.js';
import { api } from '../api.js';
import { pageHead } from '../ui.js';
import { projectById } from '../store.js';
import { navigate, projectPath } from '../router.js';
import { ct } from '../i18n.js';
import { statCard, badge, copyButton } from './common.js';

function icon(path) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`; }

function resourceTile({ title, body, to }) {
  return h('button', { type: 'button', class: 'c-card', style: { textAlign: 'left', cursor: 'pointer' }, onClick: () => navigate(to) }, [
    h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px' } }, [
      h('h3', { class: 'c-card-title' }, title),
      h('span', { html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>', style: { color: 'var(--c-text-3)' } }),
    ]),
    h('p', { class: 'c-card-sub', style: { margin: 0 } }, body),
  ]);
}

export async function renderProjectOverview(container, projectId) {
  const project = projectById(projectId);
  if (!project) { navigate('#/overview'); return; }

  container.append(pageHead(project.name, `${project.slug} · ${project.project_id}`, [
    badge(project.status, project.status === 'active' ? 'active' : 'disabled'),
    copyButton(project.project_id, { label: ct('Copy project ID'), message: ct('Project ID copied') }),
    h('a', { class: 'c-btn outlined', href: projectPath(projectId, 'connect') }, ct('Connect')),
    h('a', { class: 'c-btn primary', href: projectPath(projectId, 'files', 'drive') }, ct('Open Files')),
  ]));

  const meta = h('p', { class: 'c-page-sub', style: { margin: '-10px 0 18px' } },
    ct('Created {created} · Last updated {updated} · Status: {status}', {
      created: formatDate(project.created_at),
      updated: formatDate(project.updated_at),
      status: project.status,
    }));
  container.append(meta);

  const statsGrid = h('div', { class: 'c-grid cols-4', id: 'c-overview-stats' });
  [
    { key: 'storage', icon: icon('<path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h3.1l1.8 1.8h7.7A2.2 2.2 0 0 1 20.5 10v7.3a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/>'), label: ct('Loading storage…'), value: '…' },
    { key: 'db', icon: icon('<ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6M4.5 11.5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6"/>'), label: ct('Loading database…'), value: '…' },
    { key: 'keys', icon: icon('<circle cx="8" cy="15" r="3.5"/><path d="M10.6 12.4 20 3M17 6l2.5 2.5M14.5 8.5 17 11"/>'), label: ct('Loading API keys…'), value: '…' },
    { key: 's3', icon: icon('<path d="M12 3a9 9 0 1 0 9 9"/><path d="M21 3v6h-6"/><path d="M12 7v5l3 2"/>'), label: ct('Loading S3 credentials…'), value: '…' },
  ].forEach((card) => statsGrid.append(statCard(card)));
  container.append(statsGrid);

  container.append(h('div', { class: 'c-section' }, [
    h('div', { class: 'c-section-head' }, [h('h2', { class: 'c-section-title' }, ct('Resources'))]),
    // Canonical project IA: Data | Files | API | Connect | Settings.
    h('div', { class: 'c-grid cols-3' }, [
      resourceTile({ title: ct('Files'), body: ct('Browse, upload, and organize files and folders with direct links.'), to: projectPath(projectId, 'files', 'drive') }),
      resourceTile({ title: ct('Data'), body: ct('Collections and versioned JSON documents with a document API.'), to: projectPath(projectId, 'data') }),
      resourceTile({ title: ct('API'), body: ct('Bearer keys for the document and object APIs.'), to: projectPath(projectId, 'api', 'keys') }),
      resourceTile({ title: ct('Connect'), body: ct('.env, curl, and JSON setup snippets for your app.'), to: projectPath(projectId, 'connect') }),
      resourceTile({ title: ct('Settings'), body: ct('Project names are display labels; the ID and slug are stable references.'), to: projectPath(projectId, 'settings') }),
    ]),
  ]));

  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const loaders = [
    api.get(`${base}/drive/stats`).then((stats) => ({
      key: 'storage',
      value: ct('{n} objects', { n: stats.objects }) + (stats.truncated ? '+' : ''),
      label: ct('{buckets} buckets · {bytes}', { buckets: stats.buckets, bytes: formatBytes(stats.bytes) }) + (stats.truncated ? ct(' (partial)') : ''),
    })).catch(() => ({ key: 'storage', value: ct('Unavailable'), label: ct('Storage index not reachable') })),
    api.get(`${base}/db/collections`).then((collections) => ({
      key: 'db',
      value: String(collections.data.length),
      label: ct('{n} collections', { n: collections.data.length }),
    })).catch(() => ({ key: 'db', value: ct('Unavailable'), label: ct('Document database not reachable') })),
    api.get(`${base}/keys?limit=100`).then((page) => {
      const active = page.data.filter((k) => k.status === 'active').length;
      return { key: 'keys', value: String(active), label: ct('{n} total API keys', { n: page.data.length }) };
    }).catch(() => ({ key: 'keys', value: ct('Unavailable'), label: '' })),
    api.get(`${base}/s3-credentials?limit=100`).then((page) => {
      const active = page.data.filter((k) => k.status === 'active').length;
      return { key: 's3', value: String(active), label: ct('{n} total credentials', { n: page.data.length }) };
    }).catch(() => ({ key: 's3', value: ct('Unavailable'), label: '' })),
  ];

  for (const result of await Promise.all(loaders)) {
    const cards = statsGrid.children;
    const order = ['storage', 'db', 'keys', 's3'];
    const index = order.indexOf(result.key);
    const card = cards[index];
    if (!card) continue;
    const valueEl = card.querySelector('.c-stat-value');
    const labelEl = card.querySelector('.c-stat-label');
    if (valueEl) valueEl.textContent = result.value;
    if (labelEl) labelEl.textContent = result.label;
  }
}
