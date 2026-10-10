// Read the truth out of a FLAC file instead of asserting it.
// STREAMINFO is always the first metadata block, so a 64-byte Range read is enough.

const HEADER_BYTES = 64;

function parseStreamInfo(bytes) {
  if (bytes.length < 42) return null;
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'fLaC') return null;
  if (bytes[4] >> 7 !== 0) return null; // first block must be STREAMINFO

  const si = bytes.subarray(8, 42);
  const sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
  const channels = ((si[12] >> 1) & 0x7) + 1;
  const bitDepth = (((si[12] & 0x1) << 4) | (si[13] >> 4)) + 1;
  const totalSamples =
    (si[13] & 0x0f) * 2 ** 32 + ((si[14] << 24) >>> 0) + (si[15] << 16) + (si[16] << 8) + si[17];

  if (!sampleRate) return null;
  return {
    sampleRate,
    channels,
    bitDepth,
    totalSamples,
    duration: totalSamples / sampleRate,
  };
}

function totalBytesFromRange(contentRange) {
  if (!contentRange) return null;
  const m = /\/(\d+)\s*$/.exec(contentRange);
  return m ? Number(m[1]) : null;
}

/**
 * Probe a URL and report what it actually is.
 * Never throws: an unreadable URL returns a minimal description.
 */
export async function describeAudioUrl(url, { timeoutMs = 9000 } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${HEADER_BYTES - 1}`, 'User-Agent': 'bitchord-hires-addon/1.0' },
      signal: ac.signal,
      redirect: 'follow',
    });
    if (!res.ok && res.status !== 206) {
      return { url, error: `probe returned ${res.status}` };
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    const total = totalBytesFromRange(res.headers.get('content-range'));
    const stream = parseStreamInfo(bytes);
    const type = (res.headers.get('content-type') || '').toLowerCase();

    if (stream) {
      const duration = stream.duration;
      const bitrate = duration > 0 && total ? Math.round((total * 8) / duration) : undefined;
      return {
        url,
        codec: 'flac',
        container: 'flac',
        manifest: 'none',
        encrypted: false,
        sampleRate: stream.sampleRate,
        bitDepth: stream.bitDepth,
        channels: stream.channels,
        duration,
        ...(bitrate ? { bitrate } : {}),
        verified: true,
      };
    }

    // MP3 fallback (Qobuz fmt=5, and some lossless-CDN fallbacks).
    if (type.includes('mpeg') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
      return { url, codec: 'mp3', container: 'mp3', manifest: 'none', encrypted: false, verified: true };
    }

    return { url, error: 'unrecognised container' };
  } catch (err) {
    return { url, error: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// Exported only so the test suite can exercise the parser without a network call.
export const __test = { parseStreamInfo };

export function qualityLabel(desc) {
  if (desc.codec === 'flac' && desc.sampleRate) {
    const depth = desc.bitDepth ? `${desc.bitDepth}-bit` : 'lossless';
    return `Lossless · ${depth} / ${(desc.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`;
  }
  if (desc.codec === 'mp3') return 'MP3 320 kbps';
  return 'Unknown';
}