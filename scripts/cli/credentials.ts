/**
 * Credential handling for the two commands that talk to a live zone.
 *
 * There is no implicit credential path. The operator names the source — an
 * environment variable via `--token-env` or a file via `--token-file` — and the
 * CLI reads nothing else: no dotfile, no keychain, no application settings
 * store. A command that needs credentials and was not given a source fails
 * rather than going looking for one.
 *
 * The token value never reaches the output. Only the *name* of the source is
 * ever printed, and {@link redact} is applied to any message derived from a
 * failure so a token cannot escape through an API error string.
 */
import { readFile } from "node:fs/promises";
import type { DNSRecord } from "../../src/types/dns";

/** Where the token came from. The value is deliberately not part of this. */
export interface CredentialSource {
  kind: "env" | "file";
  name: string;
}

/** A resolved credential, kept together with its provenance. */
export interface Credential {
  token: string;
  source: CredentialSource;
  /** Set when authenticating with a global API key rather than a token. */
  email?: string;
}

/** The flags that select a credential source. */
export interface CredentialOptions {
  tokenEnv?: string;
  tokenFile?: string;
  email?: string;
}

/** Raised when no usable credential could be obtained. */
export class CredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialError";
  }
}

/** A human-readable description of a source that never includes the secret. */
export function describeCredentialSource(source: CredentialSource): string {
  return source.kind === "env"
    ? `environment variable ${source.name}`
    : `file ${source.name}`;
}

/**
 * Replace every occurrence of `secret` in `text` with a placeholder.
 *
 * Applied to anything derived from a failure before it is printed, so a token
 * echoed back by a transport layer or embedded in a URL cannot leak.
 */
export function redact(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 4) return text;
  return text.split(secret).join("[redacted]");
}

/** Read the token from exactly the source the operator named. */
export async function resolveCredential(
  options: CredentialOptions,
  env: Record<string, string | undefined> = process.env,
): Promise<Credential> {
  if (options.tokenEnv && options.tokenFile) {
    throw new CredentialError(
      "Pass either --token-env or --token-file, not both.",
    );
  }

  if (options.tokenEnv) {
    const value = env[options.tokenEnv];
    if (typeof value !== "string" || value.trim() === "") {
      throw new CredentialError(
        `Environment variable ${options.tokenEnv} is not set or is empty.`,
      );
    }
    return {
      token: value.trim(),
      source: { kind: "env", name: options.tokenEnv },
      ...(options.email ? { email: options.email } : {}),
    };
  }

  if (options.tokenFile) {
    let contents: string;
    try {
      contents = await readFile(options.tokenFile, "utf8");
    } catch (error) {
      throw new CredentialError(
        `Could not read the credential file ${options.tokenFile}: ${(error as Error).message}`,
      );
    }
    const token = contents.trim();
    if (token === "") {
      throw new CredentialError(
        `The credential file ${options.tokenFile} is empty.`,
      );
    }
    return {
      token,
      source: { kind: "file", name: options.tokenFile },
      ...(options.email ? { email: options.email } : {}),
    };
  }

  throw new CredentialError(
    "No credential source was given. Pass --token-env <VAR> to read the token " +
      "from a named environment variable, or --token-file <PATH> to read it " +
      "from a file you name. Credentials are never read from anywhere else.",
  );
}

/** The only Cloudflare operations this CLI performs. */
export interface DnsClient {
  getDNSRecords(zoneId: string): Promise<DNSRecord[]>;
  createDNSRecord(
    zoneId: string,
    record: Partial<DNSRecord>,
  ): Promise<DNSRecord>;
}

/** How a client is obtained; tests substitute this to keep the suite offline. */
export type DnsClientFactory = (
  credential: Credential,
  apiBase?: string,
) => Promise<DnsClient>;

/**
 * Build a real Cloudflare client.
 *
 * The application's `CloudflareAPI` is imported dynamically so that neither the
 * SDK nor a network-capable object is loaded by the offline commands
 * (`validate` and `migrate`), which must run with no credentials at all.
 */
export const createCloudflareClient: DnsClientFactory = async (
  credential,
  apiBase,
) => {
  const { CloudflareAPI } = await import("../../src/lib/api/cloudflare");
  // `undefined` selects the constructor's own default base URL.
  const api = new CloudflareAPI(credential.token, apiBase, credential.email);
  return {
    getDNSRecords: (zoneId) => api.getDNSRecords(zoneId),
    createDNSRecord: (zoneId, record) => api.createDNSRecord(zoneId, record),
  };
};
