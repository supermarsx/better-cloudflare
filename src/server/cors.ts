import type { Request, Response, NextFunction } from 'express';
import { getEnv } from '../lib/env.ts';

export function getCorsMiddleware() {
  const env = getEnv('ALLOWED_ORIGINS', 'VITE_ALLOWED_ORIGINS', '*')!;
  const allowed = new Set(
    env
      .split(',')
      .map((o) => o.trim())
      .filter((o) => o.length > 0),
  );

  return function cors(req: Request, res: Response, next: NextFunction) {
    const origin = req.headers.origin as string | undefined;
    if (origin && (allowed.has('*') || allowed.has(origin))) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    } else if (origin) {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }

    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Auth-Key, X-Auth-Email',
    );
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET,POST,PUT,DELETE,OPTIONS',
    );

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }

    next();
  };
}

export type CorsMiddleware = ReturnType<typeof getCorsMiddleware>;
