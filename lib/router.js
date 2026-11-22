import { qobuz } from './providers/qobuz.js';
import { arcod } from './providers/arcod.js';
import { tidal } from './providers/tidal.js';
import { monochrome } from './providers/monochrome.js';
import { netease } from './providers/netease.js';
import { deezer } from './providers/deezer.js';
import { streamCache, createCache } from './cache.js';

const AUDIO_SOURCES = [monochrome, arcod, tidal, netease, qobuz];
const CATALOGUE_SOURCES = [monochrome, arcod, netease, deezer];
const AUDIO_CHECK_KEYS = ['qobuz', 'tidal', 'monochrome', 'netease', 'arcod'];
const SEARCH_BUDGET_MS = 3500;
const metaCache = createCache(60 * 60 * 1000, 2000);

function decodeRow(row) {
    const { _isrc, _hiRes, ...rest } = row;
    return rest;
}

function tierKey(raw) {
    const q = String(raw || 'LOSSLESS').toUpperCase();
    if (q.includes('HIGH')) return 'HIGH';
    if (q.includes('LOW')) return 'LOW';
    return 'LOSSLESS';
}

function within(promise, timeoutMs) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((resolve) => {
            timer = setTimeout(() => resolve({ tracks: [] }), timeoutMs);
        }),
    ]);
}

export async function searchAll(query, quality) {
    const q = String(query || '').trim();
    if (!q) return { tracks: [], perSource: {} };

    const results = await Promise.allSettled(
        CATALOGUE_SOURCES.map((p) => within(p.search(q, quality), SEARCH_BUDGET_MS)),
    );
    const tracks = [];
    const seen = new Set();
    const perSource = {};
    for (let i = 0; i < results.length; i++) {
        const provider = CATALOGUE_SOURCES[i];
        const result = results[i];
        if (result.status === 'rejected' || !result.value?.tracks?.length) {
            perSource[provider.id] = { ok: result.status === 'fulfilled', count: 0 };
            continue;
        }
        perSource[provider.id] = { ok: true, count: result.value.tracks.length };
        for (const row of result.value.tracks) {
            const key = `${row.title.toLowerCase()}|${row.artist.toLowerCase()}|${row.duration || ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const decoded = decodeRow(row);
            metaCache.set(decoded.id, {
                title: decoded.title,
                artist: decoded.artist,
                duration: decoded.duration || 0,
            });
            tracks.push(decoded);
            if (tracks.length >= 40) break;
        }
    }
    return { tracks, perSource };
}

export async function resolveStream(id, quality) {
    const raw = String(id || '');
    const providerId = raw.includes(':') ? raw.split(':')[0] : '';
    const cacheKey = `final:${raw}:${tierKey(quality)}`;
    const cached = streamCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const own = AUDIO_SOURCES.find((p) => p.id === providerId);
    if (own) {
        try {
            const resolved = await own.resolve(raw, quality);
            if (resolved) return streamCache.set(cacheKey, resolved);
        } catch {
        }
    }
    const cross = await crossResolve(raw, quality);
    if (cross) return streamCache.set(cacheKey, cross);
    return null;
}

async function crossResolve(id, quality) {
    const providerId = id.includes(':') ? id.split(':')[0] : '';
    let meta = metaCache.get(id);
    if (!meta && providerId === deezer.id) {
        const dzMeta = await deezer.getTrack(id);
        if (dzMeta) {
            meta = { title: dzMeta.title, artist: dzMeta.artist, duration: dzMeta.duration };
        }
    }
    if (!meta || !meta.title) return null;

    const cleanTitle = String(meta.title)
        .replace(/\s*[\(\[](?:feat|ft|with|prod)[^)\]]*[\)\]]/gi, '')
        .trim();
    const query = `${meta.artist} ${cleanTitle || meta.title}`.trim();
    const candidates = AUDIO_SOURCES.filter((p) => p.id !== providerId && typeof p.search === 'function');
    const probes = candidates.map((source) =>
        source.search(query, quality)
            .then((value) => ({ source, value }))
            .catch(() => null),
    );

    for (const pending of probes) {
        const hit = await pending;
        if (!hit) continue;
        const best = pickBestMatch(hit.value?.tracks || [], meta);
        if (!best) continue;
        try {
            const resolved = await hit.source.resolve(best.id, quality);
            if (resolved) return resolved;
        } catch {
        }
    }
    return null;
}

function pickBestMatch(rows, meta) {
    let best = null;
    let bestScore = 0;
    for (const row of rows) {
        if (norm(row.title) !== norm(meta.title)) continue;
        if (!artistsOverlap(row.artist, meta.artist)) continue;
        let score = 60;
        if (meta.duration && row.duration) {
            const drift = Math.abs(row.duration - meta.duration);
            if (drift <= 3) score += 40;
            else if (drift <= 10) score += 20;
            else if (drift <= 45) score += 8;
            else continue;
        } else {
            score += 15;
        }
        if (score > bestScore) {
            bestScore = score;
            best = row;
        }
    }
    return best;
}

function norm(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\(.*?\)|\[.*?\]/g, ' ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function artistsOverlap(a, b) {
    const parts = (v) => String(v || '')
        .split(/\s*(?:,|;|&|\bfeat\.?\b|\bft\.?\b|\band\b|\bx\b)\s*/i)
        .map((p) => norm(p))
        .filter((p) => p.length > 2);
    const pa = parts(a);
    const pb = parts(b);
    if (!pa.length || !pb.length) return false;
    if (pa.includes(pb[0]) || pb.includes(pa[0])) return true;
    const reversed = (name) => name.split(' ').reverse().join(' ');
    return pa.some((x) => pb.some((y) => x === y || reversed(x) === reversed(y)));
}

async function checkProvider(key, url, { headers = {}, timeoutMs = 8000, parse } = {}) {
    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
        const res = await fetch(url, { headers: { Accept: 'application/json', ...headers }, signal: ac.signal });
        if (!res.ok) {
            return {
                provider: key,
                configured: true,
                reachable: false,
                latencyMs: Date.now() - started,
                reason: `http ${res.status}`,
            };
        }
        let reason;
        if (parse) {
            const type = (res.headers.get('content-type') || '').toLowerCase();
            let body;
            try {
                body = await res.json();
            } catch {
                return {
                    provider: key,
                    configured: true,
                    reachable: false,
                    latencyMs: Date.now() - started,
                    reason: `non-json response (${type || 'no content-type'})`,
                };
            }
            if (!parse(body)) reason = `unexpected payload (${type || 'no content-type'})`;
        }
        const reachable = !reason;
        return {
            provider: key,
            configured: true,
            reachable,
            latencyMs: Date.now() - started,
            ...(reason ? { reason } : {}),
        };
    } catch (err) {
        return {
            provider: key,
            configured: true,
            reachable: false,
            error: String(err?.message || err),
            reason: err?.message ? `request failed (${err.message})` : 'request failed',
        };
    } finally {
        clearTimeout(timer);
    }
}

export async function health() {
    const checks = await Promise.all([
        checkProvider('qobuz', `${process.env.QOBUZ_UPSTREAM_BASE_URL || 'https://soundfean-musics.onrender.com/a'}/search?q=test&quality=LOSSLESS`, { parse: (b) => Array.isArray(b?.tracks) }),
        checkProvider('tidal', `${process.env.TIDAL_INDEX_BASE_URL || 'https://tracks.monochrome.st'}/search/tracks?q=test&limit=1`, { headers: { 'User-Agent': 'BitChord/v1.8.1', Accept: 'application/json' }, parse: (b) => Array.isArray(b?.tracks) }),
        checkProvider('monochrome', `${process.env.MONOCHROME_INDEX_BASE_URL || 'https://tracks.monochrome.st'}/search?q=test&limit=1`, { parse: (b) => Array.isArray(b?.tracks) }),
        checkProvider('netease', `${process.env.NETEASE_UPSTREAM_BASE_URL || 'https://losslessbridge.de.deplexo.com/u/tpg000.vxrtcq1VeQcF0m1koi0Ncw.ThwpJfA6x3aCvX1oGq5iV_'}/search?q=test&quality=lossless`, { headers: { 'User-Agent': 'BitChord/v1.8.1' }, timeoutMs: 10000, parse: (b) => Array.isArray(b?.tracks) }),
        checkProvider('arcod', `${process.env.ARCOD_BASE_URL || 'https://arcod.xyz'}/api/search?q=test&limit=1`, {
            timeoutMs: 10000,
            parse: (b) => b?.success === true && Array.isArray(b?.data?.tracks?.items),
        }),
        checkProvider('deezer', 'https://api.deezer.com/search?q=test&limit=1', {
            parse: (b) => Array.isArray(b?.data),
        }),
    ]);
    const audio = checks.filter((c) => AUDIO_CHECK_KEYS.includes(c.provider));
    const alive = audio.filter((c) => c.reachable);
    return {
        ok: alive.length > 0,
        node: process.version,
        audioSources: AUDIO_SOURCES.map((p) => p.name),
        audioAlive: alive.map((c) => c.provider),
        audioDown: audio
            .filter((c) => !c.reachable)
            .map((c) => ({ provider: c.provider, reason: c.reason || 'unreachable' })),
        providers: checks,
    };
}
