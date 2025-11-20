# Better Cloudflare — Application Specification

⚙️ Overview

Better Cloudflare is a minimalist single-page application (SPA) for managing DNS records on Cloudflare. It provides a lightweight, secure, and self-contained environment: a React + Vite frontend with an optional Node/Express server that acts as a proxy to the Cloudflare API.

The application stores Cloudflare credentials locally in encrypted form, and the user unlocks keys with a password. Key features include: listing zones, browsing DNS records, adding/updating/deleting records, importing/exporting records (JSON/CSV/BIND), and secure local storage for API tokens.


## Table of contents

1. Product purpose & scope
2. Target users
3. System architecture
4. Runtime requirements & environment variables
5. Pages & UI sections
6. Features & flows
7. Detailed UI components
8. Data models & validation rules
9. Client-server API specification
10. Storage & encryption
11. Security, privacy and operations
12. Error handling & logging
13. Performance & benchmarks
14. Testing & QA
15. Accessibility & UX considerations
 - Optional OS vault: The server can optionally store secrets in the OS keychain when `KEYTAR_ENABLED=1` and `keytar` is available. This provides alternative secure storage for decrypted API keys and passkey credential storage in local server environments.
 - Passkeys (WebAuthn): The app integrates an optional passkey flow to register and authenticate using platform passkeys as an alternative to password-based decryption. The passkey flow uses `@simplewebauthn/server` to validate attestation and assertions, and the server stores registered credentials in the vault. Password fallback remains supported.
   - Multiple credentials: The server supports multiple passkey credentials per `id` (user/key) and stores an array of credential objects under `passkey:{id}` in the vault. `createPasskeyAuthOptions` aggregates all known credentials as `allowCredentials`.
   - Server origin & rpID: The server uses `SERVER_ORIGIN` (or `VITE_SERVER_ORIGIN`) to compute the expected origin and `rpID` for verification — set this variable when deploying beyond local development.
   - Registration verification: `registerPasskey` verifies the attestation blob (`verifyRegistrationResponse`) and persists credential metadata securely in the vault.
   - Assertion verification: `authenticatePasskey` verifies assertions (`verifyAuthenticationResponse`) and updates counters; mismatches return 400 errors. The UI uses server-provided options to call platform WebAuthn APIs.

16. Internationalization & configuration
17. Extensibility & integration points
18. Known limitations & future work


## 1. Product purpose & scope

Purpose: To make Cloudflare DNS management easier and safer for users who prefer a local-first/desktop-like experience: store tokens locally (encrypted), manage DNS records quickly with a UI, and use the official Cloudflare API via a proxied server.

Scope:
- Manage DNS records across zones for accounts/tokens.
- Securely store API tokens locally using password-based encryption.
- Provide simple import/export options for records (JSON, CSV, BIND zone files).
- Support three authentication modes: bearer token, global API key + email, or use local stored keys decrypted with password.
- Keep the server small, ephemeral, and stateless (does not store tokens persistently).

Out-of-scope (explicit):
- Multi-user server-side account management.
- Long-term server-side credential storage.
- Fine-grained role-based access.


## 2. Target users

- System administrators and devops/engineers who manage Cloudflare zones and prefer a lightweight local UI instead of dashboards.
- Users who want to keep API tokens locally and encrypted rather than using a hosted solution.
- Power users who need import/export, fast edits, and bulk operations.


## 3. System architecture

The app is a two-tier architecture:

- Frontend: React (Vite) SPA located in `src/`. Handles UI, local storage for encrypted API keys, client-side DNS record and zone UX, encryption controls, and local import/export.
- Proxy Server: A small Node/Express-based server (`server.ts` and `src/server/*`) that acts as a secure proxy for Cloudflare API endpoints. It's optional but recommended for local development.

Key server responsibilities:
- Accept HTTP requests from local UI clients.
- Accept either `Authorization: Bearer <token>` or `X-Auth-Key` + `X-Auth-Email` for credentials.
- Proxy and map operations to the Cloudflare API using the `cloudflare` library.
- Validate input using server-side validation.
- Expose the following API endpoints (see specification below): verify-token, zones, dns_records list/create/update/delete.

Server features:
- CORS handling with `ALLOWED_ORIGINS`.
- JSON body parsing.
- Rate limiting (configurable via env variables).
- Error handler returning JSON.
- Debug logging toggles (DEBUG_SERVER, DEBUG_SERVER_API, DEBUG_CF_API, VITE_DEBUG_CF_API).


## 4. Runtime requirements & environment variables

Requirements:
- Node 18+ for development and server.
- NPM for scripts: `npm install`, `npm run dev` and `npm run server`.

Important environment variables:
- For frontend (Vite): `VITE_SERVER_API_BASE` — base URL to server API.
- For server (`server.ts`):
  - `PORT` / `VITE_PORT` — port for server (default 8787)
  - `ALLOWED_ORIGINS` — comma-separated allowed origins for CORS (`*` allows all)
  - `SERVER_ORIGIN` / `VITE_SERVER_ORIGIN` — base origin used to validate WebAuthn/assertion origin (defaults to `http://localhost:8787`)
  - `RATE_LIMIT_WINDOW` (ms default: 60000) & `RATE_LIMIT_MAX` (e.g., default: 100)
  - `CLOUDFLARE_API_BASE` — optional Cloudflare base to proxy
  - `DEBUG_SERVER`, `DEBUG_SERVER_API`, `DEBUG_CF_API`, `VITE_DEBUG_CF_API` — debug flags

Usage examples:
```
# Run API server
PORT=8787 DEBUG_SERVER=1 npm run server
# Run app pointing to server
VITE_SERVER_API_BASE=http://localhost:8787/api npm run dev
```


## 5. Pages & UI sections

The application is a single-page UI with two primary screens:

1. Login / Key management (root view when not logged in)
  - Key selection dropdown (stored keys)
  - Password unlock form
  - Add API key dialog (label, key/token, optional email, password for encryption)
  - Edit key modal (rename or rotate encryption password)
  - Encryption settings & benchmark

2. DNS Manager (visible after unlocking a stored key)
  - Header with current session information and Logout button
  - Zone selector (list zones returned from Cloudflare)
  - DNS Records list for selected zone
  - Search input and type filter (A, AAAA, CNAME, etc.)
  - Inline edit per record (TTL, proxied for supported types, priority for MX)
  - Add Record dialog
  - Import/Export dialog (JSON/CSV/BIND)
  - Bulk import preview/validation

Additionally, the app provides lightweight toasts for success/error messages.

---

## 6. Features & Flows

Authentication & Key Management
- New keys are added using `AddKeyDialog` and encrypted with a password.
- Encryption metadata (salt, iv, iterations, keyLength, algorithm) are stored locally.
- The user selects an API key, enters the password to decrypt the token.
- The decrypted token is verified against the server (`POST /api/verify-token`), then stored as the current session in storage.
- Logging out clears the session from local storage.

Zone & Record Management
- Zones list is fetched via `GET /api/zones` after login.
- Selecting a zone fetches DNS records via `GET /api/zones/:zone/dns_records`.
- Add a new record via `POST /api/zones/:zone/dns_records` with client-side validation.
- Update a record via `PUT /api/zones/:zone/dns_records/:id`.
- Delete a record via `DELETE /api/zones/:zone/dns_records/:id`.
- Inline record editing with preset TTL choices, custom TTL, and MX priority editing.
- Search & filter operations operate client-side on fetched records.

Import/Export
- Export: Records exported in JSON, CSV, or BIND zone format.
- Import: Accepts JSON array, CSV, or BIND zone file; parsed using `parseCSVRecords` and `parseBINDZone`.
- De-duplication: During import, the UI skips exact duplicates (type + name + content) and counts skipped items.

Encryption configuration & Benchmarking
- Users can change PBKDF2 iteration count, key length, and algorithm via the `EncryptionSettingsDialog`.
- Running a CPU benchmark measures the time to derive a key with the provided iterations (via `lib/crypto-benchmark.ts`).

Server Features
- Rate limiting via `express-rate-limit`.
- CORS allowed origins via `getCorsMiddleware`.
- Centralized error handler returns JSON and hides stack in production.


## 7. Detailed UI components

- `LoginForm` (`src/components/auth/login-form.tsx`)
  - Select stored key, enter password, login.
  - Secondary actions: Add Key, encryption settings, edit key.

- `AddKeyDialog`, `EditKeyDialog` (`auth/*`)
  - Add or edit key: label, API token, optional email (global key), encryption password.

- `EncryptionSettingsDialog` (`auth/EncryptionSettingsDialog.tsx`)
  - Change PBKDF2 iterations, key length, algorithm; perform benchmark.

- `DNSManager` (`dns/dns-manager.tsx`)
  - Zone selector, list of records, AddRecordDialog, import/export.

- `RecordRow` (`dns/RecordRow.tsx`)
  - Displays record metadata; edit inline with inputs for editable fields.

- `AddRecordDialog`, `ImportExportDialog` (`dns/*`)

- Shared UI primitives (`ui/*`): Button, Input, Select, Card, Dialog, Toast / Toaster


## 8. Data models & validation rules

Types (from `src/types/dns.ts`):
- DNSRecord: { id, type, name, content, ttl, priority?, proxied?, zone_id, zone_name, created_on, modified_on }
- Zone: { id, name, status, paused, type, development_mode }
- ApiKey: Metadata for encrypted keys stored locally.
- EncryptionConfig: { iterations, keyLength, algorithm }

Validation:
- Client-side: UI checks for required fields when adding/updating records.
- Server-side: `zod` schema `dnsRecordSchema` to validate incoming create/update record payloads.

`dnsRecordSchema` requires:
- type ∈ RECORD_TYPES
- name (string)
- content (string)
- ttl: optional, either integer or 'auto'
- priority: optional (integer for MX)
- proxied: optional boolean


## 9. Client-server API specification

Base path: {VITE_SERVER_API_BASE}/api

Headers: Authorization: Bearer <token> OR X-Auth-Key: <key> + X-Auth-Email: <email>

Endpoints:
- POST /api/verify-token
  - Purpose: Verify a provided token or key.
  - Request: {} body is not required; credentials from headers.
  - Response: { success: true }
  - Errors: 400 missing credentials; 403/401 on invalid creds.

- GET /api/zones
  - Purpose: List Cloudflare zones available for credentials.
  - Response: Array of Zone objects.

- GET /api/zones/:zone/dns_records
  - Purpose: List DNS records for a zone.
  - Response: Array of DNSRecord objects.

- POST /api/zones/:zone/dns_records
  - Purpose: Create a new DNS record in a zone.
  - Request: body must match dnsRecordSchema.
  - Response: created DNSRecord.

- PUT /api/zones/:zone/dns_records/:id
  - Purpose: Update an existing DNS record.
  - Request: body must match dnsRecordSchema.
  - Response: updated DNSRecord.

- DELETE /api/zones/:zone/dns_records/:id
  - Purpose: Delete an existing DNS record.
  - Response: { success: true }

- POST /api/vault/:id
  - Purpose: Store a secret in the server-side vault (OS keychain when available). Requires valid credentials.
  - Request: { secret: string }
  - Response: { success: true }

- GET /api/vault/:id
  - Purpose: Retrieve a secret from the server vault.
  - Response: { secret: string }

- DELETE /api/vault/:id
  - Purpose: Remove a secret from the server vault.
  - Response: { success: true }

- GET /api/passkeys/register/options/:id
  - Purpose: Get registration options (challenge) for passkey registration.
  - Response: { challenge: string, options: object }

- POST /api/passkeys/register/:id
  - Purpose: Register a new passkey credential for an id. Verifies attestation and stores credential(s).
  - Request: attestation blob (per WebAuthn)
  - Response: { success: true }

- GET /api/passkeys/authenticate/options/:id
  - Purpose: Get authentication options (challenge) for passkey assertion.
  - Response: { challenge: string, options: object }

- POST /api/passkeys/authenticate/:id
  - Purpose: Verify a passkey assertion; updates credential counters and returns success.
  - Request: assertion blob (per WebAuthn)
  - Response: { success: true }

- GET /api/passkeys/:id
  - Purpose: List registered passkey credentials for the given id.
  - Response: Array of credential metadata objects containing ids and counters.

- DELETE /api/passkeys/:id/:cid
  - Purpose: Remove a registered passkey credential by id (revoke) for the given id.
  - Response: { success: true }

Common Response behavior:
- HTTP non-2xx returns a JSON payload with `error` or a Cloudflare `errors` array.
- Rate-limiting returns standard headers and status code per `express-rate-limit`.

Network & Timeout
- ServerClient uses 10s default timeout; configurable when instantiating the client.


## 10. Storage & encryption

Local storage keys & formats:
- STORAGE_KEY `cloudflare-dns-manager`: stores `StorageData` object:
  - { apiKeys: ApiKey[], currentSession?: string, lastZone?: string }

- `ApiKey` metadata includes: `id`, `label`, `encryptedKey` (base64), `salt`, `iv`, `iterations`, `keyLength`, `algorithm`, `createdAt`, and optional `email`.

Encryption:
- Uses Web Crypto API in `CryptoManager`.
- Key derivation: PBKDF2 with `iterations` and `SHA-256`.
- Key length options: 128, 192, 256 bits.
- Cipher: AES-GCM (preferred) or AES-CBC as fallback (though AES-GCM is recommended).
- `CryptoManager.encrypt` returns base64-encoded encrypted data, salt, and iv.
- `CryptoManager.decrypt` uses the stored salt/iv & password to derive and decrypt.

Encryption configuration & operations:
- Config persisted under `encryption-settings`.
- Users can upgrade encryption settings; when rotating a key, `updateApiKey` will re-encrypt the key with the new password or algorithm.

Security model: The frontend never transmits the plain unencrypted API key except in requests to the server when used as current session. The server only forwards the provided token/key to Cloudflare and does not persist any tokens.


## 11. Security, privacy and operations

- Local-only key storage: Encrypted API keys persist on the user agent via localStorage; best for one-person usage or local hosting.
- Credentials formats allowed: Cloudflare API tokens (recommended) or global API key + email.
- Server API expects credentials in secure headers only; prefer HTTPS when deployed publicly.
- The server forbids cross-origin requests by default unless ALLOWED_ORIGINS is set to allow a list or wildcard.
- Rate limiting defaults: RATE_LIMIT_WINDOW=60000 (ms), RATE_LIMIT_MAX=100 requests; configurable.

Security flags:
- DEBUG flags are available for development only. Avoid enabling in production.
- The app performs server-side validation for record create/update requests.
- CryptoManager uses PBKDF2 & AES-GCM. Support for AES-CBC exists but less secure.

Operational concerns:
- The server does not store tokens. If deployed, ensure TLS termination is in place.
- Users managing production DNS should use API tokens with appropriate restricted permissions.


## 12. Error handling & logging

Server:
- Central error handler returns JSON { error: <message> } and appropriate status codes.
- Debug mode prints request/response logs to console.
- Requests are timed out by the ServerClient and client-side operations show toasts for errors.

Client:
- Standardized error toast: the UI surfaces success or error via `useToast`.
- When a server returns JSON `errors`, the `ServerClient` attempts to parse and include the detail message.


## 13. Performance & benchmarks

- Client-side operations are fast for common tasks. Bulk importing a large zone may be limited by memory.
- `CryptoManager` provides a benchmarking utility to measure PBKDF2 cost at the user hardware/iterations combination.
- Default PBKDF2 iterations are 100,000; lower values may be chosen to reduce UI latency, and higher values to increase security.

Notes:
- The iteration count should balance security and performance; the benchmark shows ms to derive a key with the chosen iteration count.
- For large record sets and long lists, the app could benefit from incremental loading (pagination) but currently loads the entire zone.


## 14. Testing & QA

Unit Tests currently include tests for:
- `storageManager` (import/export, update, rotation, clear session)
- `cryptoManager` (derive, encrypt, decrypt, iteration behavior)
- `server` utilities: CORS, error handler, express router validation, server-client
- API client: `ServerClient` request handling and error parsing

End-to-end flows tested by unit tests:
- Adding and decrypting keys
- Verifying token via server
- Create/update/delete record flows

Automated testing coverage recommendations:
- Add Playwright/Cypress E2E tests for full user flows (add key, login, CRUD records, import/export, passkeys, vault integration).
- Integrate accessibility checks with `axe-core` into CI.

Developer testing commands:
- Run all tests: `npm test` (or `npm run test` as configured)
- Generate docs: `npm run docs`


## 15. Accessibility & UX considerations

- Use of semantic HTML and accessible form controls (Select, Input, Buttons); dialogs use accessible patterns.
- Keyboard shortcuts: pressing Enter on password field triggers login; modals respect standard controls.
- Suggest improvements: ARIA labels for custom components, focus trap for dialogs, form error messaging focused for keyboard-only users.


## 16. Internationalization & configuration

- The codebase does not include i18n currently; UI strings are in plain text and would need extraction for i18n.
- Theme configuration uses Tailwind and CSS variables in `index.css`; theming is possible by adjusting classes and CSS variables.


## 17. Extensibility & integration points

- Server has a small `ServerAPI` class which maps endpoints to `CloudflareAPI` functions — a natural place to add more Cloudflare operations (e.g., page rules, other DNS features).
- `CryptoManager` & `StorageManager` are designed for injection of storage/crypto implementations in tests; this also supports substituting a server-backed cryptographic store for multi-user deployments.
- `ServerClient` is a thin wrapper; additional error handling or response shaping is simple to add.

Suggested extensions:
- Support for bulk operations on the server to import large zone files server-side.
- Paginated zone records and offline editing with background sync.
- A role-based access control (RBAC) server that stores keys securely.

### Suggested new features (proactive roadmap)
- Multi-device passkey management: Add UI to list, revoke, and label registered passkeys per stored key. Add server routes to delete specific passkey credentials.
- Passkey revocation and management: Allow users to list registered credentials per id and remove a credential or all credentials when needed.
- Server-side credential store with access control: Add optional server-side persistent storage (encrypted DB) for credentials with multi-user support and RBAC.
- E2E test suite and CI pipelines: Add Playwright or Cypress tests to validate critical flows (add key, login, CRUD records, import/export, passkeys, vault).
- Accessibility automated testing: Integrate axe-core accessibility checks into testing pipeline.
- Pagination and virtualized lists + offline-first UX: Enhance performance and offline support for large zones.
- Background.sync or PWA support for offline editing and later synchronization (requires server-side conflict resolution).
- Audit logs: Track sensitive events (key addition, rotation, delete, passkey registration, passkey auth) in server logs or a secure audit store.
- Trusted attestation and attestation policies: Add configurable attestation verification rules (e.g., require certain attestation formats or authenticators).


## 18. Known limitations & future work

- Single-user oriented: Local storage-based keys and session model assume a single user per browser.
- No multi-account server model: the server is a simple proxy and is not meant to be a shared multi-user platform.
- Lack of fine-grained control for API tokens on the server; consider adding OAuth or a more secure server-side credential manager for multi-tenant deployments.
- No live events or automatic polling of changes; the UI expects the user to use operations to refresh lists.
- Large zones may cause the browser to display long lists; implement pagination or virtualized lists for performance.


Appendix: Useful References and File Locations
- Frontend entry: `src/main.tsx`, `src/App.tsx`
- Key components: `src/components/auth` and `src/components/dns`
- Client API: `src/lib/server-client.ts`
- Server API: `src/lib/server-api.ts`, `src/server/router.ts`
- Cloudflare wrapper: `src/lib/cloudflare.ts`
- Storage & crypto: `src/lib/storage.ts`, `src/lib/crypto.ts`
- Validation: `src/lib/validation.ts`
- Tests: `test/*` — includes coverage for many key areas


## Examples — API & UI flows

### API requests (examples)

- Verify token (Bearer auth)
  - Request:
    - POST /api/verify-token
    - Headers: `Authorization: Bearer <token>`
  - Response: 200 { "success": true }

- List zones
  - Request:
    - GET /api/zones
    - Headers: `Authorization: Bearer <token>`
  - Response: 200 [ { id: "zoneId", name: "example.org", status: "active", ... } ]

- Get records
  - Request: GET /api/zones/:zone/dns_records
  - Response: 200 [ { id: "recId", type: "A", name: "www", content: "1.2.3.4", ttl: 3600, zone_id: "zoneId" } ]

- Create record
  - Request: POST /api/zones/:zone/dns_records
  - Body example:
    {
      "type": "A",
      "name": "www",
      "content": "1.2.3.4",
      "ttl": 300,
      "proxied": false
    }
  - Response: newly created record (200)

- Update record
  - PUT /api/zones/:zone/dns_records/:id
  - Body: same as Create record but partial fields allowed
  - Response: updated record (200)

- Delete record
  - DELETE /api/zones/:zone/dns_records/:id
  - Response: 200 { "success": true }

### Common UI flows

- Add and Encrypt Key
  1. Open Add Key dialog in `LoginForm`.
  2. Fill label, API token, optional email, encryption password.
  3. Click Add — app verifies the token via `POST /api/verify-token`.
  4. If valid, the key is encrypted with the password and stored locally.

- Login With Stored Key
  1. Select a stored key in `LoginForm`.
  2. Enter the encryption password and click Login.
  3. `LoginForm` decrypts token via `StorageManager.getDecryptedApiKey` and verifies with the server.
  4. On success, set current session and show DNS Manager.

- Create & Update Record
  1. Select zone in `DNSManager`.
  2. Click Add Record and fill required fields.
  3. Submitting sends POST to `/api/zones/:zone/dns_records`.
  4. For updates, Edit inline or via modal then send PUT to `/api/zones/:zone/dns_records/:id`.


## Acceptance Criteria (for the main features)

- Users can add API tokens and store them encrypted locally.
- Login flow must validate decrypted credentials against the server before creating a live session.
- Listing zones and records must match Cloudflare's responses for the token used.
- Create, update and delete record operations must be performed and reflected in UI state.
- Import/export operations handle JSON, CSV and BIND format and provide user feedback for skipped/invalid items.
- Server should enforce rate limiting and CORS policies.


## Edge Cases and Error scenarios

- Wrong encryption password: UI should display an error toast and not set the session.
- Invalid credentials: server returns an error; UI surfaces a descriptive toast.
- Network timeouts: ServerClient has a default timeout; UI should handle AbortError and display informative messages.
- Import duplicates: duplicates skipped; user is informed of skipped count.
- Large zone lists: consider adding pagination or virtualized lists if performance limits observed.

