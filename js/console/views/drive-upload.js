import { h, clear, formatBytes, formatDate } from '../util.js';
import { driveObjectsUrl } from '../api.js';
import { human } from './drive-dialogs.js';
import { ct } from '../i18n.js';

export function renderUploadQueue({ getTarget, onUploaded }) {
  const queue = [];
  const panel = h('div', { class: 'c-queue', hidden: true, role: 'region', 'aria-label': ct('Uploads') });
  const listEl = h('div', {});
  const summaryEl = h('span', { class: 'c-queue-state', style: { color: 'var(--c-text-3)' } });

  function render() {
    const active = queue.filter((entry) => ['queued', 'uploading'].includes(entry.status));
    const failed = queue.filter((entry) => entry.status === 'error');
    const done = queue.filter((entry) => entry.status === 'done');
    panel.hidden = queue.length === 0;
    clear(panel);

    panel.append(h('div', { class: 'c-queue-head' }, [
      h('span', { class: 'c-queue-title' }, ct('Uploads')),
      h('span', { class: 'c-queue-state' }, active.length
        ? ct('{active} in progress · {done} done', { active: active.length, done: done.length })
        : failed.length ? ct('{failed} failed · {done} done', { failed: failed.length, done: done.length }) : ct('{n} uploaded', { n: done.length })),
      h('button', {
        type: 'button', class: 'c-icon-btn', 'aria-label': ct('Close uploads'),
        onClick: () => { queue.length = 0; render(); },
        html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
      }),
    ]));
    panel.append(listEl);
    clear(listEl);
    for (const entry of queue.slice(-30)) listEl.append(renderEntry(entry));

    if (queue.some((e) => e.status === 'error') || active.length || done.length) {
      const actions = h('div', { class: 'c-queue-actions' });
      if (failed.length) {
        actions.append(h('button', { type: 'button', class: 'c-btn sm outlined', onClick: () => retryFailed() }, ct('Retry failed')));
      }
      if (active.length) {
        actions.append(h('button', {
          type: 'button', class: 'c-btn sm text',
          onClick: cancelAll,
        }, ct('Cancel pending')));
      }
      if (!active.length && done.length && !failed.length) {
        actions.append(h('button', { type: 'button', class: 'c-btn sm text', onClick: () => { queue.length = 0; render(); } }, ct('Clear')));
      }
      panel.append(actions);
    }
    panel.append(summaryEl);
  }

  function renderEntry(entry) {
    const state = {
      queued: ct('Waiting'),
      uploading: ct('{percent}% · {loaded}/{total}', { percent: Math.round(entry.progress * 100), loaded: formatBytes(entry.loaded || 0), total: formatBytes(entry.size) }),
      done: ct('Uploaded'),
      error: human(entry.errorCode, ct('Upload failed')),
      canceled: ct('Canceled'),
    }[entry.status];

    return h('div', { class: 'c-queue-item' }, [
      h('div', { class: 'c-queue-row' }, [
        h('span', { class: 'c-queue-name', title: entry.key }, entry.name),
        h('span', { class: `c-queue-state${entry.status === 'error' ? ' error' : ''}` }, state),
        entry.status === 'error'
          ? h('button', { type: 'button', class: 'c-icon-button', title: ct('Retry'), 'aria-label': ct('Retry upload'), onClick: () => retry(entry) }, [
            h('span', { html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.2-5.5"/><path d="M20 4v5h-5"/></svg>' }),
          ])
          : null,
        (entry.status === 'queued' || entry.status === 'uploading')
          ? h('button', {
            type: 'button', class: 'c-icon-button', title: ct('Cancel'), 'aria-label': ct('Cancel upload'),
            onClick: () => cancel(entry),
          }, [h('span', { html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>' })])
          : null,
      ]),
      h('div', { class: 'c-progress', 'aria-hidden': 'true' }, [
        h('i', { style: { width: `${entry.status === 'done' ? 100 : Math.round(entry.progress * 100)}%` } }),
      ]),
    ]);
  }

  let processing = false;

  function enqueue(entries) {
    for (const entry of entries) queue.push(entry);
    render();
    if (!processing) process();
  }

  async function process() {
    processing = true;
    let settledCount = 0;
    for (const entry of queue) {
      if (entry.status !== 'queued') continue;
      await runEntry(entry);
      if (entry.status === 'done') settledCount += 1;
      render();
    }
    processing = false;
    render();
    if (settledCount) onUploaded?.();
  }

  function runEntry(entry) {
    if (entry.status === 'canceled') return Promise.resolve();
    entry.status = 'uploading';
    entry.progress = 0;
    entry.loaded = 0;
    render();

    const { projectId, bucket } = entry.target;
    const url = driveObjectsUrl(projectId, { bucket, key: entry.key });
    return new Promise((resolve) => {
      const xhr = new XMLHttpRequest();
      entry.xhr = xhr;
      xhr.open('PUT', url, true);
      xhr.withCredentials = true;
      xhr.setRequestHeader('Content-Type', entry.file.type || 'application/octet-stream');
      xhr.upload.onprogress = (event) => {
        if (entry.status === 'canceled') return;
        entry.loaded = event.loaded;
        entry.progress = event.lengthComputable ? event.loaded / event.total : 0;
        const bar = panel.querySelectorAll('.c-queue-item');
        const idx = queue.indexOf(entry);
        const row = bar[idx];
        if (row) {
          row.querySelector('.c-progress i').style.width = `${Math.round(entry.progress * 100)}%`;
          const label = row.querySelector('.c-queue-state');
          if (label) label.textContent = ct('{percent}% · {loaded}/{total}', { percent: Math.round(entry.progress * 100), loaded: formatBytes(entry.loaded), total: formatBytes(entry.size) });
        }
      };
      xhr.onload = () => {
        if (entry.status === 'canceled') return resolve();
        if (xhr.status >= 200 && xhr.status < 300) {
          entry.status = 'done';
          entry.progress = 1;
          entry.uploadedAt = new Date().toISOString();
        } else {
          entry.status = 'error';
          let code = `http_${xhr.status}`;
          try { code = JSON.parse(xhr.responseText)?.error || code; } catch (_) { /* keep http code */ }
          entry.errorCode = code;
          entry.errorMessage = xhr.statusText;
        }
        resolve();
      };
      xhr.onerror = () => {
        if (entry.status === 'canceled') return resolve();
        entry.status = 'error';
        entry.errorCode = 'network_error';  // code stable; mapped via human()
        resolve();
      };
      xhr.onabort = () => { entry.status = 'canceled'; resolve(); };
      xhr.send(entry.file);
    });
  }

  function retry(entry) {
    if (entry.status !== 'error') return;
    entry.status = 'queued';
    entry.progress = 0;
    render();
    process();
  }
  function retryFailed() {
    for (const entry of queue) if (entry.status === 'error') { entry.status = 'queued'; entry.progress = 0; }
    render();
    process();
  }
  function cancel(entry) {
    entry.status = 'canceled';
    try { entry.xhr?.abort(); } catch (_) { /* noop */ }
    render();
  }
  function cancelAll() {
    for (const entry of queue) {
      if (entry.status === 'queued') entry.status = 'canceled';
      if (entry.status === 'uploading') cancel(entry);
    }
    render();
  }

  render();
  return { panel, enqueue, queue };
}

export function uploadFiles({ projectId, bucket, entries, queue, panel }) {
  // queue/panel are the view-owned queue panel created by renderUploadQueue;
  // drive.js creates the panel first and then hands new entries to it.
  const target = { projectId, bucket };
  panel.enqueue(entries.map(({ file, key }, index) => ({
    id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
    target,
    name: file.name,
    key,
    file,
    size: file.size || 0,
    loaded: 0,
    progress: 0,
    status: 'queued',
  })));
}
