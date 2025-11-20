import { CloudflareAPI } from './cloudflare';
import { dnsRecordSchema } from './validation';
import { getEnvBool } from './env';
const DEBUG = getEnvBool('DEBUG_SERVER_API', 'VITE_DEBUG_SERVER_API');
/**
 * Build a CloudflareAPI client from the request's authentication headers.
 *
 * Supports either a `Bearer <token>` authorization header or a pair of
 * `x-auth-key` and `x-auth-email` headers. Throws a 400 error if neither
 * method is supplied.
 *
 * @param req - express request object
 * @returns an instance of CloudflareAPI configured with the appropriate creds
 */
function createClient(req) {
    const auth = req.header('authorization');
    if (auth?.startsWith('Bearer ')) {
        if (DEBUG)
            console.debug('Using bearer token for Cloudflare API');
        return new CloudflareAPI(auth.slice(7));
    }
    const key = req.header('x-auth-key');
    const email = req.header('x-auth-email');
    if (key && email) {
        if (DEBUG)
            console.debug('Using key/email for Cloudflare API');
        return new CloudflareAPI(key, undefined, email);
    }
    const err = new Error('Missing Cloudflare credentials');
    err.status = 400;
    throw err;
}
/**
 * HTTP handlers used by the server API.
 *
 * All functions are declared as static factory methods returning an
 * express-compatible request handler (req, res) => Promise. The returned
 * handler is used by `src/server/router` and wrapped with `asyncHandler` in
 * order to forward exceptions to the global error middleware.
 */
export class ServerAPI {
    /**
     * Handler to verify that the provided credentials are valid with Cloudflare.
     *
     * Returns 200 if verification succeeded.
     */
    static verifyToken() {
        /**
         * @returns express RequestHandler that verifies the provided credentials
         */
        return async (req, res) => {
            const client = createClient(req);
            await client.verifyToken();
            res.json({ success: true });
        };
    }
    /**
     * Handler to list the zones reachable by the provided credentials.
     */
    static getZones() {
        /**
         * @returns express RequestHandler that lists zones for the credentials
         */
        return async (req, res) => {
            const client = createClient(req);
            const zones = await client.getZones();
            res.json(zones);
        };
    }
    /**
     * Handler to return DNS records for the requested zone.
     */
    static getDNSRecords() {
        /**
         * @returns express RequestHandler that returns DNS records for a zone
         * @param req.params.zone - zone id used to select the records
         */
        return async (req, res) => {
            const client = createClient(req);
            const records = await client.getDNSRecords(req.params.zone);
            res.json(records);
        };
    }
    /**
     * Handler to create a DNS record. It validates the request body with
     * `dnsRecordSchema` and returns the newly created DNS record.
     */
    static createDNSRecord() {
        /**
         * @returns express RequestHandler that validates and creates a DNS record
         */
        return async (req, res) => {
            const parsed = dnsRecordSchema.safeParse(req.body);
            if (!parsed.success) {
                res.status(400).json({
                    error: parsed.error.issues
                        .map((i) => `${i.path.join('.')}: ${i.message}`)
                        .join(', '),
                });
                return;
            }
            const client = createClient(req);
            const record = await client.createDNSRecord(req.params.zone, parsed.data);
            res.json(record);
        };
    }
    /**
     * Handler to update an existing DNS record. Validates the body with
     * `dnsRecordSchema` and returns the updated record.
     */
    static updateDNSRecord() {
        /**
         * @returns express RequestHandler that validates and updates a DNS record
         */
        return async (req, res) => {
            const parsed = dnsRecordSchema.safeParse(req.body);
            if (!parsed.success) {
                res.status(400).json({
                    error: parsed.error.issues
                        .map((i) => `${i.path.join('.')}: ${i.message}`)
                        .join(', '),
                });
                return;
            }
            const client = createClient(req);
            const record = await client.updateDNSRecord(req.params.zone, req.params.id, parsed.data);
            res.json(record);
        };
    }
    /**
     * Handler to delete a DNS record and respond with { success: true }
     */
    static deleteDNSRecord() {
        /**
         * @returns express RequestHandler that deletes a DNS record
         */
        return async (req, res) => {
            const client = createClient(req);
            await client.deleteDNSRecord(req.params.zone, req.params.id);
            res.json({ success: true });
        };
    }
}
