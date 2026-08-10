/**
 * Shared in-memory harness for the `scripts/cli` DNS utility tests.
 *
 * Every dependency the CLI reaches for — streams, environment, file reads and
 * writes, and the Cloudflare client — is supplied here, so no test touches the
 * disk, the network, or the real process environment. `clientCalls` and
 * `factoryCalls` exist so a test can assert that a dry run made *no* call
 * rather than merely that it printed the right thing.
 */
import type { DNSRecord } from "../src/types/dns";
import type { CliDependencies } from "../scripts/cli/dns-cli";
import { runCli } from "../scripts/cli/dns-cli";

export interface HarnessOptions {
  files?: Record<string, string>;
  env?: Record<string, string | undefined>;
  /** Records the stubbed client returns from `getDNSRecords`. */
  remoteRecords?: DNSRecord[];
  /** When set, `createDNSRecord` rejects for records whose name matches. */
  failCreateFor?: (record: Partial<DNSRecord>) => boolean;
  /** Pretend stdout is an interactive terminal. */
  tty?: boolean;
}

export interface HarnessResult {
  code: number;
  stdout: string;
  stderr: string;
  /** Everything written through `--out`, keyed by path. */
  written: Map<string, string>;
  /** One entry per `createDNSRecord` call the CLI made. */
  clientCalls: Array<{ zoneId: string; record: Partial<DNSRecord> }>;
  /** How many times a client was constructed at all. */
  factoryCalls: number;
  /** Credential values the factory was handed, so a test can assert redaction. */
  tokensSeen: string[];
}

/** Build a full `DNSRecord` for stubbed remote responses. */
export function remoteRecord(partial: Partial<DNSRecord>): DNSRecord {
  return {
    id: "id0000",
    type: "A",
    name: "www.example.com",
    content: "192.0.2.1",
    ttl: 300,
    zone_id: "zone0000",
    zone_name: "example.com",
    created_on: "2026-01-01T00:00:00Z",
    modified_on: "2026-01-01T00:00:00Z",
    ...partial,
  };
}

/** Run the CLI against fully stubbed dependencies. */
export async function runHarness(
  argv: string[],
  options: HarnessOptions = {},
): Promise<HarnessResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const written = new Map<string, string>();
  const clientCalls: HarnessResult["clientCalls"] = [];
  const tokensSeen: string[] = [];
  let factoryCalls = 0;

  const deps: Partial<CliDependencies> = {
    streams: {
      stdout: {
        write: (chunk: string) => stdout.push(chunk),
        ...(options.tty ? { isTTY: true } : {}),
      },
      stderr: { write: (chunk: string) => stderr.push(chunk) },
    },
    env: options.env ?? {},
    readFile: async (filePath: string) => {
      const contents = options.files?.[filePath];
      if (contents === undefined) {
        throw new Error(`ENOENT: no such file, open '${filePath}'`);
      }
      return contents;
    },
    writeFile: async (filePath: string, contents: string) => {
      written.set(filePath, contents);
    },
    clientFactory: async (credential) => {
      factoryCalls++;
      tokensSeen.push(credential.token);
      return {
        getDNSRecords: async () => options.remoteRecords ?? [],
        createDNSRecord: async (zoneId: string, record: Partial<DNSRecord>) => {
          clientCalls.push({ zoneId, record });
          if (options.failCreateFor?.(record)) {
            throw new Error(
              `Cloudflare rejected the record (token ${credential.token})`,
            );
          }
          return remoteRecord(record);
        },
      };
    },
  };

  const code = await runCli(argv, deps);
  return {
    code,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    written,
    clientCalls,
    factoryCalls,
    tokensSeen,
  };
}

/** A clean zone: RFC 2606 names, RFC 5737 / RFC 3849 documentation addresses. */
export const GOOD_ZONE = `; example.com zone
example.com.            300     IN      A       192.0.2.1
www.example.com.        300     IN      CNAME   example.com.
ipv6.example.com.       300     IN      AAAA    2001:db8::1
example.com.            3600    IN      MX      10 mail.example.com.
example.com.            300     IN      TXT     "v=spf1 include:_spf.example.com ~all"
_dmarc.example.com.     300     IN      TXT     "v=DMARC1; p=none; rua=mailto:dmarc@example.com"
`;

/** Six distinct defects, each on a line of its own. */
export const BROKEN_ZONE = `; example.com zone with defects
example.com.            300     IN      A       192.0.2.300
short.example.com.      5       IN      A       192.0.2.2
example.com.            300     IN      AAAA    192.0.2.3
_sip._tcp.example.com.  300     IN      SRV     sip.example.com.
www.example.com.        300     IN      CNAME   example.com.
www.example.com.        300     IN      A       192.0.2.4
elsewhere.example.net.  300     IN      A       192.0.2.5
`;
