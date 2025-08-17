import express from 'express';
import { apiRouter } from './src/server/router';
import { errorHandler } from './src/server/errorHandler';
import { getEnvBool, getEnvNumber } from './src/lib/env';
import { getCorsMiddleware } from './src/server/cors';

const app = express();
const PORT = getEnvNumber('PORT', 'VITE_PORT', 8787);
const DEBUG = getEnvBool('DEBUG_SERVER', 'VITE_DEBUG_SERVER');

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
app.use(getCorsMiddleware());

app.use(apiRouter);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
