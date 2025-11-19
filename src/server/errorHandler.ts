import type { Request, Response, NextFunction } from 'express';
import { getEnvBool } from '../lib/env';

const DEBUG = getEnvBool('DEBUG_SERVER_API', 'VITE_DEBUG_SERVER_API');

/**
 * Express error middleware that returns JSON responses for errors.
 *
 * The exported function is an express error handler used as the last
 * middleware in the pipeline to convert exceptions into HTTP responses.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
) {
  if (DEBUG) console.error(err);
  const status = (err as { status?: number }).status ?? 500;
  res.status(status).json({ error: (err as Error).message });
}

