// Qobuz — the real hi-res source.
//
// Two upstream modes:
//   1. qobuz-dll  : public credential-free proxy (default). Search + signed stream URL.
//   2. selfhosted : a self-hosted qobuz-rest-api, set QOBUZ_REST_API=https://...
//
// Format ids as returned by the upstream:
//   5 = MP3 320 kbps
//   6 = FLAC 16/44.1   (CD)
//   7 = FLAC 24-bit up to 96 kHz
//   27 = FLAC 24-bit up to 192 kHz

import { describeAudioUrl, qualityLabel } from '../flac.js';
import { searchCache, streamCache, probeCache } from '../cache.js';

const PREFIX = 'qb';
const UPSTREAM = process.env.QOBUZ_UPSTREAM_BASE_URL || 'https://qobuz-dll.vercel.app';
const SELF_HOSTED = process.env.QOBUZ_REST_API || '';
const UA = { 'User-Agent': 'bitchord-hires-addon/1.0' };

// Ordered best-first, per requested tier.
const FORMATS = {
  LOSSLESS: [27, 7, 6, 5],
  HIGH: [7, 6, 5],
  LOW: [5, 6],
};
const FORMAT_CODEC = { 27: 'flac', 7: 'flac', 6: 'flac', 5: 'mp3' };

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
    const res = await fetch(`${UPSTREAM}${path}`, { headers: UA, signal: ac.signal });
    if (!res.ok) return { error: `upstream ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

function trackFromQobuz(item) {
  const id = item?.id;
  const title = item?.title;
  if (id == null || !title) return null;

  const artist = item.performer?.name || item.composer?.name || '';
  const album = item.album?.title || '';
  const artwork = item.album?.image?.large || item.album?.image?.small || undefined;
  const hires = Boolean(item.hires_streamable || item.hires);

  return {
    id: `${PREFIX}:${id}`,
    title,
    artist,
    album,
    duration: Number(item.duration) || undefined,
    artworkURL: artwork,
    format: 'flac',
    audioQuality: hires ? 'LOSSLESS' : 'LOSSLESS',
    provider: 'Qobuz',
    // kept out of the manifest payload, used only for ordering/diagnostics
    _hiRes: hires,
    _maxSampleRate: item.maximum_sampling_rate || undefined,
  };
}

export async function search(query, quality) {
  const q = String(query || '').trim();
  if (!q) return { tracks: [], error: null };

  return searchCache.wrap(`qb:${normaliseQuality(quality)}:${q.toLowerCase()}`, async () => {
    const payload = await getJson(`/api/get-music?q=${encodeURIComponent(q)}&offset=0`);
    if (payload?.error || payload?.success === false) {
      return { tracks: [], error: payload?.error || 'qobuz upstream error' };
    }
    const items = payload?.data?.tracks?.items || [];
    const tracks = [];
    const seen = new Set();

    for (const item of items) {
      const row = trackFromQobuz(item);
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
  const { _hiRes, _maxSampleRate, provider, ...rest } = row;
  return { ...rest, source: provider };
}

export async function resolve(id, quality) {
  const trackId = String(id).replace(/^qb:/, '');
  if (!/^\d+$/.test(trackId)) return null;

  const tier = normaliseQuality(quality);

  return streamCache.wrap(`qb:${trackId}:${tier}`, async () => {
    // Self-hosted mode gets the URL from qobuz-rest-api instead.
    if (SELF_HOSTED) {
      return resolveSelfHosted(trackId, tier);
    }

    for (const format of FORMATS[tier]) {
      const payload = await getJson(
        `/api/download-music?track_id=${encodeURIComponent(trackId)}&quality=${format}`,
      );
      const url = payload?.data?.url;
      if (payload?.success === false || !url) continue;
      if (!/^https:\/\//i.test(url)) continue;

      const described = await probeCache.wrap(url, () => describeAudioUrl(url));
      if (described.error) continue;

      return {
        url: described.url,
        codec: described.codec || FORMAT_CODEC[format],
        container: described.container || FORMAT_CODEC[format],
        manifest: 'none',
        encrypted: false,
        ...(described.sampleRate ? { sampleRate: described.sampleRate } : {}),
        ...(described.bitDepth ? { bitDepth: described.bitDepth } : {}),
        ...(described.bitrate ? { bitrate: described.bitrate } : {}),
        format: described.codec || FORMAT_CODEC[format],
        quality: qualityLabel(described),
        provider: 'Qobuz',
      };
    }
    return null;
  });
}

async function resolveSelfHosted(trackId, tier) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(`${SELF_HOSTED}/track/getStreamUrl?id=${encodeURIComponent(trackId)}&quality=${tier}`, {
      headers: UA,
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