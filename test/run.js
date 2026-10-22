import { describeAudioUrl, qualityLabel } from '../lib/flac.js';
import { searchAll, resolveStream, health } from '../lib/router.js';

let pass = 0;
let fail = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name} ${detail}`);
  }
}

console.log('\n== FLAC header parsing ==');
{
  // Hand-build a STREAMINFO block so the parser is tested without a network round-trip.
  function buildStreamInfo(sampleRate, channels, bitDepth, totalSamples) {
    const bytes = new Uint8Array(42);
    bytes.set([0x66, 0x4c, 0x61, 0x43], 0); // "fLaC"
    bytes[4] = 0x00; // first block, type 0 (STREAMINFO), not last
    bytes[5] = 0x00;
    bytes[6] = 0x22; // length 34
    const si = 8;
    bytes[si + 10] = (sampleRate >> 12) & 0xff;
    bytes[si + 11] = (sampleRate >> 4) & 0xff;
    bytes[si + 12] = ((sampleRate & 0x0f) << 4) | ((channels - 1) << 1) | (((bitDepth - 1) >> 4) & 0x1);
    bytes[si + 13] = (((bitDepth - 1) & 0x0f) << 4) | ((Math.floor(totalSamples / 2 ** 32)) & 0x0f);
    bytes[si + 14] = (totalSamples >>> 24) & 0xff;
    bytes[si + 15] = (totalSamples >>> 16) & 0xff;
    bytes[si + 16] = (totalSamples >>> 8) & 0xff;
    bytes[si + 17] = totalSamples & 0xff;
    return bytes;
  }

  const { parseStreamInfoForTest } = await import('../lib/flac.js').then((m) => ({
    parseStreamInfoForTest: m.__test?.parseStreamInfo,
  }));

  const hiRes = buildStreamInfo(192000, 2, 24, 547 * 192000);
  const parsed = parseStreamInfoForTest(hiRes);
  ok('reads 192 kHz', parsed?.sampleRate === 192000, String(parsed?.sampleRate));
  ok('reads 24-bit', parsed?.bitDepth === 24, String(parsed?.bitDepth));
  ok('reads 2 channels', parsed?.channels === 2, String(parsed?.channels));
  ok('derives duration', Math.abs(parsed.duration - 547) < 1, String(parsed?.duration));

  const cd = buildStreamInfo(44100, 2, 16, 2723 * 44100);
  const parsedCd = parseStreamInfoForTest(cd);
  ok('reads CD quality', parsedCd?.sampleRate === 44100 && parsedCd?.bitDepth === 16);

  const notFlac = new Uint8Array(42).fill(0x3c);
  ok('rejects non-fLaC magic', parseStreamInfoForTest(notFlac) === null);
  ok('rejects truncated header', parseStreamInfoForTest(hiRes.slice(0, 20)) === null);
}

console.log('\n== Qobuz search ==');
{
  const res = await searchAll('so what miles davis', 'LOSSLESS');
  ok('search returns tracks', res.tracks.length > 0, `got ${res.tracks.length}`);
  const row = res.tracks[0];
  ok('rows have id and title', Boolean(row?.id && row?.title));
  ok('rows have absolute artwork url', /^https:\/\//.test(row?.artworkURL || ''), row?.artworkURL);
  ok('at least one qobuz row', res.perSource?.qb?.count > 0, JSON.stringify(res.perSource));
  console.log('   sample:', JSON.stringify(res.tracks.slice(0, 3).map((t) => ({
    id: t.id, title: t.title, artist: t.artist, dur: t.duration, src: t.source,
  })), null, 0));
}

console.log('\n== Qobuz stream (lossless) ==');
{
  const res = await searchAll('so what miles davis', 'LOSSLESS');
  const row = res.tracks.find((t) => t.id.startsWith('qb:'));
  if (!row) {
    ok('found a qobuz row to resolve', false);
  } else {
    const stream = await resolveStream(row.id, 'LOSSLESS');
    ok('stream resolved', Boolean(stream?.url));
    ok('url is https', /^https:\/\//.test(stream?.url || ''));
    ok('encrypted is false', stream?.encrypted === false);
    ok('codec reported', Boolean(stream?.codec), stream?.codec);
    ok('sampleRate reported', Boolean(stream?.sampleRate), String(stream?.sampleRate));
    ok('bitDepth reported', Boolean(stream?.bitDepth), String(stream?.bitDepth));
    ok('quality label readable', typeof stream?.quality === 'string', stream?.quality);
    console.log('   stream:', JSON.stringify({
      quality: stream.quality, codec: stream.codec, sr: stream.sampleRate,
      bd: stream.bitDepth, br: stream.bitrate,
    }));
  }
}

console.log('\n== Deezer catalogue row resolves through Qobuz ==');
{
  const res = await searchAll('miles davis so what', 'LOSSLESS');
  const dz = res.tracks.find((t) => t.id.startsWith('dz:'));
  ok('deezer produced a row', Boolean(dz), dz ? dz.title : 'none');
  if (dz) {
    const stream = await resolveStream(dz.id, 'LOSSLESS');
    ok('deezer row resolves to a stream', Boolean(stream?.url));
    ok('resolved via Qobuz', stream?.provider === 'Qobuz', stream?.provider);
    console.log('   resolved:', JSON.stringify({
      from: dz.title, quality: stream?.quality, provider: stream?.provider,
    }));
  }
}

console.log('\n== Misses and bad input ==');
{
  const bogus = await resolveStream('qb:999999999', 'LOSSLESS');
  ok('unknown qobuz id returns null', bogus === null);
  const badPrefix = await resolveStream('xx:not-an-id', 'LOSSLESS');
  ok('unknown prefix returns null', badPrefix === null);
  const empty = await searchAll('', 'LOSSLESS');
  ok('empty query returns no tracks', empty.tracks.length === 0);
}

console.log('\n== Health ==');
{
  const report = await health();
  ok('health responds', typeof report === 'object');
  ok('qobuz reachable', report.providers.find((p) => p.provider === 'qobuz')?.reachable);
  ok('deezer reachable', report.providers.find((p) => p.provider === 'deezer')?.reachable);
  console.log('   ' + JSON.stringify(report.providers));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);