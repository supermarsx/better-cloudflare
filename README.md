# Better Cloudflare

Better Cloudflare is a minimalist interface for managing DNS records on Cloudflare. It lets you securely store your API tokens in local storage using password-based encryption and provides a simple UI for creating, updating and deleting records.

## Requirements

The project requires **Node 18 or higher**. Use a modern Node version when running
`npm install`, `npm run dev`, and `npm run build`.

## Development

Install dependencies and start the Next.js development server:

```bash
npm install
npm run dev
```

Then open <http://localhost:3000> in your browser.

### Custom API base

By default the app talks to the real Cloudflare API at
`https://api.cloudflare.com/client/v4`. When developing locally you can run the
included API server. Configure the frontend with the `VITE_SERVER_API_BASE`
environment variable if the server runs on a custom URL. The server itself can
be pointed at a different Cloudflare base by setting `CLOUDFLARE_API_BASE`.

All API calls are handled server-side by `server.ts`. Start the API server
first:

```bash
npm run server
```

By default the API server allows requests from any origin. Set
`ALLOWED_ORIGINS` to a comma-separated list to restrict CORS:

```bash
ALLOWED_ORIGINS=http://localhost:3000,http://example.com npm run server
```

Then start the app pointing at the API server:

```bash
VITE_SERVER_API_BASE=http://localhost:8787/api npm run dev
```

### Request timeout

API calls made through `ServerClient` time out after 10 seconds by default. Pass a
custom timeout in milliseconds as the fourth constructor argument when you need
to adjust this:

```ts
const client = new ServerClient(
  "token",
  "http://example.com",
  undefined,
  15_000,
);
```

### Debugging

Enable verbose logs from the Cloudflare API wrapper by running the development server with `VITE_DEBUG_CF_API=1`:

Set `DEBUG_SERVER=1` to enable detailed request logs from the Express server and
`DEBUG_SERVER_API=1` to log Cloudflare API requests made by the server.

Boolean flags accept `1`, `true`, `yes` or `on`.

The API server listens on port `8787` by default. Override it with:

```bash
PORT=3000 npm run server
```

Create a `.env` file with your desired base URL:

```bash
# .env
VITE_SERVER_API_BASE=http://localhost:8787/api
CLOUDFLARE_API_BASE=https://api.cloudflare.com/client/v4
```

Run the app with the custom base applied:

```bash
VITE_SERVER_API_BASE=http://localhost:8787/api npm run dev
```

### Rate limiting

The API server enforces a simple rate limit. Adjust the limits with:

```bash
RATE_LIMIT_WINDOW=60000 RATE_LIMIT_MAX=100 npm run server
```

`RATE_LIMIT_WINDOW` defines the window size in milliseconds and `RATE_LIMIT_MAX`
sets the number of requests allowed per window for each IP. The defaults are
60,000 ms and 100 requests.

## Building for production

Create an optimized build and preview it locally:

```bash
npm run build
npm run preview
```

The build output is placed in the `out` directory.

## Optional OS Vault & Passkeys

When running the optional local server (`npm run server`) you can enable an OS-backed vault for in-memory secret storage. Install `keytar` and set `KEYTAR_ENABLED=1` to enable storing secrets in the OS keychain (macOS Keychain, Windows Credential Manager, or Linux Secret Service) instead of the in-memory fallback.

The server also exposes simple passkey (WebAuthn) registration and authentication endpoints. These allow you to register a platform passkey for a stored key and authenticate using the passkey instead of a password. The implementation is a scaffold for local usage and demonstrates the UI flow; production readiness requires a full WebAuthn verification implementation on the server.

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
