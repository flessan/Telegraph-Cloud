import { h } from '../util.js';
import { api } from '../api.js';
import { pageHead, emptyState, loadingView, errorState } from '../ui.js';
import { loadProjects } from '../store.js';
import { navigate } from '../router.js';
import { ct } from '../i18n.js';
import { projectCard } from './projects.js';

export async function renderOverview(container) {
  container.append(pageHead(ct('Telegraph Cloud'), ct('Your free cloud for files, data, and APIs.'), [
    h('a', { class: 'c-btn outlined', href: '#/docs' }, ct('Documentation')),
    h('button', {
      class: 'c-btn primary',
      onClick: () => navigate('#/projects?new=1'),
    }, [
      h('span', { html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>' }),
      ct('New project'),
    ]),
  ]));

  const body = h('div', {});
  container.append(body);
  body.append(loadingView(ct('Loading projects…')));
  try {
    const projects = await loadProjects();
    body.innerHTML = '';
    if (!projects.length) {
      body.append(emptyState({
        icon: 'projects',
        title: ct('No projects yet'),
        body: ct('A project names an isolated Drive, document database, object storage bucket namespace, and developer credentials.'),
        actions: [h('button', {
          class: 'c-btn primary',
          onClick: () => navigate('#/projects?new=1'),
        }, ct('Create your first project'))],
      }));
      return;
    }

    body.append(h('div', { class: 'c-section-head', style: { marginBottom: '12px' } }, [
      h('h2', { class: 'c-section-title' }, ct('Projects ({n})', { n: projects.length })),
      h('a', { class: 'c-section-link', href: '#/projects' }, ct('View all')),
    ]));
    const grid = h('div', { class: 'c-grid cols-3' });
    body.append(grid);

    for (const project of projects.slice(0, 6)) {
      const card = projectCard(project);
      grid.append(card);
      // Lazy, bounded real stats; failures show an honest unavailable state.
      const statSlot = card.querySelector('[data-stats-slot]');
      api.get(`/api/projects/${encodeURIComponent(project.project_id)}/drive/stats`).then((stats) => {
        if (!statSlot) return;
        statSlot.textContent = ct('{n} objects', { n: stats.objects || 0 }) + (stats.truncated ? '+' : '');
      }).catch(() => {
        if (statSlot) statSlot.textContent = ct('Storage unavailable');
      });
    }

    const services = h('div', { class: 'c-section' }, [
      h('div', { class: 'c-section-head' }, [h('h2', { class: 'c-section-title' }, ct('Platform'))]),
      h('div', { class: 'c-grid cols-3' }, [
        platformCard({
          title: ct('Telegraph Drive'),
          body: ct('Upload, organize, and preview any file. The same objects are available through the object API and S3 endpoint.'),
          icon: folderIcon(),
        }),
        platformCard({
          title: ct('Telegraph Database'),
          body: ct('A document database backed by the Telegram/KV journal. Collections, versioned records, and a document API — not PostgreSQL.'),
          icon: dbIcon(),
        }),
        platformCard({
          title: ct('Developer access'),
          body: ct('Bearer API keys, SigV4 S3 credentials, direct links, and a generated .env connection guide per project.'),
          icon: keyIcon(),
        }),
      ]),
    ]);
    body.append(services);
  } catch (error) {
    body.innerHTML = '';
    body.append(errorState(ct('Projects could not be loaded'), error?.message || error?.code || ct('Network or configuration error.'), {
      retry: () => renderOverview(container),
    }));
  }
}

function platformCard({ title, body, icon }) {
  return h('div', { class: 'c-card' }, [
    h('div', { class: 'c-stat-icon', 'aria-hidden': 'true', html: icon }),
    h('h3', { class: 'c-card-title', style: { marginBottom: '4px' } }, title),
    h('p', { class: 'c-card-sub', style: { margin: 0 } }, body),
  ]);
}

function folderIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h3.1l1.8 1.8h7.7A2.2 2.2 0 0 1 20.5 10v7.3a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/></svg>';
}
function dbIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6M4.5 11.5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6"/></svg>';
}
function keyIcon() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="3.5"/><path d="M10.6 12.4 20 3M17 6l2.5 2.5M14.5 8.5 17 11"/></svg>';
}
