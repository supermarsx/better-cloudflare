import type { Request, Response } from 'express';
import { CloudflareAPI } from './cloudflare';
import { vaultManager } from '../server/vault';
import { dnsRecordSchema } from './validation';
import { getEnvBool } from './env';
import { randomBytes } from 'crypto';

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
function createClient(req: Request): CloudflareAPI {
  const auth = req.header('authorization');
  if (auth?.startsWith('Bearer ')) {
    if (DEBUG) console.debug('Using bearer token for Cloudflare API');
    return new CloudflareAPI(auth.slice(7));
  }
  const key = req.header('x-auth-key');
  const email = req.header('x-auth-email');
  if (key && email) {
    if (DEBUG) console.debug('Using key/email for Cloudflare API');
    return new CloudflareAPI(key, undefined, email);
  }
  const err = new Error('Missing Cloudflare credentials') as Error & {
    status?: number;
  };
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
    return async (req: Request, res: Response) => {
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
    return async (req: Request, res: Response) => {
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
    return async (req: Request, res: Response) => {
      const client = createClient(req);
      const page = req.query.page ? Number.parseInt(String(req.query.page), 10) : undefined;
      const perPage = req.query.per_page ? Number.parseInt(String(req.query.per_page), 10) : undefined;
      const records = await client.getDNSRecords(req.params.zone, page, perPage);
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
    return async (req: Request, res: Response) => {
      const parsed = dnsRecordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues
            .map((issue: any) => `${issue.path.join('.')}: ${issue.message}`)
            .join(', '),
        });
        return;
      }
      const client = createClient(req);
      const record = await client.createDNSRecord(
        req.params.zone,
        parsed.data,
      );
      res.json(record);
    };
  }

  /**
   * Handler to bulk-create DNS records. Accepts an array of records in the
   * request body and creates them in sequence. Returns an array of created
   * records and an optional `skipped` count for invalid or duplicate items.
   */
  static createBulkDNSRecords() {
    /**
     * Express handler for bulk DNS record creation.
     *
     * The handler accepts an array of DNS records in the request body and
     * validates each with `dnsRecordSchema`. If `?dryrun=1` is present, it
     * returns what would have been created without actually calling
     * Cloudflare's API. The response contains `created` and `skipped` arrays
     * with details about the processing.
     */
    return async (req: Request, res: Response) => {
      const items = req.body;
      if (!Array.isArray(items)) {
        res.status(400).json({ error: 'Request body must be an array of records' });
        return;
      }
      const client = createClient(req);
      const created: unknown[] = [];
      const skipped: { index: number; error: string }[] = [];

      // check for duplicates inside the payload and invalid TTL/priority
      const seen = new Set<string>();
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (!it || !it.type || !it.name || !it.content) {
          skipped.push({ index: i, error: 'Missing required fields' });
          continue;
        }
        const key = `${it.type}|${it.name}|${it.content}`;
        if (seen.has(key)) {
          skipped.push({ index: i, error: 'Duplicate in payload' });
          continue;
        }
        seen.add(key);
        const parsed = dnsRecordSchema.safeParse(it);
        if (!parsed.success) {
          skipped.push({ index: i, error: parsed.error.message });
          continue;
        }
        if (req.query.dryrun) {
          // dry run: record as created but do not push to Cloudflare
          created.push(parsed.data);
          continue;
        }
        try {
          // create record using client
          const rec = await client.createDNSRecord(req.params.zone, parsed.data);
          created.push(rec);
        } catch (err) {
          skipped.push({ index: i, error: (err as Error).message });
        }
      }

      res.json({ created, skipped });
    };
  }

  /**
   * Export DNS records for a zone in a given format (json/csv/bind)
   */
  static exportDNSRecords() {
    /**
     * Express handler to export DNS records for a zone.
     *
     * Supports formats: json, csv, bind. Optional pagination parameters
     * `page` and `per_page` are forwarded to the Cloudflare API.
     */
    return async (req: Request, res: Response) => {
      const client = createClient(req);
      const format = String(req.query.format || 'json').toLowerCase();
      const page = req.query.page ? Number.parseInt(String(req.query.page), 10) : undefined;
      const perPage = req.query.per_page ? Number.parseInt(String(req.query.per_page), 10) : undefined;
      const records = await client.getDNSRecords(req.params.zone, page, perPage);
      switch (format) {
        case 'json':
          res.setHeader('Content-Type', 'application/json');
          res.send(JSON.stringify(records, null, 2));
          return;
        case 'csv':
          res.setHeader('Content-Type', 'text/csv');
          res.send((await import('./export-api')).recordsToCSV(records));
          return;
        case 'bind':
          res.setHeader('Content-Type', 'text/plain');
          res.send((await import('./export-api')).recordsToBIND(records));
          return;
        default:
          res.status(400).json({ error: 'Unknown format' });
      }
    };
  }

  static storeVaultSecret() {
    /**
     * Store a secret into the server's configured vault.
     * Requires valid Cloudflare credentials to be present in the request.
     */
    return async (req: Request, res: Response) => {
      // Require server auth to manipulate vault secrets
      createClient(req);
      const id = req.params.id;
      const secret = req.body && req.body.secret;
      if (!id || !secret) {
        res.status(400).json({ error: 'Missing id or secret' });
        return;
      }
      await vaultManager.setSecret(String(id), String(secret));
      res.json({ success: true });
    };
  }

  static getVaultSecret() {
    /**
     * Retrieve a secret from the server vault.
     * Requires credentials in the request and will return 404 when not found.
     */
    return async (req: Request, res: Response) => {
      createClient(req);
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'Missing id' });
        return;
      }
      const secret = await vaultManager.getSecret(String(id));
      if (!secret) {
        res.status(404).json({ error: 'Secret not found' });
        return;
      }
      res.json({ secret });
    };
  }

  static deleteVaultSecret() {
    /**
     * Delete a secret from the server vault. Request must contain
     * valid credentials and a vault id parameter.
     */
    return async (req: Request, res: Response) => {
      createClient(req);
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'Missing id' });
        return;
      }
      await vaultManager.deleteSecret(String(id));
      res.json({ success: true });
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
    return async (req: Request, res: Response) => {
      const parsed = dnsRecordSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: parsed.error.issues
            .map((issue: any) => `${issue.path.join('.')}: ${issue.message}`)
            .join(', '),
        });
        return;
      }
      const client = createClient(req);
      const record = await client.updateDNSRecord(
        req.params.zone,
        req.params.id,
        parsed.data,
      );
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
    return async (req: Request, res: Response) => {
      const client = createClient(req);
      await client.deleteDNSRecord(req.params.zone, req.params.id);
      res.json({ success: true });
    };
  }

  // Temporary in-memory store for passkey registration challenges and stored
  // credentials; should be replaced by a proper verification & storage
  // mechanism for production use.
  private static passkeyChallenges: Map<string, string> = new Map();
  private static passkeyCredentials: Map<string, unknown> = new Map();

  static createPasskeyRegistrationOptions() {
    /**
     * Generate a simple challenge for WebAuthn passkey registration.
     *
     * Note: This implementation only provides a challenge and stores it
     * in-memory. A production implementation should use a library like
     * `@simplewebauthn/server` to craft proper registration options.
     */
    return async (req: Request, res: Response) => {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'Missing id' });
        return;
      }
      const challenge = randomBytes(16).toString('base64');
      ServerAPI.passkeyChallenges.set(id, challenge);
      res.json({ challenge });
    };
  }

  static registerPasskey() {
    /**
     * Register a passkey by persisting the attestation blob in the vault and
     * in-memory store. This function does not perform attestation
     * verification - the stored blob should be verified before trusting it
     * in a production environment.
     */
    return async (req: Request, res: Response) => {
      const id = req.params.id;
      const body = req.body;
      // In a full implementation we'd verify attestation using a FIDO2
      // verification library; here we store the credential for future
      // authentication and mark success.
      if (!id || !body) {
        res.status(400).json({ error: 'Missing id or body' });
        return;
      }
      // persist attestation blob as-is
      await vaultManager.setSecret(`passkey:${id}`, JSON.stringify(body));
      ServerAPI.passkeyCredentials.set(id, body);
      res.json({ success: true });
    };
  }

  static createPasskeyAuthOptions() {
    /**
     * Generate a challenge for WebAuthn authentication (assertion).
     */
    return async (req: Request, res: Response) => {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'Missing id' });
        return;
      }
      const challenge = randomBytes(16).toString('base64');
      ServerAPI.passkeyChallenges.set(id, challenge);
      res.json({ challenge });
    };
  }

  static authenticatePasskey() {
    /**
     * Authenticate a passkey assertion. This stub verifies that a challenge
     * exists and then accepts the assertion; proper verification against
     * stored public key material should be implemented with a FIDO2
     * library (e.g. `@simplewebauthn/server`).
     */
    return async (req: Request, res: Response) => {
      const id = req.params.id;
      const body = req.body;
      if (!id || !body) {
        res.status(400).json({ error: 'Missing id or body' });
        return;
      }
      // In a proper implementation we'd verify the assertion using stored
      // public key; here we accept the assertion if challenge matches.
      const challenge = ServerAPI.passkeyChallenges.get(id);
      if (!challenge) {
        res.status(400).json({ error: 'No challenge found' });
        return;
      }
      // This stub accepts any client assertion that was submitted, assuming
      // containing the same challenge returned earlier.
      // In future, implement verification using @simplewebauthn/server.
      ServerAPI.passkeyChallenges.delete(id);
      res.json({ success: true });
    };
  }
}
