import type { Request, Response, NextFunction } from 'express';

const DEBUG = Boolean(process.env.DEBUG_SERVER_API);

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return function (req: Request, res: Response, next: NextFunction) {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      if (DEBUG) console.error(err);
      res.status(400).json({ error: (err as Error).message });
    });
  };
}
