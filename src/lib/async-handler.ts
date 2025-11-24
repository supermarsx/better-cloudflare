import type { Request, Response, NextFunction } from "express";

/**
 * Express middleware wrapper for async route handlers.
 *
 * This helper ensures that rejections from promise-based route handlers are
 * forwarded to the express error middleware (next). It prevents the need to
 * wrap every handler in a try/catch.
 *
 * @param fn - async express handler (req, res, next) => Promise
 * @returns a standard express request handler that catches and forwards errors
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return function (req: Request, res: Response, next: NextFunction) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
