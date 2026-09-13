// Resolves which Workers AI models moderation should try, in order.
//
// Three tiers:
//   1. MODERATION_AI_MODEL          - explicit pin, used alone
//   2. live discovery (optional)    - when CF_ACCOUNT_ID + CF_API_TOKEN are set,
//      the official model-search API supplies the current catalog so retired
//      models drop out and new vision models join without a code change
//   3. DEFAULT_MODELS               - static chain, used when discovery is not
//      configured or unavailable
//
// The env.AI binding itself cannot enumerate models (it only has run()), which
// is why discovery needs an API token. The token only needs "Workers AI: Read".
export const DEFAULT_MODELS = [
    '@cf/meta/llama-3.2-11b-vision-instruct',
    // Deprecated upstream; kept as a last resort while Cloudflare still serves it.
    '@cf/llava-hf/llava-1.5-7b-hf',
];

// Image-to-Text is the one catalog task whose models share the
// { image: [bytes], prompt } input schema this provider sends.
const DISCOVERABLE_TASK = 'Image-to-Text';
const CACHE_KEY = 'moderation:live-models';
const CACHE_TTL_SECONDS = 6 * 60 * 60;

export async function resolveModerationModels(env) {
    if (env.MODERATION_AI_MODEL) {
        return [env.MODERATION_AI_MODEL];
    }

    const live = await getLiveModels(env);
    if (!live || live.length === 0) {
        return DEFAULT_MODELS;
    }

    const liveNames = new Set(live.map(model => model.name));
    const preferred = DEFAULT_MODELS.filter(name => liveNames.has(name));
    const extras = live
        .filter(model => model.task === DISCOVERABLE_TASK && !DEFAULT_MODELS.includes(model.name))
        .map(model => model.name);

    const chain = [...preferred, ...extras];
    return chain.length ? chain : DEFAULT_MODELS;
}

async function getLiveModels(env) {
    if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
        return null;
    }

    if (env.img_url) {
        const record = await env.img_url.getWithMetadata(CACHE_KEY);
        if (record?.value) {
            try {
                return JSON.parse(record.value);
            } catch {
                // fall through to a fresh fetch
            }
        }
    }

    try {
        const url = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/models/search?per_page=100`;
        const response = await fetch(url, {
            headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
        });

        if (!response.ok) {
            console.error(`Model discovery request failed: ${response.status}`);
            return null;
        }

        const data = await response.json();
        const models = (Array.isArray(data.result) ? data.result : [])
            .filter(entry => entry?.name && !isDeprecated(entry))
            .map(entry => ({ name: entry.name, task: entry.task?.name || '' }));

        if (models.length && env.img_url) {
            await env.img_url.put(CACHE_KEY, JSON.stringify(models), {
                expirationTtl: CACHE_TTL_SECONDS,
            });
        }

        return models.length ? models : null;
    } catch (_) {
        // A fetch error can include an account-scoped URL. Discovery has a
        // static fallback, so do not expose upstream/request detail in logs.
        console.error('Model discovery failed.');
        return null;
    }
}

function isDeprecated(entry) {
    const date = deprecationDate(entry);
    if (!date) {
        return false;
    }

    const parsed = Date.parse(date);
    return Number.isFinite(parsed) && parsed <= Date.now();
}

// The API has surfaced deprecation dates both as a top-level field and inside
// the properties array; tolerate either shape.
function deprecationDate(entry) {
    if (entry.planned_deprecation_date) {
        return entry.planned_deprecation_date;
    }

    if (Array.isArray(entry.properties)) {
        const property = entry.properties.find(item => item?.property_id === 'planned_deprecation_date');
        return property?.value || null;
    }

    return null;
}
