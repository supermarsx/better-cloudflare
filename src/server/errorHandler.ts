import type { Request, Response, NextFunction } from 'express';
import { getEnvBool } from '../lib/env';

const DEBUG = getEnvBool('DEBUG_SERVER_API', 'VITE_DEBUG_SERVER_API');

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

