import assert from 'node:assert/strict';
import { describeAudioUrl } from '../lib/flac.js';
import { searchAll, resolveStream } from '../lib/router.js';

export async function run() {
  // ---- qualityLabel / description honesty -------------------------------------
  const bogus = await describeAudioUrl('https://example.com/does-not-exist.flac', { timeoutMs: 5000 });
  assert.ok(bogus.error, 'unreachable URL should report an error, not a fake stream');

  const notAudio = await describeAudioUrl('https://example.com/', { timeoutMs: 5000 });
  assert.ok(notAudio.error || notAudio.verified !== true, 'HTML must never be reported as audio');

  // ---- contract: /search shape ------------------------------------------------
  const res = await searchAll('miles davis so what', 'LOSSLESS');
  assert.ok(res.tracks.length > 0, 'search returned nothing');

  for (const t of res.tracks) {
    assert.ok(typeof t.id === 'string' && t.id.length > 0, `row missing id: ${JSON.stringify(t)}`);
    assert.ok(typeof t.title === 'string' && t.title.length > 0, `row missing title: ${JSON.stringify(t)}`);
    if (t.artworkURL) {
      assert.match(t.artworkURL, /^https?:\/\//, `artwork must be absolute: ${t.artworkURL}`);
    }
    if (t.duration !== undefined) {
      assert.ok(Number.isFinite(t.duration) && t.duration > 0, `bad duration: ${t.duration}`);
    }
    assert.ok(!('_isrc' in t) && !('_hiRes' in t), 'internal hints leaked to BitChord');
  }

  // ---- contract: /stream shape ------------------------------------------------
  const qb = res.tracks.find((t) => t.id.startsWith('qb:'));
  assert.ok(qb, 'expected a qobuz row');

  const stream = await resolveStream(qb.id, 'LOSSLESS');
  assert.ok(stream, 'stream did not resolve');
  assert.match(stream.url, /^https:\/\//, 'stream url must be absolute https');
  assert.equal(stream.encrypted, false, 'never advertise an encrypted rendition');
  assert.ok(stream.codec, 'codec must be reported');
  assert.ok(stream.manifest, 'transport must be declared');
  if (stream.codec === 'flac') {
    assert.ok(stream.sampleRate >= 44100, `implausible sample rate: ${stream.sampleRate}`);
    assert.ok([16, 24].includes(stream.bitDepth), `unexpected bit depth: ${stream.bitDepth}`);
  }

  // ---- cache must not poison later calls --------------------------------------
  const cached = await resolveStream(qb.id, 'LOSSLESS');
  assert.equal(cached.url, stream.url, 'cached resolution changed');

  // ---- honest misses ----------------------------------------------------------
  assert.equal(await resolveStream('qb:999999999', 'LOSSLESS'), null);
  assert.equal(await resolveStream('dz:999999999', 'LOSSLESS'), null);
  assert.equal(await resolveStream('nonsense', 'LOSSLESS'), null);
  assert.equal((await searchAll('   ', 'LOSSLESS')).tracks.length, 0);

  return {
    tracks: res.tracks.length,
    perSource: res.perSource,
    stream: {
      quality: stream.quality,
      codec: stream.codec,
      sampleRate: stream.sampleRate,
      bitDepth: stream.bitDepth,
      bitrate: stream.bitrate,
    },
  };
}