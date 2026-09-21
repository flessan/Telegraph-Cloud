// Shared by the workspace model/persistence modules and the UI layer.

export const PREFS_KEY = 'ti.prefs';

export const DB_NAME = 'ti-workspace';

export const DB_STORE = 'items';

export const DB_ALBUMS = 'albums';

export const DB_VERSION = 2;

// Push spacing: one file at a time, with a short jittered gap between files so
// a large batch does not turn into a burst. The two intervals are advanced
// preferences (persisted with the other workspace prefs) rather than constants,
// so a slow or strict host can be given more room without touching the code.
export const PUSH_DELAY_DEFAULT_MS = 1200;

export const PUSH_RETRY_BASE_DEFAULT_MS = 2000;

export const PUSH_JITTER = 0.25;

export const PUSH_MAX_RETRIES = 3;

export const RECENT_MS = 48 * 60 * 60 * 1000;

export const REMOTE_PAGE_SIZE = 100;

// Text/code previews are read-only and never run as markup (content is written
// through textContent), so they are safe. A size cap keeps a large log or data
// file from being slurped into the DOM; bigger text falls back to the generic
// surface plus Download.
export const TEXT_PREVIEW_MAX = 512 * 1024;
