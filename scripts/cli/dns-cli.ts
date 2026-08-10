#!/usr/bin/env tsx
/**
 * A lightweight DNS record utility: validate a migration before it happens,
 * move records between the formats the application already supports, and — only
 * when explicitly told to — write them into a live Cloudflare zone.
 *
 * Design rules, in priority order:
 *
 * 1. **Nothing mutates by default.** `validate` and `migrate` never open a
 *    socket and never ask for credentials. `import` is a dry run until
 *    `--apply` is passed, and it prints the complete plan before the first
 *    write either way.
 * 2. **Credentials are named by the operator.** See `./credentials.ts`.
 * 3. **The parsers are the application's.** See `./records.ts` and
 *    `./validate.ts`; no format or rule is reimplemented here.
 * 4. **Exit codes are usable from CI.** 0 success, 1 validation or operation
 *    failure, 2 usage error.
 */
import {
  readFile as readFileFs,
  writeFile as writeFileFs,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { DNSRecord } from "../../src/types/dns";
import { prepareCopiedDnsRecord } from "../../src/lib/dns/record-copy";
import {
  createCloudflareClient,
  describeCredentialSource,
  redact,
  resolveCredential,
  CredentialError,
  type DnsClientFactory,
} from "./credentials";
import {
  completeRecord,
  inferFormat,
  isRecordFormat,
  parseRecords,
  RECORD_FORMATS,
  RecordFormatError,
  serializeRecords,
  type RecordFormat,
  type SourceRecord,
} from "./records";
import { Terminal, shouldUseColor, type OutputStreams } from "./terminal";
import { validateRecords, type ValidationReport } from "./validate";

/** Exit codes, fixed so the CLI can gate someone else's pipeline. */
export const EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  usage: 2,
});

/** Everything the CLI touches outside itself, so tests can supply their own. */
export interface CliDependencies {
  streams: OutputStreams;
  env: Record<string, string | undefined>;
  readFile: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, contents: string) => Promise<void>;
  clientFactory: DnsClientFactory;
}

class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const COMMANDS = ["validate", "export", "import", "migrate"] as const;
type Command = (typeof COMMANDS)[number];

const FORMAT_LIST = RECORD_FORMATS.join("|");

const ROOT_HELP = `better-cloudflare DNS CLI

Usage:
  npm run dns -- <command> [options]

Commands:
  validate   Report every record in a file that would be rejected. Offline;
             needs no credentials. Use this before touching a live zone.
  migrate    Convert a file between ${FORMAT_LIST} and rewrite hostnames when
             moving records from one zone to another. Offline.
  export     Read a live Cloudflare zone and write it as ${FORMAT_LIST}.
  import     Create records in a live Cloudflare zone from a file.
             DRY RUN by default; --apply is required to write anything.

Run \`npm run dns -- <command> --help\` for a command's options.

Exit codes:
  0  success
  1  validation failed, or the operation failed
  2  usage error`;

const VALIDATE_HELP = `dns validate — check a file for records that would be rejected

Usage:
  npm run dns -- validate <file> [options]

Runs entirely offline. No credentials are read and no network request is made.

Options:
  -f, --format <fmt>         Input format (${FORMAT_LIST}). Inferred from
                             the file extension when omitted.
      --zone <apex>          Zone the records are destined for. Enables the
                             check that every name lives inside that zone.
      --strict               Treat warnings as failures.
      --json                 Emit the report as JSON instead of text.
      --no-color             Never style the output.
  -h, --help                 Show this help.

Exit codes:
  0  no errors (and, with --strict, no warnings)
  1  at least one record would be rejected
  2  the file could not be read or the arguments were wrong`;

const MIGRATE_HELP = `dns migrate — convert formats and rewrite hostnames between zones

Usage:
  npm run dns -- migrate <file> --to <${FORMAT_LIST}> [options]

Runs entirely offline and never writes to a zone. Hostname rewriting reuses
prepareCopiedDnsRecord from src/lib/dns/record-copy.ts, so record types whose
RDATA embeds a hostname — SRV, MX, NAPTR, SVCB/HTTPS, URI, RP, and the domains
inside SPF and DMARC payloads — are rewritten too, not just the record name.

Options:
      --to <fmt>             Output format (${FORMAT_LIST}). Required.
      --from <fmt>           Input format (${FORMAT_LIST}). Inferred from
                             the file extension when omitted.
      --from-zone <apex>     Zone the records currently belong to.
      --to-zone <apex>       Zone they are moving to. Pass both to rewrite.
  -o, --out <file>           Write here instead of stdout.
      --no-color             Never style the output.
  -h, --help                 Show this help.

Exit codes:
  0  success
  2  the file could not be read or the arguments were wrong`;

const EXPORT_HELP = `dns export — read a live zone and write it to a file

Usage:
  npm run dns -- export --zone-id <id> --token-env <VAR> [options]

Reads only; this command never modifies a zone. Credentials come from the
source you name and from nowhere else, and the token is never printed.

Options:
      --zone-id <id>         Cloudflare zone id. Required.
  -f, --format <fmt>         Output format (${FORMAT_LIST}). Default: json.
  -o, --out <file>           Write here instead of stdout.
      --token-env <VAR>      Read the API token from this environment variable.
      --token-file <path>    Read the API token from this file.
      --email <address>      Use global API key authentication with this email.
      --api-base <url>       Override the Cloudflare API base URL.
      --no-color             Never style the output.
  -h, --help                 Show this help.

Exactly one of --token-env or --token-file is required.

Exit codes:
  0  success
  1  the export failed
  2  the arguments were wrong or no credential source was named`;

const IMPORT_HELP = `dns import — create records in a live zone from a file

Usage:
  npm run dns -- import <file> --zone-id <id> [options]

DRY RUN BY DEFAULT. Without --apply this command validates the file, prints
every record it would create, and exits without contacting Cloudflare at all —
no credentials are read and no client is constructed.

The file is always validated first. If any record would be rejected the import
refuses to proceed unless --allow-invalid is given.

Options:
      --zone-id <id>         Cloudflare zone id. Required.
  -f, --format <fmt>         Input format (${FORMAT_LIST}). Inferred from
                             the file extension when omitted.
      --zone <apex>          Zone apex, for the name-containment check.
      --apply                Actually create the records. Without this flag
                             nothing is written.
      --allow-invalid        Proceed even though records failed validation.
      --continue-on-error    Keep going after a record fails to create.
                             Default: stop at the first failure.
      --token-env <VAR>      Read the API token from this environment variable.
      --token-file <path>    Read the API token from this file.
      --email <address>      Use global API key authentication with this email.
      --api-base <url>       Override the Cloudflare API base URL.
      --no-color             Never style the output.
  -h, --help                 Show this help.

--apply requires exactly one of --token-env or --token-file.

Exit codes:
  0  success, including a completed dry run
  1  validation failed, or a record could not be created
  2  the arguments were wrong or no credential source was named`;

const HELP_BY_COMMAND: Record<Command, string> = {
  validate: VALIDATE_HELP,
  migrate: MIGRATE_HELP,
  export: EXPORT_HELP,
  import: IMPORT_HELP,
};

const CREDENTIAL_OPTIONS = {
  "token-env": { type: "string" },
  "token-file": { type: "string" },
  email: { type: "string" },
  "api-base": { type: "string" },
} as const;

const COMMON_OPTIONS = {
  help: { type: "boolean", short: "h" },
  "no-color": { type: "boolean" },
} as const;

function resolveFormat(
  explicit: string | undefined,
  filePath: string,
  what: string,
): RecordFormat {
  if (explicit !== undefined) {
    if (!isRecordFormat(explicit)) {
      throw new UsageError(
        `Unknown ${what} "${explicit}". Supported formats: ${FORMAT_LIST}.`,
      );
    }
    return explicit;
  }
  const inferred = inferFormat(filePath);
  if (inferred) return inferred;
  throw new UsageError(
    `Could not infer the format of "${path.basename(filePath)}". ` +
      `Pass an explicit format (${FORMAT_LIST}).`,
  );
}

function requirePositional(
  positionals: string[],
  what: string,
  command: Command,
): string {
  if (positionals.length === 0) {
    throw new UsageError(
      `${command} needs a ${what}. Run \`npm run dns -- ${command} --help\`.`,
    );
  }
  if (positionals.length > 1) {
    throw new UsageError(
      `${command} takes one ${what}; got ${positionals.length}.`,
    );
  }
  return positionals[0];
}

function requireOption(value: string | undefined, flag: string): string {
  if (value === undefined || value.trim() === "") {
    throw new UsageError(`${flag} is required.`);
  }
  return value;
}

function locationOf(line: number | null, index: number): string {
  return line === null ? `record[${index}]` : `line ${line}`;
}

function describeRecord(record: Partial<DNSRecord>): string {
  const ttl = record.ttl === undefined ? "" : ` ttl=${record.ttl}`;
  const priority =
    record.priority === undefined ? "" : ` priority=${record.priority}`;
  const proxied = record.proxied === true ? " proxied" : "";
  return `${record.type ?? "?"} ${record.name ?? "?"} -> ${record.content ?? "?"}${ttl}${priority}${proxied}`;
}

function printReport(
  terminal: Terminal,
  report: ValidationReport,
  strict: boolean,
): void {
  const { style } = terminal;
  for (const entry of report.reports) {
    if (entry.issues.length === 0) continue;
    terminal.out(
      `  ${style.bold(locationOf(entry.line, entry.index))}  ${style.dim(entry.label)}`,
    );
    for (const issue of entry.issues) {
      const tag =
        issue.severity === "error"
          ? style.red("error  ")
          : style.yellow("warning");
      terminal.out(`      ${tag}  ${issue.message}`);
    }
  }

  if (report.notes.length > 0) {
    terminal.out();
    for (const note of report.notes) {
      terminal.out(`  ${style.bold("note")}  ${note}`);
    }
  }

  terminal.out();
  const summary =
    `${report.recordCount} record(s), ` +
    `${report.errorCount} error(s), ${report.warningCount} warning(s)`;
  const failed = report.errorCount > 0 || (strict && report.warningCount > 0);
  terminal.out(failed ? style.red(summary) : style.green(summary));
}

async function loadFile(
  deps: CliDependencies,
  filePath: string,
  format: RecordFormat,
): Promise<SourceRecord[]> {
  let text: string;
  try {
    text = await deps.readFile(filePath);
  } catch (error) {
    throw new UsageError(
      `Could not read ${filePath}: ${(error as Error).message}`,
    );
  }
  return parseRecords(text, format);
}

async function emit(
  deps: CliDependencies,
  terminal: Terminal,
  contents: string,
  outPath: string | undefined,
): Promise<void> {
  if (outPath === undefined) {
    terminal.out(contents);
    return;
  }
  await deps.writeFile(outPath, `${contents}\n`);
  terminal.err(`Wrote ${outPath}`);
}

async function runValidate(
  argv: string[],
  deps: CliDependencies,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      ...COMMON_OPTIONS,
      format: { type: "string", short: "f" },
      zone: { type: "string" },
      strict: { type: "boolean" },
      json: { type: "boolean" },
    },
  });

  const terminal = makeTerminal(deps, values["no-color"] === true);
  if (values.help) {
    terminal.out(VALIDATE_HELP);
    return EXIT.ok;
  }

  const filePath = requirePositional(positionals, "file", "validate");
  const format = resolveFormat(values.format, filePath, "format");
  const sources = await loadFile(deps, filePath, format);
  const report = validateRecords(sources, {
    ...(values.zone ? { zone: values.zone } : {}),
  });
  const failed =
    report.errorCount > 0 ||
    (values.strict === true && report.warningCount > 0);

  if (values.json) {
    terminal.out(
      JSON.stringify({ file: filePath, format, ...report }, null, 2),
    );
    return failed ? EXIT.failed : EXIT.ok;
  }

  terminal.out(
    `Validating ${filePath} (${format}, ${sources.length} record(s))`,
  );
  terminal.out();
  printReport(terminal, report, values.strict === true);
  return failed ? EXIT.failed : EXIT.ok;
}

async function runMigrate(
  argv: string[],
  deps: CliDependencies,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      ...COMMON_OPTIONS,
      to: { type: "string" },
      from: { type: "string" },
      "from-zone": { type: "string" },
      "to-zone": { type: "string" },
      out: { type: "string", short: "o" },
    },
  });

  const terminal = makeTerminal(deps, values["no-color"] === true);
  if (values.help) {
    terminal.out(MIGRATE_HELP);
    return EXIT.ok;
  }

  const filePath = requirePositional(positionals, "file", "migrate");
  const target = requireOption(values.to, "--to");
  if (!isRecordFormat(target)) {
    throw new UsageError(
      `Unknown output format "${target}". Supported formats: ${FORMAT_LIST}.`,
    );
  }
  const source = resolveFormat(values.from, filePath, "input format");

  const fromZone = values["from-zone"];
  const toZone = values["to-zone"];
  if ((fromZone === undefined) !== (toZone === undefined)) {
    throw new UsageError(
      "--from-zone and --to-zone must be given together to rewrite hostnames.",
    );
  }

  const sources = await loadFile(deps, filePath, source);
  const records = sources.map((entry) =>
    fromZone && toZone
      ? prepareCopiedDnsRecord(
          completeRecord(entry.record),
          fromZone,
          toZone,
          true,
        )
      : entry.record,
  );

  await emit(deps, terminal, serializeRecords(records, target), values.out);
  terminal.err(
    `Converted ${records.length} record(s) from ${source} to ${target}` +
      (fromZone && toZone ? `, rewriting ${fromZone} to ${toZone}` : ""),
  );
  return EXIT.ok;
}

async function runExport(
  argv: string[],
  deps: CliDependencies,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      ...COMMON_OPTIONS,
      ...CREDENTIAL_OPTIONS,
      "zone-id": { type: "string" },
      format: { type: "string", short: "f" },
      out: { type: "string", short: "o" },
    },
  });

  const terminal = makeTerminal(deps, values["no-color"] === true);
  if (values.help) {
    terminal.out(EXPORT_HELP);
    return EXIT.ok;
  }
  if (positionals.length > 0) {
    throw new UsageError(
      `export takes no positional arguments; got "${positionals[0]}".`,
    );
  }

  const zoneId = requireOption(values["zone-id"], "--zone-id");
  const format = values.format ?? "json";
  if (!isRecordFormat(format)) {
    throw new UsageError(
      `Unknown output format "${format}". Supported formats: ${FORMAT_LIST}.`,
    );
  }

  const credential = await resolveCredential(
    {
      ...(values["token-env"] ? { tokenEnv: values["token-env"] } : {}),
      ...(values["token-file"] ? { tokenFile: values["token-file"] } : {}),
      ...(values.email ? { email: values.email } : {}),
    },
    deps.env,
  );
  terminal.err(
    `Reading zone ${zoneId} with credentials from ${describeCredentialSource(credential.source)}.`,
  );

  let records: DNSRecord[];
  try {
    const client = await deps.clientFactory(credential, values["api-base"]);
    records = await client.getDNSRecords(zoneId);
  } catch (error) {
    terminal.err(
      terminal.style.red(
        `Export failed: ${redact((error as Error).message, credential.token)}`,
      ),
    );
    return EXIT.failed;
  }

  await emit(deps, terminal, serializeRecords(records, format), values.out);
  terminal.err(`Exported ${records.length} record(s) as ${format}.`);
  return EXIT.ok;
}

async function runImport(
  argv: string[],
  deps: CliDependencies,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      ...COMMON_OPTIONS,
      ...CREDENTIAL_OPTIONS,
      "zone-id": { type: "string" },
      format: { type: "string", short: "f" },
      zone: { type: "string" },
      apply: { type: "boolean" },
      "allow-invalid": { type: "boolean" },
      "continue-on-error": { type: "boolean" },
    },
  });

  const terminal = makeTerminal(deps, values["no-color"] === true);
  const { style } = terminal;
  if (values.help) {
    terminal.out(IMPORT_HELP);
    return EXIT.ok;
  }

  const filePath = requirePositional(positionals, "file", "import");
  const zoneId = requireOption(values["zone-id"], "--zone-id");
  const format = resolveFormat(values.format, filePath, "format");
  const sources = await loadFile(deps, filePath, format);
  const report = validateRecords(sources, {
    ...(values.zone ? { zone: values.zone } : {}),
  });

  terminal.out(
    `${values.apply ? "Importing" : "Dry run"}: ${sources.length} record(s) ` +
      `from ${filePath} (${format}) into zone ${zoneId}`,
  );
  terminal.out();
  for (const entry of sources) {
    const failing = report.reports[entry.index].issues.some(
      (issue) => issue.severity === "error",
    );
    const marker = failing ? style.red("SKIP  ") : style.green("CREATE");
    terminal.out(
      `  ${marker}  ${style.dim(locationOf(entry.line, entry.index))}  ${describeRecord(entry.record)}`,
    );
  }
  terminal.out();

  if (report.errorCount > 0) {
    printReport(terminal, report, false);
    if (values["allow-invalid"] !== true) {
      terminal.out();
      terminal.err(
        style.red(
          `Refusing to import: ${report.errorCount} error(s) in ${filePath}. ` +
            "Fix the file, or pass --allow-invalid to send it anyway.",
        ),
      );
      return EXIT.failed;
    }
    terminal.out(
      style.yellow(
        "--allow-invalid was given: records with errors are still skipped, " +
          "the rest will be sent.",
      ),
    );
  }

  const creatable = sources.filter(
    (entry) =>
      !report.reports[entry.index].issues.some(
        (issue) => issue.severity === "error",
      ),
  );

  if (values.apply !== true) {
    terminal.out(
      style.bold(
        `Dry run complete. ${creatable.length} record(s) would be created; ` +
          "nothing was sent to Cloudflare.",
      ),
    );
    terminal.out("Re-run with --apply to create them.");
    return EXIT.ok;
  }

  const credential = await resolveCredential(
    {
      ...(values["token-env"] ? { tokenEnv: values["token-env"] } : {}),
      ...(values["token-file"] ? { tokenFile: values["token-file"] } : {}),
      ...(values.email ? { email: values.email } : {}),
    },
    deps.env,
  );
  terminal.err(
    `Applying with credentials from ${describeCredentialSource(credential.source)}.`,
  );

  let client;
  try {
    client = await deps.clientFactory(credential, values["api-base"]);
  } catch (error) {
    terminal.err(
      style.red(
        `Could not create an API client: ${redact((error as Error).message, credential.token)}`,
      ),
    );
    return EXIT.failed;
  }

  let created = 0;
  let failed = 0;
  for (const entry of creatable) {
    try {
      await client.createDNSRecord(zoneId, entry.record);
      created++;
      terminal.out(
        `  ${style.green("created")}  ${describeRecord(entry.record)}`,
      );
    } catch (error) {
      failed++;
      terminal.out(
        `  ${style.red("failed ")}  ${describeRecord(entry.record)}: ` +
          redact((error as Error).message, credential.token),
      );
      if (values["continue-on-error"] !== true) {
        terminal.err(
          style.red(
            "Stopping at the first failure. Pass --continue-on-error to keep going.",
          ),
        );
        break;
      }
    }
  }

  terminal.out();
  terminal.out(`Created ${created} record(s), ${failed} failure(s).`);
  return failed > 0 ? EXIT.failed : EXIT.ok;
}

function makeTerminal(deps: CliDependencies, noColor: boolean): Terminal {
  return new Terminal(
    deps.streams,
    shouldUseColor(deps.streams.stdout, deps.env, noColor),
  );
}

function defaultDependencies(): CliDependencies {
  return {
    streams: { stdout: process.stdout, stderr: process.stderr },
    env: process.env,
    readFile: (filePath) => readFileFs(filePath, "utf8"),
    writeFile: (filePath, contents) => writeFileFs(filePath, contents, "utf8"),
    clientFactory: createCloudflareClient,
  };
}

const RUNNERS: Record<
  Command,
  (argv: string[], deps: CliDependencies) => Promise<number>
> = {
  validate: runValidate,
  migrate: runMigrate,
  export: runExport,
  import: runImport,
};

function isCommand(value: string): value is Command {
  return (COMMANDS as readonly string[]).includes(value);
}

/**
 * Run the CLI. Returns the process exit code instead of exiting, so the whole
 * surface — including `--help` and every failure path — is testable in-process.
 */
export async function runCli(
  argv: string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const deps: CliDependencies = { ...defaultDependencies(), ...overrides };
  const [commandName, ...rest] = argv;

  if (
    commandName === undefined ||
    commandName === "--help" ||
    commandName === "-h" ||
    commandName === "help"
  ) {
    const topic = rest[0];
    const terminal = makeTerminal(deps, false);
    if (topic !== undefined && isCommand(topic)) {
      terminal.out(HELP_BY_COMMAND[topic]);
      return EXIT.ok;
    }
    terminal.out(ROOT_HELP);
    return commandName === undefined ? EXIT.usage : EXIT.ok;
  }

  if (!isCommand(commandName)) {
    const terminal = makeTerminal(deps, false);
    terminal.err(`Unknown command "${commandName}".`);
    terminal.err(`Commands: ${COMMANDS.join(", ")}. Try --help.`);
    return EXIT.usage;
  }

  try {
    return await RUNNERS[commandName](rest, deps);
  } catch (error) {
    const terminal = makeTerminal(deps, false);
    if (
      error instanceof UsageError ||
      error instanceof CredentialError ||
      error instanceof RecordFormatError
    ) {
      terminal.err(`${commandName}: ${error.message}`);
      return EXIT.usage;
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      // node:util throws these for unknown or malformed options.
      terminal.err(`${commandName}: ${(error as Error).message}`);
      terminal.err(`Run \`npm run dns -- ${commandName} --help\`.`);
      return EXIT.usage;
    }
    terminal.err(`${commandName}: ${(error as Error).message}`);
    return EXIT.failed;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = EXIT.failed;
    });
}
