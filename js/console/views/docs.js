import { h } from '../util.js';
import { pageHead } from '../ui.js';
import { ct } from '../i18n.js';
import { codeBlock } from './common.js';

export function renderDocs(container) {
  container.append(pageHead(ct('Documentation'), ct('How Telegraph Cloud’s Drive, document database, object storage, and access model fit together.')));

  const doc = h('div', { class: 'c-doc c-card', style: { padding: '22px 26px' } });
  container.append(doc);

  section(ct('What is Telegraph Cloud?'), [
    p(ct('Telegraph Cloud is a free cloud for files, data, and APIs. Each project contains a Drive (folders and objects), a document database (collections of versioned JSON records), an S3-compatible object endpoint, and developer credentials.')),
    p(ct('The data plane uses the existing Telegram-backed object and journal engines with a Cloudflare KV index. There is no PostgreSQL database anywhere in this product.')),
  ]);

  section(ct('Projects'), [
    p(ct('A project is the authorization and isolation boundary. Drive objects, documents, and credentials are all scoped to a project ID (prj_…). The server derives that scope from your dashboard session or a verified credential — the browser never supplies project IDs for data-plane authorization.')),
  ]);

  section(ct('Drive model'), [
    p(ct('Buckets are top-level containers, exactly like S3 buckets. Folders are key prefixes: a file at covers/front.webp lives in the covers folder. Creating an empty folder persists a small marker; folders containing objects are implied by their keys automatically.')),
    p(ct('Upload, rename, move, star, trash, restore, delete, copy direct links, and preview are wired to the same object engine that serves /api/storage and /s3. Renaming and moving copy bytes once to the new key and remove the old key — Telegram’s immutable history is never rewritten.')),
    p(ct('Trash is a console-level marker. Items in trash are hidden from normal browsing and can be restored; “Delete permanently” tombstones the object in the object index. Physical provider bytes follow the established retention behavior and are not purged from journal history.')),
  ]);

  section(ct('Direct links & access'), [
    p(ct('Every object has one unlisted public direct link that anyone can read without credentials; the inspector’s Direct URL / Markdown / HTML / BBCode / CSS snippets use it. Moving an object to trash immediately revokes its direct link.')),
    codeBlock(`${location.origin}/p/<projectId>/<bucket>/<key>`),
    p(ct('For clients and scripts, the same engine is served by authenticated endpoints: a Bearer API key with storage scopes for the Object API, or SigV4 S3 credentials.')),
    codeBlock(`${location.origin}/api/storage/<bucket>/<key>\n${location.origin}/s3/<bucket>/<key>`),
    p(ct('Presigned URLs, per-file passwords, and bucket policies are not implemented; the S3 section lists them as deferred. Legacy Telegraph-Image public links under /file/* are unaffected and continue to work from the Legacy Media workspace.')),
  ]);

  section(ct('Direct link snippets'), [
    p(ct('The file inspector generates category-aware markup: <img> for images, <audio> for audio, <video> for video, plus Markdown, BBCode, and CSS for images. Non-image files never produce image markup.')),
  ]);

  section(ct('Document database'), [
    p(ct('Telegraph Database stores JSON documents in collections. Every write creates an immutable revision with an incrementing version; PATCH and DELETE require the expected version (If-Match header or _expected_version field).')),
    codeBlock(`# Create
POST /api/db/users       Authorization: Bearer tg_live_…
{"name":"Thio"}

# Update with optimistic version
PATCH /api/db/users/rec_…
{"role":"owner","_expected_version":1}

# List (id-ascending; exact string filters on indexed fields)
GET /api/db/users?role=admin&limit=50`),
    p(ct('This is a document API, not PostgreSQL: there is no SQL, no psql, and no Postgres wire protocol. Do not point Postgres drivers at it.')),
  ]);

  section(ct('S3 endpoint'), [
    p(ct('Endpoint {origin}/s3, region us-east-1, service s3, path-style addressing. Supported: GetObject, HeadObject, PutObject, DeleteObject, ListObjectsV2, and SigV4. Deferred: multipart, presigned URLs, bucket CRUD, ACLs, and policies. The endpoint returns explicit method errors instead of pretending those features exist.', { origin: location.origin })),
  ]);

  section(ct('Credentials & security'), [
    p(ct('API keys (tg_live_…) are Bearer credentials for the document and object APIs with scopes db:read/db:write/storage:read/storage:write. S3 credentials (tgsk_live_… plus a secret) are separate and use SigV4.')),
    p(ct('Plaintext secrets are shown exactly once at creation (and rotation). They are HMAC-verifier based and cannot be retrieved later. The console never writes secrets to localStorage, never puts them in URLs, and never logs them. Star/trash and UI preferences are the only browser-local state.')),
  ]);

  section(ct('MIME-aware previews'), [
    p(ct('Images render directly; video and audio use native players; text and JSON/code render as safe text (never executed); PDFs use a sandboxed frame; archives and unknown binaries show metadata with download. Uploaded content is always served with X-Content-Type-Options: nosniff and a sandbox CSP, and HTML/SVG are never executed as documents from the console.')),
  ]);

  section(ct('Legacy media'), [
    p(ct('The original workspace remains at /admin-legacy (/admin redirects into this console): staged uploads, push queue, albums, whitelist/blacklist, moderation, short URLs, and R2/Telegram legacy serving. It is a compatibility area and keeps all existing workflows and public links.')),
  ]);

  function section(title, children) {
    doc.append(h('h2', { id: slug(title) }, title));
    for (const child of children) doc.append(child);
  }
  function p(text) { return h('p', {}, text); }
  function slug(text) { return text.toLowerCase().replace(/[^a-z0-9]+/g, '-'); }
}
