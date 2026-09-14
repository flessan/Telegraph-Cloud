import { h, clear } from './util.js';
import { ct } from './i18n.js';

let toastEl;
let toastTimer;

export function toast(message, { kind = '', action = null, onAction = null } = {}) {
  toastEl = toastEl || document.getElementById('c-toast');
  if (!toastEl) return;
  clear(toastEl);
  toastEl.className = `c-toast${kind ? ` ${kind}` : ''}`;
  toastEl.append(String(message));
  if (action) {
    const btn = h('button', { class: 'c-btn sm text', style: { color: 'inherit', marginLeft: '8px', textDecoration: 'underline' }, onClick: onAction }, action);
    toastEl.append(btn);
  }
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
  announce(message);
}

export function announce(message) {
  const live = document.getElementById('c-live');
  if (live) live.textContent = message;
}

/* ------------------------------ State views ----------------------------- */
export function loadingView(label = ct('Loading…')) {
  return h('div', { class: 'c-loading', role: 'status' }, [
    h('span', { class: 'c-spinner', 'aria-hidden': 'true' }),
    h('span', {}, label),
  ]);
}

export function emptyState({ icon = 'unknown', title, body, actions = [] }) {
  return h('div', { class: 'c-empty' }, [
    h('div', { class: 'c-empty-icon', 'aria-hidden': 'true', html: iconSvg(icon) }),
    h('h3', {}, title),
    body ? h('p', {}, body) : null,
    actions.length ? h('div', { class: 'c-actions' }, actions) : null,
  ]);
}

export function errorState(title, body, { retry = null, retryLabel = ct('Retry') } = {}) {
  return h('div', { class: 'c-error-state', role: 'alert' }, [
    h('h3', { style: { margin: '0 0 6px' } }, title),
    h('p', { style: { margin: '0', color: 'var(--c-text-3)' } }, body),
    retry ? h('div', { class: 'c-actions' }, [h('button', { class: 'c-btn outlined', onClick: retry }, retryLabel)]) : null,
  ]);
}

function iconSvg(name) {
  const icons = {
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.2A2.2 2.2 0 0 1 5.7 6h3.1l1.8 1.8h7.7A2.2 2.2 0 0 1 20.5 10v7.3a2.2 2.2 0 0 1-2.2 2.2H5.7a2.2 2.2 0 0 1-2.2-2.2z"/></svg>',
    db: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5.5" rx="7.5" ry="2.5"/><path d="M4.5 5.5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6M4.5 11.5v6c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-6"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="3.5"/><path d="M10.6 12.4 20 3M17 6l2.5 2.5M14.5 8.5 17 11"/></svg>',
    projects: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
    docs: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-3"/></svg>',
    unknown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  };
  return icons[name] || icons.unknown;
}

/* ------------------------------- Menus ----------------------------------- */
let menuStack = [];

export function closeMenus() {
  for (const menu of menuStack) menu.remove();
  menuStack = [];
  document.getElementById('c-overlay')?.toggleAttribute('hidden', true);
}

export function contextMenu(anchor, items, { position = null } = {}) {
  closeMenus();
  const fresh = h('div', { class: 'c-menu', role: 'menu' });
  populateMenu(fresh, items);
  document.body.append(fresh);
  positionMenu(fresh, position || { x: anchor?.clientX ?? 0, y: anchor?.clientY ?? 0 });
  trackMenu(fresh);
  return fresh;
}

export function popupMenu(anchorEl, items) {
  closeMenus();
  const fresh = h('div', { class: 'c-menu', role: 'menu' });
  populateMenu(fresh, items);
  document.body.append(fresh);
  const rect = anchorEl.getBoundingClientRect();
  const width = fresh.offsetWidth || 200;
  const height = fresh.offsetHeight || 120;
  positionMenu(fresh, {
    x: Math.min(rect.left, window.innerWidth - width - 12),
    y: Math.min(rect.bottom + 6, window.innerHeight - height - 8),
  });
  trackMenu(fresh);
  return fresh;
}

function populateMenu(menu, items) {
  const buttons = [];
  for (const item of items) {
    if (item === 'sep') {
      menu.append(h('div', { class: 'c-menu-sep' }));
    } else if (item.label) {
      menu.append(h('div', { class: 'c-menu-label' }, item.label));
    } else {
      const btn = h('button', {
        type: 'button',
        role: 'menuitem',
        class: `c-menu-item${item.danger ? ' danger' : ''}`,
        ...(item.disabled ? { disabled: true } : {}),
        onClick: () => { closeMenus(); item.onClick?.(); },
      }, [
        item.icon ? h('span', { 'aria-hidden': 'true', html: item.icon }) : h('span'),
        h('span', {}, item.title),
      ]);
      menu.append(btn);
      buttons.push(btn);
    }
  }
  menu._buttons = buttons;
  if (buttons[0]) buttons[0].classList.add('is-keyboard');
}

function positionMenu(menu, { x, y }) {
  menu.hidden = false;
  const width = menu.offsetWidth || 200;
  const height = menu.offsetHeight || 120;
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(y, window.innerHeight - height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function trackMenu(menu) {
  document.getElementById('c-overlay').hidden = false;
  menuStack.push(menu);
  const items = menu._buttons || [];
  let index = items.findIndex((b) => b.classList.contains('is-keyboard'));
  if (index < 0) index = 0;
  const move = (next) => {
    items[index]?.classList.remove('is-keyboard');
    index = (next + items.length) % items.length;
    items[index]?.classList.add('is-keyboard');
    items[index]?.focus();
  };
  setTimeout(() => items[index]?.focus(), 0);
  const onKey = (event) => {
    if (event.key === 'Escape') { closeMenus(); event.stopPropagation(); }
    else if (event.key === 'ArrowDown') { move(index + 1); event.preventDefault(); }
    else if (event.key === 'ArrowUp') { move(index - 1); event.preventDefault(); }
    else if (event.key === 'Home') { move(0); event.preventDefault(); }
    else if (event.key === 'End') { move(items.length - 1); event.preventDefault(); }
  };
  document.addEventListener('keydown', onKey, { once: false });
  const cleanupObserved = setInterval(() => {
    if (!menu.isConnected) {
      document.removeEventListener('keydown', onKey);
      clearInterval(cleanupObserved);
    }
  }, 200);
}

document.addEventListener('click', (event) => {
  if (!menuStack.length) return;
  if (event.target.closest('.c-menu')) return;
  closeMenus();
});

/* ------------------------------- Dialogs --------------------------------- */
let lastFocused = null;

export function openDialog({ title, subtitle = '', body, actions = [], size = '', onClose = null }) {
  closeMenus();
  lastFocused = document.activeElement;
  const overlay = document.getElementById('c-overlay');
  const dialog = h('div', {
    class: `c-dialog${size ? ` ${size}` : ''}`,
    role: 'dialog',
    'aria-modal': 'true',
    'aria-labelledby': 'c-dialog-title',
  });
  const close = () => {
    dialog.remove();
    overlay.hidden = true;
    document.removeEventListener('keydown', keyHandler);
    lastFocused?.focus?.();
    onClose?.();
  };
  const keyHandler = (event) => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); }
  };
  const head = h('div', { class: 'c-dialog-head' }, [
    h('div', {}, [
      h('h2', { class: 'c-dialog-title', id: 'c-dialog-title' }, title),
      subtitle ? h('p', { class: 'c-dialog-sub' }, subtitle) : null,
    ]),
    h('button', { type: 'button', class: 'c-icon-btn', 'aria-label': ct('Close'), onClick: close }, [
      h('span', { html: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' }),
    ]),
  ]);
  const content = h('div', { class: 'c-dialog-content' }, Array.isArray(body) ? body : [body]);
  const footer = actions.length
    ? h('div', { class: 'c-dialog-actions' }, actions.map((action) => h('button', {
      type: 'button',
      class: `c-btn ${action.variant || ''}`,
      onClick: () => {
        if (action.onClick?.(close) !== false) { if (!action.keepOpen) close(); }
      },
    }, action.label)))
    : null;
  dialog.append(head, content, footer);
  overlay.hidden = false;
  overlay.onclick = close;
  document.body.append(dialog);
  document.addEventListener('keydown', keyHandler);
  setTimeout(() => dialog.querySelector('input, textarea, select, button.c-btn.primary')?.focus(), 30);
  return { element: dialog, close };
}

export function confirmDialog({ title, body, confirmLabel = ct('Confirm'), danger = false }) {
  return new Promise((resolve) => {
    openDialog({
      title,
      body: [h('p', { style: { margin: 0, color: 'var(--c-text-2)' } }, body)],
      actions: [
        { label: ct('Cancel'), variant: 'outlined', onClick: () => resolve(false) },
        { label: confirmLabel, variant: danger ? 'danger' : 'primary', onClick: () => resolve(true) },
      ],
      onClose: () => resolve(false),
    });
  });
}

/* ------------------------------- Fields ---------------------------------- */
export function field(labelText, control, { hint = '', errorId = null } = {}) {
  return h('label', { class: 'c-field' }, [
    h('span', { class: 'c-field-label' }, labelText),
    control,
    hint ? h('span', { class: 'c-field-hint' }, hint) : null,
    errorId ? h('span', { class: 'c-field-error', id: errorId, role: 'alert' }) : null,
  ]);
}

export function pageHead(title, subtitle, actions = []) {
  return h('div', { class: 'c-page-head' }, [
    h('div', {}, [
      h('h1', { class: 'c-page-title' }, title),
      subtitle ? h('p', { class: 'c-page-sub' }, subtitle) : null,
    ]),
    actions.length ? h('div', { class: 'c-page-actions' }, actions) : null,
  ]);
}

export function runAsync(container, loadFn) {
  clear(container);
  container.append(loadingView());
  return loadFn()
    .then((view) => {
      clear(container);
      if (view) container.append(view);
      return view;
    })
    .catch((error) => {
      clear(container);
      container.append(errorState(ct('Something went wrong'), error?.message || error?.code || ct('The request could not be completed.'), {
        retry: () => runAsync(container, loadFn),
      }));
      throw error;
    });
}
