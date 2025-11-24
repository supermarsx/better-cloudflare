/**
 * Server entry point and express app.
 *
 * This script creates an Express application that acts as a small HTTP
 * API proxy to Cloudflare. The server centralizes requests to Cloudflare
 * and provides a simplified API surface for the frontend. The server
 * implements the following features:
 *  - CORS handling via `getCorsMiddleware` (ALLOWED_ORIGINS env var)
 *  - JSON body parsing
 *  - Simple rate limiting (configurable window and max per IP)
 *  - Centralized error handler that returns JSON
 *  - Optional debug logging when `DEBUG_SERVER` is set
 *
 * Environment variables (with defaults):
 *  - PORT / VITE_PORT (default: 8787)
 *  - ALLOWED_ORIGINS / VITE_ALLOWED_ORIGINS (default: *)
 *  - RATE_LIMIT_WINDOW / VITE_RATE_LIMIT_WINDOW (default: 60000)
 *  - RATE_LIMIT_MAX / VITE_RATE_LIMIT_MAX (default: 100)
 *  - DEBUG_SERVER / VITE_DEBUG_SERVER (default: false)
 *
 * Example usage (development):
 *
 * ```bash
 * PORT=8787 VITE_DEBUG_SERVER=1 npm run server
 * ```
 *
 * The app is intentionally small and is designed to be used locally with
 * the frontend during development or deployed behind a reverse proxy for
 * self-hosted scenarios. It does not persist or store any secrets except
 * to forward them to the Cloudflare API.
 * @module server
 */
import express from "express";
import type { Request, Response, NextFunction } from "express";
import rateLimit from "express-rate-limit";
import { apiRouter } from "./src/server/router";
import { errorHandler } from "./src/server/errorHandler";
import {
  getEnvBool,
  getEnvNumber,
  RATE_LIMIT_WINDOW,
  RATE_LIMIT_MAX,
} from "./src/lib/env";
import { getCorsMiddleware } from "./src/server/cors";

/**
 * Express application instance. Exported for testing and integration where
 * the test runner may need to mount or shut down the server without binding
 * to a network socket.
 */
const app = express();
/**
 * Port to listen on. Reads `PORT` and `VITE_PORT` environment variables
 * followed by a default of 8787.
 */
const PORT = getEnvNumber("PORT", "VITE_PORT", 8787);
/**
 * A debug switch (boolean) to enable request logging. Controlled via
 * `DEBUG_SERVER` or `VITE_DEBUG_SERVER`.
 */
const DEBUG = getEnvBool("DEBUG_SERVER", "VITE_DEBUG_SERVER");

/**
 * Rate limiting middleware to reduce abusive traffic. Configure via ENV:
 * - `RATE_LIMIT_WINDOW`/`VITE_RATE_LIMIT_WINDOW` (ms)
 * - `RATE_LIMIT_MAX`/`VITE_RATE_LIMIT_MAX` (requests per window)
 *
 * @see RATE_LIMIT_WINDOW
 * @see RATE_LIMIT_MAX
 */
const rateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
});

// Parse JSON request bodies
app.use(express.json());
if (DEBUG) {
  // Debug middleware that prints request/response info to console when
  // the DEBUG_SERVER flag is enabled. This is intentionally simple and
  // only used during local development; don't enable in production.
  app.use((req: Request, res: Response, next: NextFunction) => {
    console.debug("Incoming request", req.method, req.originalUrl);
    res.on("finish", () => {
      console.debug(
        "Completed request",
        req.method,
        req.originalUrl,
        res.statusCode,
      );
    });
    next();
  });
}
// CORS middleware configured with ALLOWED_ORIGINS (default '*')
app.use(getCorsMiddleware());

app.use(rateLimiter);

// Register application API routes (see `src/server/router.ts`)
app.use(apiRouter);

// Error handler: returns JSON responses for errors and hides stack in prod
app.use(errorHandler);

// Start listener. Export `app` above so tests can create their own listener
// or import the app for integration tests.
app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});

/**
 * Express application instance. Exported for tests and integration.
 *
 * Import from the server module to mount this express app in a test or
 * to reuse it elsewhere.
 */
export { app };
