import { getEnvBool } from '../lib/env';
const DEBUG = getEnvBool('DEBUG_SERVER_API', 'VITE_DEBUG_SERVER_API');
/**
 * Express error middleware that returns JSON responses for errors.
 *
 * The exported function is an express error handler used as the last
 * middleware in the pipeline to convert exceptions into HTTP responses.
 */
export function errorHandler(
/**
 * Error handler middleware for express.
 *
 * @param err - error object thrown by route handlers/middleware
 * @param _req - express request
 * @param res - express response
 * @param _next - express next function (currently unused)
 * @returns void
 */
err, _req, res, 
// eslint-disable-next-line @typescript-eslint/no-unused-vars
_next) {
    if (DEBUG)
        console.error(err);
    const status = err.status ?? 500;
    res.status(status).json({ error: err.message });
}
