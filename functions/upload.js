import { errorHandling, telemetryData } from "./utils/middleware.js";
import { authenticateUploadRequest } from "./utils/auth.js";
import { jsonResponse } from "./utils/http.js";
import { createDefaultMetadata, putMetadata } from "./utils/metadata.js";
import { allocateShortId, isShortUrlsEnabled, putShortLink } from "./utils/shortlink.js";
import { getUploadProvider } from "./storage/index.js";

function safeUploadFailure(error) {
    const message = typeof error?.message === 'string' ? error.message : '';
    if (message === 'No file uploaded') return { code: 'no_file', status: 400 };
    if (message === 'Missing required environment variable: TG_Bot_Token'
        || message === 'Missing required environment variable: TG_Chat_ID') {
        return { code: 'telegram_not_configured', status: 503 };
    }
    if (message === 'Missing required R2 bucket binding: img_r2') {
        return { code: 'r2_not_configured', status: 503 };
    }
    if (message.startsWith('Parsing a Body as FormData')) return { code: 'invalid_upload_request', status: 400 };

    // The Telegram client intentionally returns a safe, prefix-only error
    // string. Classify its HTTP/network failure without reflecting the raw
    // provider description or URL.
    const match = /^Telegram (?:sendPhoto|sendAudio|sendVideo|sendDocument) failed: (\d{3})\b/.exec(message);
    if (match) {
        const status = Number(match[1]);
        const kind = /\\[([a-z_]+)\\]/.exec(message)?.[1] || '';
        if (status === 401 || kind === 'auth_failed') return { code: 'telegram_auth_failed', status: 502 };
        if (status === 403 || kind === 'forbidden') return { code: 'telegram_forbidden', status: 502 };
        if (status === 404 || kind === 'not_found') return { code: 'telegram_not_found', status: 502 };
        if (status === 413 || kind === 'payload_too_large') return { code: 'file_too_large_for_provider', status: 413 };
        if (status === 429 || kind === 'rate_limited') return { code: 'telegram_rate_limited', status: 429 };
        if (status >= 500 && status <= 599 || kind === 'upstream_unavailable') {
            return { code: 'telegram_upstream_unavailable', status: 503 };
        }
        if (kind === 'chat_not_found') return { code: 'telegram_chat_not_found', status: 502 };
        if (kind === 'invalid_file') return { code: 'telegram_invalid_file', status: 502 };
        return { code: 'telegram_api_rejected', status: 502 };
    }
    if (message === 'Network error occurred') return { code: 'telegram_network_error', status: 503 };
    if (message === 'Failed to get file ID') return { code: 'telegram_invalid_response', status: 502 };

    // KV/provider errors can contain remote details or caller data. Keep the
    // public error opaque rather than turning it into a diagnostic oracle.
    return { code: 'upload_failed', status: 500 };
}

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const authResponse = authenticateUploadRequest(request, env);
        if (authResponse) {
            return authResponse;
        }

        const provider = getUploadProvider(env);
        provider.validateConfig(env);

        const clonedRequest = request.clone();
        const formData = await clonedRequest.formData();

        await errorHandling(context);
        telemetryData(context);

        const uploadFile = formData.get('file');
        if (!uploadFile) {
            throw new Error('No file uploaded');
        }

        const fileName = uploadFile.name;
        const fileExtension = fileName.split('.').pop().toLowerCase();

        const longId = await provider.upload(env, uploadFile, { fileName, fileExtension });
        let shortId = null;

        // 将文件信息保存到 KV 存储
        if (env.img_url) {
            if (isShortUrlsEnabled(env)) {
                shortId = await allocateShortId(env);
            }

            await putMetadata(env, longId, createDefaultMetadata(longId, {
                fileName,
                fileSize: uploadFile.size,
                provider: provider.key,
                ...(shortId ? { shortId } : {}),
            }));

            if (shortId) {
                await putShortLink(env, shortId, longId);
            }
        }

        return jsonResponse([{ 'src': `/file/${shortId || longId}` }]);
    } catch (error) {
        // Never pass a caught Error to logs or the response. Fetch/provider
        // errors can include a Bot API URL, upstream body, or caller metadata.
        console.error('Upload request failed.');
        const failure = safeUploadFailure(error);
        return jsonResponse({ error: failure.code }, {
            status: failure.status,
            headers: { 'Cache-Control': 'no-store' },
        });
    }
}
