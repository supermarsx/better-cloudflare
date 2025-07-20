import express from 'express';
import { ServerAPI } from './src/lib/server-api';

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

app.post('/api/verify-token', (req, res) => {
  void ServerAPI.verifyToken(req, res);
});

app.get('/api/zones', (req, res) => {
  void ServerAPI.getZones(req, res);
});

app.get('/api/zones/:zone/dns_records', (req, res) => {
  void ServerAPI.getDNSRecords(req, res);
});

app.post('/api/zones/:zone/dns_records', (req, res) => {
  void ServerAPI.createDNSRecord(req, res);
});

app.put('/api/zones/:zone/dns_records/:id', (req, res) => {
  void ServerAPI.updateDNSRecord(req, res);
});

app.delete('/api/zones/:zone/dns_records/:id', (req, res) => {
  void ServerAPI.deleteDNSRecord(req, res);
});

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
