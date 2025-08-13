import type { Request, Response, NextFunction } from 'express';

const DEBUG = Boolean(process.env.DEBUG_SERVER_API);

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (DEBUG) console.error(err);
  const status =
    typeof err === 'object' && err && 'status' in err
      ? (err as { status?: number }).status
      : undefined;
  res.status(status ?? 500).json({ error: (err as Error).message });
}

