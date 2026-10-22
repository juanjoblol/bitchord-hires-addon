import { createServer } from 'node:http';
import handler from './api/index.js';

const port = Number(process.env.PORT || 8787);

createServer((req, res) => {
  handler(req, res).catch((err) => {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  });
}).listen(port, '0.0.0.0', () => {
  console.log(`juanjob hi res addon listening on http://0.0.0.0:${port}`);
});