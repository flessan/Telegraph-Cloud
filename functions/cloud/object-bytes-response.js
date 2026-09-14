// Shared construction of the raw-object byte response used by the
// authenticated dashboard object route and the public direct-link route.
// Uploaded bytes are never executed at this origin: scripts stay disabled
// even for inlined text/SVG (the console re-renders previews itself).

function safeFilename(key) {
  const base = String(key).split('/').pop() || 'download';
  // Control chars, quotes, and path separators never reach a header.
  const ascii = base.replace(/[\u0000-\u001f\u007f"\\/]/g, '_').replace(/[^\x20-\x7e]/g, '_');
  return ascii || 'download';
}

function rfc5987Filename(key) {
  const base = String(key).split('/').pop() || 'download';
  return encodeURIComponent(base).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

// publicView:
//   false - dashboard/developer reads (private, no-store, version header).
//   true  - anonymous direct-link reads (short shared cache, no internal
//           revision id leaked in a header).
export function objectBytesResponse(result, { key, download = false, publicView = false } = {}) {
  const object = result.object;
  const disposition = `${download ? 'attachment' : 'inline'}; filename="${safeFilename(key)}"; filename*=UTF-8''${rfc5987Filename(key)}`;
  const headers = new Headers({
    'Cache-Control': publicView ? 'public, max-age=300' : 'private, no-store',
    'Content-Type': object.content_type,
    'Content-Disposition': disposition,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'unsafe-inline'; sandbox",
    'Referrer-Policy': 'no-referrer',
    Vary: publicView ? 'Range' : 'Authorization, Range',
    'Accept-Ranges': 'bytes',
    ETag: `"${object.etag}"`,
    'Last-Modified': new Date(object.updated_at).toUTCString(),
  });
  if (!publicView) headers.set('X-Telegraph-Cloud-Object-Version', String(object.version));
  if (result.status === 304) return new Response(null, { status: 304, headers });
  if (result.range) {
    headers.set('Content-Range', `bytes ${result.range.start}-${result.range.end}/${result.range.size}`);
    headers.set('Content-Length', String(result.range.length));
  } else {
    headers.set('Content-Length', String(object.size));
  }
  return new Response(result.status === 206 ? result.body : (result.body ?? null), {
    status: result.status,
    headers,
  });
}
