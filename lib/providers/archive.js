// Internet Archive — credential-free FLAC, second audio source.
//
// Real lossless files served straight from the archive's CDN with no DRM and no
// account. Catalogue is smaller and mostly live/jazz/classical/bootleg, so it is
// a fallback under Qobuz rather than a peer.

import { describeAudioUrl, qualityLabel } from '../flac.js';
import { searchCache, streamCache, probeCache } from '../cache.js';

const PREFIX = 'ia';
const SEARCH = 'https://archive.org/advancedsearch.php';
const META = 'https://archive.org/metadata';
const UA = { 'User-Agent': 'bitchord-hires-addon/1.0' };

export async function search(query) {
  const q = String(query || '').trim();
  if (!q) return { tracks: [] };

  return searchCache.wrap(`ia:${q.toLowerCase()}`, async () => {
    // NB: repeat keys must be appended individually. Putting three `fl[]` keys in
    // an object literal silently collapses to one and the response loses fields.
    const params = new URLSearchParams({
      q: `mediatype:audio AND format:"Flac" AND (title:(${q}) OR creator:(${q}))`,
      rows: '12',
      page: '1',
      output: 'json',
    });
    params.append('fl[]', 'identifier');
    params.append('fl[]', 'title');
    params.append('fl[]', 'creator');
    params.append('sort[]', 'downloads desc');

    try {
      const res = await fetch(`${SEARCH}?${params}`, { headers: UA });
      if (!res.ok) return { tracks: [] };
      const payload = await res.json();
      const docs = payload?.response?.docs || [];

      return {
        tracks: docs
          .filter((d) => d?.identifier && d?.title)
          .slice(0, 8)
          .map((d) => ({
            id: `${PREFIX}:${d.identifier}`,
            title: d.title,
            artist: Array.isArray(d.creator) ? d.creator.join(', ') : d.creator || '',
            album: '',
            artworkURL: `https://archive.org/services/img/${encodeURIComponent(d.identifier)}`,
            format: 'flac',
            audioQuality: 'LOSSLESS',
            source: 'Internet Archive',
          })),
      };
    } catch {
      return { tracks: [] };
    }
  });
}

/**
 * Pick the best FLAC file for an item and return a playable URL.
 * Prefers a track-sized file over a multi-hour concert.
 */
export async function resolve(id, quality) {
  const identifier = String(id).replace(/^ia:/, '');
  if (!identifier || identifier.includes('/')) return null;

  const tier = String(quality || 'LOSSLESS').toUpperCase();

  return streamCache.wrap(`ia:${identifier}:${tier}`, async () => {
    let payload;
    try {
      const res = await fetch(`${META}/${encodeURIComponent(identifier)}`, { headers: UA });
      if (!res.ok) return null;
      payload = await res.json();
    } catch {
      return null;
    }

    const flacs = (payload?.files || []).filter(
      (f) => /\.flac$/i.test(f.name || '') && Number(f.size) > 200_000,
    );
    if (!flacs.length) return null;

    // "1:23:45" or "12:34" -> seconds
    const runtime = String(payload?.metadata?.runtime || '');
    const seconds =
      runtime
        .split(':')
        .map(Number)
        .filter((n) => Number.isFinite(n))
        .reduce((acc, n) => (acc === null ? n : acc * 60 + n), null) || 0;

    // LOW picks the smallest decent file; anything else takes the largest.
    const bySize = flacs.slice().sort((a, b) => Number(a.size) - Number(b.size));
    const chosen = tier === 'LOW' ? bySize[0] : bySize[bySize.length - 1];

    const url = `https://archive.org/download/${encodeURIComponent(identifier)}/${encodeURIComponent(chosen.name)}`;
    const described = await probeCache.wrap(url, () => describeAudioUrl(url, { timeoutMs: 12000 }));
    if (described.error || !described.verified) return null;

    return {
      url: described.url,
      codec: described.codec,
      container: described.container,
      manifest: 'none',
      encrypted: false,
      ...(described.sampleRate ? { sampleRate: described.sampleRate } : {}),
      ...(described.bitDepth ? { bitDepth: described.bitDepth } : {}),
      ...(described.bitrate ? { bitrate: described.bitrate } : {}),
      format: described.codec,
      quality: qualityLabel(described),
      provider: 'Internet Archive',
      ...(seconds ? { note: `${chosen.name}` } : {}),
    };
  });
}

export const archive = { id: PREFIX, name: 'Internet Archive', search, resolve };