/**
 * The renderer never talks to an AI provider.
 *
 * Every provider call goes through the Rust side: `bc-ai-provider` owns the
 * HTTP clients, and the renderer only ever invokes `ai_*` Tauri commands. That
 * is what keeps a provider API key out of the web layer entirely — it is held
 * in a `RwLock<HashMap<…>>` on the Rust side and no command ever returns it, so
 * a renderer that could reach `api.openai.com` would have to be given a key to
 * do it with, and the whole arrangement would be pointless.
 *
 * Nothing enforced that. These two tests do:
 *
 * 1. No file under `src/` may name a provider endpoint host. The host list is
 *    parsed out of `ProviderProtocol::default_base_url` rather than copied, and
 *    is then compared against a pinned set — so adding a fourth protocol fails
 *    this test until someone extends it deliberately, instead of silently
 *    leaving the new endpoint unguarded.
 *
 *    This is also why no default base URL lives in the renderer at all: a
 *    profile saved without one is stored with the protocol's default by the
 *    Rust side, and `src/lib/ai/providers.ts` holds only default *models*.
 * 2. The renderer's AI code issues no outbound request by *any* route — not
 *    `fetch`, not `XMLHttpRequest`, not a `WebSocket`, not a beacon. Naming a
 *    host is the obvious way to break the boundary; assembling one from parts
 *    is the non-obvious way, and this is what catches that.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const SRC_DIR = join(ROOT, "src");
const PROVIDER_CONFIG_PATH = join(
  ROOT,
  "src-tauri",
  "crates",
  "bc-ai-provider",
  "src",
  "config.rs",
);

/**
 * The hosts the Rust providers actually dial, as of the pinned provider set.
 * Not a guess: each one is asserted against `default_base_url` below.
 */
const PINNED_PROVIDER_HOSTS = [
  "api.openai.com",
  "api.anthropic.com",
  "localhost:11434",
] as const;

/**
 * Aliases for the Ollama default that resolve to the same daemon. Forbidden
 * too, because "we only banned the spelling they happened to use" is not a
 * boundary. The MCP server's own default host is `127.0.0.1:8787`, so these
 * cannot collide with it.
 */
const PROVIDER_HOST_ALIASES = ["127.0.0.1:11434", "[::1]:11434"] as const;

/** Every outbound-request mechanism available to a browser renderer. */
const REQUEST_MECHANISMS = [
  "fetch(",
  "XMLHttpRequest",
  "new WebSocket",
  "EventSource",
  "sendBeacon",
  "new Request(",
  "navigator.connection",
] as const;

/** The renderer code that owns the assistant, and must stay request-free. */
const AI_RENDERER_PATHS = [
  "src/components/ai",
  "src/hooks/ai",
  "src/lib/ai",
  "src/types/ai.ts",
] as const;

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...sourceFiles(path));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!/\.(?:ts|tsx|js|jsx|mjs|cjs|json|css)$/.test(entry.name)) continue;
    found.push(path);
  }
  return found;
}

function rustProviderHosts(): string[] {
  const source = readFileSync(PROVIDER_CONFIG_PATH, "utf8");
  const block = source.match(
    /fn\s+default_base_url\s*\(&self\)\s*->\s*&'static\s+str\s*\{(?<body>[\s\S]*?)\n    \}/,
  );
  assert.ok(
    block?.groups?.body,
    "ProviderProtocol::default_base_url must stay parseable by this contract test",
  );

  const urls = [...block.groups.body.matchAll(/"([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(urls.length > 0, "default_base_url must return literal URLs");
  return urls.map((url) => new URL(url).host);
}

test("the pinned provider host list still matches the Rust providers", () => {
  const hosts = rustProviderHosts();

  // Order-insensitive, but exact: a new provider, or a changed endpoint, has to
  // be added to `PINNED_PROVIDER_HOSTS` before this suite will pass again.
  assert.deepEqual(
    [...hosts].sort(),
    [...PINNED_PROVIDER_HOSTS].sort(),
    `bc-ai-provider dials ${JSON.stringify(hosts)}; this test guards ${JSON.stringify(PINNED_PROVIDER_HOSTS)}. Add the new host here and confirm nothing under src/ reaches it.`,
  );
});

test("no renderer source names an AI provider endpoint host", () => {
  const forbidden = [...PINNED_PROVIDER_HOSTS, ...PROVIDER_HOST_ALIASES];
  const offences: string[] = [];

  for (const file of sourceFiles(SRC_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const host of forbidden) {
      if (!source.includes(host)) continue;
      const line =
        source.split(/\r?\n/).findIndex((text) => text.includes(host)) + 1;
      offences.push(
        `${relative(ROOT, file).replaceAll("\\", "/")}:${line} names ${host}`,
      );
    }
  }

  assert.deepEqual(
    offences,
    [],
    `The renderer must never reference a provider endpoint. Provider traffic goes through the ai_* Tauri commands so the API key never leaves the Rust side; a host named in src/ is either a direct call or the beginning of one.\n${offences.join("\n")}`,
  );
});

test("the renderer's AI code issues no outbound request of its own", () => {
  const files = AI_RENDERER_PATHS.flatMap((target) => {
    const path = join(ROOT, target);
    return /\.tsx?$/.test(target) ? [path] : sourceFiles(path);
  });
  assert.ok(
    files.length > 0,
    "the AI renderer paths must exist for this test to mean anything",
  );

  const offences: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const mechanism of REQUEST_MECHANISMS) {
      if (!source.includes(mechanism)) continue;
      const line =
        source.split(/\r?\n/).findIndex((text) => text.includes(mechanism)) + 1;
      offences.push(
        `${relative(ROOT, file).replaceAll("\\", "/")}:${line} uses ${mechanism}`,
      );
    }
  }

  assert.deepEqual(
    offences,
    [],
    `The assistant's renderer code must reach the network only through TauriClient's ai_* invocations. Every outbound mechanism here is a way to dial a provider without naming it in a string literal.\n${offences.join("\n")}`,
  );
});
