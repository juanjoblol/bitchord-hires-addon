import { qualityLabel } from '../flac.js';
import { searchCache, streamCache } from '../cache.js';
const PREFIX = 'mc';
const REGISTRY = 'https://raw.githubusercontent.com/monochrome-music/monochrome/main/public/instances.json';
const MODERN = 'https://tracks.monochrome.st';
const UPSTREAM_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'x-client': 'BiniLossless/v3.4',
    Origin: 'https://monochrome.st',
    Referer: 'https://monochrome.st/',
    Accept: 'application/json',
};
const DEFAULT_INSTANCES = [
    'https://wolf.qqdl.site',
    'https://maus.qqdl.site',
    'https://vogel.qqdl.site',
    'https://hund.qqdl.site',
    'https://tidal.kinoplus.online',
];
const INSTANCE_TTL = 30 * 60 * 1000;
let instanceCache = { at: 0, urls: [...DEFAULT_INSTANCES] };
function isValidInstance(raw) {
    try {
        const u = new URL(String(raw || '').trim());
        return u.protocol === 'https:' || u.protocol === 'http:';
    }
    catch {
        return false;
    }
}
async function instances({ force = false } = {}) {
    if (!force && Date.now() - instanceCache.at < INSTANCE_TTL)
        return instanceCache.urls;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 6000);
    try {
        const res = await fetch(REGISTRY, { signal: ac.signal, headers: { Accept: 'application/json' } });
        if (res.ok) {
            const data = await res.json();
            const list = [...(Array.isArray(data?.api) ? data.api : []), ...(Array.isArray(data?.streaming) ? data.streaming : [])]
                .map((u) => String(u || '').trim().replace(/\/+$/, ''))
                .filter(isValidInstance);
            const merged = [...new Set([...list, ...DEFAULT_INSTANCES])];
            if (merged.length)
                instanceCache = { at: Date.now(), urls: merged };
        }
    }
    catch {
    }
    finally {
        clearTimeout(timer);
    }
    return instanceCache.urls;
}
async function tryFetch(url, timeoutMs) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, { headers: UPSTREAM_HEADERS, signal: ac.signal, redirect: 'follow' });
        if (!res.ok)
            return null;
        const type = (res.headers.get('content-type') || '').toLowerCase();
        if (!type.includes('json'))
            return null;
        return await res.json();
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
function mapTrack(item, base) {
    const rawId = String(item?.trackId || item?.id || '');
    if (!/^\d+$/.test(rawId))
        return null;
    const title = item?.title;
    if (!title)
        return null;
    const artist = Array.isArray(item.artistNames) && item.artistNames.length
        ? item.artistNames.join(', ')
        : item.artist?.name || (Array.isArray(item.artists) ? item.artists[0]?.name : '') || '';
    const rawDuration = Number(item.duration || 0);
    const duration = rawDuration > 3600 ? Math.round(rawDuration / 1000) : rawDuration;
    let artwork = item.artwork || '';
    if (artwork && !/^https?:\/\//i.test(artwork)) {
        try {
            artwork = new URL(artwork, base).toString();
        }
        catch {
            artwork = '';
        }
    }
    const hires = Array.isArray(item.mediaMetadata?.tags) && item.mediaMetadata.tags.includes('HIRES_LOSSLESS');
    return {
        id: `${PREFIX}:${rawId}`,
        title,
        artist,
        album: item.album?.title || item.releaseTitle || '',
        duration: duration || undefined,
        artworkURL: artwork || undefined,
        format: 'flac',
        audioQuality: hires ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
        source: 'Monochrome',
        _hiRes: hires,
    };
}
function itemsFrom(payload) {
    const candidates = [
        payload?.items,
        payload?.data?.items,
        payload?.tracks,
        payload?.data?.tracks,
        Array.isArray(payload?.data) ? payload.data : null,
        Array.isArray(payload?.topResults) ? payload.topResults : null,
    ];
    for (const c of candidates)
        if (Array.isArray(c) && c.length)
            return c;
    return [];
}
export async function search(query, quality) {
    const q = String(query || '').trim();
    if (!q)
        return { tracks: [], error: null };
    return searchCache.wrap(`mc:${q.toLowerCase()}`, async () => {
        const urls = await instances();
        const tracks = [];
        const seen = new Set();
        const push = (payload, base) => {
            for (const item of itemsFrom(payload)) {
                const row = mapTrack(item, base);
                if (!row || seen.has(row.id))
                    continue;
                seen.add(row.id);
                tracks.push(row);
                if (tracks.length >= 20)
                    break;
            }
        };
        const modern = await tryFetch(`${MODERN}/search?q=${encodeURIComponent(q)}`, 5000);
        push(modern, MODERN);
        if (tracks.length < 20) {
            const pool = await Promise.allSettled(urls.slice(0, 6).map((base) => tryFetch(`${base}/search/?s=${encodeURIComponent(q)}`, 6000)));
            for (const r of pool) {
                if (r.status === 'fulfilled' && r.value)
                    push(r.value, '');
                if (tracks.length >= 20)
                    break;
            }
        }
        return { tracks, error: tracks.length ? null : 'monochrome unreachable' };
    });
}
function decodeManifest(rawManifestBase64, manifestMimeType = '', quality = 'LOSSLESS') {
    if (!rawManifestBase64 || typeof rawManifestBase64 !== 'string')
        return null;
    let decoded;
    try {
        decoded = Buffer.from(rawManifestBase64, 'base64').toString('utf8').trim();
    }
    catch {
        return null;
    }
    if (manifestMimeType.includes('dash+xml') || decoded.startsWith('<MPD') || decoded.startsWith('<?xml')) {
        return { isDash: true };
    }
    if (manifestMimeType.includes('vnd.tidal.bts') || decoded.startsWith('{')) {
        let json;
        try {
            json = JSON.parse(decoded);
        }
        catch {
            return null;
        }
        const url = Array.isArray(json.urls) ? json.urls[0] : json.url;
        if (!url || !/^https?:\/\//i.test(url))
            return null;
        const sampleRate = Number(json.sampleRate) || 44100;
        const bitDepth = Number(json.bitDepth) || 16;
        return {
            isDash: false,
            stream: {
                url,
                codec: 'flac',
                container: 'flac',
                manifest: 'none',
                mimeType: 'audio/flac',
                encrypted: false,
                sampleRate,
                bitDepth,
                format: 'flac',
                quality: qualityLabel({ codec: 'flac', sampleRate, bitDepth }),
                provider: 'Monochrome',
            },
        };
    }
    return null;
}
export async function resolve(id, quality) {
    const trackId = String(id).replace(/^mc:/, '');
    if (!/^\d+$/.test(trackId))
        return null;
    const tier = String(quality || 'LOSSLESS').toUpperCase();
    const upstreamQuality = tier.includes('LOW') ? 'LOW' : tier.includes('HIGH') ? 'HIGH' : 'LOSSLESS';
    return streamCache.wrap(`mc:${trackId}:${upstreamQuality}`, async () => {
        if (trackId.length >= 15) {
            const modern = await tryFetch(`${MODERN}/track/${trackId}?quality=${upstreamQuality}`, 8000);
            if (modern && typeof modern === 'object' && !modern.error && (modern.url || modern.manifest)) {
                if (modern.url && /^https:\/\//i.test(modern.url)) {
                    const sampleRate = Number(modern.sampleRate) || 44100;
                    const bitDepth = Number(modern.bitDepth) || 16;
                    return {
                        url: modern.url,
                        codec: 'flac',
                        container: modern.container || 'flac',
                        manifest: modern.manifest === 'dash' ? 'dash' : 'none',
                        encrypted: false,
                        sampleRate,
                        bitDepth,
                        ...(modern.bitrate ? { bitrate: modern.bitrate } : {}),
                        format: 'flac',
                        quality: qualityLabel({ codec: 'flac', sampleRate, bitDepth }),
                        provider: 'Monochrome',
                    };
                }
            }
        }
        const urls = await instances();
        const pool = await Promise.allSettled(urls.slice(0, 6).map((base) => tryFetch(`${base}/track/?id=${encodeURIComponent(trackId)}&quality=${upstreamQuality}`, 8000)));
        const fallbacks = [];
        for (const r of pool) {
            if (r.status !== 'fulfilled' || !r.value)
                continue;
            const body = r.value?.data || r.value;
            if (!body?.manifest)
                continue;
            if (body.assetPresentation === 'PREVIEW')
                continue;
            if (typeof body.duration === 'number' && body.duration > 0 && body.duration <= 30)
                continue;
            const decoded = decodeManifest(body.manifest, body.manifestMimeType || '', upstreamQuality);
            if (!decoded)
                continue;
            if (decoded.isDash) {
                fallbacks.push(base);
                continue;
            }
            return decoded.stream;
        }
        for (const base of fallbacks) {
            const body = await tryFetch(`${base}/track/?id=${encodeURIComponent(trackId)}&quality=LOSSLESS`, 8000);
            const inner = body?.data || body;
            if (!inner?.manifest)
                continue;
            const decoded = decodeManifest(inner.manifest, inner.manifestMimeType || '', 'LOSSLESS');
            if (decoded && !decoded.isDash)
                return decoded.stream;
        }
        return null;
    });
}
export const monochrome = { id: PREFIX, key: 'monochrome', name: 'Monochrome', search, resolve };
