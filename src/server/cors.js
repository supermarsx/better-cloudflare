import { getEnv } from '../lib/env.ts';
/**
 * Build a CORS middleware suitable for the server. The function reads
 * `ALLOWED_ORIGINS` from environment (supporting Vite-style `VITE_ALLOWED_ORIGINS`)
 * and allows either a wildcard `*` or a whitelist of origins separated by
 * commas.
 *
 * @returns express middleware handling CORS headers and preflight requests
 */
export function getCorsMiddleware() {
    const env = getEnv('ALLOWED_ORIGINS', 'VITE_ALLOWED_ORIGINS', '*');
    const allowed = new Set(env
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0));
    return function cors(req, res, next) {
        const origin = req.headers.origin;
        let allowedOrigin;
        if (allowed.has('*')) {
            allowedOrigin = '*';
        }
        else if (origin && allowed.has(origin)) {
            allowedOrigin = origin;
        }
        else if (origin) {
            res.status(403).json({ error: 'Origin not allowed' });
            return;
        }
        if (allowedOrigin) {
            res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
            res.setHeader('Vary', 'Origin');
        }
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Auth-Key, X-Auth-Email');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
        if (req.method === 'OPTIONS') {
            res.sendStatus(204);
            return;
        }
        next();
    };
}
