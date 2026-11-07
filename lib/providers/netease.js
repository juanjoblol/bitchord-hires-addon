
import { qualityLabel } from '../flac.js';
import { searchCache, streamCache } from '../cache.js';

const PREFIX = 'ne';
const UPSTREAM = process.env.NETEASE_UPSTREAM_BASE_URL || 'https://losslessbridge.de.deplexo.com/u/tpg000.vxrtcq1VeQcF0m1koi0Ncw.ThwpJfA6x3aCvX1oGq5iV_';

const UA = { 'User-Agent': 'BitChord/v1.8.1', Accept: 'application/json' };

async function getJson(path, timeoutMs = 9000) {
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
  if (!q) return { tracks: [], error: null };

  return searchCache.wrap(`ne:${q.toLowerCase()}`, async () => {
    const payload = await getJson(`/search?q=${encodeURIComponent(q)}&quality=lossless`);
    if (payload?.error || !Array.isArray(payload?.tracks)) {
      return { tracks: [], error: payload?.error || 'no rows' };
    }

    const tracks = [];
    const seen = new Set();

    for (const item of payload.tracks) {
      const rawId = String(item?.id || '').replace(/^ne_/, '');
      if (!/^\d+$/.test(rawId) || !item?.title) continue;
      const key = `${item.title.toLowerCase()}|${String(item.artist || '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tracks.push({
        id: `${PREFIX}:${rawId}`,
        title: item.title,
        artist: item.artist || '',
        album: item.album || '',
        duration: Number(item.duration) || undefined,
        artworkURL: item.artworkURL || undefined,
        format: 'flac',
        audioQuality: 'LOSSLESS',
        source: 'Netease',
      });
      if (tracks.length >= 15) break;
    }

    return { tracks, error: tracks.length ? null : 'no netease rows' };
  });
}

export async function resolve(id, quality) {
  const trackId = String(id).replace(/^ne:/, '');
  if (!/^\d+$/.test(trackId)) return null;

  const tier = String(quality || 'LOSSLESS').toUpperCase();
  const upstreamQuality = tier.includes('LOW') ? 'low' : tier.includes('HIGH') ? 'high' : 'lossless';

  return streamCache.wrap(`ne:${trackId}:${upstreamQuality}`, async () => {
    const payload = await getJson(`/stream/ne_${trackId}?quality=${upstreamQuality}`, 12000);
    const url = payload?.url;
    if (payload?.error || !url || payload?.encrypted === true) return null;
    if (!/^https:\/\//i.test(url)) return null;

    const sampleRate = Number(payload.sampleRate) || 44100;
    const bitDepth = Number(payload.bitDepth) || 16;

    return {
      url,
      codec: payload.codec || 'flac',
      container: payload.container || 'flac',
      manifest: 'none',
      encrypted: false,
      sampleRate,
      bitDepth,
      ...(payload.bitrate ? { bitrate: payload.bitrate } : {}),
      format: 'flac',
      quality: qualityLabel({ codec: 'flac', sampleRate, bitDepth }),
      provider: 'Netease',
    };
  });
}

export const netease = { id: PREFIX, key: 'netease', name: 'Netease', search, resolve };
