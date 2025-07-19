import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const PORT = Number(process.env.PORT ?? 8787);

function sendCorsHeaders(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
}

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === 'OPTIONS') {
    sendCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', chunk => chunks.push(chunk as Buffer));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    try {
      const cfRes = await fetch(`${API_BASE}${req.url}`, {
        method: req.method,
        headers: {
          ...req.headers,
          host: 'api.cloudflare.com',
        } as Record<string, string>,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });

      const headers = Object.fromEntries(cfRes.headers.entries());
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
      headers['Access-Control-Allow-Methods'] = 'GET,POST,PUT,DELETE,PATCH,OPTIONS';
      res.writeHead(cfRes.status, headers);
      if (cfRes.body) {
        cfRes.body.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      sendCorsHeaders(res);
      res.writeHead(500);
      res.end(String(err));
    }
  });
});

server.listen(PORT, () => {
  console.log(`Proxy listening on http://localhost:${PORT}`);
});
