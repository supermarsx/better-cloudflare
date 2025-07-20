import express from 'express';
import { CloudflareAPI } from './src/lib/cloudflare';

const app = express();
const PORT = Number(process.env.PORT ?? 8787);
const DEBUG = Boolean(process.env.DEBUG_SERVER);

app.use(express.json());
if (DEBUG) {
  app.use((req, res, next) => {
    console.debug('Incoming request', req.method, req.originalUrl);
    res.on('finish', () => {
      console.debug(
        'Completed request',
        req.method,
        req.originalUrl,
        res.statusCode,
      );
    });
    next();
  });
}
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-Auth-Key, X-Auth-Email'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

function createClient(req: express.Request): CloudflareAPI {
  const auth = req.header('authorization');
  if (auth?.startsWith('Bearer ')) {
    if (DEBUG) console.debug('Using bearer token for Cloudflare API');
    return new CloudflareAPI(auth.slice(7));
  }
  const key = req.header('x-auth-key');
  const email = req.header('x-auth-email');
  if (key && email) {
    if (DEBUG) console.debug('Using key/email for Cloudflare API');
    return new CloudflareAPI(key, undefined, email);
  }
  throw new Error('Missing Cloudflare credentials');
}

app.post('/api/verify-token', async (req, res) => {
  try {
    const client = createClient(req);
    await client.verifyToken();
    res.json({ success: true });
  } catch (err) {
    if (DEBUG) console.error(err);
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get('/api/zones', async (req, res) => {
  try {
    const client = createClient(req);
    const zones = await client.getZones();
    res.json(zones);
  } catch (err) {
    if (DEBUG) console.error(err);
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get('/api/zones/:zone/dns_records', async (req, res) => {
  try {
    const client = createClient(req);
    const records = await client.getDNSRecords(req.params.zone);
    res.json(records);
  } catch (err) {
    if (DEBUG) console.error(err);
    res.status(400).json({ error: (err as Error).message });
  }
});

app.post('/api/zones/:zone/dns_records', async (req, res) => {
  try {
    const client = createClient(req);
    const record = await client.createDNSRecord(req.params.zone, req.body);
    res.json(record);
  } catch (err) {
    if (DEBUG) console.error(err);
    res.status(400).json({ error: (err as Error).message });
  }
});

app.put('/api/zones/:zone/dns_records/:id', async (req, res) => {
  try {
    const client = createClient(req);
    const record = await client.updateDNSRecord(
      req.params.zone,
      req.params.id,
      req.body
    );
    res.json(record);
  } catch (err) {
    if (DEBUG) console.error(err);
    res.status(400).json({ error: (err as Error).message });
  }
});

app.delete('/api/zones/:zone/dns_records/:id', async (req, res) => {
  try {
    const client = createClient(req);
    await client.deleteDNSRecord(req.params.zone, req.params.id);
    res.json({ success: true });
  } catch (err) {
    if (DEBUG) console.error(err);
    res.status(400).json({ error: (err as Error).message });
  }
});

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
