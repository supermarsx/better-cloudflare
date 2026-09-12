/**
 * Shared TCP port resolution and dev-server identity for the whole dev stack.
 *
 *   node scripts/dev-port.mjs [--base 3000] [--host 127.0.0.1] [--attempts 100]
 *                             [--reuse|--no-reuse] [--json]
 *
 * Everything that needs "the dev port" - `npm run dev`, `npm run tauri:dev`, the
 * Tauri `beforeDevCommand` guard, Playwright and the screenshot harness -
 * resolves it through this module so a single run cannot end up with two
 * different answers.
 *
 * # What "ours" means, and why it is a secret
 *
 * The desktop shell loads the dev server's URL with this application's native
 * command surface attached. So the question every consumer has to answer
 * correctly is "is the server on this port *this checkout's* dev server?".
 *
 * That used to be answered by looking for `/_next/` or "Better Cloudflare" in
 * the response, with either one enough. `/_next/` is served by every Next.js
 * application and the name by every checkout of this repository, so both
 * answered a different question: a second Next.js project on the same machine
 * was accepted as ours, and the Tauri guard joined it.
 *
 * Identity is now a per-launch secret. `startNextDev` generates a random token,
 * passes it to `next dev` through a server-only environment variable, and the
 * root layout renders it as a `<meta>` tag in development only (see
 * `src/lib/dev-identity.ts`). The launcher records the token in the state file
 * once the server is verified, and a server is "ours" only while it serves that
 * exact token. Nothing else can produce it: not another application, not another
 * checkout, and not whatever inherits a stale record's port.
 *
 * # Every loopback address, not one
 *
 * `localhost` resolves to `::1` before `127.0.0.1` on common systems, and both
 * browsers and Node try each in turn. A server that is ours on `127.0.0.1` is
 * still unsafe to hand to a client if a stranger answers on `[::1]` at the same
 * port, because the client connects there first. So availability and identity
 * are both judged across {@link LOOPBACK_ADDRESSES}, and a stranger on any one of
 * them disqualifies the port.
 *
 * # Rules that keep the result honest
 *
 *  1. Availability is proven by holding a real listener *and* confirming that
 *     every loopback address routes to it. A successful bind is not proof on
 *     its own: Windows lets a wildcard bind succeed while another process holds
 *     the same port on a specific loopback address, and the specific binding
 *     receives the traffic.
 *  2. Where a number has to be handed to a child process, the reservation is
 *     released microseconds before the spawn, the consumer retries on
 *     `EADDRINUSE`, and it then verifies the child it actually started. See
 *     `scripts/dev-server.mjs`.
 *  3. When `PORT` is set explicitly, or `CI` is truthy, the base port is used
 *     exactly as given and nothing climbs.
 *  4. Nothing is ever guessed. A resolution that cannot be made safely fails
 *     loudly instead of falling back to a default port.
 *
 * # What this does not defend against
 *
 * A local process that deliberately binds a more specific loopback address on
 * the same port *after* verification, or relays requests to the genuine server,
 * can intercept any loopback dev server; no content check can distinguish a
 * relay. That is an active attacker on the machine, not a collision. Production
 * builds are not exposed at all: they are served from Tauri's own asset
 * protocol, not from a port.
 */

import { connect, createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where the search starts when nothing overrides it. */
export const DEFAULT_BASE_PORT = 3000;
/** Upper bound on the climb, so a wedged machine fails instead of spinning. */
export const DEFAULT_ATTEMPTS = 100;
const MIN_PORT = 1;
const MAX_PORT = 65535;

/**
 * The one address `next dev` is told to bind.
 *
 * Next's own default is `0.0.0.0`. That leaves `[::1]` unclaimed for anyone,
 * and on Windows it lets another process take `127.0.0.1` at the same port by
 * binding it specifically, after which that process receives the requests.
 * Binding the exact address makes a later stranger's bind fail with
 * `EADDRINUSE` instead. Clients still use `http://localhost:<port>`, which is
 * the origin passkeys need.
 */
export const DEV_SERVER_HOST = "127.0.0.1";

/** Every address a `localhost` client can land on. */
export const LOOPBACK_ADDRESSES = Object.freeze(["127.0.0.1", "::1"]);

/**
 * Carries the per-launch identity token into `next dev`. No `NEXT_PUBLIC_`
 * prefix, so Next never inlines it into a browser bundle.
 */
export const DEV_IDENTITY_ENV = "BETTER_CLOUDFLARE_DEV_IDENTITY";

/** The `name` of the `<meta>` tag the root layout renders the token into. */
export const DEV_IDENTITY_META = "better-cloudflare-dev-identity";

/**
 * 32 random bytes, base64url, no padding. `src/lib/dev-identity.ts` holds the
 * same pattern; `test/dev-identity.test.ts` keeps the two in step.
 */
export const DEV_IDENTITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const STATE_DIRECTORY = path.join(
  REPO_ROOT,
  "node_modules",
  ".cache",
  "better-cloudflare",
);

/**
 * Records the dev server this checkout launched and verified: its port, and the
 * identity token that proves a server on that port is still it. Later consumers
 * (Playwright, the Tauri launchers, the screenshot harness) join it only after
 * re-proving that. It lives under `node_modules/.cache`, which git ignores.
 */
export const DEV_SERVER_STATE_FILE = path.join(
  STATE_DIRECTORY,
  "dev-server.json",
);

/**
 * @typedef {object} PortReservation
 * @property {number} port The bound port.
 * @property {import("node:net").Server} server The listener holding it.
 * @property {() => Promise<void>} release Stops holding the port.
 */

/**
 * @typedef {object} DevServerState
 * @property {number} port
 * @property {string} url
 * @property {number} [pid]
 * @property {string} [startedAt]
 * @property {string} [token] The identity token the server was verified with.
 */

/**
 * @typedef {object} DevServerResolution
 * @property {number} port
 * @property {boolean} reuse Whether a server already on `port` was verified as
 *   this checkout's, and may therefore be joined instead of started.
 */

export class NoFreePortError extends Error {
  /**
   * @param {number} basePort
   * @param {number} attempts
   * @param {string | undefined} host
   */
  constructor(basePort, attempts, host) {
    super(
      `No free TCP port was found in ${basePort}-${basePort + attempts - 1} on ` +
        `${host ?? "all interfaces"} after ${attempts} attempt(s). ` +
        "Free a port in that range, or set PORT to choose a different base.",
    );
    this.name = "NoFreePortError";
    this.basePort = basePort;
    this.attempts = attempts;
    this.host = host;
  }
}

/**
 * @param {unknown} value
 * @returns {number | null} The port, or `null` when `value` is not one.
 */
export function parsePort(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!/^\d+$/u.test(text)) return null;
  const port = Number(text);
  return port >= MIN_PORT && port <= MAX_PORT ? port : null;
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isTruthyFlag(value) {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== "0" && normalized !== "false";
}

/**
 * A pinned port is used verbatim: no probing, no climbing. This is what keeps CI
 * byte-for-byte deterministic and what lets a parent process hand an exact port
 * to a child.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isPinnedPort(env = process.env) {
  return parsePort(env.PORT) !== null || isTruthyFlag(env.CI);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} `PORT` when it is a valid port, otherwise {@link DEFAULT_BASE_PORT}.
 */
export function basePortFrom(env = process.env) {
  return parsePort(env.PORT) ?? DEFAULT_BASE_PORT;
}

/**
 * @param {number} milliseconds
 * @param {AbortSignal} [signal] Resolves early when aborted.
 * @returns {Promise<void>}
 */
function delay(milliseconds, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Identity tokens
// ---------------------------------------------------------------------------

/** @returns {string} A fresh identity token for one dev-server launch. */
export function createDevIdentityToken() {
  return randomBytes(32).toString("base64url");
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isDevIdentityToken(value) {
  return typeof value === "string" && DEV_IDENTITY_TOKEN_PATTERN.test(value);
}

/**
 * Constant-time comparison of two well-formed tokens, so a probe's timing
 * cannot be used to recover a token byte by byte.
 *
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
function tokensMatch(left, right) {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

const META_TAG = /<meta\b[^>]*>/giu;
const TAG_ATTRIBUTE =
  /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gu;

/**
 * Reads the identity token out of an HTML document, or `null` when the page
 * carries no identity tag at all.
 *
 * Only a real `<meta>` element counts. Next also serializes metadata into its
 * flight payload, but as JSON inside a script, not as a tag - so a page that
 * merely *contains* the tag's name cannot pass for one that renders it. Every
 * tag in the document is read, not just `<head>`, because Next can stream
 * metadata after the initial shell.
 *
 * A tag with no content, or several tags that disagree, yields `""`: a value
 * that is present - so the page is not mistaken for an unrelated one - but that
 * no token can ever equal.
 *
 * @param {string} body
 * @returns {string | null}
 */
export function extractDevIdentity(body) {
  /** @type {Set<string>} */
  const found = new Set();
  for (const [tag] of body.matchAll(META_TAG)) {
    /** @type {Record<string, string>} */
    const attributes = {};
    for (const match of tag.matchAll(TAG_ATTRIBUTE)) {
      attributes[match[1].toLowerCase()] =
        match[2] ?? match[3] ?? match[4] ?? "";
    }
    if (attributes.name === DEV_IDENTITY_META) {
      found.add(attributes.content ?? "");
    }
  }
  if (found.size === 0) return null;
  return found.size === 1 ? [...found][0] : "";
}

// ---------------------------------------------------------------------------
// Port reservation
// ---------------------------------------------------------------------------

/**
 * Attempts to take exclusive ownership of `port`.
 *
 * On its own this is necessary but not sufficient evidence that the port is
 * free - see {@link reservePort}.
 *
 * @param {number} port
 * @param {string} [host] Omit to listen on every interface.
 * @returns {Promise<import("node:net").Server | null>} The live listener, or
 *   `null` when the port is taken or forbidden.
 */
export function bindPort(port, host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const onError = (/** @type {NodeJS.ErrnoException} */ error) => {
      server.close();
      if (
        error.code === "EADDRINUSE" ||
        error.code === "EACCES" ||
        error.code === "EADDRNOTAVAIL"
      ) {
        resolve(null);
        return;
      }
      reject(error);
    };

    server.once("error", onError);
    server.listen(
      host === undefined
        ? { port, exclusive: true }
        : { host, port, exclusive: true },
      () => {
        server.removeListener("error", onError);
        // A reservation is short-lived; a late socket error must not crash the
        // process that is only holding the port.
        server.on("error", () => {});
        resolve(server);
      },
    );
  });
}

/** How long a reservation waits to hear its own nonce back. */
const RESERVATION_ECHO_TIMEOUT_MS = 750;

/**
 * @param {import("node:net").Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

/**
 * Connects to `address:port` and returns what the listener sends first, or
 * `null` when nothing accepted the connection.
 *
 * @param {string} address
 * @param {number} port
 * @param {number} length How many characters settle the answer.
 * @param {number} timeoutMs
 * @returns {Promise<string | null>}
 */
function readGreeting(address, port, length, timeoutMs) {
  return new Promise((resolve) => {
    const socket = connect({ host: address, port });
    let received = "";
    let connected = false;
    let settled = false;
    /** @param {string | null} value */
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(
      () => settle(connected ? received : null),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      connected = true;
    });
    socket.on("data", (chunk) => {
      received += chunk;
      if (received.length >= length) settle(received);
    });
    socket.once("end", () => settle(received));
    socket.once("error", () => settle(connected ? received : null));
  });
}

/**
 * Whether any loopback address on `port` routes to something other than the
 * reservation holding it.
 *
 * The reservation answers every connection with a one-off nonce. A connection
 * that hears exactly the nonce reached the reservation. One that hears anything
 * else - or nothing, which is what an HTTP server says before it gets a request
 * - reached a stranger. An address that refuses the connection is fine: no
 * client can land there.
 *
 * @param {import("node:net").Server} server
 * @param {number} port
 * @param {readonly string[]} addresses
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
async function loopbackReachesStranger(server, port, addresses, timeoutMs) {
  const nonce = randomBytes(16).toString("hex");
  const answer = (/** @type {import("node:net").Socket} */ socket) => {
    socket.on("error", () => {});
    socket.end(nonce);
  };
  server.on("connection", answer);
  try {
    const greetings = await Promise.all(
      addresses.map((address) =>
        readGreeting(address, port, nonce.length, timeoutMs),
      ),
    );
    return greetings.some(
      (greeting) => greeting !== null && greeting !== nonce,
    );
  } finally {
    server.removeListener("connection", answer);
  }
}

/**
 * Finds the first port at or above `basePort` that is genuinely free for a
 * `localhost` client, and *keeps holding it*.
 *
 * "Genuinely free" means two things, both proven rather than assumed:
 *
 *  1. an exclusive listener could be bound on `host`, and
 *  2. every loopback address on that port routes to that listener - checked by
 *     having it answer each connection with a one-off nonce.
 *
 * The second step is the one a bind cannot do for itself. On Windows a wildcard
 * bind succeeds while another process holds the port on `127.0.0.1`, and a bind
 * on `127.0.0.1` succeeds while another process holds it on `::1`. In both cases
 * a `localhost` client would reach the other process.
 *
 * The caller owns the port until `release()`.
 *
 * @param {object} [options]
 * @param {number} [options.basePort]
 * @param {number} [options.attempts]
 * @param {string} [options.host] Defaults to {@link DEV_SERVER_HOST}, the
 *   address `next dev` will be told to bind. Pass `"0.0.0.0"` or `"::"` for a
 *   wildcard bind.
 * @param {readonly string[]} [options.addresses]
 * @param {number} [options.echoTimeoutMs]
 * @returns {Promise<PortReservation>}
 */
export async function reservePort(options = {}) {
  const basePort = options.basePort ?? DEFAULT_BASE_PORT;
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const host = options.host ?? DEV_SERVER_HOST;
  const addresses = options.addresses ?? LOOPBACK_ADDRESSES;
  const echoTimeoutMs = options.echoTimeoutMs ?? RESERVATION_ECHO_TIMEOUT_MS;

  if (parsePort(basePort) === null) {
    throw new TypeError(`Not a usable base port: ${String(basePort)}`);
  }
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError(`Port search attempts must be positive: ${attempts}`);
  }

  for (let offset = 0; offset < attempts; offset += 1) {
    const port = basePort + offset;
    if (port > MAX_PORT) break;

    const server = await bindPort(port, host);
    if (server === null) continue;

    if (await loopbackReachesStranger(server, port, addresses, echoTimeoutMs)) {
      await closeServer(server);
      continue;
    }

    return { port, server, release: () => closeServer(server) };
  }

  throw new NoFreePortError(basePort, attempts, host);
}

/**
 * Convenience wrapper that releases the reservation before returning.
 *
 * The number is stale the instant it is returned, so only use this when the
 * consumer retries on `EADDRINUSE` and verifies what it started (see
 * `scripts/dev-server.mjs`).
 *
 * @param {Parameters<typeof reservePort>[0]} [options]
 * @returns {Promise<number>}
 */
export async function findFreePort(options = {}) {
  const reservation = await reservePort(options);
  await reservation.release();
  return reservation.port;
}

/**
 * @param {number} port
 * @param {string} [host]
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>} Whether something is accepting connections there.
 */
export function isPortListening(port, host = "127.0.0.1", timeoutMs = 750) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const settle = (/** @type {boolean} */ listening) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

/**
 * @param {DevServerState} state
 * @returns {void}
 */
export function writeDevServerState(state) {
  try {
    mkdirSync(STATE_DIRECTORY, { recursive: true });
    writeFileSync(
      DEV_SERVER_STATE_FILE,
      `${JSON.stringify({ startedAt: new Date().toISOString(), ...state }, null, 2)}\n`,
      // The token is what lets a tool join this server. Keep it from other
      // accounts where the filesystem honours modes.
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // The state file is an optimisation, never a requirement.
  }
}

/** @returns {DevServerState | null} */
export function readDevServerState() {
  try {
    const parsed = JSON.parse(readFileSync(DEV_SERVER_STATE_FILE, "utf8"));
    const port = parsePort(parsed?.port);
    if (port === null) return null;
    return {
      port,
      url: typeof parsed.url === "string" ? parsed.url : devServerUrl(port),
      pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
      startedAt:
        typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
      token: isDevIdentityToken(parsed.token) ? parsed.token : undefined,
    };
  } catch {
    return null;
  }
}

/** @returns {void} */
export function clearDevServerState() {
  try {
    rmSync(DEV_SERVER_STATE_FILE, { force: true });
  } catch {
    // Nothing depends on the file being gone.
  }
}

/**
 * @param {number} port
 * @param {string} [host]
 * @returns {string}
 */
export function devServerUrl(port, host = "localhost") {
  return `http://${host}:${port}`;
}

// ---------------------------------------------------------------------------
// Identity probe
// ---------------------------------------------------------------------------

/**
 * How long {@link probeDevServer} keeps asking one address before it gives up.
 * The first request to a Next.js 16 dev server triggers Turbopack's compile of
 * the route - measured at 8 s cold on this project, and it can be longer on a
 * slow disk - so a single short-lived request would see nothing. Every attempt
 * keeps the compile going, so retrying converges.
 */
export const DEV_SERVER_PROBE_DEADLINE_MS = 30_000;
const PROBE_ATTEMPT_TIMEOUT_MS = 5_000;
const PROBE_RETRY_DELAY_MIN_MS = 250;
const PROBE_RETRY_DELAY_MAX_MS = 2_000;
const MAX_PROBE_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PROBE_REDIRECTS = 3;

/**
 * @typedef {"ours" | "foreign" | "absent" | "unresponsive"} DevServerVerdict
 *   - `ours`: every loopback address that accepts connections served this
 *     launch's identity token.
 *   - `foreign`: at least one loopback address answered conclusively as
 *     something else - never to be joined, never to be loaded into the window.
 *   - `absent`: nothing accepts connections on the port at any loopback address.
 *   - `unresponsive`: something accepts connections but gave no conclusive
 *     answer before the deadline.
 */

/**
 * Judges one HTTP answer from one address. Kept pure so the rule is
 * unit-testable.
 *
 * - The identity tag settles it, whatever the status: a Next error page rendered
 *   inside the root layout still carries it. This launch's exact token is
 *   `ours`; any other value - another launch, another checkout - is `foreign`.
 * - A successful page with no identity tag is conclusively someone else. That
 *   includes every other Next.js application, whatever else it serves.
 * - Anything else is inconclusive and worth another try: a route still
 *   compiling, a build error page rendered outside the layout, a proxy's 502.
 *
 * With no `expectedToken` nothing can be `ours`. That is deliberate: a server
 * this process cannot prove it launched is never joined.
 *
 * @param {number} status
 * @param {string} body
 * @param {string | null | undefined} expectedToken
 * @returns {"ours" | "foreign" | "unclear"}
 */
export function classifyDevServerResponse(status, body, expectedToken) {
  const token = extractDevIdentity(body);
  if (token !== null) {
    return isDevIdentityToken(token) &&
      isDevIdentityToken(expectedToken) &&
      tokensMatch(token, expectedToken)
      ? "ours"
      : "foreign";
  }
  return status >= 200 && status < 300 ? "foreign" : "unclear";
}

/**
 * Combines one verdict per loopback address into a verdict for the port. Kept
 * pure so the rule is unit-testable.
 *
 * A stranger on *any* address disqualifies the port, because a `localhost`
 * client may connect there first. `ours` requires every address that accepts
 * connections to prove it. An address that refuses is irrelevant: no client can
 * land on it.
 *
 * @param {readonly DevServerVerdict[]} verdicts
 * @returns {DevServerVerdict}
 */
export function aggregateDevServerVerdicts(verdicts) {
  if (verdicts.includes("foreign")) return "foreign";
  const accepting = verdicts.filter((verdict) => verdict !== "absent");
  if (accepting.length === 0) return "absent";
  return accepting.every((verdict) => verdict === "ours")
    ? "ours"
    : "unresponsive";
}

/** Errors meaning "no client can reach anything here", as opposed to "retry". */
const UNREACHABLE_CODES = new Set([
  "ECONNREFUSED",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "ENETUNREACH",
  "EHOSTUNREACH",
]);

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isUnreachable(error) {
  /** @type {unknown} */
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth += 1) {
    const code = /** @type {NodeJS.ErrnoException} */ (current).code;
    if (typeof code === "string" && UNREACHABLE_CODES.has(code)) return true;
    const aggregate = /** @type {{ errors?: unknown[] }} */ (current).errors;
    if (Array.isArray(aggregate) && aggregate.some(isUnreachable)) return true;
    current = current.cause;
  }
  return false;
}

/**
 * One GET against one exact address, carrying the `Host` a `localhost` client
 * would send.
 *
 * `fetch` cannot do this job: it resolves the name itself, so it cannot be
 * pinned to one address, and it forbids setting `Host`.
 *
 * @param {string} address
 * @param {number} port
 * @param {string} pathname
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ status: number, body: string, location: string | undefined }>}
 */
function getOnce(address, port, pathname, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("probe cancelled"));
      return;
    }

    let settled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    /** @param {() => void} settleWith */
    const finish = (settleWith) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      settleWith();
    };

    const request = httpRequest(
      {
        host: address,
        family: address.includes(":") ? 6 : 4,
        port,
        path: pathname,
        method: "GET",
        headers: { host: `localhost:${port}`, accept: "text/html" },
        agent: false,
      },
      (response) => {
        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        const complete = () =>
          finish(() =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString("utf8"),
              location:
                typeof response.headers.location === "string"
                  ? response.headers.location
                  : undefined,
            }),
          );
        response.on("data", (/** @type {Buffer} */ chunk) => {
          if (settled) return;
          chunks.push(chunk);
          size += chunk.length;
          if (size >= MAX_PROBE_BODY_BYTES) {
            complete();
            request.destroy();
          }
        });
        response.once("end", complete);
        response.once("error", (error) => finish(() => reject(error)));
      },
    );

    const onAbort = () => request.destroy(new Error("probe cancelled"));
    timer = setTimeout(() => {
      request.destroy(
        Object.assign(
          new Error(`GET ${pathname} on ${address}:${port} timed out`),
          { code: "ETIMEDOUT" },
        ),
      );
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    request.once("error", (error) => finish(() => reject(error)));
    request.end();
  });
}

/**
 * The same-origin path a redirect points at, or `null` when it should not be
 * followed. A redirect somewhere else is not this server vouching for itself.
 *
 * @param {{ status: number, location: string | undefined }} response
 * @param {number} port
 * @returns {string | null}
 */
function sameOriginRedirect({ status, location }, port) {
  if (status < 300 || status >= 400 || location === undefined) return null;
  /** @type {URL} */
  let target;
  try {
    target = new URL(location, `http://localhost:${port}/`);
  } catch {
    return null;
  }
  const loopbackHost = ["localhost", "127.0.0.1", "[::1]"].includes(
    target.hostname,
  );
  if (
    target.protocol !== "http:" ||
    !loopbackHost ||
    Number(target.port || 80) !== port
  ) {
    return null;
  }
  return `${target.pathname}${target.search}`;
}

/**
 * Asks one loopback address, patiently, whether it is this launch's server.
 *
 * @param {string} address
 * @param {number} port
 * @param {{ expectedToken?: string | null, deadlineMs?: number, attemptTimeoutMs?: number, signal?: AbortSignal }} options
 * @returns {Promise<DevServerVerdict>}
 */
async function probeAddress(address, port, options) {
  const deadlineMs = options.deadlineMs ?? DEV_SERVER_PROBE_DEADLINE_MS;
  const attemptTimeoutMs = options.attemptTimeoutMs ?? PROBE_ATTEMPT_TIMEOUT_MS;
  const deadline = Date.now() + deadlineMs;
  let retryDelay = PROBE_RETRY_DELAY_MIN_MS;

  for (;;) {
    if (options.signal?.aborted) return "unresponsive";
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "unresponsive";

    try {
      let pathname = "/";
      let response = await getOnce(
        address,
        port,
        pathname,
        Math.min(attemptTimeoutMs, remaining),
        options.signal,
      );
      for (let hop = 0; hop < MAX_PROBE_REDIRECTS; hop += 1) {
        const next = sameOriginRedirect(response, port);
        if (next === null) break;
        pathname = next;
        response = await getOnce(
          address,
          port,
          pathname,
          Math.max(1, Math.min(attemptTimeoutMs, deadline - Date.now())),
          options.signal,
        );
      }

      const verdict = classifyDevServerResponse(
        response.status,
        response.body,
        options.expectedToken,
      );
      if (verdict !== "unclear") return verdict;
    } catch (error) {
      if (options.signal?.aborted) return "unresponsive";
      if (isUnreachable(error)) return "absent";
      // Timed out, reset, or not speaking HTTP: try again until the deadline.
    }

    if (Date.now() + retryDelay >= deadline) return "unresponsive";
    await delay(retryDelay, options.signal);
    retryDelay = Math.min(retryDelay * 2, PROBE_RETRY_DELAY_MAX_MS);
  }
}

/**
 * Establishes whether the server on `port` is the dev server this checkout
 * launched with `expectedToken` - on every loopback address a `localhost`
 * client could reach.
 *
 * Each address is asked in parallel. The probe is patient (see
 * {@link DEV_SERVER_PROBE_DEADLINE_MS}) but returns the moment the answer is
 * settled: immediately when nothing listens, and as soon as any address is
 * conclusively a stranger, cancelling the others.
 *
 * @param {number} port
 * @param {object} [options]
 * @param {string | null} [options.expectedToken] Without it, nothing is `ours`.
 * @param {number} [options.deadlineMs] Time budget per address.
 * @param {number} [options.attemptTimeoutMs] Budget for one request.
 * @param {readonly string[]} [options.addresses]
 * @returns {Promise<DevServerVerdict>}
 */
export function probeDevServer(port, options = {}) {
  const addresses = options.addresses ?? LOOPBACK_ADDRESSES;
  const controller = new AbortController();

  return new Promise((resolve) => {
    /** @type {DevServerVerdict[]} */
    const verdicts = [];
    let pending = addresses.length;
    let settled = false;

    if (pending === 0) {
      resolve("absent");
      return;
    }

    addresses.forEach((address, index) => {
      void probeAddress(address, port, {
        ...options,
        signal: controller.signal,
      }).then((verdict) => {
        if (settled) return;
        verdicts[index] = verdict;
        pending -= 1;
        if (verdict === "foreign" || pending === 0) {
          settled = true;
          controller.abort();
          resolve(
            verdict === "foreign"
              ? "foreign"
              : aggregateDevServerVerdicts(verdicts),
          );
        }
      });
    });
  });
}

/**
 * Boolean form of {@link probeDevServer}.
 *
 * @param {number} port
 * @param {Parameters<typeof probeDevServer>[1]} [options]
 * @returns {Promise<boolean>}
 */
export async function isOurDevServer(port, options) {
  return (await probeDevServer(port, options)) === "ours";
}

/**
 * Structural proof for a server this process just spawned on an exact address.
 *
 * `next dev -H 127.0.0.1` holds that exact address, and no other process can
 * bind it while it does. So when that address accepts and every *other*
 * loopback address refuses, every `localhost` client reaches the child - proven
 * without waiting for a page to compile, and even while the app fails to
 * render.
 *
 * It proves nothing about a server someone else started: another checkout's dev
 * server holds its exact address just as firmly. That is why joining an
 * existing server always goes through the identity token instead.
 *
 * @param {number} port
 * @param {object} [options]
 * @param {string} [options.bindHost]
 * @param {readonly string[]} [options.addresses]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<"ours" | "foreign" | "absent">}
 */
export async function checkLoopbackOwnership(port, options = {}) {
  const bindHost = options.bindHost ?? DEV_SERVER_HOST;
  const addresses = options.addresses ?? LOOPBACK_ADDRESSES;
  const timeoutMs = options.timeoutMs ?? 750;
  const bindIndex = addresses.indexOf(bindHost);
  if (bindIndex === -1) {
    throw new TypeError(
      `${bindHost} is not one of the loopback addresses being checked`,
    );
  }

  const listening = await Promise.all(
    addresses.map((address) => isPortListening(port, address, timeoutMs)),
  );
  if (!listening[bindIndex]) return "absent";
  return listening.some((accepts, index) => index !== bindIndex && accepts)
    ? "foreign"
    : "ours";
}

/**
 * Whether a process with `pid` still exists.
 *
 * Signal 0 tests for existence without delivering anything, on every platform
 * Node supports. `EPERM` means the process exists but belongs to another user,
 * which still counts as alive here.
 *
 * @param {number | undefined} pid
 * @returns {boolean}
 */
function isProcessAlive(pid) {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return /** @type {NodeJS.ErrnoException} */ (error).code === "EPERM";
  }
}

/**
 * The recorded dev server, if it is genuinely still running *and* still this
 * checkout's - proven by the identity token recorded with it.
 *
 * A record that cannot be proven is dropped when it is provably stale - nothing
 * listens there any more, a stranger does, or it predates identity tokens - so
 * the next resolution climbs instead of reusing it. So is a record whose
 * server process has exited, whatever now holds its port. A record whose
 * server is still alive - accepting connections, but not answering yet - is
 * left in place and simply not reused: it may well be ours, still compiling.
 *
 * @param {object} [options]
 * @param {number} [options.deadlineMs]
 * @returns {Promise<DevServerState | null>}
 */
export async function readRunningDevServer(options = {}) {
  const state = readDevServerState();
  if (state === null) return null;
  if (state.token === undefined) {
    clearDevServerState();
    return null;
  }

  const verdict = await probeDevServer(state.port, {
    expectedToken: state.token,
    deadlineMs: options.deadlineMs,
  });
  if (verdict === "ours") return state;
  // Without the liveness check, a record whose port is now held by a stranger
  // that accepts but never answers conclusively would never clear, and every
  // tool would wait out the probe deadline on it.
  if (
    verdict === "absent" ||
    verdict === "foreign" ||
    !isProcessAlive(state.pid)
  ) {
    clearDevServerState();
  }
  return null;
}

/**
 * The single answer to "which port should this run use, and may it join a
 * server that is already there?".
 *
 * Only a server proven to be this checkout's is ever reused. Pinned runs use
 * their port verbatim and never climb; unpinned runs take the first port that
 * is genuinely free on every loopback address.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.basePort]
 * @param {number} [options.attempts]
 * @param {string} [options.host]
 * @param {boolean} [options.reuse] Consider joining a recorded dev server.
 * @param {number} [options.probeDeadlineMs]
 * @returns {Promise<DevServerResolution>}
 */
export async function resolveDevServer(options = {}) {
  const env = options.env ?? process.env;
  const basePort = options.basePort ?? basePortFrom(env);
  const pinned = isPinnedPort(env);

  if (options.reuse ?? true) {
    const running = await readRunningDevServer({
      deadlineMs: options.probeDeadlineMs,
    });
    if (running !== null && (!pinned || running.port === basePort)) {
      return { port: running.port, reuse: true };
    }
  }

  if (pinned) return { port: basePort, reuse: false };
  return {
    port: await findFreePort({
      basePort,
      attempts: options.attempts,
      host: options.host,
    }),
    reuse: false,
  };
}

/**
 * The port half of {@link resolveDevServer}.
 *
 * @param {Parameters<typeof resolveDevServer>[0]} [options]
 * @returns {Promise<number>}
 */
export async function resolveDevPort(options = {}) {
  return (await resolveDevServer(options)).port;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * @param {readonly string[]} argv
 * @returns {{ basePort?: number, attempts?: number, host?: string, reuse: boolean, json?: boolean }}
 */
export function parseCliArguments(argv) {
  /** @type {{ basePort?: number, attempts?: number, host?: string, reuse: boolean, json?: boolean }} */
  const parsed = { reuse: true };

  for (let index = 0; index < argv.length; index += 1) {
    const [name, inlineValue] = splitArgument(argv[index]);
    const value = inlineValue ?? argv[index + 1];
    const consume = () => {
      if (inlineValue === undefined) index += 1;
      if (value === undefined) throw new Error(`${name} requires a value.`);
      return value;
    };

    switch (name) {
      case "--base":
      case "--port": {
        const port = parsePort(consume());
        if (port === null) throw new Error(`${name} must be a TCP port.`);
        parsed.basePort = port;
        break;
      }
      case "--attempts": {
        const attempts = Number(consume());
        if (!Number.isSafeInteger(attempts) || attempts < 1) {
          throw new Error("--attempts must be a positive integer.");
        }
        parsed.attempts = attempts;
        break;
      }
      case "--host":
        parsed.host = consume();
        break;
      case "--reuse":
        parsed.reuse = true;
        break;
      case "--no-reuse":
        parsed.reuse = false;
        break;
      case "--json":
        parsed.json = true;
        break;
      default:
        throw new Error(`Unknown option: ${name}`);
    }
  }

  return parsed;
}

/**
 * @param {string} argument
 * @returns {[string, string | undefined]}
 */
function splitArgument(argument) {
  const equalsIndex = argument.indexOf("=");
  return equalsIndex === -1
    ? [argument, undefined]
    : [argument.slice(0, equalsIndex), argument.slice(equalsIndex + 1)];
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const { json, ...options } = parseCliArguments(process.argv.slice(2));
  resolveDevServer(options)
    .then((resolution) => {
      process.stdout.write(
        json ? `${JSON.stringify(resolution)}\n` : `${resolution.port}\n`,
      );
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : error}\n`,
      );
      process.exitCode = 1;
    });
}
