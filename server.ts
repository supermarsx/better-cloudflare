import http from 'node:http';
import { CloudflareAPI } from './src/lib/cloudflare';

const PORT = Number(process.env.PORT ?? 3000);

function setCors(res: http.ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Auth-Key, X-Auth-Email'
  );
}

function createClient(headers: http.IncomingHttpHeaders): CloudflareAPI {
  const auth = headers['authorization'];
  const key = headers['x-auth-key'];
  const email = headers['x-auth-email'];

  if (auth && auth.toString().startsWith('Bearer ')) {
    const token = auth.toString().slice('Bearer '.length);
    return new CloudflareAPI(token);
  }
  if (key) {
    return new CloudflareAPI(key.toString(), undefined, email?.toString());
  }
  throw new Error('Missing credentials');
}

async function parseBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (!chunks.length) return undefined;
  const str = Buffer.concat(chunks).toString();
  try {
    return JSON.parse(str);
  } catch {
    return undefined;
  }
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (!req.url) throw new Error('Invalid URL');
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    const client = createClient(req.headers);

    if (req.method === 'POST' && path === '/api/verify-token') {
      await client.verifyToken();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (req.method === 'GET' && path === '/api/zones') {
      const zones = await client.getZones();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: zones }));
      return;
    }

    const zoneMatch = path.match(/^\/api\/zones\/([^/]+)\/dns_records(?:\/([^/]+))?$/);
    if (zoneMatch) {
      const zoneId = zoneMatch[1];
      const recordId = zoneMatch[2];
      if (req.method === 'GET' && !recordId) {
        const records = await client.getDNSRecords(zoneId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: records }));
        return;
      }
      if (req.method === 'POST' && !recordId) {
        const body = await parseBody(req);
        const record = await client.createDNSRecord(zoneId, body ?? {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: record }));
        return;
      }
      if (recordId && req.method === 'PUT') {
        const body = await parseBody(req);
        const record = await client.updateDNSRecord(zoneId, recordId, body ?? {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: record }));
        return;
      }
      if (recordId && req.method === 'DELETE') {
        await client.deleteDNSRecord(zoneId, recordId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
});

server.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
