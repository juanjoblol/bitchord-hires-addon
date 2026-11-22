import { describeAudioUrl, qualityLabel } from '../flac.js';
import { streamCache, probeCache } from '../cache.js';

const PREFIX = 'td';
const INDEX = (process.env.TIDAL_INDEX_BASE_URL || 'https://tracks.monochrome.st').replace(/\/+$/, '');

export async function resolve(id) {
    const trackId = String(id).replace(/^td:/, '');
    if (!/^\d+$/.test(trackId) || trackId.length < 15) return null;

    return streamCache.wrap(`td:${trackId}`, async () => {
        const url = `${INDEX}/track/${trackId}`;
        const described = await probeCache.wrap(url, () => describeAudioUrl(url));
        if (described?.error || described.codec !== 'flac' || !described.sampleRate || !described.bitDepth) {
            return null;
        }

        return {
            url: described.url,
            codec: 'flac',
            container: 'flac',
            manifest: 'none',
            mimeType: 'audio/flac',
            encrypted: false,
            sampleRate: described.sampleRate,
            bitDepth: described.bitDepth,
            ...(described.channels ? { channels: described.channels } : {}),
            ...(described.bitrate ? { bitrate: described.bitrate } : {}),
            format: 'flac',
            quality: qualityLabel(described),
            provider: 'Tidal',
        };
    });
}

export const tidal = { id: PREFIX, key: 'tidal', name: 'Tidal', resolve };
