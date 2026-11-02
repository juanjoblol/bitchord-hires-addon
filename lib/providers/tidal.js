
import { describeAudioUrl, qualityLabel } from '../flac.js';
import { streamCache, probeCache } from '../cache.js';

const PREFIX = 'td';
const UPSTREAM = process.env.TIDAL_UPSTREAM_BASE_URL || 'https://losslessbridge.de.deplexo.com';
const UA = { 'User-Agent': 'bitchord-hires-addon/1.0' };

function normaliseQuality(raw) {
  const q = String(raw || 'LOSSLESS').toUpperCase();
  if (q.includes('HIGH')) return 'HIGH';
  if (q.includes('LOW')) return 'LOW';
  return 'LOSSLESS';
}

async function getJson(path, timeoutMs = 10000) {
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

export async function search(query, quality) {
  const q = String(query || '').trim();
  if (!q) return { tracks: [] };

  const payload = await getJson(`/search?q=${encodeURIComponent(q)}`);
  if (payload?.error || !payload?.tracks?.length) {
    return { tracks: [], error: payload?.error || null };
  }

  return {
    tracks: payload.tracks
      .filter((t) => t?.id && t?.title)
      .slice(0, 25)
      .map((t) => {
        const tidalId = String(t.id).replace(/^td:/, '');
        return {
          id: `${PREFIX}:${tidalId}`,
          title: t.title,
          artist: t.artist || '',
          album: t.album || '',
          duration: Number(t.duration) || undefined,
          artworkURL: t.artworkURL || undefined,
          format: 'flac',
          audioQuality: 'LOSSLESS',
          source: 'Tidal',
        };
      }),
  };
}

export async function resolve(id, quality) {
  const tidalId = String(id).replace(/^td:/, '');
  if (!tidalId || tidalId.includes('/') || tidalId.includes(':')) return null;

  const tier = normaliseQuality(quality);

  return streamCache.wrap(`td:${tidalId}:${tier}`, async () => {
    const payload = await getJson(`/stream/${tidalId}?quality=${tier}`);
    const url = payload?.url;
    if (!url || payload?.error) return null;
    if (!/^https:\/\//i.test(url)) return null;

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
      ...(described.bitrate ? { bitrate: described.bitrate } : {}),
      format: described.codec || 'flac',
      quality: qualityLabel(described),
      provider: 'Tidal',
    };
  });
}

export const tidal = { id: PREFIX, name: 'Tidal', search, resolve };