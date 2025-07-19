# Better Cloudflare

Better Cloudflare is a minimalist interface for managing DNS records on Cloudflare. It lets you securely store your API tokens in local storage using password-based encryption and provides a simple UI for creating, updating and deleting records.

## Requirements

The project requires **Node 18 or higher**. Use a modern Node version when running
`npm install`, `npm run dev`, and `npm run build`.


## Development

Install dependencies and start the Vite development server:

```bash
npm install
npm run dev
```

Then open <http://localhost:5173> in your browser.

### Custom API base

By default the app talks to the real Cloudflare API at
`https://api.cloudflare.com/client/v4`. You can change this URL using the
`VITE_CLOUDFLARE_API_BASE` environment variable, which is useful when working
with a mock API during development.

If the browser blocks requests to the Cloudflare API because of CORS
restrictions, you can run the included `proxy-server.ts` to forward requests
locally with permissive CORS headers:

```bash
npm run proxy
```

Then start the app pointing at the proxy:

```bash
VITE_CLOUDFLARE_API_BASE=http://localhost:8787 npm run dev
```

Create a `.env` file with your desired base URL:

```bash
# .env
VITE_CLOUDFLARE_API_BASE=http://localhost:8787
```

Run the app with the custom base applied:

```bash
VITE_CLOUDFLARE_API_BASE=http://localhost:8787 npm run dev
```

## Building for production

Create an optimized build and preview it locally:

```bash
npm run build
npm run preview
```

The build output is placed in the `dist` directory.

## License

This project is released under the MIT License. See [license.md](license.md) for details.
