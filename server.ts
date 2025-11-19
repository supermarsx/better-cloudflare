/**
 * Server entry point. This Express app exposes the application's API for
 * interacting with Cloudflare via a proxy and performs minimal security and
 * rate limiting. The server is intended to be started using `node server.ts`
 * or during development via Vite proxy-enabled setup.
 */
import express from 'express';
import rateLimit from 'express-rate-limit';
import { apiRouter } from './src/server/router';
import { errorHandler } from './src/server/errorHandler';
import {
  getEnvBool,
  getEnvNumber,
  RATE_LIMIT_WINDOW,
  RATE_LIMIT_MAX,
} from './src/lib/env';
import { getCorsMiddleware } from './src/server/cors';

const app = express();
const PORT = getEnvNumber('PORT', 'VITE_PORT', 8787);
const DEBUG = getEnvBool('DEBUG_SERVER', 'VITE_DEBUG_SERVER');

const rateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
});

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

app.use(rateLimiter);

app.use(apiRouter);

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});
