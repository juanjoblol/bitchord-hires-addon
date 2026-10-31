// Qobuz — the real hi-res source.
//
// Upstream: soundfean-musics (addon BitChord público con credenciales propias de
// Qobuz; sirve catálogo + URLs FLAC directas del CDN de Qobuz sin cuenta).
//   /a/search?q=...&quality=LOSSLESS  -> tracks con ids numéricos de Qobuz
//   /a/stream/{id}?quality=HI_RES     -> URL FLAC directa (encrypted: false)
//
// Se conserva el modo self-hosted (QOBUZ_REST_API) como alternativa.
//
// Calidad:
//   HI_RES    = FLAC 24-bit (hasta 192 kHz)
//   LOSSLESS  = FLAC 16/44.1
//   LOW       = MP3 320

import { describeAudioUrl, qualityLabel } from '../flac.js';
import { searchCache, streamCache, probeCache } from '../cache.js';

const PREFIX = 'qb';
const UPSTREAM = process.env.QOBUZ_UPSTREAM_BASE_URL || 'https://soundfean-musics.onrender.com/a';
const SELF_HOSTED = process.env.QOBUZ_REST_API || '';

const UA = { Accept: 'application/json' };

// Mapeo de calidad: nuestro tier -> valor que soundfean entiende.
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

async function getJson(path, timeoutMs = 12000) {
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

function trackFromUpstream(item) {
  const rawId = String(item?.id || '');
  const title = item?.title;
  if (!rawId || !title) return null;
  if (!/^\d+$/.test(rawId)) return null;

  const hires = /24[\s-]*bit/i.test(String(item?.audioQuality || ''));

  return {
    id: `${PREFIX}:${rawId}`,
    title,
    artist: item.artist || '',
    album: item.album || '',
    duration: Number(item.duration) || undefined,
    artworkURL: item.artworkURL || undefined,
    format: 'flac',
    audioQuality: hires ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
    provider: 'Qobuz',
    _hiRes: hires,
  };
}

export async function search(query, quality) {
  const q = String(query || '').trim();
  if (!q) return { tracks: [], error: null };

  return searchCache.wrap(`qb:${normaliseQuality(quality)}:${q.toLowerCase()}`, async () => {
    const payload = await getJson(`/search?q=${encodeURIComponent(q)}&quality=LOSSLESS`);
    if (payload?.error) {
      return { tracks: [], error: payload.error };
    }

    const items = payload?.tracks || [];
    const tracks = [];
    const seen = new Set();

    for (const item of items) {
      const row = trackFromUpstream(item);
      if (!row) continue;
      const key = `${row.title.toLowerCase()}|${row.artist.toLowerCase()}|${row.duration || ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push(stripInternal(row));
      if (tracks.length >= 25) break;
    }
    return { tracks, error: null };
  });
}

function stripInternal(row) {
  const { _hiRes, provider, ...rest } = row;
  return { ...rest, source: provider };
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
    const payload = await getJson(
      `/stream/${encodeURIComponent(trackId)}?quality=${upstreamQuality}`,
    );

    const url = payload?.url;
    if (payload?.error || !url) return null;
    if (!/^https:\/\//i.test(url)) return null;
    if (payload?.encrypted === true) return null;

    // soundfean devuelve metadatos precisos (sampleRate, bitDepth) leídos
    // del stream real. Confiar en ellos evita un probe extra al CDN.
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
  const timer = setTimeout(() => ac.abort(), 10000);
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

export const qobuz = { id: PREFIX, name: 'Qobuz', search, resolve };
