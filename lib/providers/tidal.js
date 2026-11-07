import { qualityLabel } from '../flac.js';
import { searchCache, streamCache } from '../cache.js';
const PREFIX = 'td';
const AURIX = process.env.TIDAL_UPSTREAM_BASE_URL || 'https://addon-2.aurix.dpdns.org/free_rLnRPnC6oZF5gvAx';
const GGLOS = process.env.TIDAL_SEARCH_BACKUP_URL || 'https://gglos.geisselgottes.cfd/u/d0c1c9339d2a154a3cae00293644f4ba';
const UA = { 'User-Agent': 'BitChord/v1.8.1', Accept: 'application/json' };
const QUALITY_MAP = { LOSSLESS: 'hi_res', HIGH: 'high', LOW: 'low' };
function normaliseQuality(raw) {
    const q = String(raw || 'LOSSLESS').toUpperCase();
    if (q === 'HIGH' || q.includes('HIGH'))
        return 'HIGH';
    if (q === 'LOW' || q.includes('LOW'))
        return 'LOW';
    return 'LOSSLESS';
}
async function getJson(base, path, timeoutMs = 9000) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(`${base}${path}`, { headers: UA, signal: ac.signal });
        if (!res.ok)
            return { error: `upstream ${res.status}` };
        return await res.json();
    }
    catch (err) {
        return { error: String(err?.message || err) };
    }
    finally {
        clearTimeout(timer);
    }
}
function mapTrack(item) {
    const rawId = String(item?.id || '').replace(/^tidal:/i, '');
    if (!/^\d+$/.test(rawId))
        return null;
    const title = item?.title;
    if (!title)
        return null;
    const hires = String(item?.audioQuality || '').includes('HI_RES');
    return {
        id: `${PREFIX}:${rawId}`,
        title,
        artist: item.artist || '',
        album: item.album || '',
        duration: Number(item.duration) || undefined,
        artworkURL: item.artworkURL || undefined,
        format: 'flac',
        audioQuality: hires ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
        source: 'Tidal',
        _hiRes: hires,
    };
}
export async function search(query, quality) {
    const q = String(query || '').trim();
    if (!q)
        return { tracks: [], error: null };
    return searchCache.wrap(`td:${normaliseQuality(quality)}:${q.toLowerCase()}`, async () => {
        const [primary, backup] = await Promise.allSettled([
            getJson(AURIX, `/search?q=${encodeURIComponent(q)}&quality=lossless`),
            getJson(GGLOS, `/search?q=${encodeURIComponent(q)}&quality=lossless`, 7000),
        ]);
        const tracks = [];
        const seen = new Set();
        for (const result of [primary, backup]) {
            if (result.status !== 'fulfilled')
                continue;
            const payload = result.value;
            if (payload?.error || !Array.isArray(payload?.tracks))
                continue;
            for (const item of payload.tracks) {
                const row = mapTrack(item);
                if (!row || seen.has(row.id))
                    continue;
                seen.add(row.id);
                tracks.push(row);
                if (tracks.length >= 25)
                    break;
            }
            if (tracks.length >= 25)
                break;
        }
        return { tracks, error: tracks.length ? null : 'no tidal rows' };
    });
}
function buildStream(payload) {
    const url = payload?.url;
    if (!url || payload?.error || payload?.encrypted === true)
        return null;
    if (!/^https:\/\//i.test(url))
        return null;
    const sampleRate = Number(payload.sampleRate) || 0;
    const bitDepth = Number(payload.bitDepth) || 0;
    if (!sampleRate || !bitDepth)
        return null;
    const manifest = payload.manifest || (payload.format === 'dash' ? 'dash' : 'none');
    const container = payload.container || (manifest === 'dash' ? 'dash' : 'flac');
    return {
        url,
        codec: payload.codec || 'flac',
        container,
        manifest,
        ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
        encrypted: false,
        sampleRate,
        bitDepth,
        ...(payload.bitrate ? { bitrate: payload.bitrate } : {}),
        format: payload.format || 'flac',
        quality: qualityLabel({ codec: 'flac', sampleRate, bitDepth }),
        provider: 'Tidal',
    };
}
export async function resolve(id, quality) {
    const tidalId = String(id).replace(/^td:/, '');
    if (!/^\d+$/.test(tidalId))
        return null;
    const tier = normaliseQuality(quality);
    return streamCache.wrap(`td:${tidalId}:${tier}`, async () => {
        const attempts = tier === 'LOSSLESS' ? ['hi_res', 'lossless'] : [QUALITY_MAP[tier]];
        for (const upstreamQuality of attempts) {
            const payload = await getJson(AURIX, `/stream/tidal:${tidalId}?quality=${upstreamQuality}`, 12000);
            const stream = buildStream(payload);
            if (stream)
                return stream;
        }
        return null;
    });
}
export const tidal = { id: PREFIX, key: 'tidal', name: 'Tidal', search, resolve };
