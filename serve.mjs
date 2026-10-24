// Serves only dist/redgifsbooru.user.js to Tampermonkey, only on this computer.
// Run: node serve.mjs
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = 8778;
const SCRIPT_NAME = 'redgifsbooru.user.js';
const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist', SCRIPT_NAME);

const server = http.createServer(async (req, res) => {
  const pathname = (req.url ?? '').split('?', 1)[0];
  let status = 404;
  if (req.method === 'GET' && pathname === `/${SCRIPT_NAME}`) {
    try {
      // Read on every request so a rebuild is served immediately.
      const body = await readFile(SCRIPT_PATH);
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(body);
      status = 200;
    } catch {
      status = 404;
    }
  }
  if (status !== 200) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
  console.log(`${req.socket.remoteAddress} "${req.method} ${req.url}" ${status}`);
});

server.listen(PORT, HOST, () => {
  console.log(`Serving ${SCRIPT_PATH} at http://${HOST}:${PORT}/${SCRIPT_NAME}`);
});
