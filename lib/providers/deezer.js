// Deezer — catalogue only.
//
// api.deezer.com is credential-free and has a huge catalogue, but every real
// stream goes through Deezer's encrypted media endpoint, so it can never be a
// direct audio source for BitChord.
//
// Instead: Deezer widens the catalogue, and /stream resolves each row by
// re-searching Qobuz for the same title+artist, confirming the match on ISRC or
// duration, then handing back the Qobuz lossless URL. That is the same trick
// SpotiFLAC uses, and it is why you get FLAC out of a Deezer query.

const API = 'https://api.deezer.com';
const UA = { 'User-Agent': 'bitchord-hires-addon/1.0' };

export async function search(query) {
  const q = String(query || '').trim();
  if (!q) return { tracks: [] };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(`${API}/search?q=${encodeURIComponent(q)}&limit=25`, {
      headers: UA,
      signal: ac.signal,
    });
    if (!res.ok) return { tracks: [] };
    const payload = await res.json();

    const tracks = (payload?.data || [])
      .filter((t) => t?.id && t?.title)
      .slice(0, 20)
      .map((t) => ({
        id: `dz:${t.id}`,
        title: t.title,
        artist: t.artist?.name || '',
        album: t.album?.title || '',
        duration: t.duration || undefined,
        artworkURL: t.album?.cover_xl || t.album?.cover_medium || undefined,
        format: 'flac',
        audioQuality: 'LOSSLESS',
        source: 'Deezer',
        _isrc: t.isrc || null,
      }));

    return { tracks };
  } catch {
    return { tracks: [] };
  } finally {
    clearTimeout(timer);
  }
}

/** Look up one Deezer track so /stream can compare ISRC and duration. */
export async function getTrack(id) {
  const numeric = String(id).replace(/^dz:/, '');
  if (!/^\d+$/.test(numeric)) return null;
  try {
    const res = await fetch(`${API}/track/${numeric}`, { headers: UA });
    if (!res.ok) return null;
    const t = await res.json();
    if (!t?.title) return null;
    return {
      title: t.title,
      artist: t.artist?.name || '',
      album: t.album?.title || '',
      duration: t.duration || 0,
      isrc: t.isrc || null,
    };
  } catch {
    return null;
  }
}

export const deezer = { id: 'dz', name: 'Deezer', search, getTrack };