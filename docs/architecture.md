---
title: Architecture
nav_order: 3
description: The desktop shell, the 17 Rust crates, key frontend modules, and CI.
---

# Architecture

Better Cloudflare is a Tauri v2 desktop application: a React 19 / Next.js frontend rendered in the system webview, over a 17-crate Rust workspace reached through Tauri IPC.

## The desktop build

|                    | Better Cloudflare                                           |
| ------------------ | ----------------------------------------------------------- |
| Shell              | Tauri v2, system webview                                    |
| Frontend           | Next.js 16 static export (`output: "export"`)               |
| Backend            | 17 Rust crates behind Tauri IPC                             |
| Build              | `npm run tauri:build`                                       |
| Credential storage | OS keyring (Keychain / Credential Manager / Secret Service) |

### The static export is an implementation detail

`next.config.mjs` sets `output: "export"` and `npm run build` writes the result to `out/`. `src-tauri/tauri.conf.json` then points `frontendDist` at `../out` and runs that build from `beforeBuildCommand`, so the export is the UI the desktop bundle ships. It is the desktop app's asset pipeline, not a separate hostable product — there is no supported web deployment of Better Cloudflare, and the browser is not a target the security model covers.

`npm run dev` serves the same frontend for development; `tauri:dev` points the desktop window at it through `devUrl`.

### The environment probe

`src/lib/environment.ts` exposes `isDesktop()` / `isWeb()` by probing for the Tauri window bridge, and `src/lib/api/tauri-client.ts` wraps IPC. Features that need the Rust backend check `TauriClient.isTauri()` and degrade rather than break, which is what keeps the frontend renderable under the dev server and the jsdom test suite. In a shipped bundle the bridge is always present, so these are development and test affordances rather than a second product.

Everything that needs the Rust backend therefore needs the desktop shell:

- Credential persistence of any kind (see [Security](security.md))
- Registrar expiry monitoring — every registrar client lives in `bc-registrar`
- The local MCP server
- Topology PTR lookups, geolocation, service probing, and export-to-file
- Audit log persistence and export
- Biometric unlock (macOS Touch ID only)

## Frontend layout

The whole application is a **single route**. There are no per-screen URLs; navigation is state inside the page. What the user experiences as "screens" are workspace tabs — one per open zone, plus utility tabs such as Settings, Tags, Audit and Registry — each of which swaps the panel below the tab strip:

![The DNS records table for harborline.test: assigned nameservers across the top, a filter row with search, a record-type filter and page controls, an action row with Add Record, Copy selected and Paste, and a sortable table of A, AAAA and CNAME records with comments, TTLs and proxy toggles](screenshots/dark/dns-records-table.png)

That shape is why the tree below is organised by feature rather than by route, and why `src/lib/tabs/tab-order.ts` — tab ordering — is application-level state rather than something a router provides.

```
app/                       Next.js route (a single page) and metadata
src/
  components/
    dns/                   Records table, workspace tabs, dialogs, topology
      builders/            24 per-record-type builders
      record-actions.ts    One action list, used by menu and right-click
    auth/                  Login, encryption settings
    analytics|firewall|workers|email|registrar|mcp/
  lib/
    dns/                   character-string.ts, record-normalize.ts, record-copy.ts
    tables/table-columns.ts
    tabs/tab-order.ts
    storage/               Preference persistence, plus browser-context sanitization
    api/                   tauri-client.ts, server-client.ts
    audit/domain-audit.ts
  hooks/
scripts/                   Test runner, screenshot capture, SPF CLI
```

Three pieces of DNS logic carry most of the app's value and are worth knowing by name:

**`src/lib/dns/character-string.ts`** implements RFC 1035 §3.3/§5.1 character-strings. It parses tolerantly, repairs unmatched quotes instead of rejecting the input, measures UTF-8 byte length correctly against the 255-byte limit, and splits longer values into adjacent quoted strings. `record-normalize.ts` applies the right treatment per record type, on every save path.

**`src/lib/dns/record-copy.ts`** rewrites hostnames when records move between zones — whole-hostname content for CNAME, MX, NS, PTR, DNAME, ALIAS and ANAME, target fields inside SRV, AFSDB, SVCB, NAPTR, RP and URI, SPF mechanisms, and DMARC `rua=` / `ruf=` addresses. Controlled by the `rewriteCopiedRecordDomains` preference, which defaults on.

**`src/lib/tables/table-columns.ts`** models per-table column visibility, with identity columns that cannot be hidden and a guard that stops you hiding the last remaining column.

## Rust workspace

`src-tauri/crates/` holds 17 crates:

| Crate                                                        | Responsibility                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `bc-error`                                                   | Shared error types                                                      |
| `bc-crypto`                                                  | PBKDF2-HMAC-SHA256 → AES-256-GCM, the `bc1:` envelope                   |
| `bc-storage`                                                 | OS keyring access, chunking, manifests                                  |
| `bc-session`                                                 | Session lifecycle                                                       |
| `bc-cloudflare-api`                                          | Cloudflare REST client                                                  |
| `bc-dns-tools`                                               | Resolver helpers                                                        |
| `bc-spf`                                                     | SPF parsing and expansion                                               |
| `bc-domain-audit`                                            | Email, Security and Hygiene check engine                                |
| `bc-topology`                                                | CNAME chain resolution, PTR, geolocation, service probes                |
| `bc-passkey`                                                 | Passkey storage — registration and auth fail closed                     |
| `bc-biometrics`                                              | macOS Touch ID; every other platform returns `PlatformNotSupported`     |
| `bc-registrar`                                               | Cloudflare, Porkbun, Namecheap, GoDaddy, Google Cloud Domains, Name.com |
| `bc-mcp`                                                     | Local MCP server, protocol `2024-11-05`, per-tool permissions           |
| `bc-ai-provider`, `bc-ai-chat`, `bc-ai-tools`, `bc-ai-agent` | Backend groundwork, **not exposed in the UI**                           |

### The local MCP server

`bc-mcp` exposes the application's Cloudflare operations to local MCP clients over JSON-RPC at protocol version `2024-11-05`. It is **off by default**, binds `127.0.0.1:8787` when enabled, and requires a bearer token.

<img src="screenshots/dark/mcp-tool-permissions.png" width="720" alt="MCP settings: server status with its local URL, an enable switch, bind host and port fields, and a searchable tool permission list summarising 34 of 53 classified tools enabled, grouped by category with per-tool risk labels">

The permission model is the architecturally interesting part: authorisation is **per tool**, not per server, and every tool carries a classification — capability, category and risk. Tools the classifier does not recognise are denied outright and cannot be enabled, so adding a tool to the crate does not implicitly expose it. See [Security](security.md#mcp-server).

### The AI crates

Four crates, their Tauri commands in `src-tauri/src/ai_commands.rs`, and a `useAiChat` hook in `src/hooks/ai/use-ai-chat.ts` all exist. **Nothing imports the hook.** There is no AI assistant in the interface and no way for a user to reach this code. It is unshipped groundwork, documented here so nobody mistakes the crate list for a feature list.

### Secure storage internals

`bc-storage` writes each logical secret as immutable, generation-tagged chunks of at most 2000 bytes, then swaps a small manifest pointer — recording generation, chunk count, byte length and a checksum — only after reading every chunk back and verifying it. An interrupted write leaves the previous generation intact. Legacy direct values and older stable-name chunk records stay readable, and ambiguous legacy chunks are deliberately preserved rather than cleaned up, since deleting one could destroy data written by an older release.

Per-logical-key locks serialise concurrent read-modify-write transactions. Lock poisoning is deliberately ignored, because the registry is on the path of every storage operation and one panic would otherwise disable secure storage process-wide.

**There is no in-memory fallback.** `Storage::default()` — the only constructor the application uses — always installs the keyring backend. See [Security](security.md#storage).

## Topology rendering

`bc-topology` resolves; the frontend draws. The split is worth understanding because it is the clearest example of the division of labour across the IPC boundary in this codebase.

![Zone topology graph following a CNAME chain from docs.shipwright.test through two intermediate hostnames to terminal A and AAAA addresses, each annotated with country geolocation and a PTR result, with pan, zoom, annotate, copy and export controls above the canvas](screenshots/light/zone-topology.png)

The Rust side does everything that needs a network or the operating system: it walks CNAME chains to their terminal addresses, performs PTR lookups, attaches geolocation, probes TCP services on the resolved addresses, and handles export-to-file. The frontend receives resolved data and is responsible only for turning it into a picture.

`ZoneTopologyTab.tsx` builds a Mermaid graph from that data and sanitizes the result (`sanitizeTopologySvg`, with Mermaid's security level and HTML-label settings pinned) before it reaches the DOM, because node labels derive from zone data that the app does not control.

This is also why the topology view degrades outside the desktop shell: without the Rust backend there is nothing to resolve, and the frontend has no resolver of its own.

## Testing and CI

The unit test runner is **Node's built-in `node:test`**, driven by `scripts/run-tests-seq.ts`. Not Vitest, not Jest — there is no alternate config file to hunt for. Playwright covers end-to-end separately. Rust tests run with `cd src-tauri && cargo test`.

`.github/workflows/ci.yml` gates release on `ci_contract`, `unit_tests` (matrix: `default` and `sqlite3-only`), `e2e_reliability`, `native_reliability`, `format`, `lint`, `test_package` and `release_contract` — which runs an OSV scan across both `package-lock.json` and `Cargo.lock` behind a fail-closed policy validator.

[Development](development.md) covers all of this in working detail: the commands, why the runner serialises test files, how to run the Rust suite the way CI does, and what each gate actually enforces.

## See also

- [Screens and features](screens.md)
- [Security model](security.md)
- [Development](development.md) — commands, tests, CI gates, screenshot harness
- [Tauri migration guide](tauri-migration.md) — command reference and build details
