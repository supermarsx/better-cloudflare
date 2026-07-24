# Better Cloudflare

Better Cloudflare is a [Next.js](https://nextjs.org/) + [Tauri](https://tauri.app/) desktop app for managing Cloudflare DNS records with secure credentials and passkey support.

The app includes:

- Cloudflare zone/DNS management
- Secure local storage for API credentials
- Passkey-based authentication flow support
- Audit logging and bulk editing workflows
- Offline-friendly local cache behavior
- Theme and locale support

## What you get

- A native desktop experience (Windows, macOS, Linux) via Tauri
- A fast web UI for day-to-day DNS record operations
- Stronger security defaults than a simple token-in-config tool
- CI-validated workflows for format, lint, tests, and build

## Prerequisites

- Node.js 18+
- Optional (for desktop build only):
  - Rust toolchain (stable)
  - Platform-specific Tauri dependencies
- Git

## Quick start

```bash
git clone https://github.com/supermarsx/better-cloudflare.git
cd better-cloudflare
npm install
```

Run web-only development:

```bash
npm run dev
```

Run full desktop mode:

```bash
npm run tauri:dev
```

Open <http://localhost:3000> for web mode, or use the Tauri window for desktop mode.

## Build targets

| Target       | Command                                | Output                              |
| ------------ | -------------------------------------- | ----------------------------------- |
| Web frontend | `npm run build`                        | `out/` (static export)              |
| Desktop app  | `npm run tauri:build`                  | `src-tauri/target/...`              |
| Package      | `npm run build && npm run tauri:build` | app packages and platform artifacts |

## Testing and quality checks

```bash
npm run format:check   # formatting
npm run lint           # ESLint
npm run typecheck      # TypeScript type check
npm run test           # unit tests
npm run build          # production build (Next export)
```

A full local gate:

```bash
npm run check
```

## Documentation

- `docs/tauri-migration.md` — migration notes and architecture decisions
- `docs/passkey-architecture.md` — passkey flow design
- `docs/spf-naptr.md` — SPF/NAPTR validation notes
- `LICENSE` in `license.md`

## Project structure

- `app/` — application shell and root routes
- `src/` — app UI and logic
- `src-tauri/` — Rust backend and Tauri configuration
- `test/` — TSX unit tests
- `e2e/` — Playwright test specs
- `docs/` — architecture and migration notes

## GitHub Pages

The repository publishes a GitHub Pages preview of the built static frontend on pushes to `main`.
When you visit the hosted site, you get a rendered README-friendly site and app landing routes from the same production build.

## CI and releases

GitHub Actions currently runs these checks:

- **Format Check** (`npm run format:check`)
- **Lint** (`npm run lint`)
- **Test and Package** (`npm test`, `npm run build`, then `npm pack`)
- **Autopublish** (release packaging) depends on successful upstream checks

## Contributing

1. Create a branch for your change
2. Run `npm run check` before committing
3. Commit small, focused changes
4. Push and open a pull request

## License

MIT — see [license.md](license.md).
