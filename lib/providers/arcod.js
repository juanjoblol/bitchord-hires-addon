import { describeAudioUrl, qualityLabel } from '../flac.js';
import { searchCache, streamCache, probeCache } from '../cache.js';

const PREFIX = 'ar';
const BASE = (process.env.ARCOD_BASE_URL || 'https://arcod.xyz').replace(/\/+$/, '');
const HEADERS = { Accept: 'application/json', 'User-Agent': 'bitchord-hires-addon/1.0' };

const QUALITY_CHAIN = {
    LOSSLESS: [27, 7, 6],
    HIGH: [7, 6],
    LOW: [5],
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
        const res = await fetch(`${BASE}${path}`, { headers: HEADERS, signal: ac.signal });
        if (!res.ok) return { error: `upstream ${res.status}` };
        return await res.json();
    } catch (err) {
        return { error: String(err?.message || err) };
    } finally {
        clearTimeout(timer);
    }
}

function mapTrack(item) {
    const rawId = String(item?.id ?? '');
    const title = item?.title;
    if (!/^\d+$/.test(rawId) || !title) return null;
    if (item?.streamable === false) return null;

    const artwork = String(item?.album?.image?.large || '');
    const hires = item?.hires === true || Number(item?.maximum_bit_depth) > 16;

    return {
        id: `${PREFIX}:${rawId}`,
        title,
        artist: item?.performer?.name || '',
        album: item?.album?.title || '',
        duration: Number(item?.duration) || undefined,
        artworkURL: /^https:\/\//i.test(artwork) ? artwork : undefined,
        format: 'flac',
        audioQuality: hires ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
        source: 'Arcod',
    };
}

export async function search(query) {
    const q = String(query || '').trim();
    if (!q) return { tracks: [], error: null };

    return searchCache.wrap(`ar:${q.toLowerCase()}`, async () => {
        const payload = await getJson(`/api/search?q=${encodeURIComponent(q)}&limit=15`, 6000);
        if (payload?.error) return { tracks: [], error: payload.error };

        const items = Array.isArray(payload?.data?.tracks?.items) ? payload.data.tracks.items : [];
        const tracks = [];
        const seen = new Set();
        for (const item of items) {
            const row = mapTrack(item);
            if (!row || seen.has(row.id)) continue;
            seen.add(row.id);
            tracks.push(row);
            if (tracks.length >= 20) break;
        }
        return { tracks, error: tracks.length ? null : 'no arcod rows' };
    });
}

export async function resolve(id, quality) {
    const trackId = String(id).replace(/^ar:/, '');
    if (!/^\d+$/.test(trackId)) return null;

    const tier = normaliseQuality(quality);

    return streamCache.wrap(`ar:${trackId}:${tier}`, async () => {
        for (const qualityId of QUALITY_CHAIN[tier]) {
            const ticket = await getJson(`/api/player/stream/${trackId}?quality=${qualityId}`);
            const url = ticket?.url;
            if (ticket?.error || !url || !/^https:\/\//i.test(url)) continue;

            const described = await probeCache.wrap(url, () => describeAudioUrl(url));
            if (described?.error) continue;

            if (described.codec === 'mp3') {
                if (tier !== 'LOW') continue;
                return {
                    url: described.url,
                    codec: 'mp3',
                    container: 'mp3',
                    manifest: 'none',
                    mimeType: 'audio/mpeg',
                    encrypted: false,
                    format: 'mp3',
                    quality: qualityLabel(described),
                    provider: 'Arcod',
                };
            }
            if (described.codec !== 'flac' || !described.sampleRate || !described.bitDepth) continue;

            return {
                url: described.url,
                codec: 'flac',
                container: 'flac',
                manifest: 'none',
                mimeType: 'audio/flac',
                encrypted: false,
                sampleRate: described.sampleRate,
                bitDepth: described.bitDepth,
                ...(described.channels ? { channels: described.channels } : {}),
                ...(described.bitrate ? { bitrate: described.bitrate } : {}),
                format: 'flac',
                quality: qualityLabel(described),
                provider: 'Arcod',
            };
        }
        return null;
    });
}

export const arcod = { id: PREFIX, key: 'arcod', name: 'Arcod', search, resolve };
