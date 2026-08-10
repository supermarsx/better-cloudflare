import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer, type AddressInfo, type Server } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  DEFAULT_ATTEMPTS,
  DEFAULT_BASE_PORT,
  NoFreePortError,
  basePortFrom,
  bindPort,
  clearDevServerState,
  devServerUrl,
  findFreePort,
  isOurDevServer,
  isPinnedPort,
  isPortListening,
  parseCliArguments,
  parsePort,
  reservePort,
  readDevServerState,
  readRunningDevServer,
  resolveDevPort,
  writeDevServerState,
} from "../scripts/dev-port.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const resolverCli = path.join(repoRoot, "scripts", "dev-port.mjs");
const host = "127.0.0.1";

/** Real listeners opened by the tests, torn down even when one fails. */
const openServers = new Set<Server>();

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    openServers.delete(server);
    server.close(() => resolve());
  });
}

/** Occupies `port` for real, so the resolver has to climb past it. */
function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host, port, exclusive: true }, () => {
      server.removeListener("error", reject);
      server.on("error", () => {});
      openServers.add(server);
      resolve(server);
    });
  });
}

/** A port nothing in this repository conventionally uses. */
async function freeBase(): Promise<number> {
  return await findFreePort({ basePort: 24_000, attempts: 500, host });
}

after(async () => {
  await Promise.all([...openServers].map((server) => closeServer(server)));
});

test("a reservation holds the base port when it is free", async () => {
  const base = await freeBase();
  const reservation = await reservePort({ basePort: base, host });

  try {
    assert.equal(reservation.port, base);
    // The port is genuinely held, not merely observed to be free.
    assert.equal(await isPortListening(base, host), true);
    assert.equal(await bindPort(base, host), null);
  } finally {
    await reservation.release();
  }

  const reclaimed = await bindPort(base, host);
  assert.notEqual(reclaimed, null);
  await new Promise<void>((resolve) => reclaimed?.close(() => resolve()));
});

test("the search climbs past ports that are really occupied", async () => {
  const base = await freeBase();
  const blockers = [
    await occupy(base),
    await occupy(base + 1),
    await occupy(base + 2),
  ];

  try {
    const reservation = await reservePort({ basePort: base, host });
    assert.equal(reservation.port, base + 3);
    await reservation.release();

    assert.equal(await findFreePort({ basePort: base, host }), base + 3);
  } finally {
    await Promise.all(blockers.map((server) => closeServer(server)));
  }
});

test("an exhausted range fails with a clear, bounded error", async () => {
  const base = await freeBase();
  const blockers = [await occupy(base), await occupy(base + 1)];

  try {
    await assert.rejects(
      () => reservePort({ basePort: base, attempts: 2, host }),
      (error: unknown) => {
        assert.ok(error instanceof NoFreePortError);
        assert.equal(error.basePort, base);
        assert.equal(error.attempts, 2);
        assert.match(error.message, new RegExp(`${base}-${base + 1}`));
        assert.match(error.message, /No free TCP port/);
        return true;
      },
    );
  } finally {
    await Promise.all(blockers.map((server) => closeServer(server)));
  }
});

test("the search rejects nonsensical bounds instead of spinning", async () => {
  await assert.rejects(
    () => reservePort({ basePort: 0, host }),
    /Not a usable base port/,
  );
  await assert.rejects(
    () => reservePort({ basePort: 3000, attempts: 0, host }),
    /must be positive/,
  );
});

test("ports are parsed strictly", () => {
  assert.equal(parsePort("3000"), 3000);
  assert.equal(parsePort(" 3001 "), 3001);
  assert.equal(parsePort(65_535), 65_535);
  assert.equal(parsePort("0"), null);
  assert.equal(parsePort("65536"), null);
  assert.equal(parsePort("3000abc"), null);
  assert.equal(parsePort(""), null);
  assert.equal(parsePort(undefined), null);
});

test("CI and an explicit PORT pin the port instead of probing", () => {
  assert.equal(isPinnedPort({}), false);
  assert.equal(isPinnedPort({ CI: "" }), false);
  assert.equal(isPinnedPort({ CI: "false" }), false);
  assert.equal(isPinnedPort({ CI: "0" }), false);
  assert.equal(isPinnedPort({ CI: "true" }), true);
  assert.equal(isPinnedPort({ CI: "1" }), true);
  assert.equal(isPinnedPort({ PORT: "4100" }), true);
  assert.equal(isPinnedPort({ PORT: "not-a-port" }), false);

  assert.equal(basePortFrom({}), DEFAULT_BASE_PORT);
  assert.equal(basePortFrom({ PORT: "4100" }), 4100);
  assert.equal(basePortFrom({ PORT: "nope" }), DEFAULT_BASE_PORT);
  assert.equal(DEFAULT_ATTEMPTS, 100);
});

test("a pinned resolution never climbs, even when the port is taken", async () => {
  const base = await freeBase();
  const blocker = await occupy(base);

  try {
    assert.equal(
      await resolveDevPort({
        env: { CI: "true" },
        basePort: base,
        host,
        reuse: false,
      }),
      base,
    );
    assert.equal(
      await resolveDevPort({
        env: { PORT: String(base) },
        host,
        reuse: false,
      }),
      base,
    );
  } finally {
    await closeServer(blocker);
  }
});

test("an unpinned resolution climbs to the first free port", async () => {
  const base = await freeBase();
  const blocker = await occupy(base);

  try {
    assert.equal(
      await resolveDevPort({ env: {}, basePort: base, host, reuse: false }),
      base + 1,
    );
  } finally {
    await closeServer(blocker);
  }
});

test("the resolver command line is parsed and validated", () => {
  assert.deepEqual(parseCliArguments([]), { reuse: true });
  assert.deepEqual(parseCliArguments(["--base", "4200", "--no-reuse"]), {
    basePort: 4200,
    reuse: false,
  });
  assert.deepEqual(parseCliArguments(["--base=4200", "--attempts=7"]), {
    basePort: 4200,
    attempts: 7,
    reuse: true,
  });
  assert.deepEqual(parseCliArguments(["--host", "127.0.0.1"]), {
    host: "127.0.0.1",
    reuse: true,
  });
  assert.throws(() => parseCliArguments(["--base", "0"]), /must be a TCP port/);
  assert.throws(() => parseCliArguments(["--attempts", "0"]), /positive/);
  assert.throws(() => parseCliArguments(["--nope"]), /Unknown option/);
});

test("the resolver command prints a climbed port to stdout", async () => {
  const base = await freeBase();
  const blocker = await occupy(base);

  try {
    const printed = execFileSync(
      process.execPath,
      [
        resolverCli,
        "--base",
        String(base),
        "--host",
        host,
        "--no-reuse",
        "--attempts",
        "20",
      ],
      { cwd: repoRoot, encoding: "utf8", env: { ...process.env, CI: "" } },
    ).trim();
    assert.equal(Number.parseInt(printed, 10), base + 1);
  } finally {
    await closeServer(blocker);
  }
});

test("a foreign server on the recorded port is not reused as our dev server", async () => {
  // A recorded port can be inherited by an unrelated process after the dev
  // server exits. Pointing the desktop shell at that would load someone else's
  // page with this application's native command surface attached, so a TCP
  // connect is not sufficient evidence — the response has to be ours.
  const decoy = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html><head><title>Some Other App</title></head></html>");
  });
  const port = await new Promise<number>((resolve) => {
    decoy.listen(0, "127.0.0.1", () => {
      resolve((decoy.address() as AddressInfo).port);
    });
  });

  try {
    assert.equal(await isPortListening(port), true, "the decoy is listening");
    assert.equal(
      await isOurDevServer(port),
      false,
      "a foreign response must not be accepted as ours",
    );

    writeDevServerState({ port, url: devServerUrl(port), pid: process.pid });
    assert.equal(
      await readRunningDevServer(),
      null,
      "reuse must refuse a port held by something else",
    );
    assert.equal(
      readDevServerState(),
      null,
      "the stale record must be cleared so the next run climbs instead",
    );
  } finally {
    decoy.close();
    clearDevServerState();
  }
});

test("a response carrying our markers is accepted", async () => {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<html><head><title>Better Cloudflare</title>" +
        '<script src="/_next/static/chunks/main.js"></script></head></html>',
    );
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });

  try {
    assert.equal(await isOurDevServer(port), true);
  } finally {
    server.close();
  }
});
