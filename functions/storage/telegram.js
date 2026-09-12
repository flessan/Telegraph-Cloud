import {
    createTelegramClient,
    createTelegramFormData,
    getFileId,
    getUploadTarget,
} from '../cloud/telegram-client.js';

// Legacy-media provider retained unchanged at its public boundary. The Bot API
// transport is now injected through the shared Telegram client so future
// document/object adapters do not duplicate URL construction or header policy.
export const telegramProvider = {
    key: 'telegram',

    validateConfig(env) {
        createTelegramClient(env).validateConfig();
    },

    async upload(env, file, { fileExtension }) {
        const telegram = createTelegramClient(env);
        const { endpoint, field } = getUploadTarget(file);
        const formData = createTelegramFormData(env.TG_Chat_ID, field, file);

        const result = await telegram.sendFormData(formData, endpoint);
        if (!result.success) {
            throw new Error(result.error);
        }

        const fileId = getFileId(result.data);
        if (!fileId) {
            throw new Error('Failed to get file ID');
        }

        return `${fileId}.${fileExtension}`;
    },

    async fetchFile(env, request, url, fileId) {
        const telegram = createTelegramClient(env);
        const fileUrl = await resolveFileUrl(telegram, url, fileId);
        if (!fileUrl) {
            return new Response('Telegram file could not be resolved.', { status: 502 });
        }
        return telegram.fetchDownload(fileUrl, request);
    },
};

async function resolveFileUrl(telegram, url, fileId) {
    // Same threshold as the old `/file/` length check: ids longer than 33
    // characters are Telegram Bot API ids; older Telegraph ids remain intact.
    if (fileId.length > 33) {
        const filePath = await telegram.getFilePath(fileId.split('.')[0]);
        return telegram.getFileDownloadUrl(filePath);
    }

    return 'https://telegra.ph//file/' + fileId + url.search;
}
