import express from 'express';
import { apiRouter } from './src/server/router';

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

app.use(apiRouter);

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
