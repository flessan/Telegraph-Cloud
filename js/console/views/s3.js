import { h } from '../util.js';
import { api } from '../api.js';
import { pageHead } from '../ui.js';
import { navigate, projectPath } from '../router.js';
import { ct } from '../i18n.js';
import { copyButton } from './common.js';

function check(on) {
  return on
    ? '<svg class="c-cap-on" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 6"/></svg>'
    : '<svg class="c-cap-off" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/></svg>';
}

export async function renderS3(container, projectId) {
  const origin = window.location.origin;
  const endpoint = `${origin}/s3`;
  const region = 'us-east-1';
  const service = 's3';

  container.append(pageHead(ct('S3-compatible storage'), ct('The same object engine behind Drive, reachable with AWS Signature Version 4. This is a deliberately scoped endpoint, not a full AWS clone.'), [
    h('button', { class: 'c-btn outlined', onClick: () => navigate(projectPath(projectId, 's3-credentials')) }, ct('Manage S3 credentials')),
  ]));

  let credentials = [];
  try {
    const page = await api.get(`/api/projects/${encodeURIComponent(projectId)}/s3-credentials?limit=100`);
    credentials = page.data || [];
  } catch (_) { /* endpoint rows still render truthfully */ }

  const active = credentials.filter((c) => c.status === 'active').length;

  container.append(
    h('div', { class: 'c-card', style: { marginBottom: '16px' } }, [
      h('h2', { class: 'c-card-title' }, ct('Connection')),
      h('div', {}, [
        endpointRow(ct('Endpoint'), endpoint, true),
        endpointRow(ct('Region'), region),
        endpointRow(ct('Service'), service),
        endpointRow(ct('Path style'), `${endpoint}/<bucket>/<key>`),
        endpointRow(ct('Active credentials'), String(active)),
      ]),
    ]),
  );

  container.append(h('div', { class: 'c-grid cols-2' }, [
    h('div', { class: 'c-card' }, [
      h('h2', { class: 'c-card-title' }, ct('Supported')),
      h('p', { class: 'c-card-sub' }, ct('Implemented and verified by the SigV4 protocol layer.')),
      h('ul', { class: 'c-cap-list' }, [
        cap(true, 'GetObject'),
        cap(true, 'HeadObject'),
        cap(true, 'PutObject'),
        cap(true, 'DeleteObject'),
        cap(true, 'ListObjectsV2'),
        cap(true, ct('AWS Signature V4')),
        cap(true, ct('Conditional headers (If-Match / ETag)')),
        cap(true, ct('Prefix & delimiter listing')),
      ]),
    ]),
    h('div', { class: 'c-card' }, [
      h('h2', { class: 'c-card-title' }, ct('Not implemented')),
      h('p', { class: 'c-card-sub' }, ct('Deferred. The API returns explicit errors instead of pretending to support them.')),
      h('ul', { class: 'c-cap-list' }, [
        cap(false, ct('Multipart uploads')),
        cap(false, ct('Presigned URLs')),
        cap(false, ct('Create / delete buckets')),
        cap(false, ct('Bucket & object ACLs')),
        cap(false, ct('Bucket policies')),
        cap(false, ct('Versioning & lifecycle APIs')),
        cap(false, ct('Cross-region replication')),
        cap(false, ct('Anonymous public reads')),
      ]),
    ]),
  ]));

  const clientConfig = `# AWS CLI-compatible
aws --endpoint-url ${endpoint} s3 ls s3://<bucket>/ --region ${region}

# Direct ListObjectsV2
curl "${endpoint}/<bucket>?list-type=2"
# Authorization: AWS4-HMAC-SHA256 Credential=<access-key>/<date>/${region}/${service}/aws4_request …

# Buckets appear after the first PutObject, exactly like Drive.
# Uploads with the CLI use multipart for large files, which is not
# implemented yet — use PutObject-compatible single-request clients.`;

  container.append(h('div', { class: 'c-section' }, [
    h('div', { class: 'c-section-head' }, [
      h('h2', { class: 'c-section-title' }, ct('Client configuration')),
    ]),
    h('div', { class: 'c-code-block' }, [
      copyButton(clientConfig),
      h('pre', {}, [h('code', {}, clientConfig)]),
    ]),
    h('div', { class: 'c-alert warn', style: { marginTop: '12px' } }, [
      h('p', {}, [
        h('strong', {}, ct('Object identity: ')),
        ct('an object uploaded in Drive, through /api/storage, or through /s3 is the same manifest and the same bytes. Drive UI never stores a separate copy of S3 objects.'),
      ]),
    ]),
  ]));

  function endpointRow(label, value, copyable = false) {
    return h('div', { class: 'c-endpoint-row' }, [
      h('span', { class: 'c-endpoint-label' }, label),
      h('span', { class: 'c-endpoint-value c-copy-cell' }, [
        h('code', {}, value),
        copyable ? copyButton(value, { label: '', message: ct('{label} copied', { label }) }) : null,
      ]),
    ]);
  }
}

function cap(on, label) {
  return h('li', {}, [
    h('span', { 'aria-hidden': 'true', html: check(on) }),
    h('span', {}, label),
    on ? h('span', { class: 'c-badge active', style: { marginLeft: 'auto' } }, ct('Available'))
      : h('span', { class: 'c-badge', style: { marginLeft: 'auto' } }, ct('Deferred')),
  ]);
}
