import http from 'node:http';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

const API_BASE = 'https://api.cloudflare.com/client/v4';
const PORT = Number(process.env.PORT ?? 8787);
const DEBUG = Boolean(process.env.DEBUG_PROXY);

function setCorsHeaders(res: ServerResponse): void {
  if (res.headersSent) {
    return;
  }
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Auth-Email, X-Auth-Key'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,PATCH,OPTIONS');
}

const server = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
  setCorsHeaders(res);
  console.log(`Incoming request: ${req.method} ${req.url}`);
  if (req.method === 'OPTIONS') {
    console.log(`CORS preflight for ${req.url}`);
    res.writeHead(204);
    res.end();
    return;
  }

  const chunks: Buffer[] = [];
  req.on('data', chunk => chunks.push(chunk as Buffer));
  req.on('end', async () => {
    const body = Buffer.concat(chunks);
    try {
      const headers = { ...req.headers } as Record<string, string>;
      if (req.method === 'GET' || req.method === 'HEAD') {
        delete headers['content-length'];
      }
      headers.host = 'api.cloudflare.com';

      const sanitizedHeaders = { ...headers };
      if (sanitizedHeaders.authorization) sanitizedHeaders.authorization = '[redacted]';
      if (sanitizedHeaders['x-auth-key']) sanitizedHeaders['x-auth-key'] = '[redacted]';
      if (DEBUG) {
        console.debug('Proxy request headers:', sanitizedHeaders);
        if (body.length) {
          console.debug('Proxy request body:', body.toString());
        }
      }

      console.log(`Forwarding to ${API_BASE}${req.url}`);
      const cfRes = await fetch(`${API_BASE}${req.url}`, {
        method: req.method,
        headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });

      if (DEBUG) {
        console.debug('Cloudflare response status:', cfRes.status, cfRes.statusText);
        console.debug(
          'Cloudflare response headers:',
          Object.fromEntries(cfRes.headers.entries())
        );
        try {
          const text = await cfRes.clone().text();
          console.debug('Cloudflare response body:', text);
        } catch (err) {
          console.debug('Cloudflare response body read error:', err);
        }
      }

      res.writeHead(cfRes.status, Object.fromEntries(cfRes.headers.entries()));
      if (cfRes.body) {
        const body: unknown = cfRes.body;
        if (typeof (body as { pipe?: unknown }).pipe === 'function') {
          (body as unknown as { pipe: (d: ServerResponse) => void }).pipe(res);
        } else {
          Readable.fromWeb(body as ReadableStream<Uint8Array>).pipe(res);
        }
      } else {
        res.end();
      }
      console.log(`Cloudflare response: ${cfRes.status} ${cfRes.statusText}`);
    } catch (err) {
      console.error('Proxy error:', err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end(String(err));
      } else {
        res.end();
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Proxy listening on http://localhost:${PORT}`);
});
