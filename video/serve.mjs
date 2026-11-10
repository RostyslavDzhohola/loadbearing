// Minimal static server for the repo root (ES modules need http, not file://).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png' };
export function serve(root, port = 0) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
      try {
        const body = await readFile(join(root, path.endsWith('/') ? path + 'index.html' : path));
        res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'text/html' }).end(body);
      } catch { res.writeHead(404).end('not found'); }
    });
    server.listen(port, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
export const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
