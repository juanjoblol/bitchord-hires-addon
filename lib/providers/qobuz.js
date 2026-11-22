import { describeAudioUrl, qualityLabel } from '../flac.js';
import { streamCache, probeCache } from '../cache.js';

const PREFIX = 'qb';
const UPSTREAM = process.env.QOBUZ_UPSTREAM_BASE_URL || 'https://soundfean-musics.onrender.com/a';
const SELF_HOSTED = process.env.QOBUZ_REST_API || '';
const UA = { Accept: 'application/json' };

const QUALITY_MAP = {
    LOSSLESS: 'HI_RES',
    HIGH: 'LOSSLESS',
    LOW: 'LOW',
};

function normaliseQuality(raw) {
    const q = String(raw || 'LOSSLESS').toUpperCase();
    if (q === 'HIGH' || q.includes('HIGH')) return 'HIGH';
    if (q === 'LOW' || q.includes('LOW')) return 'LOW';
    return 'LOSSLESS';
}

async function getJson(path, timeoutMs = 8000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(`${UPSTREAM}${path}`, { headers: UA, signal: ac.signal });
        if (!res.ok) return { error: `upstream ${res.status}` };
        return await res.json();
    } catch (err) {
        return { error: String(err?.message || err) };
    } finally {
        clearTimeout(timer);
    }
}

export async function resolve(id, quality) {
    const trackId = String(id).replace(/^qb:/, '');
    if (!/^\d+$/.test(trackId)) return null;

    const tier = normaliseQuality(quality);

    return streamCache.wrap(`qb:${trackId}:${tier}`, async () => {
        if (SELF_HOSTED) {
            return resolveSelfHosted(trackId, tier);
        }

        const upstreamQuality = QUALITY_MAP[tier] || 'HI_RES';
        const payload = await getJson(`/stream/${encodeURIComponent(trackId)}?quality=${upstreamQuality}`);
        const url = payload?.url;
        if (payload?.error || !url) return null;
        if (!/^https:\/\//i.test(url)) return null;
        if (payload?.encrypted === true) return null;

        return {
            url,
            codec: payload.codec || 'flac',
            container: payload.container || 'flac',
            manifest: 'none',
            encrypted: false,
            ...(payload.sampleRate ? { sampleRate: payload.sampleRate } : {}),
            ...(payload.bitDepth ? { bitDepth: payload.bitDepth } : {}),
            ...(payload.bitrate ? { bitrate: payload.bitrate } : {}),
            format: payload.codec || 'flac',
            quality: qualityLabel({ codec: 'flac', sampleRate: payload.sampleRate, bitDepth: payload.bitDepth }),
            provider: 'Qobuz',
        };
    });
}

async function resolveSelfHosted(trackId, tier) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    try {
        const res = await fetch(`${SELF_HOSTED}/track/getStreamUrl?id=${encodeURIComponent(trackId)}&quality=${tier}`, {
            headers: { 'User-Agent': 'bitchord-hires-addon/1.0' },
            signal: ac.signal,
        });
        if (!res.ok) return null;
        const payload = await res.json();
        const url = payload?.url || payload?.data?.url;
        if (!url || !/^https:\/\//i.test(url)) return null;

        const described = await probeCache.wrap(url, () => describeAudioUrl(url));
        if (described.error) return null;
        return {
            url: described.url,
            codec: described.codec || 'flac',
            container: described.container || 'flac',
            manifest: 'none',
            encrypted: false,
            ...(described.sampleRate ? { sampleRate: described.sampleRate } : {}),
            ...(described.bitDepth ? { bitDepth: described.bitDepth } : {}),
            quality: qualityLabel(described),
            provider: 'Qobuz',
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export const qobuz = { id: PREFIX, key: 'qobuz', name: 'Qobuz', resolve };
