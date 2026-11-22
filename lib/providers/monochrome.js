import { describeAudioUrl, qualityLabel } from '../flac.js';
import { searchCache, streamCache, probeCache } from '../cache.js';

const PREFIX = 'mc';
const INDEX = (process.env.MONOCHROME_INDEX_BASE_URL || 'https://tracks.monochrome.st').replace(/\/+$/, '');
const HEADERS = {
    Accept: 'application/json',
    'User-Agent': 'bitchord-hires-addon/1.0',
};

async function getJson(path, timeoutMs = 6000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(`${INDEX}${path}`, { headers: HEADERS, signal: ac.signal });
        if (!res.ok) return { error: `index ${res.status}` };
        return await res.json();
    } catch (err) {
        return { error: String(err?.message || err) };
    } finally {
        clearTimeout(timer);
    }
}

function mapTrack(item) {
    const rawId = String(item?.trackId || item?.id || '');
    if (!/^\d+$/.test(rawId)) return null;
    const title = item?.title;
    if (!title) return null;
    if (item?.playable === false) return null;

    const artist = Array.isArray(item.artistNames) && item.artistNames.length
        ? item.artistNames.join(', ')
        : item?.artist?.name || '';
    const rawDuration = Number(item.duration) || 0;
    const duration = rawDuration > 3600 ? Math.round(rawDuration / 1000) : rawDuration;
    const artwork = typeof item.artwork === 'string' && /^https?:\/\//i.test(item.artwork)
        ? item.artwork
        : undefined;

    return {
        id: `${PREFIX}:${rawId}`,
        title,
        artist,
        album: item.album?.title || item.releaseTitle || '',
        duration: duration || undefined,
        artworkURL: artwork,
        format: 'flac',
        audioQuality: 'LOSSLESS',
        source: 'Monochrome',
    };
}

export async function search(query) {
    const q = String(query || '').trim();
    if (!q) return { tracks: [], error: null };

    return searchCache.wrap(`mc:${q.toLowerCase()}`, async () => {
        const payload = await getJson(`/search?q=${encodeURIComponent(q)}&limit=20`);
        if (payload?.error) return { tracks: [], error: payload.error };

        const tracks = [];
        const seen = new Set();
        for (const item of Array.isArray(payload?.tracks) ? payload.tracks : []) {
            const row = mapTrack(item);
            if (!row || seen.has(row.id)) continue;
            seen.add(row.id);
            tracks.push(row);
            if (tracks.length >= 20) break;
        }
        return { tracks, error: tracks.length ? null : 'no monochrome rows' };
    });
}

export async function resolve(id) {
    const trackId = String(id).replace(/^mc:/, '');
    if (!/^\d+$/.test(trackId) || trackId.length < 15) return null;

    return streamCache.wrap(`mc:${trackId}`, async () => {
        const url = `${INDEX}/track/${trackId}`;
        const described = await probeCache.wrap(url, () => describeAudioUrl(url));
        if (described?.error || described.codec !== 'flac' || !described.sampleRate || !described.bitDepth) {
            return null;
        }

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
            provider: 'Monochrome',
        };
    });
}

export const monochrome = { id: PREFIX, key: 'monochrome', name: 'Monochrome', search, resolve };
