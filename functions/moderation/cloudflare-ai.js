import { resolveModerationModels } from './model-registry.js';

// Workers AI receives the raw bytes, so the file does not need to be publicly
// reachable — this also sidesteps the dead telegra.ph URL the legacy provider
// depends on. Oversized bodies are skipped instead of buffered.
const MAX_MODERATED_BYTES = 5 * 1024 * 1024;
const PROMPT = 'Does this image contain explicit sexual or pornographic content? Answer with exactly one word: yes or no.';
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp|avif|apng)$/i;

export const cloudflareAiProvider = {
    key: 'cloudflare-ai',

    async moderate(env, { fileId, response }) {
        if (!env.AI) {
            console.error('cloudflare-ai moderation selected but no AI binding is configured');
            return null;
        }

        if (!looksLikeImage(response, fileId)) {
            return null;
        }

        const buffer = await response.clone().arrayBuffer();
        if (buffer.byteLength === 0 || buffer.byteLength > MAX_MODERATED_BYTES) {
            return null;
        }

        const models = await resolveModerationModels(env);
        const result = await runWithFallback(env, models, {
            image: [...new Uint8Array(buffer)],
            prompt: PROMPT,
            max_tokens: 20,
        });

        const answer = String(result?.response ?? result?.description ?? '').trim().toLowerCase();
        if (!answer) {
            return null;
        }

        return /\byes\b/.test(answer) ? 'adult' : 'everyone';
    },
};

// Models are tried in order until one succeeds, so a model being retired by
// Cloudflare degrades gracefully instead of silently breaking moderation.
async function runWithFallback(env, models, input) {
    let lastError;

    for (const model of models) {
        try {
            return await env.AI.run(model, input);
        } catch (error) {
            // Model/provider errors may include request or upstream details.
            // Keep fallback behavior while avoiding sensitive log material.
            console.error('Workers AI moderation model failed.');
            lastError = error;
        }
    }

    throw lastError;
}

function looksLikeImage(response, fileId) {
    const contentType = response.headers.get('Content-Type') || '';
    return contentType.startsWith('image/') || IMAGE_EXTENSION_PATTERN.test(String(fileId));
}
