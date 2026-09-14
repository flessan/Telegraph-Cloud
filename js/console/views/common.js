import { h, copyText, esc, isNode } from '../util.js';
import { toast, openDialog, field } from '../ui.js';
import { ct } from '../i18n.js';

export function statCard({ icon, value, label, note = null }) {
  return h('div', { class: 'c-card c-stat' }, [
    h('div', { class: 'c-stat-icon', 'aria-hidden': 'true', html: icon }),
    h('div', { class: 'c-stat-value' }, String(value)),
    h('div', { class: 'c-stat-label' }, label),
    note ? h('div', { class: 'c-stat-note' }, note) : null,
  ]);
}

export function copyButton(text, { label, small = true, message } = {}) {
  const copyLabel = label === undefined ? ct('Copy') : label;
  const copiedMessage = message === undefined ? ct('Copied') : message;
  return h('button', {
    type: 'button',
    class: `c-btn ${small ? 'sm' : ''} outlined`,
    onClick: async (event) => {
      event.stopPropagation();
      const ok = await copyText(text);
      if (ok) toast(copiedMessage, { kind: 'success' });
      else toast(ct('Copy failed — select and copy manually'), { kind: 'error' });
    },
  }, [
    h('span', { html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' }),
    copyLabel,
  ]);
}

export function codeBlock(code, { language = null } = {}) {
  return h('div', { class: 'c-code-block' }, [
    copyButton(code),
    h('pre', {}, [h('code', { class: language ? `language-${language}` : '' }, esc(code))]),
  ]);
}

export function badge(text, variant = '') {
  return h('span', { class: `c-badge ${variant}` }, text);
}

export function scopeCheckboxes(scopes, descriptions, selected) {
  const group = h('div', { class: 'c-check-group' });
  for (const scope of scopes) {
    const id = `scope-${Math.random().toString(36).slice(2, 9)}-${scope.replace(/[^a-z]/gi, '')}`;
    const checkbox = h('input', { type: 'checkbox', id, value: scope, ...(selected.includes(scope) ? { checked: true } : {}) });
    group.append(
      h('label', { class: 'c-check', for: id }, [checkbox, h('span', { class: 'c-check-label' }, [h('code', {}, scope)])]),
      descriptions[scope] ? h('div', { class: 'c-check-sub' }, descriptions[scope]) : null,
    );
  }
  return {
    group,
    value() {
      return Array.from(group.querySelectorAll('input:checked')).map((input) => input.value);
    },
  };
}

// One-time secret dialog used for API keys and S3 credentials. The secret is
// only kept in memory for this dialog; it is never written to localStorage or
// the URL.
export function oneTimeSecretDialog({ title, subtitle, secret, fields = [], warning }) {
  const secretBox = h('div', { class: 'c-secret-box' }, [
    warning ? h('div', { class: 'c-alert warn', style: { marginBottom: '10px' } }, [h('p', {}, warning)]) : null,
    ...fields.map(({ label, value, mono = true }) => h('label', { class: 'c-field' }, [
      h('span', { class: 'c-field-label' }, label),
      h('div', { class: 'c-secret-value' }, [
        h('code', {}, value),
        copyButton(value, { label: '' }),
      ]),
    ])),
    h('label', { class: 'c-field' }, [
      h('span', { class: 'c-field-label' }, ct('Secret — shown once')),
      h('div', { class: 'c-secret-value' }, [
        h('code', { id: 'c-once-secret' }, secret),
        copyButton(secret, { label: '' }),
      ]),
      h('span', { class: 'c-field-hint' }, ct('Store it in a password manager or your deployment secrets. It cannot be shown again.')),
    ]),
  ]);

  return new Promise((resolve) => {
    let acknowledged = false;
    openDialog({
      title,
      subtitle,
      body: [secretBox],
      actions: [
        {
          label: ct('I saved the secret'),
          variant: 'primary',
          onClick: () => { acknowledged = true; resolve(true); },
        },
      ],
      onClose: () => {
        if (!acknowledged) resolve(false);
      },
    });
  });
}

export function createLabeledDialog({ title, subtitle = '', label, placeholder = '', initialValue = '', hint = '', confirmLabel: confirmLabelRaw, validate = null }) {
  const confirmLabel = confirmLabelRaw === undefined ? ct('Create') : confirmLabelRaw;
  return new Promise((resolve) => {
    const input = h('input', { class: 'c-input', type: 'text', value: initialValue, placeholder, autocomplete: 'off', maxlength: '64' });
    const errorEl = h('span', { class: 'c-field-error', role: 'alert' });
    let dialogApi;
    const submit = (close) => {
      const value = input.value.trim();
      if (validate) {
        const problem = validate(value);
        if (problem) { errorEl.textContent = problem; input.classList.add('invalid'); return false; }
      }
      resolve(value);
      close();
    };
    dialogApi = openDialog({
      title,
      subtitle,
      body: [
        h('label', { class: 'c-field' }, [
          h('span', { class: 'c-field-label' }, label),
          input,
          hint ? h('span', { class: 'c-field-hint' }, hint) : null,
          errorEl,
        ]),
      ],
      actions: [
        { label: ct('Cancel'), variant: 'outlined', onClick: () => resolve(null) },
        { label: confirmLabel, variant: 'primary', onClick: submit },
      ],
      onClose: () => resolve(null),
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); const closeBtn = dialogApi.element.querySelector('.c-dialog-actions .c-btn.primary'); closeBtn?.click(); }
    });
    setTimeout(() => { input.focus(); input.select(); }, 40);
  });
}

export function metaList(rows) {
  return h('dl', { class: 'c-meta-list' }, rows.filter(Boolean).flatMap(([term, value]) => [
    h('dt', {}, term),
    h('dd', {}, isNode(value) ? value : (value ? h('code', {}, String(value)) : '—')),
  ]));
}
