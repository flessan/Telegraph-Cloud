import { errorHandling, telemetryData } from "./utils/middleware.js";
import { authenticateUploadRequest } from "./utils/auth.js";
import { jsonResponse } from "./utils/http.js";
import { createDefaultMetadata, putMetadata } from "./utils/metadata.js";
import { allocateShortId, isShortUrlsEnabled, putShortLink } from "./utils/shortlink.js";
import { getUploadProvider } from "./storage/index.js";

function safeUploadError(error) {
    const message = typeof error?.message === 'string' ? error.message : '';
    // Preserve the established, locally generated validation/configuration
    // messages. They name no value, identifier, or upstream response.
    if (message === 'No file uploaded'
        || message === 'Missing required environment variable: TG_Bot_Token'
        || message === 'Missing required environment variable: TG_Chat_ID'
        || message === 'Missing required R2 bucket binding: img_r2') {
        return message;
    }
    if (message.startsWith('Parsing a Body as FormData')) return 'invalid_upload_request';
    // Telegram/KV/provider errors can include remote details or caller data.
    // The legacy public surface must not turn them into a diagnostic/secret
    // oracle; configuration state remains available as safe enums via
    // /api/config and the dashboard.
    return 'upload_failed';
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
        return jsonResponse({ error: safeUploadError(error) }, {
            status: 500,
            headers: { 'Cache-Control': 'no-store' },
        });
    }
}
