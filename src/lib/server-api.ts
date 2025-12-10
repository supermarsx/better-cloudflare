import type { Request, Response } from "express";
import { CloudflareAPI } from "./cloudflare";
import { vaultManager } from "../server/vault";
import createCredentialStore, {
  type CredentialStore,
  type PasskeyCredential,
  SqliteCredentialStore,
} from "./credential-store";
import type { SqliteWrapper } from "./sqlite-driver";

// simplewebauthn verification result types are imported from the wrapper
import { logAudit } from "./audit";
import { getAuditEntries } from "./audit";
import swauth from "./simplewebauthn-wrapper";
import { dnsRecordSchema } from "./validation";
import type { Zone } from "@/types/dns";
import { validateSPFContentAsync } from "./spf";
import { getEnv, getEnvBool } from "./env";
import { simulateSPF, buildSPFGraph } from "./spf";

const DEBUG = getEnvBool("DEBUG_SERVER_API", "VITE_DEBUG_SERVER_API");

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
  const auth = req.header("authorization");
  if (auth?.startsWith("Bearer ")) {
    if (DEBUG) console.debug("Using bearer token for Cloudflare API");
    return new CloudflareAPI(auth.slice(7));
  }
  const key = req.header("x-auth-key");
  const email = req.header("x-auth-email");
  if (key && email) {
    if (DEBUG) console.debug("Using key/email for Cloudflare API");
    return new CloudflareAPI(key, undefined, email);
  }
  const err = new Error("Missing Cloudflare credentials") as Error & {
    status?: number;
  };
  err.status = 400;
  throw err;
}

function actorFromReq(req: Request) {
  return (
    req.header("x-auth-email") ||
    req.header("authorization") ||
    req.header("x-admin-token") ||
    "unknown"
  );
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
      logAudit({
        operation: "auth:verify",
        actor: actorFromReq(req),
        resource: "auth:token",
      });
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
      logAudit({
        operation: "zones:list",
        actor: actorFromReq(req),
        resource: "zones",
      });
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
      const page = req.query.page
        ? Number.parseInt(String(req.query.page), 10)
        : undefined;
      const perPage = req.query.per_page
        ? Number.parseInt(String(req.query.per_page), 10)
        : undefined;
      const records = await client.getDNSRecords(
        req.params.zone,
        page,
        perPage,
      );
      logAudit({
        operation: "dns:list",
        actor: actorFromReq(req),
        resource: `zone:${req.params.zone}`,
        details: { page, perPage },
      });
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
            .map(
              (issue: { path: Array<string | number>; message: string }) =>
                `${issue.path.join(".")}: ${issue.message}`,
            )
            .join(", "),
        });
        return;
      }
      const client = createClient(req);
      if (parsed.data.type === "SPF") {
        // compute the fqdn from the zone name + record name
        let fqdn = parsed.data.name;
        try {
          const zones: Zone[] = await client.getZones();
          const zone = zones.find((z) => z.id === req.params.zone);
          const zoneName = zone ? zone.name : req.params.zone;
          fqdn =
            parsed.data.name === "@" || parsed.data.name === ""
              ? zoneName
              : `${parsed.data.name}.${zoneName}`;
        } catch {
          // fallback to using raw name
          if (!fqdn || fqdn === "@") fqdn = parsed.data.name || req.params.zone;
        }
        const v = await validateSPFContentAsync(
          parsed.data.content ?? "",
          fqdn,
        );
        if (!v.ok) {
          res
            .status(400)
            .json({ error: `SPF validation failed: ${v.problems.join(", ")}` });
          return;
        }
      }
      const record = await client.createDNSRecord(req.params.zone, parsed.data);
      logAudit({
        operation: "dns:create",
        actor: actorFromReq(req),
        resource: `zone:${req.params.zone}`,
        details: { record },
      });
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
        res
          .status(400)
          .json({ error: "Request body must be an array of records" });
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
          skipped.push({ index: i, error: "Missing required fields" });
          continue;
        }
        const key = `${it.type}|${it.name}|${it.content}`;
        if (seen.has(key)) {
          skipped.push({ index: i, error: "Duplicate in payload" });
          continue;
        }
        seen.add(key);
        const parsed = dnsRecordSchema.safeParse(it);
        if (!parsed.success) {
          skipped.push({ index: i, error: parsed.error.message });
          continue;
        }
        if (parsed.data.type === "SPF") {
          // determine fqdn using zone name from Cloudflare
          let fqdn = parsed.data.name;
          try {
            const zones: Zone[] = await client.getZones();
            const zone = zones.find((z) => z.id === req.params.zone);
            const zoneName = zone ? zone.name : req.params.zone;
            fqdn =
              parsed.data.name === "@" || parsed.data.name === ""
                ? zoneName
                : `${parsed.data.name}.${zoneName}`;
          } catch {
            if (!fqdn || fqdn === "@")
              fqdn = parsed.data.name || req.params.zone;
          }
          const v = await validateSPFContentAsync(
            parsed.data.content ?? "",
            fqdn,
          );
          if (!v.ok) {
            skipped.push({
              index: i,
              error: `SPF validation failed: ${v.problems.join(", ")}`,
            });
            continue;
          }
        }
        if (req.query.dryrun) {
          // dry run: record as created but do not push to Cloudflare
          created.push(parsed.data);
          continue;
        }
        try {
          // create record using client
          const rec = await client.createDNSRecord(
            req.params.zone,
            parsed.data,
          );
          created.push(rec);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          skipped.push({ index: i, error: msg });
        }
      }

      res.json({ created, skipped });
      logAudit({
        operation: "dns:create_bulk",
        actor: actorFromReq(req),
        resource: `zone:${req.params.zone}`,
        details: { createdCount: created.length, skipped },
      });
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
      const format = String(req.query.format || "json").toLowerCase();
      const page = req.query.page
        ? Number.parseInt(String(req.query.page), 10)
        : undefined;
      const perPage = req.query.per_page
        ? Number.parseInt(String(req.query.per_page), 10)
        : undefined;
      const records = await client.getDNSRecords(
        req.params.zone,
        page,
        perPage,
      );
      switch (format) {
        case "json":
          res.setHeader("Content-Type", "application/json");
          res.send(JSON.stringify(records, null, 2));
          logAudit({
            operation: "dns:export",
            actor: actorFromReq(req),
            resource: `zone:${req.params.zone}`,
            details: { format },
          });
          return;
        case "csv":
          res.setHeader("Content-Type", "text/csv");
          res.send((await import("./export-api")).recordsToCSV(records));
          logAudit({
            operation: "dns:export",
            actor: actorFromReq(req),
            resource: `zone:${req.params.zone}`,
            details: { format },
          });
          return;
        case "bind":
          res.setHeader("Content-Type", "text/plain");
          res.send((await import("./export-api")).recordsToBIND(records));
          logAudit({
            operation: "dns:export",
            actor: actorFromReq(req),
            resource: `zone:${req.params.zone}`,
            details: { format },
          });
          return;
        default:
          res.status(400).json({ error: "Unknown format" });
      }
    };
  }

  static simulateSPF() {
    return async (req: Request, res: Response) => {
      const domain = String(req.query.domain || req.body?.domain || "");
      const ip = String(req.query.ip || req.body?.ip || "");
      if (!domain || !ip) {
        res.status(400).json({ error: "Missing domain or ip" });
        return;
      }
      const result = await simulateSPF({ domain, ip });
      res.json(result);
    };
  }

  static getSPFGraph() {
    return async (req: Request, res: Response) => {
      const domain = String(req.query.domain || req.body?.domain || "");
      if (!domain) {
        res.status(400).json({ error: "Missing domain" });
        return;
      }
      const graph = await buildSPFGraph(domain);
      res.json(graph);
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
      const id = String(req.params?.id);
      const secret = req.body?.secret;
      if (!id || !secret) {
        res.status(400).json({ error: "Missing id or secret" });
        return;
      }
      await vaultManager.setSecret(String(id), String(secret));
      logAudit({
        operation: "vault:store",
        actor: actorFromReq(req),
        resource: `vault:${id}`,
      });
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
      const id = String(req.params?.id);
      if (!id) {
        res.status(400).json({ error: "Missing id" });
        return;
      }
      const secret = await vaultManager.getSecret(String(id));
      if (!secret) {
        res.status(404).json({ error: "Secret not found" });
        return;
      }
      logAudit({
        operation: "vault:retrieve",
        actor: actorFromReq(req),
        resource: `vault:${id}`,
      });
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
      const id = String(req.params?.id);
      if (!id) {
        res.status(400).json({ error: "Missing id" });
        return;
      }
      await vaultManager.deleteSecret(String(id));
      logAudit({
        operation: "vault:delete",
        actor: actorFromReq(req),
        resource: `vault:${id}`,
      });
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
            .map(
              (issue: { path: Array<string | number>; message: string }) =>
                `${issue.path.join(".")}: ${issue.message}`,
            )
            .join(", "),
        });
        return;
      }
      const client = createClient(req);
      const record = await client.updateDNSRecord(
        String(req.params?.zone),
        String(req.params?.id),
        parsed.data,
      );
      logAudit({
        operation: "dns:update",
        actor: actorFromReq(req),
        resource: `zone:${String(req.params?.zone)}/record:${String(req.params?.id)}`,
        details: { record },
      });
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
      await client.deleteDNSRecord(String(req.params?.zone), String(req.params?.id));
      logAudit({
        operation: "dns:delete",
        actor: actorFromReq(req),
        resource: `zone:${String(req.params?.zone)}/record:${String(req.params?.id)}`,
      });
      res.json({ success: true });
    };
  }

  // Temporary in-memory store for passkey registration challenges and stored
  // credentials; should be replaced by a proper verification & storage
  // mechanism for production use.
  private static passkeyChallenges: Map<string, string> = new Map();
  private static passkeyCredentials: Map<string, unknown> = new Map();
  private static credentialStore: CredentialStore = createCredentialStore();
  static setCredentialStore(store: CredentialStore) {
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
      const id = String(req.params?.id);
      if (!id) {
        res.status(400).json({ error: "Missing id" });
        return;
      }
      // Derive RP info from env or incoming host
      const origin = getEnv(
        "SERVER_ORIGIN",
        "VITE_SERVER_ORIGIN",
        "http://localhost:8787",
      )!;
      const rpID = new URL(origin).hostname;
      const opts = swauth.generateRegistrationOptions({
        rpName: "Better Cloudflare",
        rpID,
        userID: id,
        userName: id,
      });
      // Store the base64 challenge to validate later
      ServerAPI.passkeyChallenges.set(id, String(opts.challenge));
      res.json({ challenge: opts.challenge, options: opts });
      logAudit({
        operation: "passkey:request_registration",
        actor: actorFromReq(req),
        resource: `passkey:${id}`,
      });
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
        res.status(400).json({ error: "Missing id or body" });
        return;
      }
      // Verify attestation using simplewebauthn server utilities
      try {
        const origin = getEnv(
          "SERVER_ORIGIN",
          "VITE_SERVER_ORIGIN",
          "http://localhost:8787",
        )!;
        const rpID = new URL(origin).hostname;
        const expectedChallenge = ServerAPI.passkeyChallenges.get(id);
        if (!expectedChallenge) {
          res.status(400).json({ error: "No challenge found" });
          return;
        }
        const verification = await swauth.verifyRegistrationResponse({
          response: body,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
        });

        if (!verification.verified) {
          res.status(400).json({ error: "Attestation verification failed" });
          return;
        }
        const { registrationInfo, attestationType } = verification;
        // Enforce attestation policy if configured
        const policy = getEnv(
          "ATTESTATION_POLICY",
          "VITE_ATTESTATION_POLICY",
          "none",
        );
        if (policy && policy !== "none" && attestationType !== policy) {
          res
            .status(400)
            .json({
              error: `Attestation type ${attestationType} does not satisfy policy ${policy}`,
            });
          return;
        }
        // Persist the credential(s) for future authentication checks. Store as
        // an array to support multiple credentials registered per id.
        // store returned from credential store; we will add the new credential
        const info = registrationInfo ?? ({} as Record<string, unknown>);
        const toAdd: PasskeyCredential = {
          credentialID: (info.credentialID ?? info.id) as string,
          credentialPublicKey: (info.credentialPublicKey ??
            info.publicKey) as string,
          counter: (info.counter ?? 0) as number,
        };
        await ServerAPI.credentialStore.addCredential(id, toAdd);
        const updated = await ServerAPI.credentialStore.getCredentials(id);
        ServerAPI.passkeyCredentials.set(id, updated);
        ServerAPI.passkeyChallenges.delete(id);
        // Audit registration success
        logAudit({
          operation: "passkey:register",
          actor: actorFromReq(req),
          resource: `passkey:${id}`,
          details: { attestationType },
        });
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
      const id = String(req.params?.id);
      if (!id) {
        res.status(400).json({ error: "Missing id" });
        return;
      }
      const origin = getEnv(
        "SERVER_ORIGIN",
        "VITE_SERVER_ORIGIN",
        "http://localhost:8787",
      )!;
      const rpID = new URL(origin).hostname;
      const creds = await ServerAPI.credentialStore.getCredentials(id);
      const allowList =
        Array.isArray(creds) && creds.length
          ? creds.map((c: unknown) => {
              const obj = c as { credentialID?: string; id?: string };
              return { id: obj.credentialID ?? obj.id, type: "public-key" };
            })
          : [];
      const opts = swauth.generateAuthenticationOptions({
        allowCredentials: allowList,
        rpID,
      });
      ServerAPI.passkeyChallenges.set(id, String(opts.challenge));
      res.json({ challenge: opts.challenge, options: opts });
      logAudit({
        operation: "passkey:request_auth",
        actor: actorFromReq(req),
        resource: `passkey:${id}`,
      });
    };
  }
  static listPasskeys() {
    return async (req: Request, res: Response) => {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: "Missing id" });
        return;
      }
      // require valid credentials on request
      createClient(req);
      // Prefer the configured credential store for passkey storage so
      // listing works consistently regardless of underlying store (vault,
      // sqlite, file, memory).
      const creds = (await ServerAPI.credentialStore.getCredentials(id)) ?? [];
      // Return credential metadata only (no private key material)
      const metadata = (Array.isArray(creds) ? creds : []).map((c: unknown) => {
        const obj = c as {
          credentialID?: string;
          id?: string;
          counter?: number;
        };
        return { id: obj.credentialID ?? obj.id, counter: obj.counter ?? 0 };
      });
      res.json(metadata);
      logAudit({
        operation: "passkey:list",
        actor: actorFromReq(req),
        resource: `passkey:${id}`,
      });
    };
  }

  static deletePasskey() {
    return async (req: Request, res: Response) => {
      const id = String(req.params?.id);
      const cid = String(req.params?.cid);
      if (!id || !cid) {
        res.status(400).json({ error: "Missing id or credential id" });
        return;
      }
      // require valid credentials on request
      createClient(req);
      const stored = await ServerAPI.credentialStore.getCredentials(id);
      if (!stored || stored.length === 0) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      const creds = Array.isArray(stored) ? stored : [];
      const filtered = creds.filter((c) => {
        const key = c.credentialID || c.id;
        const keyStr =
          typeof key === "string" ? key : Buffer.from(String(key)).toString("base64");
        // direct match on id string
        if (keyStr === cid || key === cid) return false;
        // if cid is base64 encoded representation, try to decode and compare
        try {
          const cidDecoded = Buffer.from(cid, "base64").toString("utf-8");
          if (keyStr === cidDecoded || key === cidDecoded) return false;
        } catch {
          // ignore decode errors
        }
        return true;
      });
      // Save back the filtered list
      // For stores that support direct set: prefer that if available, otherwise delete and re-add via store API
      // We will rely on the store's deleteCredential function for simplicity and then re-add remaining.
      // Clear by deleting all and re-adding for now
      for (const c of creds) {
        await ServerAPI.credentialStore.deleteCredential(
          id,
          String(c.credentialID ?? c.id),
        );
      }
      for (const c of filtered) {
        await ServerAPI.credentialStore.addCredential(id, {
          credentialID: c.credentialID ?? c.id ?? "",
          credentialPublicKey: c.credentialPublicKey ?? c.publicKey,
          counter: c.counter ?? 0,
        });
      }
      logAudit({
        operation: "passkey:delete",
        actor: actorFromReq(req),
        resource: `passkey:${id}`,
        details: { deletedCredential: cid },
      });
      res.json({ success: true });
    };
  }

  static getAuditEntries() {
    return async (req: Request, res: Response) => {
      // Allow either valid Cloudflare credentials OR the ADMIN_TOKEN header for admin access
      const adminToken = getEnv("ADMIN_TOKEN", "VITE_ADMIN_TOKEN", undefined);
      const reqAdminToken = req.header("x-admin-token");
      // DEBUG: log values during tests
      if (getEnv("DEBUG_SERVER_API", "VITE_DEBUG_SERVER_API", undefined))
        console.debug(
          "DEBUG getAuditEntries adminToken=",
          adminToken,
          "reqAdminToken=",
          reqAdminToken,
        );
      if (!reqAdminToken || reqAdminToken !== adminToken) {
        // fallback to Cloudflare credentials check
        createClient(req);
      }
      const entries = await getAuditEntries();
      logAudit({
        operation: "audit:view",
        actor: actorFromReq(req),
        resource: "audit:index",
      });
      res.json(entries);
    };
  }

  static createUser() {
    return async (req: Request, res: Response) => {
      // require admin via ADMIN_TOKEN or Cloudflare (admin only path)
      const adminToken = getEnv("ADMIN_TOKEN", "VITE_ADMIN_TOKEN", undefined);
      const reqAdmin = req.header("x-admin-token");
      if (!reqAdmin || reqAdmin !== adminToken) {
        res.status(403).json({ error: "Admin token required" });
        return;
      }
      const body = req.body;
      if (!body || !body.id) {
        res.status(400).json({ error: "Missing body or id" });
        return;
      }
      // store user record in sqlite via credential store's db if available
      if (
        ServerAPI.credentialStore instanceof SqliteCredentialStore &&
        ServerAPI.credentialStore.db
      ) {
        const db = ServerAPI.credentialStore.db as SqliteWrapper;
        // db is a SqliteWrapper that provides async `run`/`all`/`get` for both better-sqlite3 and sqlite3 drivers
        await db.run(
          "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, roles TEXT)",
        );
        await db.run(
          "INSERT OR REPLACE INTO users (id, email, roles) VALUES (?, ?, ?)",
          [body.id, body.email ?? null, JSON.stringify(body.roles ?? [])],
        );
        res.json({ success: true });
        logAudit({
          operation: "user:create",
          actor: actorFromReq(req),
          resource: `user:${body.id}`,
          details: { email: body.email, roles: body.roles },
        });
        return;
      }
      res
        .status(501)
        .json({
          error: "User management not implemented for current credential store",
        });
    };
  }

  static getUser() {
    return async (req: Request, res: Response) => {
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: "Missing id" });
        return;
      }
      if (
        ServerAPI.credentialStore instanceof SqliteCredentialStore &&
        ServerAPI.credentialStore.db
      ) {
        const db = ServerAPI.credentialStore.db as SqliteWrapper;
        await db.run(
          "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, roles TEXT)",
        );
        interface UserRow {
          id: string;
          email: string;
          roles: string;
        }
        const row = (await db.get(
          "SELECT id, email, roles FROM users WHERE id = ?",
          [id],
        )) as UserRow | undefined;
        if (!row) {
          res.status(404).json({ error: "Not found" });
          return;
        }
        res.json({
          id: row.id,
          email: row.email,
          roles: JSON.parse(row.roles || "[]"),
        });
        logAudit({
          operation: "user:get",
          actor: actorFromReq(req),
          resource: `user:${id}`,
        });
        return;
      }
      res
        .status(501)
        .json({
          error: "User management not implemented for current credential store",
        });
    };
  }

  static updateUserRoles() {
    return async (req: Request, res: Response) => {
      const adminToken = getEnv("ADMIN_TOKEN", "VITE_ADMIN_TOKEN", undefined);
      const reqAdmin = req.header("x-admin-token");
      if (!reqAdmin || reqAdmin !== adminToken) {
        res.status(403).json({ error: "Admin token required" });
        return;
      }
      const id = req.params.id;
      const { roles } = req.body;
      if (!id || !Array.isArray(roles)) {
        res.status(400).json({ error: "Missing id or roles" });
        return;
      }
      if (
        ServerAPI.credentialStore instanceof SqliteCredentialStore &&
        ServerAPI.credentialStore.db
      ) {
        const db = ServerAPI.credentialStore.db as SqliteWrapper;
        await db.run(
          "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT, roles TEXT)",
        );
        await db.run(
          "INSERT OR REPLACE INTO users (id, email, roles) VALUES (?, ?, ?)",
          [id, null, JSON.stringify(roles)],
        );
        res.json({ success: true });
        logAudit({
          operation: "user:update_roles",
          actor: actorFromReq(req),
          resource: `user:${id}`,
          details: { roles },
        });
        return;
      }
      res
        .status(501)
        .json({
          error: "User management not implemented for current credential store",
        });
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
      const id = String(req.params?.id);
      const body = req.body;
      if (!id || !body) {
        res.status(400).json({ error: "Missing id or body" });
        return;
      }
      // In a proper implementation we'd verify the assertion using stored
      // public key; here we accept the assertion if challenge matches.
      try {
        const origin = getEnv(
          "SERVER_ORIGIN",
          "VITE_SERVER_ORIGIN",
          "http://localhost:8787",
        )!;
        const rpID = new URL(origin).hostname;
        const expectedChallenge = ServerAPI.passkeyChallenges.get(id);
        if (!expectedChallenge) {
          res.status(400).json({ error: "No challenge found" });
          return;
        }
        const stored = await ServerAPI.credentialStore.getCredentials(id);
        if (!stored || stored.length === 0) {
          res.status(400).json({ error: "No credential registered" });
          return;
        }
        const credentials = Array.isArray(stored) ? stored : [];
        // Try to find matching credential from assertion rawId or fallback to first
        let credential: unknown = credentials[0];
        try {
          const rawId =
            body.rawId || body.id || (body.response && body.response.rawId);
          if (rawId) {
            const rawToBase64 = (r: unknown) => {
              if (typeof r === "string") return r;
              if (r instanceof Uint8Array)
                return Buffer.from(r).toString("base64");
              if (ArrayBuffer.isView(r)) {
                // r is an ArrayBufferView: create a Uint8Array view over it
                try {
                  const view = r as ArrayBufferView;
                  // Some ArrayBufferView implementations expose buffer/byteOffset/byteLength
                  type ABViewLike = {
                    buffer?: ArrayBuffer;
                    byteOffset?: number;
                    byteLength?: number;
                  };
                  const v = view as ABViewLike;
                  const buffer = v.buffer ?? new ArrayBuffer(0);
                  const offset = v.byteOffset ?? 0;
                  const length =
                    typeof v.byteLength === "number"
                      ? v.byteLength
                      : buffer.byteLength - offset;
                  const u = new Uint8Array(buffer, offset, length);
                  return Buffer.from(u).toString("base64");
                } catch {
                  // fallback to generic string conversion
                  return Buffer.from(String(r)).toString("base64");
                }
              }
              if (r instanceof ArrayBuffer)
                return Buffer.from(new Uint8Array(r)).toString("base64");
              return Buffer.from(String(r)).toString("base64");
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
        } catch {
          // ignore and fallback to first
        }
        // create expected credential representation
        const credObj = credential as {
          credentialID?: string;
          id?: string;
          credentialPublicKey?: string;
          publicKey?: string;
          counter?: number;
        };
        const expected = {
          id: credObj.credentialID ?? credObj.id,
          publicKey: credObj.credentialPublicKey ?? credObj.publicKey,
          currentCounter: credObj.counter ?? 0,
        };
        const verification = await swauth.verifyAuthenticationResponse({
          response: body,
          expectedChallenge,
          expectedOrigin: origin,
          expectedRPID: rpID,
          authenticator: expected,
        });
        if (!verification.verified) {
          res.status(400).json({ error: "Assertion verification failed" });
          return;
        }
        // Update stored counter
        const newCounter =
          verification.authenticationInfo?.newCounter ??
          (expected.currentCounter || 0);
        const credentialId = expected.id as string;
        // Update the credential in store by deleting the old and adding the updated
        await ServerAPI.credentialStore.deleteCredential(id, credentialId);
        await ServerAPI.credentialStore.addCredential(id, {
          credentialID: credentialId,
          credentialPublicKey: expected.publicKey,
          counter: newCounter,
        });
        // Audit successful assertion
        logAudit({
          operation: "passkey:authenticate",
          actor:
            req.header("x-auth-email") ||
            req.header("authorization") ||
            "unknown",
          resource: `passkey:${id}`,
        });
        ServerAPI.passkeyChallenges.delete(id);
        res.json({ success: true });
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
      }
    };
  }
}
