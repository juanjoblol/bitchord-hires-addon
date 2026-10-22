import { qobuz } from './providers/qobuz.js';
import { deezer } from './providers/deezer.js';
import { archive } from './providers/archive.js';
import { streamCache } from './cache.js';

// Providers that can return an actual audio URL, in resolution order.
const AUDIO_SOURCES = [qobuz, archive];

// Catalogue sources. Deezer rows are resolved later through Qobuz.
const CATALOGUE_SOURCES = [qobuz, deezer, archive];

// Internal hints used for ranking and matching. Never sent to BitChord.
function decodeRow(row) {
  const { _isrc, _hiRes, _maxSampleRate, ...rest } = row;
  return rest;
}

function tierKey(raw) {
  const q = String(raw || 'LOSSLESS').toUpperCase();
  if (q.includes('HIGH')) return 'HIGH';
  if (q.includes('LOW')) return 'LOW';
  return 'LOSSLESS';
}

export async function searchAll(query, quality) {
  const results = await Promise.allSettled(
    CATALOGUE_SOURCES.map((p) => p.search(query, quality)),
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
      tracks.push(decodeRow(row));
      if (tracks.length >= 40) break;
    }
  }

  return { tracks, perSource };
}

/**
 * Resolve one opaque id to a playable, honestly-described stream.
 * Returns null when this addon genuinely has nothing, so BitChord falls through
 * to the next source instead of showing a broken player.
 */
export async function resolveStream(id, quality) {
  const raw = String(id || '');
  const providerId = raw.includes(':') ? raw.split(':')[0] : '';

  const cached = streamCache.get(`final:${raw}:${tierKey(quality)}`);
  if (cached !== undefined) return cached;

  // 1. Direct providers (Qobuz, Internet Archive).
  for (const provider of AUDIO_SOURCES) {
    if (providerId && providerId !== provider.id) continue;
    let resolved = null;
    try {
      resolved = await provider.resolve(raw, quality);
    } catch {
      resolved = null;
    }
    if (resolved) return streamCache.set(`final:${raw}:${tierKey(quality)}`, resolved);
  }

  // 2. Catalogue-only row: find the same recording on Qobuz and return that.
  if (providerId === deezer.id) {
    const resolved = await resolveViaQobuzMatch(raw, quality);
    if (resolved) return streamCache.set(`final:${raw}:${tierKey(quality)}`, resolved);
  }

  return streamCache.set(`final:${raw}:${tierKey(quality)}`, null);
}

async function resolveViaQobuzMatch(deezerId, quality) {
  const meta = await deezer.getTrack(deezerId);
  if (!meta) return null;

  const probe = await qobuz.search(`${meta.artist} ${meta.title}`.trim(), quality);
  let best = null;
  let bestScore = 0;

  for (const row of probe.tracks || []) {
    if (norm(row.title) !== norm(meta.title)) continue;
    if (!artistsOverlap(row.artist, meta.artist)) continue;

    let score = 60;
    if (meta.duration && row.duration) {
      const drift = Math.abs(row.duration - meta.duration);
      if (drift <= 3) score += 40;
      else if (drift <= 10) score += 20;
      else continue; // different recording, not a different master
    } else {
      score += 15;
    }
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }

  if (!best) return null;
  return qobuz.resolve(best.id, quality);
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

// Compare credit strings loosely: "Davis, Miles" vs "Miles Davis" vs
// "Miles Davis, John Coltrane" should all count as overlapping.
function artistsOverlap(a, b) {
  const parts = (v) =>
    norm(v)
      .split(/\s*(?:,|;|&|\bfeat\.?\b|\band\b|\bx\b)\s*/)
      .map((p) => p.trim())
      .filter((p) => p.length > 2);

  const pa = parts(a);
  const pb = parts(b);
  if (!pa.length || !pb.length) return false;
  if (pa.includes(pb[0]) || pb.includes(pa[0])) return true;

  const reversed = (name) => name.split(' ').reverse().join(' ');
  return pa.some((x) => pb.some((y) => x === y || reversed(x) === reversed(y)));
}

export async function health() {
  const checks = [];

  const started = Date.now();
  try {
    const res = await fetch(
      `${process.env.QOBUZ_UPSTREAM_BASE_URL || 'https://qobuz-dll.vercel.app'}/api/get-music?q=test&offset=0`,
      { headers: { 'User-Agent': 'bitchord-hires-addon/1.0' } },
    );
    checks.push({
      provider: 'qobuz',
      configured: true,
      reachable: res.ok,
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    checks.push({ provider: 'qobuz', configured: true, reachable: false, error: String(err?.message || err) });
  }

  const deezerStarted = Date.now();
  try {
    const res = await fetch('https://api.deezer.com/search?q=test&limit=1');
    checks.push({ provider: 'deezer', configured: true, reachable: res.ok, latencyMs: Date.now() - deezerStarted });
  } catch (err) {
    checks.push({ provider: 'deezer', configured: true, reachable: false, error: String(err?.message || err) });
  }

  const archiveStarted = Date.now();
  try {
    const res = await fetch(
      'https://archive.org/advancedsearch.php?q=mediatype%3Aaudio&rows=1&output=json',
    );
    checks.push({ provider: 'archive', configured: true, reachable: res.ok, latencyMs: Date.now() - archiveStarted });
  } catch (err) {
    checks.push({ provider: 'archive', configured: true, reachable: false, error: String(err?.message || err) });
  }

  return {
    ok: checks.some((c) => c.reachable),
    node: process.version,
    audioSources: AUDIO_SOURCES.map((p) => p.name),
    providers: checks,
  };
}