---
title: Development
nav_order: 6
description: Contributor guide — dev commands, the node:test runner, Rust tests, CI gates, and the documentation screenshot harness.
---

# Development

Everything you need to build, test and document Better Cloudflare locally. This page is for contributors; if you are here to learn what the application does, start at [Screens and features](screens.md).

## Contents

- [Prerequisites](#prerequisites)
- [Everyday commands](#everyday-commands)
- [Tests](#tests)
- [What CI gates on](#what-ci-gates-on)
- [The documentation screenshot harness](#the-documentation-screenshot-harness)
- [The documentation site itself](#the-documentation-site-itself)

## Prerequisites

**Node.** `package.json` declares `engines.node` as `^20.19.0 || ^22.13.0 || >=24.0.0`. CI runs every JavaScript job on Node **24.18.1**, so that is the version to match if you are chasing a discrepancy between your machine and a red build.

**Rust**, for anything touching `src-tauri/`. CI pins the toolchain to **1.97.1** with Clippy. Install it the usual way, then install the Tauri CLI — the repo already carries `@tauri-apps/cli` as a dev dependency, so `npm run tauri` works without a global install.

On Linux, building the desktop shell additionally needs the GTK/WebKit development packages that the `native_reliability` CI job installs: `build-essential`, `file`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `libssl-dev`, `libwebkit2gtk-4.1-dev`, `libxdo-dev`, `patchelf` and `xdg-utils`.

Then:

```bash
npm ci
```

## Everyday commands

| Command               | What it does                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`         | Frontend only, via `scripts/dev-server.mjs`, on the first free port. No Rust backend, so desktop-only features degrade gracefully. |
| `npm run tauri:dev`   | The real desktop app: builds the Rust workspace and points the Tauri window at the dev server.                                     |
| `npm run build`       | Next.js static export to `out/`. This is the asset bundle Tauri ships, not a deployable site.                                      |
| `npm run tauri:build` | Platform bundles into `src-tauri/target/release/bundle/`. Unsigned — see [Security](security.md#distribution).                     |
| `npm run check`       | The full local gate: `format:check`, `lint`, `typecheck`, `test`, `test:ci-contract`. Run this before opening a PR.                |
| `npm test`            | Unit tests (see [Tests](#tests)).                                                                                                  |
| `npm run test:e2e`    | Playwright end-to-end suite.                                                                                                       |
| `npm run typecheck`   | `tsc --noEmit`.                                                                                                                    |
| `npm run lint`        | ESLint over `app/` and the `src/` baseline.                                                                                        |
| `npm run format:fix`  | Prettier write across `ts,tsx,js,jsx,mjs,json,css,md` — including this documentation.                                              |
| `npm run screenshots` | Regenerates the documentation screenshots (see [below](#the-documentation-screenshot-harness)).                                    |
| `npm run docs`        | TypeDoc API reference into `docs/api/`, which is excluded from this site's nav and search.                                         |
| `npm run check-spf`   | SPF inspection CLI — see [SPF and NAPTR notes](spf-naptr.md#the-check-spf-cli).                                                    |

Because `npm run dev` serves the frontend outside the Tauri shell, anything that needs the Rust backend — credential persistence, the audit log, registrar monitoring, topology resolution — reports its absence rather than working. That is expected, and it is the same code path the jsdom tests exercise. See [Architecture](architecture.md#the-environment-probe).

## Tests

### The unit runner is `node:test`, not Vitest and not Jest

This surprises people, so it is worth stating plainly: **there is no Vitest, no Jest, and no alternate test config file to hunt for.** `npm test` runs `scripts/run-tests-seq.ts` under `tsx`, and that script drives **Node's built-in `node:test`** runner over the files in `test/`.

The wrapper exists because the suite is memory-hungry. It deliberately runs **one file at a time** — `TEST_RUNNER_LIMITS` fixes `maxWorkers: 1`, `fileParallelism: false` and `filesPerBatch: 1` — and watches the process tree, failing the run rather than letting a leak take the machine down. It also refuses arguments that would defeat those guarantees: `--watch` and `--watch-path` are rejected as unsafe persistent options, and `--max-old-space-size` is rejected because the runner sets the heap ceiling itself.

Filters are positional and match test file paths, with `*` and `?` glob support:

```bash
npm test                                   # everything
npm test -- test/storageManager.test.ts    # one file
npm test -- "test/*storage*"               # a glob
npm test -- --test-concurrency=1           # node:test flags pass through
```

The runner has its own contract test, `npm run test:runner-contract`, so changes to its argument handling are themselves covered.

### End-to-end

Playwright, configured in the repo root. `npm run test:e2e` runs everything; `npm run test:e2e:reliability` runs the Chromium-only subset that CI gates on (`e2e/home.spec.ts`, `e2e/login-key-management.spec.ts`, `e2e/auth-errors.spec.ts` and the Playwright runtime contract). E2E runs against the static export, so build first:

```bash
npm run build
npx playwright install --with-deps chromium
npm run test:e2e:reliability
```

### Rust

```bash
cd src-tauri
cargo test                                    # the crate you are working on
cargo test --workspace --all-targets --locked # what CI runs
cargo clippy --workspace --all-targets --locked
```

`bc-error` and `bc-cloudflare-api` are additionally held to `-D warnings`, so a new Clippy lint in either of those crates is a build failure rather than a note.

## What CI gates on

`.github/workflows/ci.yml` runs eight jobs, and the release job requires **all eight** to succeed — plus the commit being on `main` in the upstream repository, and a deliberate `workflow_dispatch` with the release input set. Nothing publishes on a plain push.

| Job                  | What it enforces                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci_contract`        | The CI reliability contract test and the deterministic resource-disposal tests.                                                                               |
| `unit_tests`         | `npm test` twice, in a matrix: `default`, and `sqlite3-only` with `better-sqlite3` removed so the fallback driver is exercised.                               |
| `e2e_reliability`    | Builds the static export, installs Chromium, runs the reliability specs. Failure artefacts are size-bounded before upload.                                    |
| `native_reliability` | `cargo test --workspace --all-targets --locked`, workspace Clippy, and strict Clippy for the native error contracts.                                          |
| `format`             | `npm run format:check` — Prettier across the whole repo, documentation markdown included. A misformatted page here is a red build.                            |
| `lint`               | ESLint over `app/` and the `src/` baseline.                                                                                                                   |
| `test_package`       | Typecheck, unit tests, `npm run build`, then `npm pack`. The resulting tarball is uploaded for inspection only, not published.                                |
| `release_contract`   | The release-contract test, a fail-closed OSV exception-policy validator, then an OSV vulnerability scan across **both** `package-lock.json` and `Cargo.lock`. |

The practical consequence for documentation changes: run `npm run format:check` (or just `npx prettier --check "docs/**/*.md"`) before pushing.

## The documentation screenshot harness

Every image on this site is generated. `npm run screenshots` runs `scripts/capture-screenshots.ts`, which drives the **real application** in Chromium and writes PNGs to `docs/screenshots/`.

```bash
npm run screenshots                             # every screen, every theme
npm run screenshots -- --only=login,cache       # just these screens
npm run screenshots -- --theme=light            # just one theme
npm run screenshots -- --only=login --theme=sunset,oled
```

`--only` takes screen names, which are exactly the PNG basenames (`login`, `dns-records-table`, `zone-topology`, …); an unrecognised name aborts before a browser or dev server is started, and prints the full list of known screens. `--theme` takes **theme IDs**, not output directory names: `sunset` (written to `dark/`), `light`, and `oled`.

### How it works

The harness reuses a dev server if one is already running and otherwise starts one, waiting up to three minutes for it to answer. Each capture then gets a fresh browser context at **1440×960 with a 2× device scale factor**, reduced motion, `en-US`, and UTC — so a shot does not change because your machine is in a different timezone.

Before the page loads, an init script installs a fake `window.__TAURI_INTERNALS__` bridge, the same mechanism `e2e/authenticated-workspace.spec.ts` uses. Every Tauri command the UI issues is answered from seeded fixtures in `e2e/fixtures/demo-workspace.ts` and `e2e/fixtures/demo-panels.ts`. **No Cloudflare account, no credential and no network call is involved** — the demo data is a fictional freight company, "Harborline Freight Systems", on RFC 2606 `.test` domains with RFC 5737 and RFC 3849 documentation IP ranges.

Captures are taken at 2× and then downscaled to 1440px wide with a Lanczos filter and written as a 256-colour palette PNG. That is deliberate supersampling — the written file is sharper than a native 1× capture — and it keeps the repository from accumulating tens of megabytes of oversized images. Screenshots must always be written through `writeOptimizedPng`; pointing `page.screenshot` at a `path:` directly bypasses it.

### It fails loudly on purpose

A silently broken screenshot in the documentation is worse than a missing one, so a capture is **refused and the partial PNG deleted** if:

- the stub did not answer a Tauri command the UI issued (the error names the commands, so you can add them to the invoke switch);
- the page threw an uncaught error;
- the demo decrypted API token appeared anywhere in the rendered text — a screenshot that leaked it would prove the app can render a decrypted credential;
- the clip target for a framed shot has no layout box;
- the written PNG came out suspiciously small (under 4,000 bytes, or 1,000 for a clipped shot), which almost always means the screen rendered blank.

Individual failures do not abort the run; they are collected, listed at the end, and the process exits non-zero.

### Output layout

```
docs/screenshots/
  dark/    26 screens in the sunset theme (the application default)
  light/   the same 26 screens in the light theme
  oled/    dns-records-table only — the hero shot, as a third-theme sample
```

Adding a screen means adding an entry to the `SCREENS` array in `scripts/capture-screenshots.ts` with a `stage` function that navigates to it, then referencing the new file from a documentation page.

## The documentation site itself

`docs/` is published by GitHub Pages' **legacy (built-in) Jekyll builder** using the `just-the-docs` theme, pinned to a released tag in `docs/_config.yml`. Only plugins on the GitHub Pages whitelist are available.

Two rules keep it working:

**Do not set `permalink: pretty`, and do not add a `permalink` to any page except `index.md`.** Image references are page-relative (`screenshots/dark/login.png`) so they resolve under the `/better-cloudflare` baseurl and keep working in GitHub's blob view. Pretty permalinks would move every page into its own directory and break all 53 images at once. There is a comment in `_config.yml` saying the same thing.

**Front matter must survive Prettier**, because the `format` CI job checks `docs/**/*.md`. Every page needs a `title`, a `nav_order`, and — for a child page — a `parent` that exactly matches the parent page's `title`.

Generated TypeDoc output goes to `docs/api/`, which `_config.yml` marks `nav_exclude` and `search_exclude` so it can never flood the sidebar or the search index.

## See also

- [Architecture](architecture.md) — the crate map and how the frontend reaches the backend
- [Screens and features](screens.md) — what the screenshots show
