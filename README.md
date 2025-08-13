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
`ALLOWED_ORIGIN` to restrict CORS to a specific origin:

```bash
ALLOWED_ORIGIN=http://localhost:5173 npm run server
```

Then start the app pointing at the API server:

```bash
VITE_SERVER_API_BASE=http://localhost:8787/api npm run dev
```

Or launch both in one step by running the server and Vite in parallel.

```bash
npm run dev:server
```

### Request timeout

API calls made through `ServerClient` time out after 10 seconds by default. Pass a
custom timeout in milliseconds as the fourth constructor argument when you need
to adjust this:

```ts
const client = new ServerClient('token', 'http://example.com', undefined, 15_000);
```

### Debugging

Enable verbose logs from the Cloudflare API wrapper by running the development server in debug mode:

```bash
npm run dev:debug
```

This sets `VITE_DEBUG_CF_API=1` for the React app. You can also export this variable manually and use `npm run dev:server`.

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

## Building for production

Create an optimized build and preview it locally:

```bash
npm run build
npm run preview
```

The build output is placed in the `dist` directory.

## License

This project is released under the MIT License. See [license.md](license.md) for details.
