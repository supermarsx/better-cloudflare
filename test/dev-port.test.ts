import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  type RequestListener,
  type Server as HttpServer,
} from "node:http";
import {
  createServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import {
  DEFAULT_ATTEMPTS,
  DEFAULT_BASE_PORT,
  DEV_IDENTITY_META,
  DEV_SERVER_STATE_FILE,
  NoFreePortError,
  aggregateDevServerVerdicts,
  basePortFrom,
  bindPort,
  checkLoopbackOwnership,
  classifyDevServerResponse,
  clearDevServerState,
  createDevIdentityToken,
  devServerUrl,
  extractDevIdentity,
  findFreePort,
  isOurDevServer,
  isPinnedPort,
  isPortListening,
  parseCliArguments,
  parsePort,
  probeDevServer,
  readDevServerState,
  readRunningDevServer,
  reservePort,
  resolveDevPort,
  resolveDevServer,
  writeDevServerState,
} from "../scripts/dev-port.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const resolverCli = path.join(repoRoot, "scripts", "dev-port.mjs");
const host = "127.0.0.1";

// ─── Harness ────────────────────────────────────────────────────────────────

/** Real listeners opened by the tests, torn down even when one fails. */
const openServers = new Set<Server | HttpServer>();
/** Sockets held open by listeners that never answer. */
const openSockets = new Set<Socket>();

function closeServer(server: Server | HttpServer): Promise<void> {
  return new Promise((resolve) => {
    openServers.delete(server);
    if ("closeAllConnections" in server) server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** Whether this machine can listen on `address` at all. */
function canListen(address: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ host: address, port: 0 }, () => {
      probe.close(() => resolve(true));
    });
  });
}

const ipv6 = await canListen("::1");
const needsIpv6 = ipv6 ? false : "IPv6 loopback is not available here";

/** Occupies `port` on `address` with a listener that never says anything. */
function occupy(port: number, address = host): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      openSockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => openSockets.delete(socket));
    });
    server.once("error", reject);
    server.listen({ host: address, port, exclusive: true }, () => {
      server.removeListener("error", reject);
      server.on("error", () => {});
      openServers.add(server);
      resolve(server);
    });
  });
}

/** Serves `handler` on `address`, at `port` or a random one. */
function serve(
  handler: RequestListener,
  address = host,
  port = 0,
): Promise<{ server: HttpServer; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createHttpServer(handler);
    server.once("error", reject);
    server.listen({ host: address, port }, () => {
      server.removeListener("error", reject);
      openServers.add(server);
      resolve({ server, port: (server.address() as AddressInfo).port });
    });
  });
}

function html(body: string): RequestListener {
  return (_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(body);
  };
}

/** What this checkout's dev server serves: the shell, the name, and the tag. */
function appPage(token: string): string {
  return (
    "<!DOCTYPE html><html><head><title>Better Cloudflare</title>" +
    '<meta name="application-name" content="Better Cloudflare"/>' +
    `<meta name="${DEV_IDENTITY_META}" content="${token}"/>` +
    '<script src="/_next/static/chunks/main.js"></script>' +
    "</head><body></body></html>"
  );
}

/**
 * Another Next.js application - the case that got through before. It serves
 * `/_next/`, which every Next.js app does and which alone used to be trusted.
 */
const ANOTHER_NEXT_APP =
  "<!DOCTYPE html><html><head><title>Portfolio</title>" +
  '<script src="/_next/static/chunks/main.js"></script>' +
  "</head><body></body></html>";

/**
 * A page carrying both of the markers that used to be trusted - `/_next/` and
 * the application name - with no identity tag: another checkout of this
 * repository from before identity tokens, or anything that mentions the name.
 */
const APP_NAME_WITHOUT_TOKEN =
  "<!DOCTYPE html><html><head><title>Better Cloudflare</title>" +
  '<script src="/_next/static/chunks/main.js"></script>' +
  "</head><body></body></html>";

/**
 * A free port from a base well below Windows' dynamic range (49152-65535).
 * Hyper-V and WSL reserve blocks of that range - 49673-49972 on the machine
 * this was written on - and a bind there fails with EACCES, so a fixed base
 * inside it can find no free port at all.
 */
async function freeBase(): Promise<number> {
  return await findFreePort({ basePort: 24_000, attempts: 500, host });
}

// The state-file tests write the real record. Keep whatever was there.
const priorState = existsSync(DEV_SERVER_STATE_FILE)
  ? readFileSync(DEV_SERVER_STATE_FILE, "utf8")
  : null;

after(async () => {
  for (const socket of openSockets) socket.destroy();
  await Promise.all([...openServers].map((server) => closeServer(server)));
  if (priorState === null) {
    rmSync(DEV_SERVER_STATE_FILE, { force: true });
  } else {
    mkdirSync(path.dirname(DEV_SERVER_STATE_FILE), { recursive: true });
    writeFileSync(DEV_SERVER_STATE_FILE, priorState, "utf8");
  }
});

// ─── Port reservation ───────────────────────────────────────────────────────

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

test("a wildcard bind is not taken as proof that a port is free", async () => {
  // The hole this module had. Windows lets a wildcard bind succeed while
  // another process holds the same port on 127.0.0.1, and that process then
  // receives every request to it. Only asking the loopback address tells the
  // two apart. (Linux refuses the bind itself; the result is the same.)
  const base = await freeBase();
  const stranger = await occupy(base, "127.0.0.1");

  try {
    const reservation = await reservePort({
      basePort: base,
      host: "0.0.0.0",
      attempts: 10,
    });
    try {
      assert.notEqual(
        reservation.port,
        base,
        "a port a stranger answers on is not free",
      );
    } finally {
      await reservation.release();
    }
  } finally {
    await closeServer(stranger);
  }
});

test(
  "a stranger on ::1 disqualifies a port that is free on 127.0.0.1",
  { skip: needsIpv6 },
  async () => {
    // `localhost` resolves to ::1 first, so a client would reach the stranger
    // even though 127.0.0.1 binds cleanly.
    const base = await freeBase();
    const stranger = await occupy(base, "::1");

    try {
      const reservation = await reservePort({
        basePort: base,
        host: "127.0.0.1",
        attempts: 10,
      });
      try {
        assert.notEqual(reservation.port, base);
      } finally {
        await reservation.release();
      }
    } finally {
      await closeServer(stranger);
    }
  },
);

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
  assert.deepEqual(parseCliArguments(["--no-reuse", "--json"]), {
    reuse: false,
    json: true,
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
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, CI: "", PORT: "" },
      },
    ).trim();
    assert.equal(Number.parseInt(printed, 10), base + 1);
  } finally {
    await closeServer(blocker);
  }
});

test("the resolver command reports its reuse decision as JSON", async () => {
  // Playwright reads this form: the port alone cannot say whether the server
  // already on it may be reused.
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
        "--json",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, CI: "", PORT: "" },
      },
    ).trim();
    assert.deepEqual(JSON.parse(printed), { port: base + 1, reuse: false });
  } finally {
    await closeServer(blocker);
  }
});

// ─── Identity ───────────────────────────────────────────────────────────────

test("only a real meta element carries identity", () => {
  const token = createDevIdentityToken();
  assert.equal(extractDevIdentity(appPage(token)), token);
  // Attribute order and quoting are not part of the tag's identity.
  assert.equal(
    extractDevIdentity(`<meta content='${token}' name='${DEV_IDENTITY_META}'>`),
    token,
  );
  // Next also serializes metadata into its flight payload, as JSON rather than
  // as a tag. A page that merely contains the name must not pass for one that
  // renders it.
  const flight =
    '<script>self.__next_f.push([1,"[\\"$\\",\\"meta\\",null,{\\"name\\":' +
    `\\"${DEV_IDENTITY_META}\\",\\"content\\":\\"${token}\\"}]"])</script>`;
  assert.equal(extractDevIdentity(flight), null);
  assert.equal(extractDevIdentity(ANOTHER_NEXT_APP), null);
  assert.equal(extractDevIdentity(APP_NAME_WITHOUT_TOKEN), null);
});

test("an identity tag that cannot vouch for one launch matches nothing", () => {
  const first = createDevIdentityToken();
  const second = createDevIdentityToken();
  // Present, so the page is not mistaken for an unrelated one - but no token
  // can ever equal it.
  assert.equal(
    extractDevIdentity(
      `<meta name="${DEV_IDENTITY_META}" content="${first}">` +
        `<meta name="${DEV_IDENTITY_META}" content="${second}">`,
    ),
    "",
  );
  assert.equal(extractDevIdentity(`<meta name="${DEV_IDENTITY_META}">`), "");
});

test("a response is ours only when it serves this launch's exact token", () => {
  const token = createDevIdentityToken();
  const page = appPage(token);

  // The tag settles it whatever the status: an error page rendered inside the
  // layout still carries it.
  for (const status of [200, 404, 500]) {
    assert.equal(classifyDevServerResponse(status, page, token), "ours");
  }
  // Another launch, or another checkout of this repository.
  assert.equal(
    classifyDevServerResponse(200, page, createDevIdentityToken()),
    "foreign",
  );
  assert.equal(
    classifyDevServerResponse(500, page, createDevIdentityToken()),
    "foreign",
  );
  // A caller with no token of its own can prove nothing, so nothing is ours.
  assert.equal(classifyDevServerResponse(200, page, undefined), "foreign");
  assert.equal(classifyDevServerResponse(200, page, "not-a-token"), "foreign");
});

test("the markers that used to be trusted are never enough", () => {
  const token = createDevIdentityToken();
  assert.equal(
    classifyDevServerResponse(200, ANOTHER_NEXT_APP, token),
    "foreign",
  );
  assert.equal(
    classifyDevServerResponse(200, APP_NAME_WITHOUT_TOKEN, token),
    "foreign",
  );
  // Without a tag, a failure proves nothing yet: worth another try.
  assert.equal(
    classifyDevServerResponse(500, ANOTHER_NEXT_APP, token),
    "unclear",
  );
  assert.equal(classifyDevServerResponse(502, "Bad Gateway", token), "unclear");
  assert.equal(classifyDevServerResponse(404, "", token), "unclear");
});

test("one stranger on any loopback address disqualifies the port", () => {
  assert.equal(aggregateDevServerVerdicts(["ours", "absent"]), "ours");
  assert.equal(aggregateDevServerVerdicts(["ours", "ours"]), "ours");
  assert.equal(aggregateDevServerVerdicts(["ours", "foreign"]), "foreign");
  assert.equal(aggregateDevServerVerdicts(["absent", "foreign"]), "foreign");
  assert.equal(
    aggregateDevServerVerdicts(["ours", "unresponsive"]),
    "unresponsive",
  );
  assert.equal(aggregateDevServerVerdicts(["absent", "absent"]), "absent");
  assert.equal(aggregateDevServerVerdicts([]), "absent");
});

// ─── The probe, against real sockets ────────────────────────────────────────

test("a server serving this launch's token is ours", async () => {
  const token = createDevIdentityToken();
  const { port } = await serve(html(appPage(token)));

  assert.equal(
    await probeDevServer(port, { expectedToken: token, deadlineMs: 10_000 }),
    "ours",
  );
  assert.equal(
    await isOurDevServer(port, { expectedToken: token, deadlineMs: 10_000 }),
    true,
  );
});

test("another Next.js application is never ours", async () => {
  // The collision that let a different project into the desktop window.
  const { port } = await serve(html(ANOTHER_NEXT_APP));
  assert.equal(
    await probeDevServer(port, {
      expectedToken: createDevIdentityToken(),
      deadlineMs: 10_000,
    }),
    "foreign",
  );
});

test("another checkout of this application is never ours", async () => {
  const { port } = await serve(html(appPage(createDevIdentityToken())));
  assert.equal(
    await probeDevServer(port, {
      expectedToken: createDevIdentityToken(),
      deadlineMs: 10_000,
    }),
    "foreign",
  );
});

test(
  "a stranger on ::1 makes a genuine server on 127.0.0.1 unsafe",
  { skip: needsIpv6 },
  async () => {
    const token = createDevIdentityToken();
    const { port } = await serve(html(appPage(token)), "127.0.0.1");
    await serve(html(ANOTHER_NEXT_APP), "::1", port);

    assert.equal(
      await probeDevServer(port, { expectedToken: token, deadlineMs: 10_000 }),
      "foreign",
    );
  },
);

test("the probe reports a free port as absent without waiting", async () => {
  const port = await freeBase();
  const started = Date.now();
  assert.equal(
    await probeDevServer(port, {
      expectedToken: createDevIdentityToken(),
      deadlineMs: 10_000,
    }),
    "absent",
  );
  assert.ok(
    Date.now() - started < 3_000,
    "a refused connection must settle immediately",
  );
});

test("the probe waits out a slow first response instead of misjudging it", async () => {
  // The first request to a Next.js 16 dev server triggers Turbopack's compile
  // of the route, which takes seconds.
  const token = createDevIdentityToken();
  let requests = 0;
  const { port } = await serve((_request, response) => {
    requests += 1;
    const respond = () => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(appPage(token));
    };
    // The first two requests outlive the per-attempt budget; the third is quick.
    if (requests < 3) setTimeout(respond, 1_500);
    else respond();
  });

  assert.equal(
    await probeDevServer(port, {
      expectedToken: token,
      deadlineMs: 10_000,
      attemptTimeoutMs: 400,
    }),
    "ours",
  );
  assert.ok(requests >= 3, `expected retries, saw ${requests} request(s)`);
});

test("the probe follows a same-origin redirect to the app", async () => {
  const token = createDevIdentityToken();
  const { port } = await serve((request, response) => {
    if (request.url === "/") {
      response.writeHead(307, { location: "/login" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(appPage(token));
  });

  assert.equal(
    await probeDevServer(port, { expectedToken: token, deadlineMs: 10_000 }),
    "ours",
  );
});

test("a redirect to somewhere else is not the server vouching for itself", async () => {
  const { port } = await serve((_request, response) => {
    response.writeHead(307, { location: "https://example.test/" });
    response.end();
  });

  assert.equal(
    await probeDevServer(port, {
      expectedToken: createDevIdentityToken(),
      deadlineMs: 1_500,
      attemptTimeoutMs: 300,
    }),
    "unresponsive",
  );
});

test("a socket that accepts but never answers is unresponsive, not ours", async () => {
  const silent = await occupy(0);
  const port = (silent.address() as AddressInfo).port;

  assert.equal(
    await probeDevServer(port, {
      expectedToken: createDevIdentityToken(),
      deadlineMs: 1_200,
      attemptTimeoutMs: 300,
    }),
    "unresponsive",
  );
});

// ─── Proving a spawned child ────────────────────────────────────────────────

test("a child alone on its exact loopback address is ours without a page", async () => {
  // No identity tag at all: the structural proof does not wait for a compile,
  // and holds even while the app fails to render.
  const { port } = await serve(html("<!DOCTYPE html><title>compiling</title>"));
  assert.equal(
    await checkLoopbackOwnership(port, { bindHost: "127.0.0.1" }),
    "ours",
  );
});

test(
  "a child that shares its port with a stranger on ::1 is foreign",
  { skip: needsIpv6 },
  async () => {
    const { port } = await serve(html(""), "127.0.0.1");
    await occupy(port, "::1");
    assert.equal(
      await checkLoopbackOwnership(port, { bindHost: "127.0.0.1" }),
      "foreign",
    );
  },
);

test("a child that is not listening yet is absent", async () => {
  const port = await freeBase();
  assert.equal(
    await checkLoopbackOwnership(port, { bindHost: "127.0.0.1" }),
    "absent",
  );
});

// ─── Reusing a recorded server ──────────────────────────────────────────────

test("a recorded server that still serves its token is joined", async () => {
  const token = createDevIdentityToken();
  const { port } = await serve(html(appPage(token)));
  writeDevServerState({
    port,
    url: devServerUrl(port),
    pid: process.pid,
    token,
  });

  try {
    const running = await readRunningDevServer({ deadlineMs: 10_000 });
    assert.equal(running?.port, port);
    assert.equal(running?.token, token);
    assert.deepEqual(
      await resolveDevServer({
        env: {},
        basePort: port,
        reuse: true,
        probeDeadlineMs: 10_000,
      }),
      { port, reuse: true },
    );
  } finally {
    clearDevServerState();
  }
});

test("a recorded port now held by another Next.js app is dropped, not joined", async () => {
  // The record outlived its server, and a different application took the port.
  const { port } = await serve(html(ANOTHER_NEXT_APP));
  writeDevServerState({
    port,
    url: devServerUrl(port),
    pid: process.pid,
    token: createDevIdentityToken(),
  });

  try {
    assert.equal(await readRunningDevServer({ deadlineMs: 10_000 }), null);
    assert.equal(
      readDevServerState(),
      null,
      "the stale record must be cleared so the next run climbs instead",
    );
  } finally {
    clearDevServerState();
  }
});

test("a record from before identity tokens is dropped unverified", async () => {
  // Such a record could only be vouched for by the old markers, which any
  // Next.js application satisfies.
  const { port } = await serve(html(appPage(createDevIdentityToken())));
  writeDevServerState({ port, url: devServerUrl(port), pid: process.pid });

  try {
    assert.equal(await readRunningDevServer({ deadlineMs: 10_000 }), null);
    assert.equal(readDevServerState(), null);
  } finally {
    clearDevServerState();
  }
});

test("a recorded server that has stopped is dropped", async () => {
  const port = await freeBase();
  writeDevServerState({
    port,
    url: devServerUrl(port),
    pid: process.pid,
    token: createDevIdentityToken(),
  });

  try {
    assert.equal(await readRunningDevServer({ deadlineMs: 10_000 }), null);
    assert.equal(readDevServerState(), null);
  } finally {
    clearDevServerState();
  }
});

test("with nothing verified, resolution starts fresh on a free port", async () => {
  clearDevServerState();
  const base = await freeBase();
  const blocker = await occupy(base);

  try {
    assert.deepEqual(
      await resolveDevServer({ env: {}, basePort: base, host, reuse: true }),
      { port: base + 1, reuse: false },
    );
  } finally {
    await closeServer(blocker);
  }
});

test("a record whose server process has exited is dropped, whatever holds its port", async () => {
  // The port is now held by something that accepts and answers 404 with no
  // identity tag - inconclusive for as long as it runs. Without a liveness
  // check this record would never clear, and every tool would wait out the
  // probe deadline on it.
  const { port } = await serve((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  const exited = spawnSync(process.execPath, ["-e", ""]);
  writeDevServerState({
    port,
    url: devServerUrl(port),
    pid: exited.pid,
    token: createDevIdentityToken(),
  });

  try {
    assert.equal(await readRunningDevServer({ deadlineMs: 1_500 }), null);
    assert.equal(
      readDevServerState(),
      null,
      "a record whose server process has exited is stale",
    );
  } finally {
    clearDevServerState();
  }
});

test("a live record that has not answered yet is kept, not reused", async () => {
  // Accepting but inconclusive, with its process still alive: it may well be
  // this checkout's server, still compiling. Not joined - and not forgotten.
  const token = createDevIdentityToken();
  const { port } = await serve((_request, response) => {
    response.writeHead(404);
    response.end();
  });
  writeDevServerState({
    port,
    url: devServerUrl(port),
    pid: process.pid,
    token,
  });

  try {
    assert.equal(await readRunningDevServer({ deadlineMs: 1_500 }), null);
    assert.equal(readDevServerState()?.token, token);
  } finally {
    clearDevServerState();
  }
});
