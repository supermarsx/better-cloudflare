# Better Cloudflare

Better Cloudflare is a [Next.js](https://nextjs.org/) + [Tauri](https://tauri.app/) desktop and web app for managing Cloudflare DNS securely with local credentials and passkey-ready auth flows.

## Why this project

This repo is meant for people who want:

- quick DNS record and zone operations from one app
- local-first data flow (no cloud secrets storage in the app)
- a CI pipeline that keeps quality gates reproducible
- a deployable web build that can be published as GitHub Pages

## What’s included

- Cloudflare DNS and zone management workflows
- secure local credential storage for API tokens
- passkey auth scaffolding
- audit trails and bulk-edit utilities
- locale + theme support
- desktop packaging through Tauri

## Prerequisites

- Node.js 18+
- Git
- For desktop builds only: Rust + platform-specific Tauri prerequisites

## Quick start

```bash
git clone https://github.com/supermarsx/better-cloudflare.git
cd better-cloudflare
npm install
```

Run web mode:

```bash
npm run dev
```

Run desktop mode:

```bash
npm run tauri:dev
```

## Commands you’ll use

```bash
npm run format:check   # formatting check
npm run lint           # ESLint
npm run typecheck      # TS compile check
npm run test           # unit tests
npm run build          # Next export
npm run check          # all local gates above
```

## GitHub Pages (GitHub-hosted preview)

This repo can publish a Pages site from the web export output (`out/`) on `main`.

- Pages setup is currently guarded in CI: deployment only runs when the repository already has Pages configured.
- If Pages is not configured yet, CI skips deployment instead of failing the build.
- When enabled, the site is published via:
  - build step: `npm run build`
  - artifact upload using `actions/upload-pages-artifact`
  - deployment using `actions/deploy-pages`

If you want to enable Pages for the first time, turn on GitHub Pages from repository settings and then re-push `main`.

## CI and release pipeline

Workflow set:

- `Format Check` (`npm run format:check`)
- `Lint` (`npm run lint`)
- `Test and Package` (`npm run test`, `npm run build`)
- `Deploy GitHub Pages` (conditional)
- `Autopublish` (release creation + packaged artifact upload)

Releases are generated only when upstream checks pass for the same commit SHA.

## Repository map

- `app/` — app shell and routes
- `src/` — domain and component logic
- `src-tauri/` — desktop backend + packaging config
- `test/` — unit tests
- `docs/` — deeper notes and architecture details
- `e2e/` — browser test specs

## Documentation

- [Passkey architecture](docs/passkey-architecture.md)
- [Tauri migration notes](docs/tauri-migration.md)
- [SPF/NAPTR notes](docs/spf-naptr.md)
- [Design system notes](docs/design-system.md)
- [Future work](docs/future-work.md)

## Contributing

1. Create a branch
2. Run `npm run check`
3. Commit focused changes
4. Push and open a PR

## License

MIT — see [license.md](license.md).
