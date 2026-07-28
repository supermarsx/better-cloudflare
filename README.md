# Better Cloudflare

Better Cloudflare is a Next.js and Tauri application for managing Cloudflare DNS records. It can be exported as a static web preview and built as a desktop application.

## Start here

CI uses Node.js 24.x. Install Node.js 24 locally, then clone and install the locked dependency set:

```bash
git clone https://github.com/supermarsx/better-cloudflare.git
cd better-cloudflare
npm ci
```

Run the web app:

```bash
npm run dev
```

Run the Tauri desktop app (Rust and the platform's Tauri prerequisites are also required):

```bash
npm run tauri:dev
```

## Everyday commands

```bash
npm run format:check # Prettier check for source, config, and Markdown
npm run lint         # ESLint for app/ (the current lint scope)
npm run typecheck    # TypeScript check
npm run test         # Node test suite
npm run test:e2e     # Playwright suite
npm run build        # Static Next.js export in out/
npm run check        # format:check + lint + typecheck + test
npm run docs         # API reference in docs/api/
```

## Current support

| Surface                  | Current status                                                                                                                                                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Web and GitHub Pages     | Static export is supported. It is a preview build, not a replacement for the desktop security model.                                                                                                                           |
| macOS desktop            | Tauri desktop build is configured. The only implemented biometric runtime is Touch ID on macOS.                                                                                                                                |
| Windows desktop          | Tauri desktop build is configured, but Windows Hello biometric authentication is not implemented.                                                                                                                              |
| Linux desktop            | Tauri desktop build is configured; biometric authentication is unavailable.                                                                                                                                                    |
| Passkeys                 | The legacy server-mode architecture is documented for historical reference; do not treat it as the current desktop implementation contract.                                                                                    |
| Updates and distribution | The Tauri updater is disabled. Code signing and macOS notarization are not configured. Homebrew, Chocolatey, WinGet, Flathub, Snap, and similar channels are future distribution work unless automation is added and verified. |

See [the documentation hub](docs/index.md) and [the target specification](spec.md) for the distinction between current behavior and planned product requirements.

## GitHub Pages

The Pages build is the static export in `out/`. The repository Pages workflow supplies `GITHUB_PAGES_BASE_PATH` so Next.js emits repository-relative links and assets correctly. For a local repository Pages build in PowerShell:

```powershell
$env:GITHUB_PAGES_BASE_PATH = "better-cloudflare"
npm run build
npm run preview
```

Use an empty `GITHUB_PAGES_BASE_PATH` for a root-hosted site. The project source and curated documentation remain available at [github.com/supermarsx/better-cloudflare](https://github.com/supermarsx/better-cloudflare) and [`docs/`](docs/index.md).

## Releases

Build a local desktop bundle with `npm run tauri:build` (or `npm run build:desktop`). Release artifacts must not be represented as signed, notarized, auto-updating, or package-manager-installable until those delivery steps are configured and verified.

## Repository map

- `app/` — Next.js routes and metadata
- `src/` — application logic and UI
- `src-tauri/` — Tauri desktop backend and packaging configuration
- `docs/` — curated project documentation; generated API reference is `docs/api/`
- `test/` and `e2e/` — automated tests

## Contributing

Create a focused branch, run `npm run check`, and include any relevant documentation or test changes with the implementation.

## License

MIT — see [license.md](license.md).
