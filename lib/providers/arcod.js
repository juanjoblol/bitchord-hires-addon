import { describeAudioUrl, qualityLabel } from '../flac.js';
import { searchCache, streamCache, probeCache } from '../cache.js';

const PREFIX = 'ar';
const BASE = (process.env.ARCOD_BASE_URL || 'https://arcod.xyz').replace(/\/+$/, '');

const HEADERS = { Accept: 'application/json', 'User-Agent': 'bitchord-hires-addon/1.0' };

// arcod takes Qobuz quality ids: 27 hi-res above 96 kHz, 7 hi-res up to 96 kHz,
// 6 CD (16/44.1), 5 MP3 320. Lower ids are served when the master is not hi-res.
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

async function getJson(path, timeoutMs = 15000) {
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
  const maxSampleRate = Number(item?.maximum_sampling_rate) || 0;
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
    _isrc: item?.isrc || undefined,
    _maxSampleRate: maxSampleRate ? maxSampleRate * 1000 : undefined,
  };
}

export async function search(query, quality) {
  const q = String(query || '').trim();
  if (!q) return { tracks: [], error: null };

  return searchCache.wrap(`ar:${normaliseQuality(quality)}:${q.toLowerCase()}`, async () => {
    const payload = await getJson(`/api/search?q=${encodeURIComponent(q)}&limit=15`);
    if (payload?.error) return { tracks: [], error: payload.error };

    const items = Array.isArray(payload?.data?.tracks?.items) ? payload.data.tracks.items : [];
    const tracks = [];
    const seen = new Set();
    for (const item of items) {
      const row = mapTrack(item);
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      const { _isrc, _maxSampleRate, ...wire } = row;
      tracks.push(wire);
      if (tracks.length >= 20) break;
    }
    return { tracks, error: tracks.length ? null : 'no arcod rows' };
  });
}

// arcod hands back a signed ticket URL that expires, so the resolved url is probed for the
// real FLAC header before it is returned and cached.
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

      // The data-saver tier is allowed to be the MP3 rendition; every other tier must be FLAC
      // and must report its real resolution from the stream header.
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
        codec: described.codec,
        container: described.container || described.codec,
        manifest: 'none',
        mimeType: described.codec === 'flac' ? 'audio/flac' : 'audio/mpeg',
        encrypted: false,
        sampleRate: described.sampleRate,
        bitDepth: described.bitDepth,
        ...(described.channels ? { channels: described.channels } : {}),
        ...(described.bitrate ? { bitrate: described.bitrate } : {}),
        format: described.codec,
        quality: qualityLabel(described),
        provider: 'Arcod',
      };
    }
    return null;
  });
}

export const arcod = { id: PREFIX, key: 'arcod', name: 'Arcod', search, resolve };
