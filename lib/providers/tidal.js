import { describeAudioUrl, qualityLabel } from '../flac.js';
import { searchCache, streamCache, probeCache } from '../cache.js';

const PREFIX = 'td';
const INDEX = (process.env.TIDAL_INDEX_BASE_URL || 'https://tracks.monochrome.st').replace(/\/+$/, '');

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'x-client': 'BiniLossless/v3.4',
  Origin: 'https://monochrome.st',
  Referer: 'https://monochrome.st/',
  Accept: 'application/json',
};

function normaliseQuality(raw) {
  const q = String(raw || 'LOSSLESS').toUpperCase();
  if (q === 'HIGH' || q.includes('HIGH')) return 'HIGH';
  if (q === 'LOW' || q.includes('LOW')) return 'LOW';
  return 'LOSSLESS';
}

async function getJson(path, timeoutMs = 9000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${INDEX}${path}`, { headers: HEADERS, signal: ac.signal });
    if (!res.ok) return { error: `index ${res.status}` };
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!type.includes('json')) return { error: `index sent ${type || 'no content-type'}` };
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

  const artist = Array.isArray(item?.artistNames) && item.artistNames.length
    ? item.artistNames.join(', ')
    : item?.artist?.name || '';

  // The index reports duration in milliseconds.
  const rawDuration = Number(item?.duration) || 0;
  const duration = rawDuration > 3600 ? Math.round(rawDuration / 1000) : rawDuration;

  const artwork = typeof item?.artwork === 'string' && /^https?:\/\//i.test(item.artwork)
    ? item.artwork
    : undefined;

  return {
    id: `${PREFIX}:${rawId}`,
    title,
    artist,
    album: item?.releaseTitle || item?.album?.title || '',
    duration: duration || undefined,
    artworkURL: artwork,
    format: 'flac',
    // The index serves one CD-quality FLAC rendition regardless of the tier asked for,
    // so nothing here is advertised as hi-res.
    audioQuality: 'LOSSLESS',
    source: 'Tidal',
  };
}

export async function search(query, quality) {
  const q = String(query || '').trim();
  if (!q) return { tracks: [], error: null };

  return searchCache.wrap(`td:${normaliseQuality(quality)}:${q.toLowerCase()}`, async () => {
    const payload = await getJson(`/search/tracks?q=${encodeURIComponent(q)}&limit=25`);
    if (payload?.error) return { tracks: [], error: payload.error };

    const items = Array.isArray(payload?.tracks) ? payload.tracks : [];
    const tracks = [];
    const seen = new Set();
    for (const item of items) {
      const row = mapTrack(item);
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      tracks.push(row);
      if (tracks.length >= 25) break;
    }
    return { tracks, error: tracks.length ? null : 'no tidal rows' };
  });
}

export async function resolve(id, quality) {
  const trackId = String(id).replace(/^td:/, '');
  if (!/^\d+$/.test(trackId)) return null;

  const tier = normaliseQuality(quality);

  return streamCache.wrap(`td:${trackId}:${tier}`, async () => {
    // Every tier maps to the same rendition: the index ignores ?quality= and always
    // returns the CD-quality FLAC, which we then read the real format out of.
    const url = `${INDEX}/track/${trackId}?quality=lossless`;
    const described = await probeCache.wrap(url, () => describeAudioUrl(url));
    if (described?.error || !described?.sampleRate || !described?.bitDepth) return null;
    if (described.codec !== 'flac') return null;

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
      provider: 'Tidal',
    };
  });
}

export const tidal = { id: PREFIX, key: 'tidal', name: 'Tidal', search, resolve };
