
import { qualityLabel, describeAudioUrl } from '../flac.js';
import { searchCache, streamCache } from '../cache.js';

const PREFIX = 'ne';
const UPSTREAM = process.env.NETEASE_UPSTREAM_BASE_URL || 'https://losslessbridge.de.deplexo.com/u/tpg000.vxrtcq1VeQcF0m1koi0Ncw.ThwpJfA6x3aCvX1oGq5iV_';
const METING = process.env.NETEASE_METING_BASE_URL || 'https://api.qijieya.cn/meting/';

const UA = { 'User-Agent': 'BitChord/v1.8.1', Accept: 'application/json' };
const METING_UA = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: '*/*',
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(path, timeoutMs = 12000, attempts = 1) {
  let lastError = 'upstream unreachable';
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${UPSTREAM}${path}`, { headers: UA, signal: ac.signal });
      if (res.ok) {
        const body = await res.json();
        if (!body?.error) return body;
        lastError = String(body.error);
      } else {
        lastError = `upstream ${res.status}`;
      }
    } catch (err) {
      lastError = String(err?.message || err);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await wait(350 * attempt);
  }
  return { error: lastError };
}

function bridgeTracks(rows) {
  const tracks = [];
  const seen = new Set();
  for (const item of rows) {
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
  return tracks;
}

function metingId(value) {
  const match = /[?&]id=(\d+)/.exec(String(value || ''));
  return match ? match[1] : '';
}

async function metingSearch(query, timeoutMs = 8000, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(
        `${METING}?server=netease&type=search&id=${encodeURIComponent(query)}&limit=15`,
        { headers: METING_UA, signal: ac.signal },
      );
      if (res.ok) {
        const rows = await res.json();
        if (!Array.isArray(rows)) throw new Error('malformed meting response');
        const tracks = [];
        const seen = new Set();
        for (const item of rows) {
          const rawId = metingId(item?.url);
          if (!rawId || !item?.name || seen.has(rawId)) continue;
          seen.add(rawId);
          const artist = Array.isArray(item.artist) ? item.artist.join(', ') : String(item.artist || '');
          tracks.push({
            id: `${PREFIX}:${rawId}`,
            title: item.name,
            artist,
            album: String(item.album || ''),
            artworkURL: item.pic || undefined,
            format: 'flac',
            audioQuality: 'LOSSLESS',
            source: 'Netease',
          });
          if (tracks.length >= 15) break;
        }
        return tracks;
      }
    } catch {
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await wait(350 * attempt);
  }
  return [];
}

export async function search(query, quality) {
  const q = String(query || '').trim();
  if (!q) return { tracks: [], error: null };

  const key = `ne:${q.toLowerCase()}`;
  const cached = searchCache.get(key);
  if (cached) return cached;

  const payload = await getJson(`/search?q=${encodeURIComponent(q)}&quality=lossless`, 15000, 1);
  let tracks = Array.isArray(payload?.tracks) ? bridgeTracks(payload.tracks) : [];
  let error = payload?.error || null;
  if (!tracks.length) {
    tracks = await metingSearch(q);
    error = tracks.length ? null : error || 'no netease rows';
  }

  const result = { tracks, error };
  if (tracks.length) searchCache.set(key, result);
  return result;
}

function streamFrom(url, meta) {
  const sampleRate = Number(meta.sampleRate) || 44100;
  const bitDepth = Number(meta.bitDepth) || 16;
  return {
    url,
    codec: meta.codec || 'flac',
    container: meta.container || 'flac',
    manifest: 'none',
    encrypted: false,
    sampleRate,
    bitDepth,
    ...(meta.bitrate ? { bitrate: meta.bitrate } : {}),
    ...(meta.channels ? { channels: meta.channels } : {}),
    format: 'flac',
    quality: qualityLabel({ codec: 'flac', sampleRate, bitDepth }),
    provider: 'Netease',
  };
}

async function bridgeStream(trackId, upstreamQuality) {
  const payload = await getJson(`/stream/ne_${trackId}?quality=${upstreamQuality}`, 12000, 2);
  const url = payload?.url;
  if (payload?.error || !url || payload?.encrypted === true) return null;
  if (!/^https:\/\//i.test(url)) return null;
  return streamFrom(url, payload);
}

async function metingStream(trackId, timeoutMs = 9000, attempts = 2) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${METING}?server=netease&type=url&id=${trackId}&br=999000`, {
        headers: METING_UA,
        signal: ac.signal,
        redirect: 'manual',
      });
      const url = res.headers.get('location');
      if (url && /^https:\/\//i.test(url)) {
        const described = await describeAudioUrl(url, { timeoutMs: 6000 });
        if (described?.codec === 'flac') return streamFrom(url, described);
      }
    } catch {
    } finally {
      clearTimeout(timer);
    }
    if (attempt < attempts) await wait(350 * attempt);
  }
  return null;
}

export async function resolve(id, quality) {
  const trackId = String(id).replace(/^ne:/, '');
  if (!/^\d+$/.test(trackId)) return null;

  const tier = String(quality || 'LOSSLESS').toUpperCase();
  const upstreamQuality = tier.includes('LOW') ? 'low' : tier.includes('HIGH') ? 'high' : 'lossless';
  const key = `ne:${trackId}:${upstreamQuality}`;
  const cached = streamCache.get(key);
  if (cached) return cached;

  const stream = (await bridgeStream(trackId, upstreamQuality)) || (await metingStream(trackId));
  if (stream) streamCache.set(key, stream);
  return stream;
}

export const netease = { id: PREFIX, key: 'netease', name: 'Netease', search, resolve };
