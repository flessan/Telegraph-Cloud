import { h, esc, initials, formatDate, copyText } from '../util.js';
import { pageHead, emptyState, loadingView, toast, openDialog, confirmDialog, popupMenu } from '../ui.js';
import { loadProjects, createProject, updateProject, deleteProject } from '../store.js';
import { navigate, projectPath, currentQuery } from '../router.js';
import { ct } from '../i18n.js';
import { badge } from './common.js';

function slugify(name) {
  return String(name).toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function projectCard(project) {
  const card = h('button', {
    type: 'button',
    class: 'c-card c-project-card',
    onClick: () => navigate(projectPath(project.project_id, 'overview')),
  }, [
    h('div', { class: 'c-project-card-head' }, [
      h('span', { class: 'c-proj-avatar', 'aria-hidden': 'true' }, initials(project.name)),
      h('span', { style: { minWidth: '0', flex: '1' } }, [
        h('span', { class: 'c-project-card-name', style: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, project.name),
        h('span', { class: 'c-project-card-id', style: { display: 'block' } }, project.slug),
      ]),
      badge(project.status, project.status === 'active' ? 'active' : 'disabled'),
    ]),
    h('div', { class: 'c-project-card-stats' }, [
      h('span', { 'data-stats-slot': '' }, ct('Loading storage…')),
      h('span', {}, ct('Created {date}', { date: formatDate(project.created_at) })),
    ]),
  ]);
  return card;
}

function createProjectDialog() {
  const nameInput = h('input', { class: 'c-input', type: 'text', placeholder: 'ResonTune', autocomplete: 'off', maxlength: '64' });
  const slugInput = h('input', { class: 'c-input mono', type: 'text', placeholder: 'reson-tune', autocomplete: 'off', maxlength: '48' });
  const errorEl = h('span', { class: 'c-field-error', role: 'alert' });
  let slugTouched = false;
  nameInput.addEventListener('input', () => {
    if (!slugTouched) slugInput.value = slugify(nameInput.value);
  });
  slugInput.addEventListener('input', () => { slugTouched = true; });

  const submit = async (close) => {
    errorEl.textContent = '';
    const name = nameInput.value.trim();
    const slug = slugInput.value.trim();
    if (!name) { errorEl.textContent = ct('Project name is required.'); nameInput.classList.add('invalid'); return false; }
    if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
      errorEl.textContent = ct('Slug must start with a letter and contain only lowercase letters, numbers, and hyphens.');
      slugInput.classList.add('invalid');
      return false;
    }
    try {
      const project = await createProject({ name, slug });
      toast(ct('Project created'), { kind: 'success' });
      close();
      navigate(projectPath(project.project_id, 'overview'));
    } catch (error) {
      errorEl.textContent = humanProjectError(error.code);
      return false;
    }
  };

  openDialog({
    title: ct('Create project'),
    subtitle: ct('Projects isolate Drive, document data, buckets, and credentials.'),
    body: [
      h('label', { class: 'c-field' }, [
        h('span', { class: 'c-field-label' }, ct('Project name')),
        nameInput,
      ]),
      h('label', { class: 'c-field' }, [
        h('span', { class: 'c-field-label' }, ct('Project slug')),
        slugInput,
        h('span', { class: 'c-field-hint' }, ct('Lowercase identifier used in URLs and examples.')),
        errorEl,
      ]),
    ],
    actions: [
      { label: ct('Cancel'), variant: 'outlined' },
      { label: ct('Create project'), variant: 'primary', onClick: submit, keepOpen: true },
    ],
  });
  setTimeout(() => nameInput.focus(), 40);
}

export function humanProjectError(code) {
  const map = {
    project_slug_taken: ct('That slug is already taken.'),
    invalid_project_payload: ct('The project details are invalid.'),
    project_auth_not_configured: ct('Dashboard authentication is not configured on this deployment.'),
    rate_limited: ct('Too many changes — wait a minute and try again.'),
  };
  return map[code] || ct('Request failed ({code}).', { code: code || ct('network error') });
}

export async function renderProjects(container) {
  container.append(pageHead(ct('Projects'), ct('Each project has its own Drive, document database, buckets, and credentials.'), [
    h('button', { class: 'c-btn primary', id: 'c-new-project', onClick: createProjectDialog }, [
      h('span', { html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>' }),
      ct('New project'),
    ]),
  ]));

  const body = h('div');
  container.append(body);
  body.append(loadingView(ct('Loading projects…')));
  try {
    const projects = await loadProjects();
    body.innerHTML = '';
    if (!projects.length) {
      body.append(emptyState({
        icon: 'projects',
        title: ct('No projects yet'),
        body: ct('Create a project to start uploading files, storing documents, and issuing developer credentials.'),
        actions: [h('button', { class: 'c-btn primary', onClick: createProjectDialog }, ct('New project'))],
      }));
    } else {
      const grid = h('div', { class: 'c-grid cols-3' });
      projects.forEach((project) => grid.append(projectRowCard(project)));
      body.append(grid);
    }
    if (currentQuery().get('new') === '1') {
      setTimeout(createProjectDialog, 0);
    }
  } catch (error) {
    body.innerHTML = '';
    body.append(h('div', { class: 'c-error-state', role: 'alert' }, [
      h('h3', {}, ct('Projects could not be loaded')),
      h('p', {}, humanProjectError(error.code)),
    ]));
  }
}

function projectRowCard(project) {
  const card = projectCard(project);
  const menuBtn = h('button', {
    type: 'button',
    class: 'c-icon-button',
    'aria-label': ct('Project actions'),
    onClick: (event) => {
      event.stopPropagation();
      projectMenu(event.currentTarget, project);
    },
  }, [h('span', { html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>' })]);
  card.querySelector('.c-project-card-head').append(menuBtn);
  return card;
}

function projectMenu(anchor, project) {
  popupMenu(anchor, [
    {
      title: ct('Open overview'),
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
      onClick: () => navigate(projectPath(project.project_id, 'overview')),
    },
    {
      title: ct('Drive'),
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h3.1l1.8 1.8h7.7A2.2 2.2 0 0 1 20.5 10v7.3a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/></svg>',
      onClick: () => navigate(projectPath(project.project_id, 'files', 'drive')),
    },
    {
      title: ct('Copy project ID'),
      icon: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
      onClick: async () => {
        if (await copyText(project.project_id)) toast(ct('Project ID copied'), { kind: 'success' });
      },
    },
    'sep',
    {
      title: ct('Rename project'),
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
      onClick: () => renameProjectDialog(project),
    },
    {
      title: project.status === 'active' ? ct('Disable project') : ct('Enable project'),
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>',
      onClick: async () => {
        const next = project.status === 'active' ? 'disabled' : 'active';
        await updateProject(project.project_id, { status: next });
        toast(next === 'active' ? ct('Project enabled') : ct('Project disabled'));
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      },
    },
    {
      title: ct('Delete project'),
      danger: true,
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0v13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V7"/></svg>',
      onClick: () => deleteProjectDialog(project),
    },
  ]);
}

function renameProjectDialog(project) {
  const input = h('input', { class: 'c-input', type: 'text', value: project.name, maxlength: '64' });
  const errorEl = h('span', { class: 'c-field-error', role: 'alert' });
  openDialog({
    title: ct('Rename project'),
    subtitle: ct('Project ID {id} never changes.', { id: project.project_id }),
    body: [h('label', { class: 'c-field' }, [h('span', { class: 'c-field-label' }, ct('Name')), input, errorEl])],
    actions: [
      { label: ct('Cancel'), variant: 'outlined' },
      {
        label: ct('Save'),
        variant: 'primary',
        onClick: async (close) => {
          const name = input.value.trim();
          if (!name) { errorEl.textContent = ct('Name is required.'); return false; }
          try {
            await updateProject(project.project_id, { name });
            toast(ct('Project renamed'), { kind: 'success' });
            close();
            window.dispatchEvent(new HashChangeEvent('hashchange'));
          } catch (error) {
            errorEl.textContent = humanProjectError(error.code);
            return false;
          }
        },
        keepOpen: true,
      },
    ],
  });
  setTimeout(() => { input.focus(); input.select(); }, 40);
}

async function deleteProjectDialog(project) {
  const ok = await confirmDialog({
    title: ct('Delete project?'),
    body: ct('{name} will be marked deleted and removed from listings. Existing object bytes and Telegram journal history are retained by the storage provider and are not purged by this action.', { name: project.name }),
    confirmLabel: ct('Delete project'),
    danger: true,
  });
  if (!ok) return;
  try {
    await deleteProject(project.project_id);
    toast(ct('Project deleted'));
    navigate('#/projects');
  } catch (error) {
    toast(humanProjectError(error.code), { kind: 'error' });
  }
}
