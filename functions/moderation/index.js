import { moderateContentProvider } from './moderatecontent.js';
import { cloudflareAiProvider } from './cloudflare-ai.js';

// Moderation provider contract:
//   key                                        - provider name usable in MODERATION_PROVIDER
//   moderate(env, { fileId, search, response }) -> rating label string or null (no verdict)
// Providers never block on failure — the caller treats errors and null as "not blocked".
const noneProvider = {
    key: 'none',
    async moderate() {
        return null;
    },
};

const PROVIDERS = {
    [moderateContentProvider.key]: moderateContentProvider,
    [cloudflareAiProvider.key]: cloudflareAiProvider,
    [noneProvider.key]: noneProvider,
};

export function getModerationProvider(env) {
    const name = (env.MODERATION_PROVIDER || '').toLowerCase();

    if (name) {
        const provider = PROVIDERS[name];
        if (!provider) {
            // Configuration is deployment-owned but can still accidentally
            // contain sensitive text; the public fail-open fallback needs no
            // value in a platform log.
            console.error('Unknown moderation provider configuration.');
            return noneProvider;
        }
        return provider;
    }

    // Auto-detection keeps existing deployments working without new config:
    // a legacy API key selects moderatecontent, an AI binding selects Workers AI.
    if (env.ModerateContentApiKey) {
        return moderateContentProvider;
    }

    if (env.AI) {
        return cloudflareAiProvider;
    }

    return noneProvider;
}
