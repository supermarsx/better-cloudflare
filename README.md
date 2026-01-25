# Better Cloudflare

Better Cloudflare is a Tauri-powered desktop app for managing DNS records on Cloudflare. It securely stores API tokens using password-based encryption and provides a simple UI for creating, updating, and deleting records.

For desktop-specific setup and distribution, see `README-TAURI.md`.

## Requirements

The project requires **Node 18 or higher**. Use a modern Node version when running
`npm install`, `npm run dev`, and `npm run build`.

For desktop development, you also need:
- **Rust toolchain** (latest stable)
- **Tauri system dependencies** (see `README-TAURI.md` for platform-specific packages)

## Development

Install dependencies and run the desktop app in dev mode:

```bash
npm install
npm run tauri:dev
```

For UI-only work (no backend), you can run the Next.js dev server:

```bash
npm run dev
```

Then open <http://localhost:3000> in your browser. API-driven features require the Tauri backend.

## Building for production

Create an optimized desktop build:

```bash
npm run tauri:build
```

For a static export of the frontend only:

```bash
npm run build
npm run preview
```

## Developer Documentation (JSDoc / TypeDoc)

This codebase includes TypeScript JSDoc comments and can generate developer
documentation using TypeDoc. To generate a static site containing the API
reference and module docs run:

```bash
npm run docs
```

This will output generated docs to the `docs/` directory. Keep JSDoc comments
focused on describing public APIs, expected parameter types, and return
values. For React components prefer documenting props and any callbacks.

## License

This project is released under the MIT License. See [license.md](license.md) for details.

## CI and Autopublish

The repository runs multiple GitHub Actions workflows for quality checks and packaging:

- Format Check — uses Prettier to ensure consistent formatting
- Lint — ESLint checks the codebase
- Test and Package — runs unit tests, builds the app, and creates a package artifact

The Autopublish workflow only runs after the `Test and Package` workflow completes successfully for the same commit and also verifies that `Format Check` and `Lint` passed for that commit. This ensures releases are created only when formatting, linting, tests, build and packaging all succeeded.
