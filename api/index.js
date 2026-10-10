import { searchAll, resolveStream, health } from '../lib/router.js';

const MANIFEST = {
  id: 'dev.akira.bitchord-hires',
  name: 'Hi-Res Lossless · Qobuz + Archive',
  version: '1.0.0',
  resources: ['search', 'stream'],
  // Only offer this addon while the phone has a lossless-capable output.
  checkValidLossless: 1,
  // Streaming is fine; BitChord should take downloads from another source.
  allowDownloads: 0,
  settings: [
    {
      key: 'quality',
      type: 'select',
      default: 'lossless',
      options: [
        { label: 'Lossless (FLAC, up to 24/192)', value: 'lossless' },
        { label: 'High (FLAC, up to 24/96)', value: 'high' },
        { label: 'Low (data saver)', value: 'low' },
      ],
    },
    {
      key: 'atmos',
      type: 'select',
      default: 'stereo',
      options: [
        { label: 'Stereo only', value: 'stereo' },
        { label: 'Dolby Atmos when available', value: 'auto' },
      ],
    },
  ],
};

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (req.method !== 'GET') {
    return json(res, 405, { error: 'method not allowed' }, { Allow: 'GET, OPTIONS' });
  }

  if (path === '/' || path === '/manifest.json') {
    return json(res, 200, MANIFEST);
  }

  if (path === '/health') {
    try {
      const report = await health();
      return json(res, 200, report);
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err?.message || err) });
    }
  }

  if (path === '/search') {
    const query = url.searchParams.get('q') || '';
    if (!query.trim()) return json(res, 200, { tracks: [] });

    try {
      const { tracks, perSource } = await searchAll(query, url.searchParams.get('quality'));
      return json(res, 200, { tracks }, { 'X-Addon-Sources': encodeURIComponent(JSON.stringify(perSource)) });
    } catch (err) {
      return json(res, 200, { tracks: [], error: String(err?.message || err) });
    }
  }

  if (path.startsWith('/stream/')) {
    const id = decodeURIComponent(path.slice('/stream/'.length));
    if (!id) return json(res, 404, { error: 'missing id' });

    const stream = await resolveStream(id, url.searchParams.get('quality'));
    if (!stream) return json(res, 404, { error: 'not available in this addon' });

    return json(res, 200, stream);
  }

  return json(res, 404, { error: 'not found' });
}