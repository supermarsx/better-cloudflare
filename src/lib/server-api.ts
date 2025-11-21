import type { Request, Response } from 'express';
import { CloudflareAPI } from './cloudflare';
import { vaultManager } from '../server/vault';
import createCredentialStore from './credential-store';
import { logAudit } from './audit';
import { getAuditEntries } from './audit';
import swauth from './simplewebauthn-wrapper';
import { dnsRecordSchema } from './validation';
import { getEnv, getEnvBool } from './env';

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
      logAudit({ operation: 'vault:store', actor: req.header('x-auth-email') || req.header('authorization') || 'unknown', resource: `vault:${id}` });
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
      logAudit({ operation: 'vault:retrieve', actor: req.header('x-auth-email') || req.header('authorization') || 'unknown', resource: `vault:${id}` });
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
      logAudit({ operation: 'vault:delete', actor: req.header('x-auth-email') || req.header('authorization') || 'unknown', resource: `vault:${id}` });
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
  private static credentialStore = createCredentialStore();
  static setCredentialStore(store: any) {
    ServerAPI.credentialStore = store;
  }

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
      // Derive RP info from env or incoming host
      const origin = getEnv('SERVER_ORIGIN', 'VITE_SERVER_ORIGIN', 'http://localhost:8787')!;
      const rpID = new URL(origin).hostname;
      const opts = swauth.generateRegistrationOptions({
        rpName: 'Better Cloudflare',
        rpID,
        userID: id,
        userName: id,
      });
      // Store the base64 challenge to validate later
      ServerAPI.passkeyChallenges.set(id, opts.challenge);
      res.json({ challenge: opts.challenge, options: opts });
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
      if (!id || !body) {
        res.status(400).json({ error: 'Missing id or body' });
        return;
      }
      // Verify attestation using simplewebauthn server utilities
      try {
        const origin = getEnv('SERVER_ORIGIN', 'VITE_SERVER_ORIGIN', 'http://localhost:8787')!;
        const rpID = new URL(origin).hostname;
        const expectedChallenge = ServerAPI.passkeyChallenges.get(id);
        if (!expectedChallenge) {
          res.status(400).json({ error: 'No challenge found' });
          return;
        }
        const verification = await swauth.verifyRegistrationResponse({
          response: body,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
        } as any);

        if (!verification.verified) {
          res.status(400).json({ error: 'Attestation verification failed' });
          return;
        }
        const { registrationInfo, attestationType } = verification as any;
        // Enforce attestation policy if configured
        const policy = getEnv('ATTESTATION_POLICY', 'VITE_ATTESTATION_POLICY', 'none');
        if (policy && policy !== 'none' && attestationType !== policy) {
          res.status(400).json({ error: `Attestation type ${attestationType} does not satisfy policy ${policy}` });
          return;
        }
        // Persist the credential(s) for future authentication checks. Store as
        // an array to support multiple credentials registered per id.
        // store returned from credential store; we will add the new credential
        const toAdd = { credentialID: registrationInfo.credentialID ?? registrationInfo.id, credentialPublicKey: registrationInfo.credentialPublicKey ?? registrationInfo.publicKey, counter: registrationInfo.counter ?? 0 } as any;
        await ServerAPI.credentialStore.addCredential(id, toAdd);
        const updated = await ServerAPI.credentialStore.getCredentials(id);
        ServerAPI.passkeyCredentials.set(id, updated);
        ServerAPI.passkeyChallenges.delete(id);
        // Audit registration success
        logAudit({ operation: 'passkey:register', actor: req.header('x-auth-email') || req.header('authorization') || 'unknown', resource: `passkey:${id}`, details: { attestationType } });
        res.json({ success: true });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
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
      const origin = getEnv('SERVER_ORIGIN', 'VITE_SERVER_ORIGIN', 'http://localhost:8787')!;
      const rpID = new URL(origin).hostname;
      const creds = await ServerAPI.credentialStore.getCredentials(id);
      const allowList = Array.isArray(creds) && creds.length
        ? creds.map((c: any) => ({ id: c.credentialID, type: 'public-key' }))
        : [];
      const opts = swauth.generateAuthenticationOptions({ allowCredentials: allowList, rpID });
      ServerAPI.passkeyChallenges.set(id, opts.challenge);
      res.json({ challenge: opts.challenge, options: opts });
    };
  }
  static listPasskeys() {
    return async (req: Request, res: Response) => {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'Missing id' });
        return;
      }
      // require valid credentials on request
      createClient(req);
      const stored = await vaultManager.getSecret(`passkey:${id}`);
      const creds = stored ? JSON.parse(stored) : [];
      // Return credential metadata only (no private key material)
      const metadata = creds.map((c: any) => ({ id: c.credentialID || c.id, counter: c.counter ?? 0 }));
      res.json(metadata);
    };
  }

  static deletePasskey() {
    return async (req: Request, res: Response) => {
      const id = req.params.id;
      const cid = req.params.cid;
      if (!id || !cid) {
        res.status(400).json({ error: 'Missing id or credential id' });
        return;
      }
      // require valid credentials on request
      createClient(req);
      const stored = await ServerAPI.credentialStore.getCredentials(id);
      if (!stored || stored.length === 0) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const creds = stored as any[];
      const filtered = creds.filter((c) => {
        const key = c.credentialID || c.id;
        const keyStr = typeof key === 'string' ? key : Buffer.from(key).toString('base64');
        // direct match on id string
        if (keyStr === cid || key === cid) return false;
        // if cid is base64 encoded representation, try to decode and compare
        try {
          const cidDecoded = Buffer.from(cid, 'base64').toString('utf-8');
          if (keyStr === cidDecoded || key === cidDecoded) return false;
        } catch (_e) {
          // ignore decode errors
        }
        return true;
      });
        // Save back the filtered list
        // For stores that support direct set: prefer that if available, otherwise delete and re-add via store API
        // We will rely on the store's deleteCredential function for simplicity and then re-add remaining.
        // Clear by deleting all and re-adding for now
        for (const c of creds) {
          await ServerAPI.credentialStore.deleteCredential(id, c.credentialID || c.id);
        }
        for (const c of filtered) {
          await ServerAPI.credentialStore.addCredential(id, { credentialID: c.credentialID ?? c.id, credentialPublicKey: c.credentialPublicKey ?? c.publicKey, counter: c.counter ?? 0 });
        }
      logAudit({ operation: 'passkey:delete', actor: req.header('x-auth-email') || req.header('authorization') || 'unknown', resource: `passkey:${id}`, details: { deletedCredential: cid } });
      res.json({ success: true });
    };
  }

  static getAuditEntries() {
    return async (req: Request, res: Response) => {
      // Allow either valid Cloudflare credentials OR the ADMIN_TOKEN header for admin access
      const adminToken = getEnv('ADMIN_TOKEN', 'VITE_ADMIN_TOKEN', undefined);
      const reqAdminToken = req.header('x-admin-token');
      // DEBUG: log values during tests
      if (getEnv('DEBUG_SERVER_API', 'VITE_DEBUG_SERVER_API', undefined)) console.debug('DEBUG getAuditEntries adminToken=', adminToken, 'reqAdminToken=', reqAdminToken);
      if (!reqAdminToken || reqAdminToken !== adminToken) {
        // fallback to Cloudflare credentials check
        createClient(req);
      }
      const entries = getAuditEntries();
      res.json(entries);
    };
  }

  static createUser() {
    return async (req: Request, res: Response) => {
      // require admin via ADMIN_TOKEN or Cloudflare (admin only path)
      const adminToken = getEnv('ADMIN_TOKEN', 'VITE_ADMIN_TOKEN', undefined);
      const reqAdmin = req.header('x-admin-token');
      if (!reqAdmin || reqAdmin !== adminToken) {
        res.status(403).json({ error: 'Admin token required' });
        return;
      }
      const body = req.body;
      if (!body || !body.id) {
        res.status(400).json({ error: 'Missing body or id' });
        return;
      }
      // store user record in sqlite via credential store's db if available
      const store = ServerAPI.credentialStore as any;
      if (store && typeof store.db !== 'undefined') {
        const db = (store as any).db as any;
        db.prepare('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, roles TEXT)').run();
        db.prepare('INSERT OR REPLACE INTO users (id, email, roles) VALUES (?, ?, ?)').run(body.id, body.email ?? null, JSON.stringify(body.roles ?? []));
        res.json({ success: true });
        return;
      }
      res.status(501).json({ error: 'User management not implemented for current credential store' });
    };
  }

  static getUser() {
    return async (req: Request, res: Response) => {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'Missing id' });
        return;
      }
      const store = ServerAPI.credentialStore as any;
      if (store && typeof store.db !== 'undefined') {
        const db = (store as any).db as any;
        db.prepare('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, roles TEXT)').run();
        const row = db.prepare('SELECT id, email, roles FROM users WHERE id = ?').get(id);
        if (!row) {
          res.status(404).json({ error: 'Not found' });
          return;
        }
        res.json({ id: row.id, email: row.email, roles: JSON.parse(row.roles || '[]') });
        return;
      }
      res.status(501).json({ error: 'User management not implemented for current credential store' });
    };
  }

  static updateUserRoles() {
    return async (req: Request, res: Response) => {
      const adminToken = getEnv('ADMIN_TOKEN', 'VITE_ADMIN_TOKEN', undefined);
      const reqAdmin = req.header('x-admin-token');
      if (!reqAdmin || reqAdmin !== adminToken) {
        res.status(403).json({ error: 'Admin token required' });
        return;
      }
      const id = req.params.id;
      const { roles } = req.body;
      if (!id || !Array.isArray(roles)) {
        res.status(400).json({ error: 'Missing id or roles' });
        return;
      }
      const store = ServerAPI.credentialStore as any;
      if (store && typeof store.db !== 'undefined') {
        const db = (store as any).db as any;
        db.prepare('CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, roles TEXT)').run();
        db.prepare('INSERT OR REPLACE INTO users (id, email, roles) VALUES (?, ?, ?)').run(id, null, JSON.stringify(roles));
        res.json({ success: true });
        return;
      }
      res.status(501).json({ error: 'User management not implemented for current credential store' });
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
      try {
        const origin = getEnv('SERVER_ORIGIN', 'VITE_SERVER_ORIGIN', 'http://localhost:8787')!;
        const rpID = new URL(origin).hostname;
        const expectedChallenge = ServerAPI.passkeyChallenges.get(id);
        if (!expectedChallenge) {
          res.status(400).json({ error: 'No challenge found' });
          return;
        }
        const stored = await ServerAPI.credentialStore.getCredentials(id);
        if (!stored || stored.length === 0) {
          res.status(400).json({ error: 'No credential registered' });
          return;
        }
        const credentials = stored as any[];
        // Try to find matching credential from assertion rawId or fallback to first
        let credential: any = credentials[0];
        try {
          const rawId = body.rawId || body.id || (body.response && body.response.rawId);
          if (rawId) {
            const rawToBase64 = (r: unknown) => {
              if (typeof r === 'string') return r;
              if (r instanceof Uint8Array) return Buffer.from(r).toString('base64');
              if (ArrayBuffer.isView(r as any)) return Buffer.from(new Uint8Array((r as ArrayBufferLike))).toString('base64');
              if (r instanceof ArrayBuffer) return Buffer.from(new Uint8Array(r)).toString('base64');
              return Buffer.from(String(r)).toString('base64');
            };
            const rawBase64 = rawToBase64(rawId);
            const found = credentials.find((c) => {
              const cid = c.credentialID || c.id;
              if (!cid) return false;
              const cidStr = rawToBase64(cid);
              return cidStr === rawBase64;
            });
            if (found) credential = found;
          }
        } catch (e) {
          // ignore and fallback to first
        }
        // create expected credential representation
        const expected = {
          id: credential.credentialID || credential.id,
          publicKey: credential.credentialPublicKey || credential.publicKey,
          currentCounter: credential.counter ?? 0,
        };
        const verification = await swauth.verifyAuthenticationResponse({
          response: body,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          authenticator: expected,
        } as any);
        if (!verification.verified) {
          res.status(400).json({ error: 'Assertion verification failed' });
          return;
        }
        // Update stored counter
        const newCounter = verification.authenticationInfo?.newCounter ?? (expected.currentCounter || 0);
        const credentialId = expected.id as string;
        // Update the credential in store by deleting the old and adding the updated
        await ServerAPI.credentialStore.deleteCredential(id, credentialId);
        await ServerAPI.credentialStore.addCredential(id, { credentialID: credentialId, credentialPublicKey: expected.publicKey, counter: newCounter });
        // Audit successful assertion
        logAudit({ operation: 'passkey:authenticate', actor: req.header('x-auth-email') || req.header('authorization') || 'unknown', resource: `passkey:${id}` });
        ServerAPI.passkeyChallenges.delete(id);
        res.json({ success: true });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    };
  }
}
