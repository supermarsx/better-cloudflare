# Better Cloudflare

A multi-zone console for managing Cloudflare DNS — one codebase, two builds: a **static Next.js export** you can host anywhere, and a **Tauri v2 desktop app** backed by a 17-crate Rust workspace.

It is aimed at the part of DNS work that web dashboards handle badly: editing many records across many zones, getting the fiddly record types (SPF, DMARC, TLSA, SVCB, CAA…) right the first time, copying records between zones without hand-rewriting every hostname, and keeping quoted TXT content RFC-legal.

![The DNS records table for a zone, showing per-record type badges, inline content, comments, TTL and proxy toggles, with workspace tabs across the top](docs/screenshots/dark/dns-records-table.png)

Every zone opens as its own workspace tab. Inside a tab, fourteen views cover records, import/export, zone settings, cache, SSL/TLS, audits, registry, topology, analytics, firewall, workers, email routing, propagation, and zone comparison.

> Screenshots use synthetic demo data — a fictional "Harborline Freight Systems" on RFC 2606 `.test` domains with RFC 5737 / RFC 3849 documentation IPs. Regenerate them with `npm run screenshots`.

---

## What it does

**Structured record builders.** 24 builders in `src/components/dns/builders/` cover 25 record types — SPF, DKIM, DMARC, CAA, TLSA, SSHFP, DS, DNSKEY, SVCB, HTTPS, NAPTR, LOC, APL, SOA, SRV, URI, RP, HINFO, AFSDB, ANAME, DNAME, CERT, SMIMEA, OPENPGPKEY and raw TXT (HTTPS and SVCB share one builder). Each field is validated live, so you compose a DMARC policy from labelled inputs instead of hand-typing a semicolon-delimited string.

<img src="docs/screenshots/dark/add-record-dialog.png" alt="Add DNS Record dialog with the TXT type selected and the DMARC builder expanded into labelled p=, rua=, ruf=, adkim=, aspf= and pct= fields" width="850">

**RFC 1035 quote handling that actually works.** `src/lib/dns/character-string.ts` parses tolerantly, repairs unmatched quotes rather than rejecting them, counts UTF-8 bytes correctly against the 255-byte character-string limit, and splits long values into adjacent quoted strings. `record-normalize.ts` applies it on every save path, so a pasted DKIM key comes out valid.

**Cross-zone record copy with domain rewriting.** Copy records in one zone, paste in another, and hostnames are rewritten to the destination zone — across CNAME/MX/NS/PTR/DNAME/ALIAS/ANAME content plus SRV, AFSDB, SVCB, NAPTR, RP and URI targets, SPF mechanisms, and DMARC `rua=`/`ruf=` addresses. Opt out with the `rewriteCopiedRecordDomains` preference; a preview step confirms anything that changed.

**Zone topology graphs.** Follows CNAME chains to their terminal addresses and renders them as a sanitized Mermaid graph, with PTR, geolocation and service probing on desktop.

<img src="docs/screenshots/light/zone-topology.png" alt="Zone topology graph following a CNAME chain from docs.shipwright.test through two intermediate hostnames to A and AAAA addresses annotated with geolocation and a PTR result" width="850">

**Domain health audit.** Grouped into Email (SPF/DKIM/DMARC/MX), Security (CAA policy) and Hygiene (TTL outliers, CNAME conflicts and chains, bogon and private IPs, NS redundancy, SOA review, TXT sprawl, SRV format, deprecated SPF RR type, domain expiry). Findings carry a severity and can be individually overridden.

<img src="docs/screenshots/dark/domain-audit.png" alt="Domain audits panel with Email, Security and Hygiene check groups, a Show passed toggle, and findings badged INFO or WARNING each with an Override control" width="850">

**Multi-registrar expiry monitoring.** Track renewal dates, lock state and auto-renew across Cloudflare, Porkbun, Namecheap, GoDaddy, Google Cloud Domains and Name.com in one list.

<img src="docs/screenshots/dark/registry-monitor.png" alt="Registry monitoring list showing five domains across Porkbun and Namecheap credentials with days-to-expiry, lock and auto-renew indicators" width="850">

**A local MCP server.** JSON-RPC over protocol version `2024-11-05`, bound to `127.0.0.1:8787` by default, bearer-token authenticated, off unless you enable it — with per-tool permissions so a connected client only gets the Cloudflare actions you grant.

<img src="docs/screenshots/dark/mcp-tool-permissions.png" alt="MCP settings tab showing server status, bind host and port, and a searchable tool permission list reading 34 of 53 classified tools enabled" width="850">

**And the rest:** per-table column visibility with locked identity columns · right-click row actions sharing one source of truth with the actions menu · draggable and keyboard-reorderable workspace tabs · bulk TTL/proxy/delete/export · import from JSON, CSV and BIND with a dry-run preview · zone comparison with one-click copy of missing records · resolver-diverse propagation checking · per-record local tags · an exportable audit log · an SPF expansion CLI (`npm run check-spf <domain>`).

**Full walkthrough:** [every screen, documented](docs/screens.md).

---

## Getting started

Requires Node.js `^20.19 || ^22.13 || >=24` (CI pins 24.18.1).

```bash
git clone https://github.com/supermarsx/better-cloudflare.git
cd better-cloudflare
npm ci
```

**Web preview** — static Next.js export, runs anywhere:

```bash
npm run dev            # dev server, first free port from :3000 upwards
npm run build          # static export into out/
npm run preview        # serve the export, same free-port search
```

Every part of the dev stack — the desktop window, Playwright and the screenshot
harness — resolves the port through `scripts/dev-port.mjs` and follows whatever
`next dev` actually bound, so a busy `:3000` no longer strands them. Set `PORT`
to pin an exact port (`CI=true` pins as well, which is what keeps CI fixed).

**Desktop app** — additionally needs a Rust toolchain and your platform's [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/):

```bash
npm run tauri:dev      # dev window
npm run tauri:build    # local bundle in src-tauri/target/release/bundle/
```

There is no package-manager distribution (Homebrew, Chocolatey, WinGet, Flathub, Snap). Bundles are unsigned and un-notarized, and the Tauri updater is disabled — see [Security](#security).

---

## Web build vs. desktop build

These are not the same product with a different shell. The security models genuinely differ.

| Capability                           | Web (static export)                                                     | Desktop (Tauri)                                             |
| ------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| DNS record CRUD, builders, quoting   | Yes                                                                     | Yes                                                         |
| Credential persistence               | **Never.** Keys are stripped before every write and live only in memory | OS keyring (Keychain / Credential Manager / Secret Service) |
| Encryption of stored keys            | Not applicable — nothing is stored                                      | PBKDF2-HMAC-SHA256 → AES-256-GCM                            |
| Topology graph rendering             | Yes, from zone records                                                  | Yes                                                         |
| Topology PTR / geo / service probing | No                                                                      | Yes                                                         |
| Topology export to file              | No                                                                      | Yes                                                         |
| Registrar expiry monitoring          | No — served by the Rust backend                                         | Yes                                                         |
| Local MCP server                     | No                                                                      | Yes, opt-in                                                 |
| Biometric unlock                     | No                                                                      | macOS Touch ID only                                         |
| Passkey login                        | Unavailable                                                             | Unavailable — see below                                     |

The web build is a **preview**. Treat it as a way to try the interface, not as a credential manager.

---

## Security

**Encryption.** API keys are encrypted with AES-256-GCM under a key derived by PBKDF2-HMAC-SHA256. Ciphertext is written in a versioned `bc1:` envelope bound to the AAD `better-cloudflare:crypto-envelope:v1`, with a random 16-byte salt, a 12-byte nonce and a 16-byte tag. New encryption accepts 100,000–1,000,000 iterations, tunable and benchmarkable in-app.

> **Limit worth knowing:** a legacy decrypt path still reads older unversioned envelopes that carry no AAD and may declare as few as 1 iteration. The 100k floor is enforced when encrypting, not when decrypting. Re-save old keys to move them onto the `bc1:` envelope.

**Desktop storage.** Secrets go to the OS keyring, chunked into ≤2000-byte entries under a digest-verified manifest that is swapped atomically, so an interrupted write cannot leave a half-updated secret readable.

**There is no in-memory fallback.** If the OS keyring is unavailable, secure-storage operations fail with an error — credentials are never silently relocated into process memory or anywhere less protected. On Linux this means a Secret Service provider must be running and unlocked.

**Web storage.** The browser preference writer validates against an allowlist schema that contains no `apiKeys` or `currentSession` keys, so credentials are structurally dropped before every persist.

**What does not work, stated plainly:**

- **Passkey login and registration are disabled.** `bc-passkey` fail-closes both by design. The previous implementation never validated the clientDataJSON type or origin, the RP ID hash, the UP/UV flags, the signature, or the authenticator counter — so it was removed rather than shipped insecure. Only listing and deleting legacy credentials still works, for recovery.
- **Biometrics are macOS Touch ID only.** Windows Hello and Linux are not implemented; the non-macOS path returns `PlatformNotSupported` for every operation.
- **The auto-updater is disabled** (`"updater": { "active": false }`), and there is no code signing or macOS notarization configured. Do not describe the bundles as signed, notarized or self-updating.
- **There is no AI assistant in the UI.** Four Rust crates, Tauri commands and a `useAiChat` hook exist as backend groundwork, but no component imports the hook. Nothing is user-reachable.

More detail: [security model](docs/security.md).

---

## Development

```bash
npm run check          # format:check + lint + typecheck + test + ci-contract
npm run dev            # web dev server
npm run tauri:dev      # desktop dev window
npm run test           # unit tests
npm run test:e2e       # Playwright
npm run screenshots    # regenerate docs/screenshots/
npm run docs           # TypeDoc API reference into docs/api/
cd src-tauri && cargo test
```

**The test runner is Node's built-in `node:test`**, driven by `scripts/run-tests-seq.ts` — not Vitest and not Jest. This surprises people, so: there is no `vitest.config.ts` to look for, and `describe`/`it` come from `node:test`. Playwright is used separately for end-to-end tests.

CI (`.github/workflows/ci.yml`) gates release on `ci_contract`, `unit_tests` (matrix: `default` and `sqlite3-only`), `e2e_reliability`, `native_reliability`, `format`, `lint`, `test_package` and `release_contract`, the last of which runs an OSV scan across both `package-lock.json` and `Cargo.lock`.

---

## Repository map

| Path            | Contents                                                   |
| --------------- | ---------------------------------------------------------- |
| `app/`          | Next.js routes and metadata                                |
| `src/`          | React UI, DNS logic, storage and API clients               |
| `src-tauri/`    | Tauri host plus `crates/` — 17 Rust crates                 |
| `docs/`         | Curated documentation; `docs/api/` is generated by TypeDoc |
| `test/`, `e2e/` | Node test suite and Playwright specs                       |
| `scripts/`      | Test runner, screenshot capture, SPF CLI                   |

---

## Documentation

- **[Screens and features](docs/screens.md)** — all 26 screens, what each one does
- [Architecture](docs/architecture.md) — the two builds, the crate map, how data flows
- [Security model](docs/security.md) — encryption, storage, and current limits
- [Tauri migration guide](docs/tauri-migration.md) — desktop backend and command reference
- [Design system](docs/design-system.md) — theming and UI conventions
- [SPF and NAPTR notes](docs/spf-naptr.md)
- [Documentation hub](docs/index.md)

## Contributing

Branch, run `npm run check`, and include documentation or test changes alongside the implementation.

## License

MIT — see [license.md](license.md).
