import {
    LABEL,
    getOrCreateMetadata,
    isBlocked,
    isWhitelisted,
    putMetadata,
} from "../utils/metadata.js";
import { isShortUrlsEnabled, looksLikeShortId, resolveShortId } from "../utils/shortlink.js";
import { getServingProvider } from "../storage/index.js";
import { getModerationProvider } from "../moderation/index.js";
import { isSafeLegacyFileId } from "../cloud/validation.js";

export async function onRequest(context) {
    const { request, env, params } = context;
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
        return withCors(new Response(null, { status: 204 }), request, env);
    }

    // Anti-hotlinking: reject disallowed referers before spending upstream bandwidth
    if (!isRefererAllowed(env, request, url)) {
        return withCors(new Response('Hotlinking is not allowed on this deployment.', {
            status: 403,
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        }), request, env);
    }

    // Keep historical opaque ids working, but reject values that could mutate
    // the upstream URL before a Telegram/Telegraph provider sees them.
    if (!isSafeLegacyFileId(params.id)) {
        return withCors(new Response('Not Found', { status: 404 }), request, env);
    }

    const fileId = await resolveRequestedId(env, params.id);
    if (!isSafeLegacyFileId(fileId)) {
        return withCors(new Response('Not Found', { status: 404 }), request, env);
    }
    const response = await getServingProvider(fileId).fetchFile(env, request, url, fileId);

    if (!response.ok) return withCors(response, request, env);

    const isAdmin = request.headers.get('Referer')?.includes(`${url.origin}/admin`);
    if (isAdmin) return withFileHeaders(response, fileId, request, env);

    if (!env.img_url) {
        console.log("KV storage not available, returning image directly");
        return withFileHeaders(response, fileId, request, env);
    }

    const metadata = await getOrCreateMetadata(env, fileId);

    if (isWhitelisted(metadata)) {
        return withFileHeaders(response, fileId, request, env);
    } else if (isBlocked(metadata)) {
        const referer = request.headers.get('Referer');
        const redirectUrl = referer ? "https://static-res.pages.dev/teleimage/img-block-compressed.png" : `${url.origin}/block-img.html`;
        return Response.redirect(redirectUrl, 302);
    }

    if (env.WhiteList_Mode === "true") {
        return Response.redirect(`${url.origin}/whitelist-on.html`, 302);
    }

    const moderationResult = await moderateFile(env, url, fileId, metadata, response);
    if (moderationResult.blocked) {
        await putMetadata(env, fileId, metadata);
        return Response.redirect(`${url.origin}/block-img.html`, 302);
    }

    await putMetadata(env, fileId, metadata);
    return withFileHeaders(response, fileId, request, env);
}

async function resolveRequestedId(env, requestedId) {
    if (!env.img_url || !isShortUrlsEnabled(env) || requestedId.includes('.') || !looksLikeShortId(requestedId)) {
        return requestedId;
    }
    const target = await resolveShortId(env, requestedId);
    return target || requestedId;
}

function isRefererAllowed(env, request, url) {
    const allowlist = String(env.ALLOWED_REFERERS || '')
        .split(',')
        .map(entry => entry.trim())
        .filter(Boolean);
    if (allowlist.length === 0) return true;
    const referer = request.headers.get('Referer');
    if (!referer) return true;
    let refererHost;
    try { refererHost = new URL(referer).hostname.toLowerCase(); }
    catch { return false; }
    if (refererHost === url.hostname.toLowerCase()) return true;
    return allowlist.some(pattern => matchesHost(pattern.toLowerCase(), refererHost));
}

function matchesHost(pattern, host) {
    if (pattern.startsWith('*.')) {
        const base = pattern.slice(2);
        return host === base || host.endsWith('.' + base);
    }
    return host === pattern;
}

async function moderateFile(env, url, fileId, metadata, response) {
    if (metadata.Label && metadata.Label !== LABEL.NONE) {
        return { blocked: isBlocked(metadata) };
    }
    try {
        const provider = getModerationProvider(env);
        const label = await provider.moderate(env, { fileId, search: url.search, response });
        if (label) metadata.Label = label;
    } catch (_) {
        // A moderation provider error can contain an upstream URL, key, or
        // caller-controlled detail. Preserve the existing fail-open behavior
        // without emitting that material to platform logs.
        console.error('Content moderation failed.');
    }
    return { blocked: isBlocked(metadata) };
}

function withFileHeaders(response, filename, request, env) {
    const upstreamType = response.headers.get('Content-Type') || '';
    const correctedType = isUsableContentType(upstreamType) ? null : contentTypeFromFilename(filename);
    const effectiveType = correctedType || upstreamType;
    const inline = isPreviewableContent(effectiveType) || isPreviewableFilename(filename);

    const headers = new Headers(response.headers);
    if (correctedType) headers.set('Content-Type', correctedType);
    if (inline) headers.set('Content-Disposition', `inline; filename="${escapeFilename(filename)}"`);
    addCorsHeaders(headers, request, env);

    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function withCors(response, request, env) {
    const headers = new Headers(response.headers);
    addCorsHeaders(headers, request, env);
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function addCorsHeaders(headers, request, env) {
    const origin = request.headers.get('Origin');
    const allowed = String(env.CORS_ALLOWED_ORIGINS || 'https://resontune.pages.dev,https://tune.thio.cc.cd')
        .split(',')
        .map(value => value.trim())
        .filter(Boolean);

    if (origin && allowed.includes(origin)) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Vary', 'Origin');
    }
    headers.set('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Range,Content-Type');
    headers.set('Access-Control-Expose-Headers', 'Content-Length,Content-Range,Accept-Ranges,Content-Type,Content-Disposition');
    headers.set('Accept-Ranges', headers.get('Accept-Ranges') || 'bytes');
}

function isUsableContentType(contentType) {
    return contentType !== '' && !contentType.startsWith('application/octet-stream');
}

const CONTENT_TYPES_BY_EXTENSION = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
    avif: 'image/avif', apng: 'image/apng', bmp: 'image/bmp', ico: 'image/x-icon', mp4: 'video/mp4',
    m4v: 'video/x-m4v', mov: 'video/quicktime', webm: 'video/webm', ogv: 'video/ogg', mp3: 'audio/mpeg',
    m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
    aac: 'audio/aac', pdf: 'application/pdf',
};

function contentTypeFromFilename(filename) {
    const extension = String(filename).split('.').pop().toLowerCase();
    return CONTENT_TYPES_BY_EXTENSION[extension] || null;
}

function isPreviewableContent(contentType) {
    return contentType.startsWith('image/') || contentType.startsWith('video/') ||
        contentType.startsWith('audio/') || contentType.startsWith('application/pdf');
}

function isPreviewableFilename(filename) {
    return /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp|apng|mp4|m4v|mov|webm|ogv|mp3|m4a|ogg|oga|wav|flac|aac|pdf)$/i.test(String(filename));
}

function escapeFilename(filename) {
    return String(filename).replace(/["\\]/g, '_');
}
