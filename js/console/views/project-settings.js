import { h, formatDate } from '../util.js';
import { pageHead, openDialog, toast, confirmDialog } from '../ui.js';
import { updateProject, deleteProject, projectById } from '../store.js';
import { navigate } from '../router.js';
import { ct } from '../i18n.js';
import { copyButton, badge } from './common.js';

export async function renderProjectSettings(container, projectId) {
  const project = projectById(projectId);
  if (!project) { navigate('#/overview'); return; }

  container.append(pageHead(ct('Project settings'), project.name));

  container.append(h('div', { class: 'c-grid cols-2' }, [
    h('div', { class: 'c-card' }, [
      h('h2', { class: 'c-card-title' }, ct('Identity')),
      h('dl', { class: 'c-meta-list', style: { marginTop: '8px' } }, [
        h('dt', {}, ct('Project ID')),
        h('dd', {}, h('span', { class: 'c-copy-cell' }, [h('code', {}, project.project_id), copyButton(project.project_id, { label: '', message: ct('Project ID copied') })])),
        h('dt', {}, ct('Slug')),
        h('dd', {}, h('code', {}, project.slug)),
        h('dt', {}, ct('Status')),
        h('dd', {}, badge(project.status, project.status === 'active' ? 'active' : 'disabled')),
        h('dt', {}, ct('Created')),
        h('dd', {}, formatDate(project.created_at)),
        h('dt', {}, ct('Updated')),
        h('dd', {}, formatDate(project.updated_at)),
      ]),
    ]),
    h('div', { class: 'c-card' }, [
      h('h2', { class: 'c-card-title' }, ct('Actions')),
      h('p', { class: 'c-card-sub' }, ct('Project names are display labels; the ID and slug are stable references.')),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' } }, [
        h('button', { class: 'c-btn outlined', onClick: rename }, ct('Rename project')),
        h('button', { class: 'c-btn outlined', onClick: toggleStatus },
          project.status === 'active' ? ct('Disable project') : ct('Enable project')),
        h('button', { class: 'c-btn danger', onClick: remove }, ct('Delete project')),
      ]),
    ]),
  ]));

  container.append(h('div', { class: 'c-card', style: { marginTop: '14px' } }, [
    h('h2', { class: 'c-card-title' }, ct('Legacy media workspace')),
    h('p', { class: 'c-card-sub', style: { margin: 0 } }, ct('The original Telegraph-Image workspace — uploads, albums, whitelist/blacklist, and moderation — remains available unchanged, including old /file/* public links and R2 behavior. It is a compatibility area rather than the main console.')),
    h('a', { class: 'c-btn outlined', href: '/admin', style: { marginTop: '12px' } }, ct('Open Legacy Media')),
  ]));

  function rename() {
    const input = h('input', { class: 'c-input', type: 'text', value: project.name, maxlength: '64' });
    const errorEl = h('span', { class: 'c-field-error' });
    openDialog({
      title: ct('Rename project'),
      body: [h('label', { class: 'c-field' }, [h('span', { class: 'c-field-label' }, ct('Name')), input, errorEl])],
      actions: [
        { label: ct('Cancel'), variant: 'outlined' },
        {
          label: ct('Save'), variant: 'primary', keepOpen: true,
          onClick: async (close) => {
            if (!input.value.trim()) { errorEl.textContent = ct('Name is required.'); return false; }
            try {
              await updateProject(projectId, { name: input.value.trim() });
              toast(ct('Project renamed'), { kind: 'success' });
              close();
              window.dispatchEvent(new HashChangeEvent('hashchange'));
            } catch (error) {
              errorEl.textContent = error.message || error.code;
              return false;
            }
          },
        },
      ],
    });
  }

  async function toggleStatus() {
    const next = project.status === 'active' ? 'disabled' : 'active';
    await updateProject(projectId, { status: next });
    toast(next === 'active' ? ct('Project enabled') : ct('Project disabled'));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }

  async function remove() {
    const ok = await confirmDialog({
      title: ct('Delete project?'),
      body: ct('The project is marked deleted and removed from listings. Project data (object manifests, documents, credentials) is retained by the backend; credentials belonging to the project stop authenticating.'),
      confirmLabel: ct('Delete project'),
      danger: true,
    });
    if (!ok) return;
    await deleteProject(projectId);
    toast(ct('Project deleted'));
    navigate('#/overview');
  }
}
