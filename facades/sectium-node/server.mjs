/**
 * Canonical TechEmpower Node.js HTTP/1.1 keep-alive facade server.
 *
 * Endpoints:
 *   GET /plaintext -> 200 OK, text/plain, "Hello, World!" (13 bytes)
 *   GET /json      -> 200 OK, application/json, {"message":"Hello, World!"} (27 bytes)
 *
 * Usage:
 *   E:\awesome-os\bin\node.ps1 facades/sectium-node/server.mjs [--port <N>]  (default: 18082)
 */

import http from 'node:http';

function parsePort(argv) {
  let port = 18082;
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && i + 1 < argv.length) {
      port = Number.parseInt(argv[++i], 10);
    } else if (arg.startsWith('--port=')) {
      port = Number.parseInt(arg.slice(7), 10);
    }
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    port = 18082;
  }
  return port;
}

const PORT = parsePort(process.argv);
const PLAINTEXT_BODY = Buffer.from('Hello, World!', 'utf8');
const NOT_FOUND_BODY = Buffer.from('Not Found', 'utf8');

const server = http.createServer(
  {
    keepAlive: true,
    noDelay: true,
  },
  (req, res) => {
    const url = req.url;
    if (url === '/plaintext') {
      res.writeHead(200, {
        Server: 'Sectium-Node',
        'Content-Type': 'text/plain',
        'Content-Length': PLAINTEXT_BODY.length,
        Connection: 'keep-alive',
      });
      res.end(PLAINTEXT_BODY);
      return;
    }

    if (url === '/json') {
      const payload = JSON.stringify({ message: 'Hello, World!' });
      res.writeHead(200, {
        Server: 'Sectium-Node',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        Connection: 'keep-alive',
      });
      res.end(payload);
      return;
    }

    res.writeHead(404, {
      Server: 'Sectium-Node',
      'Content-Type': 'text/plain',
      'Content-Length': NOT_FOUND_BODY.length,
      Connection: 'keep-alive',
    });
    res.end(NOT_FOUND_BODY);
  },
);

server.keepAliveTimeout = 60_000;
server.headersTimeout = 65_000;

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Sectium-Node TFB server listening on http://127.0.0.1:${PORT}`);
});
