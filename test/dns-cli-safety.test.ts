/**
 * The safety contract of the DNS CLI.
 *
 * A utility that can write to a production zone is only acceptable if the
 * dangerous path is opt-in, announced before it happens, and refusable. These
 * tests assert exactly that: a dry run constructs no client and makes no call,
 * `--apply` is required to mutate, credentials come only from a source the
 * operator named, and a token never appears in output — not even inside an
 * error message that echoes it back.
 *
 * Argument parsing, `--help` on every command, ANSI suppression when the
 * destination is not a terminal, and the exit codes CI relies on are covered
 * here too.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EXIT } from "../scripts/cli/dns-cli";
import {
  describeCredentialSource,
  redact,
  resolveCredential,
} from "../scripts/cli/credentials";
import { shouldUseColor } from "../scripts/cli/terminal";
import { GOOD_ZONE, remoteRecord, runHarness } from "./dns-cli-harness";

const files = { "/zones/good.zone": GOOD_ZONE };
const ZONE_ID = "0123456789abcdef0123456789abcdef";
const TOKEN = "cf-test-token-do-not-print-0123456789";

/** Built at runtime so this file holds no raw ESC byte. */
const ESC = String.fromCharCode(27);
const ANSI = new RegExp(`${ESC}\\[`, "u");
const ANSI_RED = new RegExp(`${ESC}\\[31m`, "u");

test("import is a dry run by default and makes no call at all", async () => {
  const result = await runHarness(
    ["import", "/zones/good.zone", "--zone-id", ZONE_ID],
    { files, env: { CF_TOKEN: TOKEN } },
  );

  assert.equal(result.code, EXIT.ok);
  // The strongest assertion available: no client was even constructed, so no
  // credential was read and no request could have been issued.
  assert.equal(result.factoryCalls, 0);
  assert.equal(result.clientCalls.length, 0);
  assert.match(result.stdout, /^Dry run: 6 record\(s\)/u);
  assert.match(result.stdout, /nothing was sent to Cloudflare/u);
  assert.match(result.stdout, /Re-run with --apply/u);
});

test("the dry run prints the full plan before anything could be written", async () => {
  const result = await runHarness(
    ["import", "/zones/good.zone", "--zone-id", ZONE_ID],
    { files },
  );

  for (const expected of [
    /CREATE {2}line 2 {2}A example\.com\. -> 192\.0\.2\.1 ttl=300/u,
    /CREATE {2}line 5 {2}MX example\.com\. -> mail\.example\.com\. ttl=3600 priority=10/u,
  ]) {
    assert.match(result.stdout, expected);
  }
  assert.equal(result.stdout.match(/^ {2}CREATE/gmu)?.length, 6);
});

test("--apply creates the records through the injected client", async () => {
  const result = await runHarness(
    [
      "import",
      "/zones/good.zone",
      "--zone-id",
      ZONE_ID,
      "--apply",
      "--token-env",
      "CF_TOKEN",
    ],
    { files, env: { CF_TOKEN: TOKEN } },
  );

  assert.equal(result.code, EXIT.ok);
  assert.equal(result.factoryCalls, 1);
  assert.equal(result.clientCalls.length, 6);
  assert.ok(result.clientCalls.every((call) => call.zoneId === ZONE_ID));
  assert.equal(result.clientCalls[0].record.content, "192.0.2.1");
  assert.match(result.stdout, /Created 6 record\(s\), 0 failure\(s\)/u);
});

test("--apply without a named credential source refuses to run", async () => {
  const result = await runHarness(
    ["import", "/zones/good.zone", "--zone-id", ZONE_ID, "--apply"],
    { files, env: { CF_TOKEN: TOKEN, CLOUDFLARE_API_TOKEN: TOKEN } },
  );

  assert.equal(result.code, EXIT.usage);
  assert.equal(result.factoryCalls, 0);
  assert.equal(result.clientCalls.length, 0);
  assert.match(result.stderr, /No credential source was given/u);
  assert.match(result.stderr, /--token-env/u);
  // An ambient CLOUDFLARE_API_TOKEN is deliberately not picked up.
  assert.doesNotMatch(result.stderr, new RegExp(TOKEN, "u"));
});

test("import refuses a file with validation errors unless --allow-invalid", async () => {
  const bad = {
    "/zones/bad.zone": "example.com. 300 IN A 192.0.2.300\n",
  };

  const refused = await runHarness(
    [
      "import",
      "/zones/bad.zone",
      "--zone-id",
      ZONE_ID,
      "--apply",
      "--token-env",
      "CF_TOKEN",
    ],
    { files: bad, env: { CF_TOKEN: TOKEN } },
  );
  assert.equal(refused.code, EXIT.failed);
  assert.equal(refused.factoryCalls, 0);
  assert.equal(refused.clientCalls.length, 0);
  assert.match(refused.stderr, /Refusing to import/u);

  // Even with --allow-invalid the rejected record is still skipped, so a bad
  // record is never sent; the flag only lets the remaining records through.
  const forced = await runHarness(
    [
      "import",
      "/zones/bad.zone",
      "--zone-id",
      ZONE_ID,
      "--apply",
      "--allow-invalid",
      "--token-env",
      "CF_TOKEN",
    ],
    { files: bad, env: { CF_TOKEN: TOKEN } },
  );
  assert.equal(forced.code, EXIT.ok);
  assert.equal(forced.clientCalls.length, 0);
});

test("--apply stops at the first failure unless --continue-on-error", async () => {
  const failOnIpv6 = (record: { type?: string }) => record.type === "AAAA";

  const stopping = await runHarness(
    [
      "import",
      "/zones/good.zone",
      "--zone-id",
      ZONE_ID,
      "--apply",
      "--token-env",
      "CF_TOKEN",
    ],
    { files, env: { CF_TOKEN: TOKEN }, failCreateFor: failOnIpv6 },
  );
  assert.equal(stopping.code, EXIT.failed);
  assert.equal(stopping.clientCalls.length, 3);
  assert.match(stopping.stderr, /Stopping at the first failure/u);

  const continuing = await runHarness(
    [
      "import",
      "/zones/good.zone",
      "--zone-id",
      ZONE_ID,
      "--apply",
      "--continue-on-error",
      "--token-env",
      "CF_TOKEN",
    ],
    { files, env: { CF_TOKEN: TOKEN }, failCreateFor: failOnIpv6 },
  );
  assert.equal(continuing.code, EXIT.failed);
  assert.equal(continuing.clientCalls.length, 6);
  assert.match(continuing.stdout, /Created 5 record\(s\), 1 failure\(s\)/u);
});

test("a token echoed back by the API never reaches the output", async () => {
  // The stub deliberately embeds the token in its error message, the way a
  // transport layer that logs a request URL or header would.
  const result = await runHarness(
    [
      "import",
      "/zones/good.zone",
      "--zone-id",
      ZONE_ID,
      "--apply",
      "--continue-on-error",
      "--token-env",
      "CF_TOKEN",
    ],
    { files, env: { CF_TOKEN: TOKEN }, failCreateFor: () => true },
  );

  assert.equal(result.code, EXIT.failed);
  assert.deepEqual(result.tokensSeen, [TOKEN]);
  assert.doesNotMatch(result.stdout, new RegExp(TOKEN, "u"));
  assert.doesNotMatch(result.stderr, new RegExp(TOKEN, "u"));
  assert.match(result.stdout, /\[redacted\]/u);
  // The source is named, the secret is not.
  assert.match(
    result.stderr,
    /credentials from environment variable CF_TOKEN/u,
  );
});

test("export reads a live zone without mutating it", async () => {
  const result = await runHarness(
    [
      "export",
      "--zone-id",
      ZONE_ID,
      "--format",
      "csv",
      "--token-env",
      "CF_TOKEN",
    ],
    {
      env: { CF_TOKEN: TOKEN },
      remoteRecords: [
        remoteRecord({ type: "A", name: "www.example.com" }),
        remoteRecord({
          type: "AAAA",
          name: "ipv6.example.com",
          content: "2001:db8::1",
        }),
      ],
    },
  );

  assert.equal(result.code, EXIT.ok);
  assert.equal(result.factoryCalls, 1);
  assert.equal(result.clientCalls.length, 0);
  assert.match(result.stdout, /^"Type","Name","Content","TTL"/u);
  assert.match(result.stdout, /"AAAA","ipv6\.example\.com","2001:db8::1"/u);
  assert.match(result.stderr, /Exported 2 record\(s\) as csv/u);
});

test("export requires a zone id and a credential source", async () => {
  const noZone = await runHarness(["export", "--token-env", "CF_TOKEN"], {
    env: { CF_TOKEN: TOKEN },
  });
  assert.equal(noZone.code, EXIT.usage);
  assert.match(noZone.stderr, /--zone-id is required/u);

  const noCredential = await runHarness(["export", "--zone-id", ZONE_ID]);
  assert.equal(noCredential.code, EXIT.usage);
  assert.equal(noCredential.factoryCalls, 0);
});

test("resolveCredential reads only the source it is given", async () => {
  const fromEnv = await resolveCredential(
    { tokenEnv: "CF_TOKEN" },
    {
      CF_TOKEN: `  ${TOKEN}  `,
    },
  );
  assert.equal(fromEnv.token, TOKEN);
  assert.equal(
    describeCredentialSource(fromEnv.source),
    "environment variable CF_TOKEN",
  );

  await assert.rejects(
    () => resolveCredential({ tokenEnv: "MISSING" }, {}),
    /MISSING is not set or is empty/u,
  );
  await assert.rejects(
    () =>
      resolveCredential(
        { tokenEnv: "CF_TOKEN", tokenFile: "/tmp/token" },
        { CF_TOKEN: TOKEN },
      ),
    /not both/u,
  );
  await assert.rejects(
    () => resolveCredential({}, {}),
    /No credential source was given/u,
  );
});

test("redact removes the secret and leaves short strings alone", () => {
  assert.equal(redact(`auth ${TOKEN} failed`, TOKEN), "auth [redacted] failed");
  assert.equal(redact("nothing to do", undefined), "nothing to do");
  // A very short "secret" would redact unrelated text, so it is ignored.
  assert.equal(redact("abc def", "ab"), "abc def");
});

test("--help works on every command and exits 0 without ANSI", async () => {
  for (const command of ["validate", "export", "import", "migrate"]) {
    const result = await runHarness([command, "--help"], { tty: true });
    assert.equal(result.code, EXIT.ok, command);
    assert.match(result.stdout, new RegExp(`^dns ${command} —`, "u"));
    assert.match(result.stdout, /Usage:/u);
    assert.match(result.stdout, /Exit codes:/u);
    // Help is plain text even on a TTY, so it stays copy-pasteable.
    assert.doesNotMatch(result.stdout, ANSI);
  }
});

test("top-level help is reachable four ways and only bare invocation fails", async () => {
  for (const argv of [["--help"], ["-h"], ["help"], ["help", "import"]]) {
    const result = await runHarness(argv);
    assert.equal(result.code, EXIT.ok, argv.join(" "));
    assert.ok(result.stdout.length > 0);
  }

  const bare = await runHarness([]);
  assert.equal(bare.code, EXIT.usage);
  assert.match(bare.stdout, /better-cloudflare DNS CLI/u);
  assert.match(bare.stdout, /DRY RUN by default/u);
});

test("unknown commands and unknown options are usage errors", async () => {
  const badCommand = await runHarness(["destroy", "--everything"]);
  assert.equal(badCommand.code, EXIT.usage);
  assert.match(badCommand.stderr, /Unknown command "destroy"/u);

  const badOption = await runHarness(
    ["validate", "/zones/good.zone", "--wat"],
    { files },
  );
  assert.equal(badOption.code, EXIT.usage);
  assert.match(badOption.stderr, /--wat/u);

  const extraPositional = await runHarness(
    ["validate", "/zones/good.zone", "/zones/good.zone"],
    { files },
  );
  assert.equal(extraPositional.code, EXIT.usage);

  const positionalOnExport = await runHarness(["export", "oops"]);
  assert.equal(positionalOnExport.code, EXIT.usage);
  assert.match(positionalOnExport.stderr, /no positional arguments/u);
});

test("exit codes are 0 / 1 / 2 and nothing else", async () => {
  const cases: Array<[string[], number]> = [
    [["validate", "/zones/good.zone"], EXIT.ok],
    [["validate", "/zones/bad.zone"], EXIT.failed],
    [["validate", "/zones/absent.zone"], EXIT.usage],
  ];
  for (const [argv, expected] of cases) {
    const result = await runHarness(argv, {
      files: {
        ...files,
        "/zones/bad.zone": "example.com. 300 IN A 192.0.2.300\n",
      },
    });
    assert.equal(result.code, expected, argv.join(" "));
  }
});

test("output is styled only for an interactive, colour-permitting terminal", async () => {
  const piped = await runHarness(["validate", "/zones/bad.zone"], {
    files: { "/zones/bad.zone": "example.com. 300 IN A 192.0.2.300\n" },
  });
  assert.doesNotMatch(piped.stdout, ANSI);

  const terminal = await runHarness(["validate", "/zones/bad.zone"], {
    files: { "/zones/bad.zone": "example.com. 300 IN A 192.0.2.300\n" },
    tty: true,
  });
  assert.match(terminal.stdout, ANSI_RED);

  const suppressed = await runHarness(
    ["validate", "/zones/bad.zone", "--no-color"],
    {
      files: { "/zones/bad.zone": "example.com. 300 IN A 192.0.2.300\n" },
      tty: true,
    },
  );
  assert.doesNotMatch(suppressed.stdout, ANSI);

  assert.equal(shouldUseColor({ write: () => true, isTTY: true }, {}), true);
  assert.equal(
    shouldUseColor({ write: () => true, isTTY: true }, { NO_COLOR: "1" }),
    false,
  );
  assert.equal(shouldUseColor({ write: () => true }, {}), false);
  assert.equal(
    shouldUseColor({ write: () => true, isTTY: true }, {}, true),
    false,
  );
});
