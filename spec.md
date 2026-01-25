# Better Cloudflare — Application Specification

⚙️ Overview

Better Cloudflare is a secure native desktop application for managing DNS records on Cloudflare. Built with Tauri 2.0, it combines a Next.js/React frontend with a Rust backend, providing a lightweight, fast, and fully offline-capable environment.

The application stores Cloudflare credentials locally in the operating system's secure keychain (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux) with AES-256-GCM encryption. Users unlock keys with a password or passkey authentication. Key features include: listing zones, browsing DNS records, adding/updating/deleting records, importing/exporting records (JSON/CSV/BIND), secure OS-level credential storage, and platform-native passkey support.

**Key Advantages of Desktop Architecture:**
- Native OS keychain integration for maximum security
- No network server required - fully offline capable
- Fast IPC communication between frontend and Rust backend
- Platform-native performance and security
- Single-binary distribution with no runtime dependencies

## Table of contents

1. Product purpose & scope
2. Target users
3. System architecture (Tauri + Rust backend)
4. Runtime requirements & build dependencies
5. Pages & UI sections
6. Features & flows
7. Detailed UI components
8. Data models & validation rules
9. IPC API specification (Tauri commands)
10. Storage & encryption (OS keychain + AES-256-GCM)
11. Security, privacy and operations
12. Error handling & logging
13. Performance & benchmarks
14. Testing & QA
15. Accessibility & UX considerations
16. Internationalization & configuration
17. Extensibility & integration points
18. Distribution & deployment
19. Known limitations & future work

**Key Architecture Features:**
- **OS Keychain Integration**: Credentials are stored in the operating system's native secure storage using the `keyring` Rust crate (macOS Keychain, Windows Credential Manager, Linux Secret Service). Fallback to encrypted in-memory storage when OS keychain is unavailable.
- **Passkeys (WebAuthn)**: Full platform authenticator support for passwordless authentication. Passkey credentials are managed in the Rust backend with challenge generation, challenge validation, and credential storage in secure storage (attestation/assertion verification planned).
  - Multiple credentials: Supports multiple passkey credentials per stored key with device naming and management UI
  - Platform integration: Uses native platform authenticators (Touch ID, Windows Hello, etc.)
  - Registration/Authentication: Rust backend handles WebAuthn challenge generation and validation (full verification planned)
- **Tauri IPC**: All communication between frontend (Next.js/React) and backend (Rust) uses Tauri's secure IPC mechanism instead of HTTP
- **Rust Backend**: Complete rewrite of backend logic in Rust for performance, security, and native compilation

## 1. Product purpose & scope

Purpose: To provide a secure, fast, and fully offline-capable native desktop application for Cloudflare DNS management. Users benefit from OS-level security (keychain integration), platform-native performance, and passwordless authentication via passkeys.

Scope:

- Manage DNS records across zones for accounts/tokens
- Securely store API tokens in OS keychain with AES-256-GCM encryption
- Provide simple import/export options for records (JSON, CSV, BIND zone files)
- Support three authentication modes: bearer token, global API key + email, or stored keys unlocked with password/passkey
- Native desktop application with no server dependency - fully offline capable
- Cross-platform support: macOS, Windows, Linux
- Platform-native passkey support (Touch ID, Windows Hello, etc.)

Out-of-scope (explicit):

- Cloud/server-based credential synchronization (local-first architecture)
- Multi-user account management (single-user desktop app)
- Web-based hosting or SaaS model
- Real-time collaboration features

## 2. Target users

- System administrators and devops/engineers who manage Cloudflare zones and prefer a native desktop application with OS-level security
- Users who want maximum security via OS keychain storage and passwordless passkey authentication
- Power users who need fast, offline-capable DNS management with import/export and bulk operations
- Privacy-conscious users who prefer local-first applications with no cloud dependency
- Teams requiring audit logs and secure credential management on developer workstations

## 3. System architecture

Better Cloudflare uses a **native desktop application architecture** powered by Tauri 2.0:

### Architecture Overview

```
┌─────────────────────────────────────────────────┐
│         Tauri Desktop Application               │
├─────────────────────────────────────────────────┤
│  Frontend (WebView)                             │
│  ├─ Next.js 16 (Static Export)                  │
│  ├─ React 19                                     │
│  ├─ Radix UI + Tailwind CSS                     │
│  └─ TypeScript                                   │
├─────────────────────────────────────────────────┤
│  IPC Layer (Tauri Commands)                     │
│  ├─ Type-safe invoke() calls                    │
│  └─ Secure message passing                      │
├─────────────────────────────────────────────────┤
│  Backend (Rust)                                  │
│  ├─ Tauri 2.0 Core                              │
│  ├─ Tokio async runtime                         │
│  ├─ Reqwest HTTP client (Cloudflare API)        │
│  ├─ AES-256-GCM encryption (aes-gcm crate)      │
│  ├─ PBKDF2 key derivation (pbkdf2 crate)        │
│  ├─ OS keychain (keyring crate)                 │
│  ├─ WebAuthn passkeys (passkey manager)         │
│  └─ Audit logging                               │
└─────────────────────────────────────────────────┘
           ↓ HTTPS
┌─────────────────────────────────────────────────┐
│      Cloudflare API (api.cloudflare.com)        │
└─────────────────────────────────────────────────┘
```

### Frontend Layer (`src/`, `app/`)

- **Next.js 16**: Static site generation (`output: 'export'`) for Tauri compatibility
- **React 19**: UI components and state management
- **Tauri Client** (`src/lib/tauri-client.ts`): TypeScript wrapper for all Tauri IPC commands
- **UI Components**: Radix UI primitives with Tailwind CSS styling
- **Local Storage**: Browser localStorage for non-sensitive UI state (last selected zone, preferences)

### IPC Communication Layer

- **Tauri Commands**: Registered commands in `src-tauri/src/main.rs` cover all backend operations
- **Type Safety**: TypeScript definitions match Rust command signatures
- **Security**: Commands are registered in Rust and exposed through Tauri IPC
- **Error Handling**: Rust errors are serialized and propagated to frontend

### Backend Layer (`src-tauri/src/`)

**Main Modules:**

1. **`main.rs`**: Tauri app entry point, command registration, app lifecycle management

2. **`commands.rs`** (~350 lines): Command handlers for all IPC operations
   - Authentication: `verify_token`, `store_vault_secret`, `get_vault_secret`, `delete_vault_secret`, `passkey_*`
   - DNS: `get_zones`, `get_dns_records`, `create_dns_record`, `update_dns_record`, `delete_dns_record`
   - Encryption: `get_encryption_settings`, `update_encryption_settings`, `benchmark_encryption`
   - Audit: `get_audit_entries`

3. **`crypto.rs`** (~180 lines): Cryptographic operations
   - AES-256-GCM encryption/decryption
   - PBKDF2-HMAC-SHA256 key derivation (100,000 iterations default)
   - Base64 encoding/decoding
   - Comprehensive error handling

4. **`storage.rs`** (~230 lines): OS keychain integration
   - macOS: Keychain Access
   - Windows: Credential Manager  
   - Linux: Secret Service API
   - Fallback: In-memory storage with encryption
   - Thread-safe access with `Arc<Mutex<>>`

5. **`cloudflare_api.rs`** (~280 lines): Cloudflare API client
   - HTTP client using `reqwest`
   - Zone operations
   - DNS record CRUD
   - Bulk operations
   - Error handling and retries

6. **`passkey.rs`** (~150 lines): WebAuthn passkey manager
   - Challenge generation and validation
   - Credential storage and retrieval
   - Device management
   - Platform authenticator integration

7. **`audit.rs`**: Audit logging for sensitive operations
   - Login attempts
   - Key additions/deletions
   - DNS modifications
   - Passkey registrations

### Key Architectural Decisions

**Why Tauri over Electron:**
- Smaller binary size (~10MB vs ~100MB+)
- Lower memory footprint (uses system webview)
- Native performance (Rust backend)
- Better security model (explicit IPC permissions)
- No Node.js runtime dependency

**Why Rust Backend:**
- Memory safety without garbage collection
- Excellent cryptography ecosystem
- Native OS integration (keychain, system APIs)
- Superior performance for CPU-intensive operations (encryption)
- Strong type system reduces bugs

**Why Static Export (Next.js):**
- Tauri requires static HTML/JS/CSS files
- No server-side rendering needed for desktop app
- Faster initial load times
- Simpler deployment model

## 4. Runtime requirements & build dependencies

### Development Requirements

**Rust Toolchain:**
```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env
rustc --version  # Verify installation
```

**Node.js & NPM:**
- Node 18+ for frontend build tools
- NPM for dependency management

**System Dependencies (Platform-Specific):**

- **macOS**: Xcode Command Line Tools
  ```bash
  xcode-select --install
  ```

- **Linux**: WebKit2GTK, GTK, development libraries
  ```bash
  # Debian/Ubuntu
  sudo apt install libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev \
    libayatana-appindicator3-dev librsvg2-dev
  
  # Fedora
  sudo dnf install webkit2gtk4.1-devel openssl-devel gtk3-devel \
    libappindicator-gtk3-devel librsvg2-devel
  ```

- **Windows**: WebView2 (usually pre-installed on Windows 10/11)
  - Visual Studio Build Tools or MSVC

### Build Configuration

**Tauri Configuration** (`tauri.conf.json`):
- App identifier: `com.better-cloudflare.app`
- Window size: 1280x800 (minimum: 800x600)
- CSP: Strict content security policy
- IPC commands: registered in `src-tauri/src/main.rs` (no separate allowlist in config)

**Cargo Dependencies** (`src-tauri/Cargo.toml`):
```toml
[dependencies]
tauri = { version = "2.0", features = ["devtools"] }
serde = { version = "1.0", features = ["derive"] }
serde_json = "1.0"
tokio = { version = "1", features = ["full"] }
reqwest = { version = "0.11", features = ["json"] }
aes-gcm = "0.10"
pbkdf2 = { version = "0.12", features = ["simple"] }
keyring = "2.3"
base64 = "0.21"
anyhow = "1.0"
thiserror = "1.0"
tracing = "0.1"
tracing-subscriber = "0.3"
```

### Development Commands

```bash
# Install dependencies
npm install

# Run development build (hot reload enabled)
npm run tauri:dev

# Build production binary
npm run tauri:build

# Run Rust tests
cd src-tauri && cargo test

# Run frontend tests
npm test

# Check Rust code
cd src-tauri && cargo check

# Format Rust code
cd src-tauri && cargo fmt

# Lint Rust code
cd src-tauri && cargo clippy
```

### Environment Variables (Development)

**Runtime Configuration** (set in Tauri app context):
- `RUST_LOG`: Set log level (`debug`, `info`, `warn`, `error`)
  ```bash
  RUST_LOG=debug npm run tauri:dev
  ```

**Build Configuration:**
- `TAURI_PRIVATE_KEY`: Code signing key (production builds)
- `TAURI_KEY_PASSWORD`: Key password for signing

### Binary Distribution

**Output Locations:**
- **macOS**: `src-tauri/target/release/bundle/macos/Better Cloudflare.app`
- **Windows**: `src-tauri/target/release/bundle/msi/Better Cloudflare_1.0.0_x64_en-US.msi`
- **Linux**: `src-tauri/target/release/bundle/appimage/better-cloudflare_1.0.0_amd64.AppImage`

**Binary Sizes** (approximate, release mode):
- macOS: ~8-12 MB
- Windows: ~10-15 MB
- Linux: ~12-18 MB

## 5. Pages & UI sections

The application is a single-page UI with two primary screens:

1. Login / Key management (root view when not logged in)

- Key selection dropdown (stored keys)
- Password unlock form
- Add API key dialog (label, key/token, optional email, password for encryption)
- Edit key modal (rename or rotate encryption password)
- Encryption settings & benchmark
  - Passkey management: Register passkeys, manage (list/revoke) registered passkeys per stored key.

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
- The decrypted token is verified via the Tauri `verify_token` command (IPC to Rust), then stored as the current session in storage.
- Logging out clears the session from local storage.

Zone & Record Management

- Zones list is fetched via the `get_zones` Tauri command after login.
- Selecting a zone fetches DNS records via the `get_dns_records` Tauri command.
- Add a new record via the `create_dns_record` Tauri command with client-side validation.
- Update a record via the `update_dns_record` Tauri command.
- Delete a record via the `delete_dns_record` Tauri command.
- Inline record editing with preset TTL choices, custom TTL, and MX priority editing.
- Search & filter operations operate client-side on fetched records.

Import/Export

- Export: Records exported in JSON, CSV, or BIND zone format.
- Import: Accepts JSON array, CSV, or BIND zone file; parsed using `parseCSVRecords` and `parseBINDZone`.
- De-duplication: During import, the UI skips exact duplicates (type + name + content) and counts skipped items.

Encryption configuration & Benchmarking

- Users can change PBKDF2 iteration count, key length, and algorithm via the `EncryptionSettingsDialog`.
- Running a CPU benchmark measures the time to derive a key with the provided iterations (via `lib/crypto-benchmark.ts`).

Optional local server features (web mode)

- Rate limiting via `express-rate-limit`.
- CORS is only relevant for optional local HTTP endpoints; Tauri IPC does not use CORS.
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

Supported record types:

We accept the following DNS record types in the UI and Rust backend (inherited from `RECORD_TYPES`):

- A, AAAA, CNAME, MX, TXT, SRV, NS, PTR, CAA, DS, DNSKEY, NAPTR, SSHFP, TLSA, HINFO, LOC, SPF, RP, DNAME, CERT, SVCB, HTTPS, URI, ALIAS, ANAME

Note: The UI renders proxied controls for records where Cloudflare proxies are meaningful (A/AAAA/CNAME). MX records are offered a `priority` field. More specialized types (e.g., SRV, TLSA) currently accept a `content` string and follow standard Cloudflare handling.
The UI offers specialized inputs for certain record types:

- MX: `priority` input is displayed and required by validation.
- SRV: inputs for `priority`, `weight`, `port` and `target` are shown; the UI composes these into the record `content` string.
- A/AAAA: content must be a valid IPv4/IPv6 address (validated in the Rust backend).

## 9. IPC API specification (Tauri commands)

All communication between frontend and backend uses **Tauri's IPC (Inter-Process Communication)** mechanism via the `invoke()` function. Commands are type-safe and explicitly allowed in `tauri.conf.json`.

### Command Invocation Pattern

```typescript
import { invoke } from '@tauri-apps/api/core';

// Example: Verify token
const ok = await invoke<boolean>('verify_token', {
  apiKey: 'api_token_here',
  email: null
});
```

### Authentication & Credential Commands

#### `verify_token`
- **Purpose**: Verify Cloudflare API token or global key
- **Parameters**: 
  - `apiKey: string` - API token or global key
  - `email: string | null` - Email (required for global key)
- **Returns**: `boolean`
- **Errors**: `Invalid credentials`, `Network error`

#### `get_api_keys`
- **Purpose**: List stored API keys
- **Parameters**: none
- **Returns**: `ApiKey[]`

#### `add_api_key`
- **Purpose**: Store an API key encrypted with the provided password
- **Parameters**:
  - `label: string`
  - `apiKey: string`
  - `email?: string`
  - `password: string`
- **Returns**: `string` (id)

#### `update_api_key`
- **Purpose**: Update stored key metadata or rotate password
- **Parameters**:
  - `id: string`
  - `label?: string`
  - `email?: string`
  - `currentPassword?: string`
  - `newPassword?: string`
- **Returns**: `void`

#### `delete_api_key`
- **Purpose**: Remove a stored key
- **Parameters**: `id: string`
- **Returns**: `void`

#### `decrypt_api_key`
- **Purpose**: Decrypt a stored API key
- **Parameters**:
  - `id: string`
  - `password: string`
- **Returns**: `string` (decrypted API key)

#### `store_vault_secret`
- **Purpose**: Store a transient secret for passkey-based login
- **Parameters**:
  - `id: string`
  - `secret: string`
- **Returns**: `void`

#### `get_vault_secret`
- **Purpose**: Retrieve a vault secret after passkey auth
- **Parameters**:
  - `id: string`
  - `token: string` (required, one-time use)
- **Returns**: `string`

#### `delete_vault_secret`
- **Purpose**: Remove a vault secret
- **Parameters**:
  - `id: string`
- **Returns**: `void`

### Encryption Commands

#### `get_encryption_settings`
- **Purpose**: Read current encryption configuration
- **Parameters**: none
- **Returns**: `{ iterations: number, keyLength: number, algorithm: string }`

#### `update_encryption_settings`
- **Purpose**: Update encryption configuration
- **Parameters**:
  - `config: { iterations: number, keyLength: number, algorithm: string }`
- **Returns**: `void`

#### `benchmark_encryption`
- **Purpose**: Benchmark key derivation performance
- **Parameters**:
  - `iterations: number`
- **Returns**: `number` (duration in ms)

### DNS Management Commands

#### `get_zones`
- **Purpose**: List all Cloudflare zones for authenticated account
- **Parameters**:
  - `apiKey: string` - API token
  - `email: string | null` - Email for global key
- **Returns**: `Zone[]`
  ```typescript
  interface Zone {
    id: string;
    name: string;
    status: string;
    paused: boolean;
    type: string;
    development_mode: number;
  }
  ```

#### `get_dns_records`
- **Purpose**: List DNS records for a zone
- **Parameters**:
  - `apiKey: string` - API token
  - `email: string | null` - Email for global key
  - `zoneId: string` - Zone identifier
- **Returns**: `DnsRecord[]`
  ```typescript
  interface DnsRecord {
    id: string;
    type: string;
    name: string;
    content: string;
    ttl: number;
    priority?: number;
    proxied?: boolean;
    zone_id: string;
    zone_name: string;
    created_on: string;
    modified_on: string;
  }
  ```

#### `create_dns_record`
- **Purpose**: Create new DNS record
- **Parameters**:
  - `apiKey: string` - API token
  - `email: string | null` - Email for global key
  - `zoneId: string` - Zone identifier
  - `record: DnsRecordInput` - Record data
    ```typescript
    interface DnsRecordInput {
      type: string;
      name: string;
      content: string;
      ttl?: number | 'auto';
      priority?: number;
      proxied?: boolean;
    }
    ```
- **Returns**: `DnsRecord` - Created record with ID
- **Validation**: Server-side validation for record type, content format

#### `update_dns_record`
- **Purpose**: Update existing DNS record
- **Parameters**:
  - `apiKey: string`
  - `email: string | null`
  - `zoneId: string`
  - `recordId: string`
  - `record: DnsRecordInput` - Updated record data
- **Returns**: `DnsRecord` - Updated record

#### `delete_dns_record`
- **Purpose**: Delete DNS record
- **Parameters**:
  - `apiKey: string`
  - `email: string | null`
  - `zoneId: string`
  - `recordId: string`
- **Returns**: `void`

#### `create_bulk_dns_records`
- **Purpose**: Create multiple DNS records (batch operation)
- **Parameters**:
  - `apiKey: string`
  - `email: string | null`
  - `zoneId: string`
  - `records: DnsRecordInput[]`
- **Returns**: `{ created: DnsRecord[], skipped: unknown[] }`
  ```typescript
  interface BulkResult {
    created: DnsRecord[];
    skipped: unknown[];
  }
  ```

#### `export_dns_records`
- **Purpose**: Export DNS records for a zone
- **Parameters**:
  - `apiKey: string`
  - `email: string | null`
  - `zoneId: string`
  - `format: "json" | "csv" | "bind"`
  - `page?: number`
  - `per_page?: number`
- **Returns**: `string` (formatted export payload)

### SPF Commands

#### `simulate_spf`
- **Purpose**: Evaluate SPF result for a domain and IP
- **Parameters**:
  - `domain: string`
  - `ip: string`
- **Returns**: `{ result: string; reasons: string[]; lookups: number }`

#### `spf_graph`
- **Purpose**: Build SPF include/redirect graph
- **Parameters**:
  - `domain: string`
- **Returns**: `SPFGraph`
  ```typescript
  interface SPFGraph {
    nodes: Array<{ domain: string; txt?: string | null }>;
    edges: Array<{ from: string; to: string; edge_type: string }>;
    lookups: number;
    cyclic: boolean;
  }
  ```

### Passkey (WebAuthn) Commands

#### `get_passkey_registration_options`
- **Purpose**: Generate WebAuthn registration options
- **Parameters**:
  - `id: string` - User/key identifier
- **Returns**: `{ challenge: string; options: Record<string, unknown> }`

#### `register_passkey`
- **Purpose**: Store passkey credential
- **Parameters**:
  - `id: string` - User/key identifier
  - `attestation: PublicKeyCredential` - Registration response from WebAuthn API
- **Returns**: `void`
- **Storage**: Stored in OS keychain (fallback to in-memory when unavailable)
 - **Verification**: Challenge validation only (attestation verification planned)

#### `get_passkey_auth_options`
- **Purpose**: Generate WebAuthn authentication options
- **Parameters**:
  - `id: string` - User/key identifier
- **Returns**: `{ challenge: string; options: Record<string, unknown> }`

#### `authenticate_passkey`
- **Purpose**: Verify passkey authentication assertion
- **Parameters**:
  - `id: string` - User/key identifier
  - `assertion: PublicKeyCredential` - Authentication response
- **Returns**: `{ success: boolean; token?: string }`
 - **Verification**: Challenge + credential id check only (signature verification planned)

#### `list_passkeys`
- **Purpose**: List registered passkey credentials
- **Parameters**:
  - `id: string` - User/key identifier
- **Returns**: `Array<{ id: string; counter?: number }>`
  ```typescript
  interface PasskeyCredentialSummary {
    id: string;
    counter?: number;
  }
  ```

#### `delete_passkey`
- **Purpose**: Remove passkey credential
- **Parameters**:
  - `id: string` - User/key identifier
  - `credentialId: string` - Credential to remove
- **Returns**: `void`

### Audit & Logging Commands

#### `get_audit_entries`
- **Purpose**: Retrieve audit log entries
- **Parameters**: none
- **Returns**: `AuditLog[]`
  ```typescript
  interface AuditLog {
    timestamp: string;
    operation: string;
    resource?: string;
    [key: string]: unknown;
  }
  ```
- **Logged Events**:
- Key additions/updates/deletions
- Vault store/delete operations
- DNS record create/update/delete/bulk/export
- Passkey register/auth/delete (success/failure)
- Login attempts (password/passkey)
- Auth token verification attempts
- Encryption setting changes
- **Retention**: Last 1000 entries kept
- **Export**: UI supports JSON/CSV download from desktop audit log viewer


### Error Handling

All Tauri commands return errors in a consistent format:

```typescript
try {
  const result = await invoke('command_name', { params });
  // Handle success
} catch (error) {
  // Error is a string message from Rust
  console.error('Command failed:', error);
  toast.error(error as string);
}
```

**Common Error Types:**
- `"Invalid credentials"` - Authentication failed
- `"Network error"` - Cloudflare API unreachable
- `"Not found"` - Resource doesn't exist
- `"Decryption failed"` - Wrong password or corrupted data
- `"OS keychain access denied"` - User denied keychain access
- `"Validation error: <details>"` - Input validation failed

### Frontend Client Wrapper

**TauriClient** (`src/lib/tauri-client.ts`) provides a type-safe wrapper:

```typescript
import { TauriClient } from '@/lib/tauri-client';

// Check if running in Tauri
if (TauriClient.isTauri()) {
  // Desktop app - use Tauri commands
  await TauriClient.verifyToken(token, email);
} else {
  // Web mode - fallback or error
  throw new Error('Desktop app required');
}
```

### Security Considerations

- **Command Allowlist**: Only explicitly allowed commands in `tauri.conf.json` are callable
- **CSP**: Strict Content Security Policy prevents XSS attacks
- **No Dynamic Code**: No `eval()` or dynamic script injection allowed
- **IPC Security**: Messages validated and sanitized on both sides
- **Credential Handling**: Credentials never logged, always cleared from memory after use

## 10. Storage & encryption

### Storage Architecture

Better Cloudflare uses a **two-tier storage model**:

1. **Browser localStorage**: Non-sensitive UI state (web + desktop)
   - Last selected zone
   - UI preferences (theme, language)
   - Current session id
   - Web mode only: encrypted key metadata

2. **OS Keychain**: Sensitive encrypted credentials (desktop)
   - macOS: Keychain Access (via Security framework)
   - Windows: Credential Manager (via Windows Credential API)
   - Linux: Secret Service API (via libsecret/gnome-keyring)

### LocalStorage Schema

**Storage Key**: `cloudflare-dns-manager`

```typescript
interface StorageData {
  // Web mode only: encrypted key metadata stored client-side.
  apiKeys?: ApiKeyMetadata[];
  currentSession?: string;     // Active credential ID
  lastZone?: string;           // Last selected zone ID
  preferences?: {
    theme?: 'light' | 'dark' | 'system';
    language?: string;
  };
}

interface ApiKeyMetadata {
  id: string;                  // Unique identifier
  label: string;               // User-friendly label
  email?: string;              // For global key auth
  createdAt: string;           // ISO timestamp
  encryptionConfig: {
    iterations: number;        // PBKDF2 iterations
    keyLength: number;         // 128, 192, or 256 bits
    algorithm: 'AES-GCM';      // Always AES-GCM
  };
}
```

### OS Keychain Storage

**Service Name**: `better-cloudflare`

**Stored Items**:
- **API Keys**: Stored as a JSON list
  - Key: `api_keys_list`
  - Value: JSON array with encrypted key blobs and metadata
  ```json
  [
    {
      "id": "key_123",
      "label": "Work token",
      "email": "user@example.com",
      "encrypted_key": "base64_ciphertext"
    }
  ]
  ```

- **Vault Secrets**: Transient secrets for passkey login
  - Key: `vault:{id}`
  - Value: decrypted API token

- **Passkey Credentials**: Stored in OS keychain (fallback to in-memory when unavailable)
  - Key: `passkeys:{id}`
  - Value: JSON array of WebAuthn credential metadata

**Fallback Mechanism**:
If OS keychain is unavailable or user denies access:
- In-memory storage (cleared on app close)
- Encrypted with same AES-256-GCM algorithm
- ⚠️ Warning displayed to user about reduced security

### Encryption Specification

**Algorithm**: AES-256-GCM (Galois/Counter Mode)
- Provides both confidentiality and authenticity
- Detects tampering via authentication tag
- Industry-standard AEAD cipher

**Key Derivation**: PBKDF2-HMAC-SHA256
- Default iterations: 100,000
- Configurable: 10,000 - 1,000,000
- Salt: 32 random bytes (256 bits)
- Output key length: 128, 192, or 256 bits

**Encryption Process**:
1. Generate random 256-bit salt
2. Derive encryption key from password + salt using PBKDF2
3. Generate random 96-bit nonce (recommended for GCM)
4. Encrypt plaintext with AES-256-GCM
5. Return: `encrypted || nonce || salt` (all base64-encoded)

**Decryption Process**:
1. Parse salt and nonce from stored data
2. Derive decryption key from password + salt using PBKDF2
3. Decrypt ciphertext with AES-256-GCM
4. Verify authentication tag (automatic in GCM)
5. Return plaintext or error if authentication fails

### Rust Crypto Implementation

**Module**: `src-tauri/src/crypto.rs`

**Dependencies**:
```toml
aes-gcm = "0.10"       # AES-GCM encryption
pbkdf2 = "0.12"        # Key derivation
sha2 = "0.10"          # SHA-256 for PBKDF2
rand = "0.8"           # Cryptographically secure RNG
base64 = "0.21"        # Encoding
```

**Key Functions**:
```rust
// Encrypt data with password
pub fn encrypt(
    data: &str,
    password: &str,
    iterations: u32,
    key_length: usize,
) -> Result<EncryptedData> {
    // 1. Generate salt
    // 2. Derive key with PBKDF2
    // 3. Generate nonce
    // 4. Encrypt with AES-256-GCM
    // 5. Return encrypted + salt + nonce
}

// Decrypt data with password
pub fn decrypt(
    encrypted: &str,
    salt: &str,
    nonce: &str,
    password: &str,
    iterations: u32,
    key_length: usize,
) -> Result<String> {
    // 1. Decode base64
    // 2. Derive key with PBKDF2
    // 3. Decrypt with AES-256-GCM
    // 4. Verify authentication tag
    // 5. Return plaintext
}
```

### Encryption Configuration

**User-Configurable Settings**:
- **Iterations**: Trade-off between security and performance
  - Low (10,000): Fast, less secure
  - Default (100,000): Balanced
  - High (500,000+): Slow, maximum security
  
- **Key Length**: 
  - 128 bits: Fast, sufficient for most use cases
  - 192 bits: Extra security margin
  - 256 bits: Maximum security (default)

**Benchmark Tool**:
Users can run a benchmark to determine optimal iteration count for their hardware:
```typescript
const durationMs = await invoke<number>('benchmark_encryption', {
  iterations: 100000
});
console.log(`Time: ${durationMs}ms`);
```

**Recommendations**:
- Aim for 100-500ms derivation time on user's hardware
- Higher iterations for infrequently accessed keys
- Lower iterations for frequently used keys (with strong passwords)

### Key Rotation

Users can update encryption settings for stored keys:

1. **Password Change**:
   - Decrypt with old password
   - Re-encrypt with new password
   - Update keychain entry
   - Update encryption config (desktop: Rust settings; web: localStorage)

2. **Algorithm Upgrade**:
   - Decrypt with current settings
   - Re-encrypt with new iteration count/key length
   - Update configuration

3. **Bulk Re-encryption**:
   - When changing encryption settings
   - Re-encrypt all stored API keys
   - Show progress indicator

### Security Best Practices

✅ **What We Do**:
- Use OS keychain for sensitive data
- AES-256-GCM for encryption (AEAD)
- Strong key derivation (PBKDF2 with high iterations)
- Random salts and nonces for each encryption
- Credentials never logged or transmitted unencrypted
- Memory cleared after use (Rust's ownership ensures this)
- Authentication tags prevent tampering

✅ **What Users Should Do**:
- Use strong passwords (12+ characters, mixed case, symbols)
- Enable passkey authentication (passwordless)
- Regularly rotate API tokens in Cloudflare dashboard
- Use scoped API tokens (not global keys)
- Keep the app updated
- Don't share encrypted keychain backups

⚠️ **Security Considerations**:
- If OS keychain is compromised, credentials are at risk
- Fallback mode (in-memory) provides no persistence security
- Password strength is critical - weak passwords can be brute-forced
- Physical access to unlocked machine = access to keychain
- Backup keychain exports are encrypted but password-dependent

## 11. Security, privacy and operations

### Security Architecture

**Desktop-First Security Model:**
- No network server required - eliminates entire class of network attacks
- No CORS, no HTTP authentication, no server-side vulnerabilities
- All data stays on user's machine
- OS-level credential protection via keychain
- Tauri's security sandbox prevents unauthorized access

### Threat Model

**Protected Against:**
- ✅ Network interception (no local server, direct HTTPS to Cloudflare)
- ✅ XSS attacks (strict CSP, no dynamic code execution)
- ✅ Credential theft from browser storage (desktop keys live in OS keychain)
- ✅ CSRF attacks (no cookies, no web session)
- ✅ Man-in-the-middle (HTTPS to Cloudflare API only)
- ✅ Tampering (AES-GCM authentication tags)
- ✅ Replay attacks (passkey counters, nonce validation)

**Attack Vectors:**
- ⚠️ Physical access to unlocked machine
- ⚠️ OS compromise (malware with keychain access)
- ⚠️ Weak passwords (mitigated by passkeys)
- ⚠️ Supply chain attacks (mitigated by code signing)
- ⚠️ Social engineering

### Tauri Security Features

**Content Security Policy (CSP)**:
```json
"csp": "default-src 'self'; connect-src 'self' https://api.cloudflare.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'"
```
- Only allows connections to Cloudflare API
- Blocks inline scripts (except inline styles for Tailwind)
- Prevents loading external resources
- WASM allowed for potential future features

**IPC Command Allowlist**:
- Only explicitly listed commands are callable from frontend
- Commands defined in `tauri.conf.json`
- Invalid commands rejected at Tauri core level
- Type-safe invocation enforced

**Webview Isolation**:
- Frontend runs in isolated webview context
- Cannot access filesystem directly
- Cannot spawn processes
- Cannot access system APIs without IPC
- Sandboxed by OS (depends on platform)

### Credential Management

**API Token Storage:**
1. User enters Cloudflare API token + password
2. Token encrypted with AES-256-GCM + PBKDF2
3. Encrypted blob stored in OS keychain
4. Password never stored
5. Token only decrypted when needed
6. Decrypted token cleared from memory after use

**Passkey Storage:**
1. WebAuthn credential generated on device
2. Private key stored in platform authenticator (TPM/Secure Enclave)
3. Public key + metadata stored in OS keychain (fallback to in-memory when unavailable)
4. Challenge-response prevents credential extraction
5. Counter prevents replay attacks

**Session Management:**
- Active session id stored in localStorage (UI state only)
- Decrypted token stays in memory only
- Cleared on logout
- Cleared on app close
- No persistent session tokens
- Re-authentication required on app restart

### Cryptographic Standards

**Encryption:**
- Algorithm: AES-256-GCM (NIST approved, FIPS 140-2)
- Mode: Galois/Counter Mode (AEAD)
- Key derivation: PBKDF2-HMAC-SHA256 (NIST SP 800-132)
- Iterations: 100,000 default (user configurable)
- Salt: 256-bit random (per encryption)
- Nonce: 96-bit random (GCM recommended size)

**Randomness:**
- OS-provided CSPRNG (Cryptographically Secure Pseudo-Random Number Generator)
- Rust `rand` crate with `OsRng`
- Suitable for cryptographic use

**WebAuthn:**
- ES256 (ECDSA with SHA-256)
- Platform authenticator required
- User verification required
- Resident keys supported

### Privacy Guarantees

**No Telemetry:**
- Zero data collection
- No analytics
- No crash reporting (unless explicitly enabled by user)
- No phone-home mechanisms

**Local-First:**
- All data stays on user's device
- No cloud synchronization (by design)
- No server-side storage
- No third-party services (except Cloudflare API)

**Minimal Permissions:**
- Keychain access (for secure storage)
- Network access (Cloudflare API only)
- No file system access (except app data)
- No camera/microphone access
- No location access

### Audit Logging

**Logged Events:**
- Login attempts (success/failure)
- API key additions/deletions
- DNS record modifications (create/update/delete)
- Passkey registrations/authentications
- Encryption setting changes
- Vault access (read/write/delete)

**Log Format:**
```typescript
interface AuditLog {
  timestamp: string;      // ISO 8601
  event_type: string;     // Event category
  user_id: string;        // Key/credential ID
  details: string;        // Human-readable description
  success: boolean;       // Operation result
  ip_address?: string;    // Not applicable (local app)
}
```

**Log Storage:**
- SQLite database in app data directory
- Encrypted at rest (OS-level encryption)
- Rotation: configurable max size/age
- Export: JSON format for external analysis

**Privacy Note**: Logs contain operation metadata but never passwords or decrypted tokens.

### Code Signing

**Purpose:**
- Verify app authenticity
- Prevent tampering
- Establish trust chain
- Required for distribution

**Platform-Specific:**
- **macOS**: Apple Developer certificate, notarization
- **Windows**: Authenticode certificate
- **Linux**: GPG signing (optional)

**Configuration** (in `tauri.conf.json`):
```json
"bundle": {
  "macOS": {
    "signingIdentity": "Developer ID Application: ..."
  },
  "windows": {
    "certificateThumbprint": "...",
    "timestampUrl": "http://timestamp.digicert.com"
  }
}
```

### Security Best Practices for Users

**Strong Authentication:**
- Use passkeys (Touch ID, Windows Hello) instead of passwords
- If using passwords: 12+ characters, mixed case, numbers, symbols
- Enable platform authenticator if available
- Don't reuse passwords from other services

**API Token Hygiene:**
- Use scoped API tokens (not global keys)
- Minimum required permissions only
- Rotate tokens periodically
- Revoke unused tokens in Cloudflare dashboard
- Monitor token usage in Cloudflare audit logs

**Device Security:**
- Keep OS updated
- Use full-disk encryption
- Lock screen when away
- Enable firewall
- Run antivirus/anti-malware

**Backup & Recovery:**
- Export encrypted keychain backups
- Store backups securely (encrypted volume)
- Don't share backup passwords
- Test recovery procedures

### Operational Security

**Development:**
- Dependencies audited with `cargo audit` and `npm audit`
- Static analysis with `cargo clippy`
- Automated security scanning in CI/CD
- Dependabot for automated dependency updates

**Distribution:**
- Signed releases only
- Checksums published (SHA256)
- Release integrity verified in CI/CD
- No pre-built binaries from third parties

**Updates:**
- Automatic update checks (optional)
- Signature verification before applying updates
- Rollback mechanism if update fails
- User control over update timing

## 12. Error handling & logging

### Error Handling Architecture

**Rust Backend:**
- Comprehensive error types using `thiserror` crate
- Errors serialized to strings for IPC transmission
- Detailed error context with `anyhow` for debugging
- No stack traces exposed to frontend (security)

**Error Types:**
```rust
#[derive(Debug, thiserror::Error)]
enum AppError {
    #[error("Invalid credentials")]
    InvalidCredentials,
    
    #[error("Network error: {0}")]
    NetworkError(String),
    
    #[error("Encryption failed: {0}")]
    EncryptionError(String),
    
    #[error("Decryption failed: {0}")]
    DecryptionError(String),
    
    #[error("OS keychain error: {0}")]
    KeychainError(String),
    
    #[error("Validation error: {0}")]
    ValidationError(String),
    
    #[error("Not found")]
    NotFound,
}
```

**Frontend:**
- Try-catch blocks around all `invoke()` calls
- Error messages displayed via toast notifications
- User-friendly error descriptions
- Technical details in console (development mode)
- Retry mechanisms for transient failures

### Error Handling Patterns

**Authentication Errors:**
```typescript
try {
  await TauriClient.verifyToken(token, email);
  toast.success('Authentication successful');
} catch (error) {
  if (error === 'Invalid credentials') {
    toast.error('Invalid Cloudflare API token. Please check your credentials.');
  } else if (error.includes('Network error')) {
    toast.error('Cannot reach Cloudflare API. Check your internet connection.');
  } else {
    toast.error('Authentication failed: ' + error);
  }
}
```

**Encryption Errors:**
```typescript
try {
  await invoke('decrypt_api_key', { id: 'key_id', password });
} catch (error) {
  if (error.includes('Invalid password')) {
    toast.error('Incorrect password');
  } else if (error.includes('Decryption failed')) {
    toast.error('Data corrupted or wrong password');
  } else {
    toast.error('Decryption error: ' + error);
  }
}
```

**Network Errors:**
- Automatic retry with exponential backoff (3 attempts)
- Timeout after 30 seconds
- Offline detection
- User notification with retry option

**Validation Errors:**
- Client-side validation before IPC call
- Server-side validation in Rust
- Detailed field-level errors
- Inline error display in forms

### Logging System

**Rust Backend Logging:**

**Framework**: `tracing` + `tracing-subscriber`

**Log Levels:**
- `TRACE`: Detailed debugging (IPC messages, crypto operations)
- `DEBUG`: General debugging (function calls, state changes)
- `INFO`: Important events (login, DNS operations)
- `WARN`: Recoverable errors (network timeouts, retries)
- `ERROR`: Unrecoverable errors (panics, critical failures)

**Configuration:**
```bash
# Development: verbose logging
RUST_LOG=debug npm run tauri:dev

# Production: errors only
RUST_LOG=error npm run tauri:build

# Module-specific
RUST_LOG=better_cloudflare::crypto=trace,better_cloudflare=info
```

**Log Output:**
- Development: Console (stdout/stderr)
- Production: Log file in app data directory
  - macOS: `~/Library/Logs/com.better-cloudflare.app/`
  - Windows: `%APPDATA%\com.better-cloudflare.app\logs\`
  - Linux: `~/.local/share/com.better-cloudflare.app/logs/`

**Log Rotation:**
- Max file size: 10 MB
- Max files: 5
- Automatic rotation
- Compressed old logs

**Frontend Logging:**

**Console Logging:**
```typescript
// Development mode
if (import.meta.env.DEV) {
  console.log('Debug info:', data);
}

// Production: errors only
console.error('Critical error:', error);
```

**Error Tracking** (optional):
- Integration point for Sentry/similar
- Opt-in only (respects privacy)
- Strips sensitive data (passwords, tokens)
- Includes stack traces

### User-Facing Error Messages

**Principles:**
- Clear and actionable
- Non-technical language
- Suggest solutions
- Provide context
- Never expose sensitive data

**Examples:**

✅ **Good:**
- "Cannot reach Cloudflare API. Check your internet connection."
- "Incorrect password. Please try again."
- "DNS record validation failed: Invalid IP address format."

❌ **Bad:**
- "Error: NetworkError(reqwest::Error)"
- "Decryption failed: InvalidTag"
- "panic at src/crypto.rs:42"

### Debug Mode

**Activation:**
```bash
RUST_LOG=debug npm run tauri:dev
```

**Debug Features:**
- Verbose IPC logging (all commands and parameters)
- Crypto operation timing
- Network request/response details
- State transitions
- Performance metrics

**Debug UI** (development only):
- Command palette with DevTools toggle
- In-app log viewer
- State inspector
- Network monitor

### Error Recovery

**Automatic Recovery:**
- Network errors: retry with backoff
- Transient keychain errors: retry once
- Cloudflare rate limits: respect Retry-After header

**Manual Recovery:**
- App restart: clears corrupted in-memory state
- Cache clear: removes corrupted localStorage
- Keychain repair: delete + re-add credentials

**Graceful Degradation:**
- OS keychain unavailable → in-memory storage (with warning)
- Network offline → display last-known state (read-only)
- Invalid credentials → prompt for re-authentication

## 13. Performance & benchmarks

- Client-side operations are fast for common tasks. Bulk importing a large zone may be limited by memory.
- `CryptoManager` provides a benchmarking utility to measure PBKDF2 cost at the user hardware/iterations combination.
- Default PBKDF2 iterations are 100,000; lower values may be chosen to reduce UI latency, and higher values to increase security.

Notes:

- The iteration count should balance security and performance; the benchmark shows ms to derive a key with the chosen iteration count.
- For large record sets and long lists, the app could benefit from incremental loading (pagination) but currently loads the entire zone.

## 14. Testing & QA

### Testing Strategy

**Multi-Layer Testing:**
1. **Rust Unit Tests**: Backend logic
2. **Rust Integration Tests**: Tauri commands
3. **TypeScript Unit Tests**: Frontend components
4. **E2E Tests**: Full user workflows
5. **Manual Testing**: Platform-specific behavior

### Rust Backend Tests

**Unit Tests** (`src-tauri/src/`):

**Crypto Module Tests:**
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_roundtrip() {
        let data = "secret token";
        let password = "strong_password";
        
        let encrypted = encrypt(data, password, 100000, 256).unwrap();
        let decrypted = decrypt(
            &encrypted.encrypted,
            &encrypted.salt,
            &encrypted.nonce,
            password,
            100000,
            256,
        ).unwrap();
        
        assert_eq!(data, decrypted);
    }

    #[test]
    fn test_wrong_password_fails() {
        let encrypted = encrypt("data", "password1", 100000, 256).unwrap();
        let result = decrypt(
            &encrypted.encrypted,
            &encrypted.salt,
            &encrypted.nonce,
            "password2",  // Wrong password
            100000,
            256,
        );
        
        assert!(result.is_err());
    }
}
```

**Run Tests:**
```bash
cd src-tauri
cargo test                    # All tests
cargo test crypto::tests      # Specific module
cargo test -- --nocapture     # With output
cargo test --release          # Optimized
```

**Test Coverage:**
```bash
# Install tarpaulin
cargo install cargo-tarpaulin

# Generate coverage report
cargo tarpaulin --out Html --output-dir coverage
```

**Target Coverage:**
- Crypto module: >95%
- Storage module: >85%
- Cloudflare API client: >80%
- Command handlers: >75%
- Overall: >80%

### Frontend Tests

**Unit Tests** (tsx + React Testing Library):

**Component Tests:**
```typescript
import { render, screen, fireEvent } from '@testing-library/react';
import { LoginForm } from '@/components/auth/LoginForm';

describe('LoginForm', () => {
  it('renders login form', () => {
    render(<LoginForm />);
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('validates empty password', async () => {
    render(<LoginForm />);
    const button = screen.getByRole('button', { name: 'Login' });
    fireEvent.click(button);
    
    expect(await screen.findByText('Password required')).toBeInTheDocument();
  });
});
```

**Mock Tauri Commands:**
```typescript
import { mockIPC } from '@tauri-apps/api/mocks';

beforeEach(() => {
  mockIPC((cmd, args) => {
    if (cmd === 'verify_token') {
      return Promise.resolve(true);
    }
    if (cmd === 'get_zones') {
      return Promise.resolve([
        { id: 'zone1', name: 'example.com', status: 'active' }
      ]);
    }
  });
});
```

**Run Tests:**
```bash
npm test                 # All tests
npm test -- LoginForm    # Specific file
npm test -- --coverage   # With coverage
npm test -- --watch      # Watch mode
```

### Integration Tests

**Tauri Command Integration:**
```rust
#[cfg(test)]
mod integration_tests {
    use tauri::test::*;

    #[test]
    fn test_benchmark_encryption_command() {
        let app = tauri::test::mock_app();
        
        let duration = app.invoke(
            "benchmark_encryption",
            json!({ "iterations": 10000 })
        ).unwrap();
        
        assert!(duration > 0.0);
    }
}
```

### E2E Tests (Playwright)

**Configuration** (`playwright.config.ts`):
```typescript
export default defineConfig({
  testDir: './e2e',
  use: {
    baseURL: 'tauri://localhost',  // Tauri app URL
  },
  projects: [
    { name: 'macos', use: { platform: 'darwin' } },
    { name: 'windows', use: { platform: 'win32' } },
    { name: 'linux', use: { platform: 'linux' } },
  ],
});
```

**Test Examples:**
```typescript
test('complete login flow', async ({ page }) => {
  // Launch Tauri app
  await page.goto('tauri://localhost');
  
  // Add API key
  await page.click('[data-testid="add-key-button"]');
  await page.fill('[name="label"]', 'Test Key');
  await page.fill('[name="token"]', 'test_token');
  await page.fill('[name="password"]', 'test_pass');
  await page.click('[data-testid="save-key"]');
  
  // Login
  await page.selectOption('[name="keyId"]', 'test-key-id');
  await page.fill('[name="password"]', 'test_pass');
  await page.click('[data-testid="login-button"]');
  
  // Verify DNS manager visible
  await expect(page.locator('[data-testid="dns-manager"]')).toBeVisible();
});

test('DNS record CRUD', async ({ page }) => {
  await loginHelper(page);
  
  // Select zone
  await page.selectOption('[name="zone"]', 'zone-id');
  
  // Create record
  await page.click('[data-testid="add-record"]');
  await page.selectOption('[name="type"]', 'A');
  await page.fill('[name="name"]', 'test');
  await page.fill('[name="content"]', '1.2.3.4');
  await page.click('[data-testid="save-record"]');
  
  // Verify record created
  await expect(page.locator('text=test.example.com')).toBeVisible();
});
```

**Run E2E Tests:**
```bash
npm run test:e2e              # All tests
npm run test:e2e -- --headed  # With UI
npm run test:e2e -- --debug   # Debug mode
```

### Manual Testing Checklist

**Per Platform (macOS, Windows, Linux):**

☐ **Installation**
- [ ] Clean install
- [ ] Upgrade from previous version
- [ ] Uninstall
- [ ] App appears in launcher
- [ ] File associations work

☐ **Authentication**
- [ ] Add API key (token)
- [ ] Add API key (global key + email)
- [ ] Login with password
- [ ] Login with passkey
- [ ] Wrong password error
- [ ] Invalid token error
- [ ] Logout clears session

☐ **OS Keychain**
- [ ] Credentials stored in keychain
- [ ] Credentials retrieved on login
- [ ] Keychain permission prompt (first time)
- [ ] Fallback to memory when keychain denied
- [ ] Multiple keys stored/retrieved

☐ **Passkeys**
- [ ] Register passkey (platform authenticator)
- [ ] Authenticate with passkey
- [ ] Multiple passkeys per key
- [ ] Rename passkey
- [ ] Delete passkey
- [ ] Touch ID works (macOS)
- [ ] Windows Hello works (Windows)

☐ **DNS Management**
- [ ] List zones
- [ ] Select zone
- [ ] List records
- [ ] Filter records by type
- [ ] Search records
- [ ] Create record (all types)
- [ ] Update record
- [ ] Delete record
- [ ] Bulk import (JSON/CSV/BIND)
- [ ] Export (all formats)

☐ **Performance**
- [ ] App startup < 2s
- [ ] Login < 1s (after decryption)
- [ ] Zone load < 3s
- [ ] Record CRUD < 500ms
- [ ] UI responsive
- [ ] No memory leaks (check after 1hr use)

☐ **Error Handling**
- [ ] Network offline handling
- [ ] Cloudflare API errors displayed
- [ ] Invalid input validation
- [ ] Encryption errors handled
- [ ] App doesn't crash on any error

### CI/CD Pipeline

**GitHub Actions** (`.github/workflows/test.yml`):

```yaml
name: Test

on: [push, pull_request]

jobs:
  test-rust:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v3
      - uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
      - name: Run Rust tests
        run: cd src-tauri && cargo test --verbose
      - name: Run Clippy
        run: cd src-tauri && cargo clippy -- -D warnings

  test-frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      - run: npm install
      - run: npm test
      - run: npm run lint

  test-e2e:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    steps:
      - uses: actions/checkout@v3
      - name: Install dependencies
        run: npm install
      - name: Run E2E tests
        run: npm run test:e2e
```

### Performance Benchmarks

**Rust Benchmarks** (using `criterion`):
```rust
use criterion::{black_box, criterion_group, criterion_main, Criterion};

fn benchmark_encryption(c: &mut Criterion) {
    c.bench_function("encrypt 1KB", |b| {
        b.iter(|| {
            encrypt(
                black_box(&"x".repeat(1024)),
                black_box("password"),
                100000,
                256,
            )
        });
    });
}

criterion_group!(benches, benchmark_encryption);
criterion_main!(benches);
```

**Run Benchmarks:**
```bash
cd src-tauri
cargo bench
```

**Target Metrics:**
- Encryption (1KB): < 100ms
- Decryption (1KB): < 100ms
- PBKDF2 (100k iterations): 50-200ms
- Zone list API call: < 2s
- Record CRUD: < 500ms

## 15. Accessibility & UX considerations

- Use of semantic HTML and accessible form controls (Select, Input, Buttons); dialogs use accessible patterns.
- Keyboard shortcuts: pressing Enter on password field triggers login; modals respect standard controls.
- Suggest improvements: ARIA labels for custom components, focus trap for dialogs, form error messaging focused for keyboard-only users.

## 16. Internationalization & configuration

- The codebase does not include i18n currently; UI strings are in plain text and would need extraction for i18n.
- Theme configuration uses Tailwind and CSS variables in `index.css`; theming is possible by adjusting classes and CSS variables.

## 17. Extensibility & integration points

### Rust Backend Extension Points

**Adding New Tauri Commands:**
1. Define command handler in `src-tauri/src/commands.rs`:
   ```rust
   #[tauri::command]
   pub async fn my_new_command(param: String) -> Result<String, String> {
       // Implementation
       Ok("result".to_string())
   }
   ```

2. Register command in `src-tauri/src/main.rs`:
   ```rust
   tauri::Builder::default()
       .invoke_handler(tauri::generate_handler![
           // ... existing commands
           my_new_command,
       ])
   ```

3. Add TypeScript wrapper in `src/lib/tauri-client.ts`:
   ```typescript
   async myNewCommand(param: string): Promise<string> {
       return await invoke('my_new_command', { param });
   }
   ```

**Cloudflare API Extensions:**
- `cloudflare_api.rs` provides the foundation for additional Cloudflare operations
- Natural place to add: Page Rules, Workers, Firewall Rules, SSL/TLS settings
- Follow existing pattern: async methods with `reqwest` HTTP client
- Add corresponding Tauri commands in `commands.rs`

**Storage Backends:**
- `storage.rs` abstracts OS keychain access
- Easy to add: SQLite backend, cloud storage, encrypted file storage
- Trait-based design allows pluggable implementations
- Tests use mock storage for isolation

**Crypto Implementations:**
- `crypto.rs` provides AES-256-GCM encryption
- Can add: other ciphers (ChaCha20-Poly1305), key derivation algorithms
- Modular design allows swapping implementations
- Benchmark utilities help compare performance

**Frontend Customization:**
- React components in `src/components/` are composable
- UI primitives in `src/components/ui/` follow Radix UI patterns
- Theming via Tailwind CSS classes and CSS variables
- Easy to add custom themes, layouts, or workflows

### Integration Opportunities

**CLI Tool Integration:**
- Rust backend code can be reused for CLI tool
- Share crypto, storage, and API client modules
- Provide headless mode for automation
- Example: `better-cloudflare-cli record create ...`

**Plugin System (Future):**
- Tauri supports plugin architecture
- Could allow: custom record types, third-party DNS providers, validation rules
- Plugins would be Rust crates or JS modules
- Security: plugins run in sandbox, explicit permissions required

**External Tool Integration:**
- Export audit logs → SIEM systems
- Import records from → Terraform, Pulumi, other IaC tools
- Webhook support → notify external services on DNS changes
- API: expose subset of functionality via local HTTP server (optional)

### Testing & Development Extensions

**Mock Implementations:**
- `storage.rs` includes in-memory mock for testing
- Easy to add mock Cloudflare API responses
- Tauri provides `mock_app()` for command testing
- Frontend can use `mockIPC()` for component tests

**Development Tools:**
- Tauri DevTools accessible in dev mode
- Rust debugging with `lldb` or `gdb`
- Frontend debugging with Chrome DevTools
- Performance profiling with `cargo flamegraph`

### Suggested Extensions (Roadmap)

**High Priority:**
- Bulk operations with progress tracking
- Paginated record loading for large zones
- Advanced search with regex and filters
- Export templates and scheduled backups
- Enhanced audit log viewer with filtering

**Medium Priority:**
- Additional Cloudflare API features (Workers, Page Rules)
- CLI companion tool for automation
- Plugin system for custom workflows
- Webhook notifications for DNS changes
- Multi-zone operations (bulk changes across zones)

**Low Priority:**
- Cloud sync with end-to-end encryption (opt-in)
- Custom validation rules engine
- DNS analytics and insights
- Cost tracking and optimization suggestions
- Integration with infrastructure-as-code tools

## 18. Distribution & deployment

### Build Process

**Development Build:**
```bash
npm run tauri:dev
```
- Fast compilation
- Hot reload enabled
- DevTools available
- Debug logging enabled
- Unoptimized binary

**Production Build:**
```bash
npm run tauri:build
```
- Optimized compilation (--release)
- Minified frontend assets
- Tree-shaking enabled
- Debug symbols stripped
- Code signed (if configured)

### Platform-Specific Builds

**macOS:**

**Artifacts:**
- `.app` bundle: `src-tauri/target/release/bundle/macos/Better Cloudflare.app`
- `.dmg` installer: `src-tauri/target/release/bundle/dmg/Better Cloudflare_1.0.0_x64.dmg`

**Requirements:**
- macOS 10.15+ (Catalina or later)
- Apple Developer ID certificate (for distribution)
- Notarization (required for macOS 10.15+)

**Code Signing:**
```bash
# Configure in tauri.conf.json
"macOS": {
  "signingIdentity": "Developer ID Application: Your Name (TEAM_ID)",
  "entitlements": "app.entitlements"
}

# Build signed
npm run tauri:build

# Notarize
xcrun notarytool submit "Better Cloudflare.dmg" \
  --apple-id your@email.com \
  --team-id TEAM_ID \
  --password app-specific-password

# Staple notarization ticket
xcrun stapler staple "Better Cloudflare.dmg"
```

**Distribution:**
- Direct download (DMG)
- Homebrew Cask (optional)
- Mac App Store (requires additional review)

**Windows:**

**Artifacts:**
- `.msi` installer: `src-tauri/target/release/bundle/msi/Better Cloudflare_1.0.0_x64_en-US.msi`
- `.exe` portable: `src-tauri/target/release/Better Cloudflare.exe`

**Requirements:**
- Windows 10 1809+ or Windows 11
- WebView2 runtime (pre-installed on Windows 11)
- Code signing certificate (for SmartScreen trust)

**Code Signing:**
```bash
# Configure in tauri.conf.json
"windows": {
  "certificateThumbprint": "YOUR_CERT_THUMBPRINT",
  "timestampUrl": "http://timestamp.digicert.com"
}

# Build signed
npm run tauri:build
```

**Distribution:**
- Direct download (MSI)
- Chocolatey package (optional)
- Microsoft Store (requires additional review)
- WinGet package (optional)

**Linux:**

**Artifacts:**
- `.AppImage`: `src-tauri/target/release/bundle/appimage/better-cloudflare_1.0.0_amd64.AppImage`
- `.deb`: `src-tauri/target/release/bundle/deb/better-cloudflare_1.0.0_amd64.deb`
- `.rpm`: `src-tauri/target/release/bundle/rpm/better-cloudflare-1.0.0-1.x86_64.rpm`

**Requirements:**
- Ubuntu 20.04+ / Debian 11+ / Fedora 36+
- WebKit2GTK 4.1
- GTK 3.24+

**Distribution:**
- Direct download (AppImage - universal)
- APT repository (Debian/Ubuntu)
- RPM repository (Fedora/RHEL)
- Flathub (optional)
- Snap Store (optional)

### Release Process

**1. Version Bump:**
```bash
# Update version in:
# - package.json
# - src-tauri/Cargo.toml
# - tauri.conf.json

npm version 1.1.0
git tag v1.1.0
```

**2. Build All Platforms:**
```bash
# macOS
npm run tauri:build

# Windows (on Windows machine)
npm run tauri:build

# Linux (on Linux machine)
npm run tauri:build
```

**3. Generate Checksums:**
```bash
# macOS/Linux
shasum -a 256 *.dmg *.AppImage *.deb > SHA256SUMS

# Windows
CertUtil -hashfile "Better Cloudflare.msi" SHA256
```

**4. Create GitHub Release:**
```bash
gh release create v1.1.0 \
  --title "v1.1.0 - Feature Release" \
  --notes-file CHANGELOG.md \
  *.dmg *.msi *.AppImage *.deb *.rpm SHA256SUMS
```

**5. Update Distribution Channels:**
- Homebrew Cask: Submit PR to homebrew-cask
- Chocolatey: Update package metadata
- AUR: Update PKGBUILD
- Flathub: Update manifest

### Auto-Update System

**Configuration** (in `tauri.conf.json`):
```json
"updater": {
  "active": true,
  "endpoints": [
    "https://releases.better-cloudflare.com/{{target}}/{{current_version}}"
  ],
  "dialog": true,
  "pubkey": "YOUR_TAURI_PUBLIC_KEY"
}
```

**Update Server Response:**
```json
{
  "version": "1.1.0",
  "notes": "Bug fixes and improvements",
  "pub_date": "2026-01-23T00:00:00Z",
  "platforms": {
    "darwin-x86_64": {
      "signature": "...",
      "url": "https://releases.../Better-Cloudflare-1.1.0.app.tar.gz"
    },
    "windows-x86_64": {
      "signature": "...",
      "url": "https://releases.../Better-Cloudflare-1.1.0.msi.zip"
    },
    "linux-x86_64": {
      "signature": "...",
      "url": "https://releases.../Better-Cloudflare-1.1.0.AppImage.tar.gz"
    }
  }
}
```

**Update Flow:**
1. App checks for updates on startup (configurable)
2. If update available, show dialog
3. User confirms update
4. Download update in background
5. Verify signature
6. Install and restart

### CI/CD Automation

**GitHub Actions** (`.github/workflows/release.yml`):
```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  build-and-release:
    strategy:
      matrix:
        platform: [macos-latest, ubuntu-latest, windows-latest]
    runs-on: ${{ matrix.platform }}
    
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Rust
        uses: actions-rs/toolchain@v1
        with:
          toolchain: stable
      
      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: 18
      
      - name: Install dependencies (Linux)
        if: matrix.platform == 'ubuntu-latest'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev
      
      - name: Install Node dependencies
        run: npm install
      
      - name: Build Tauri app
        run: npm run tauri:build
        env:
          TAURI_PRIVATE_KEY: ${{ secrets.TAURI_PRIVATE_KEY }}
          TAURI_KEY_PASSWORD: ${{ secrets.TAURI_KEY_PASSWORD }}
      
      - name: Upload artifacts
        uses: actions/upload-artifact@v3
        with:
          name: ${{ matrix.platform }}
          path: src-tauri/target/release/bundle/**/*
      
      - name: Create Release
        uses: softprops/action-gh-release@v1
        if: startsWith(github.ref, 'refs/tags/')
        with:
          files: |
            src-tauri/target/release/bundle/**/*.dmg
            src-tauri/target/release/bundle/**/*.msi
            src-tauri/target/release/bundle/**/*.AppImage
            src-tauri/target/release/bundle/**/*.deb
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### Installation Instructions

**macOS:**
```bash
# Option 1: Direct download
# Download Better-Cloudflare-1.0.0.dmg from releases
# Open DMG, drag app to Applications

# Option 2: Homebrew
brew install --cask better-cloudflare
```

**Windows:**
```powershell
# Option 1: Direct download
# Download Better-Cloudflare-1.0.0.msi from releases
# Run installer

# Option 2: Chocolatey
choco install better-cloudflare

# Option 3: WinGet
winget install BetterCloudflare.BetterCloudflare
```

**Linux:**
```bash
# Option 1: AppImage (universal)
chmod +x Better-Cloudflare-1.0.0.AppImage
./Better-Cloudflare-1.0.0.AppImage

# Option 2: Debian/Ubuntu
sudo dpkg -i better-cloudflare_1.0.0_amd64.deb

# Option 3: Fedora/RHEL
sudo rpm -i better-cloudflare-1.0.0-1.x86_64.rpm

# Option 4: Arch Linux (AUR)
yay -S better-cloudflare
```

### Uninstallation

**macOS:**
```bash
# Remove app
rm -rf "/Applications/Better Cloudflare.app"

# Remove app data
rm -rf "~/Library/Application Support/com.better-cloudflare.app"
rm -rf "~/Library/Logs/com.better-cloudflare.app"

# Remove keychain entries (manual in Keychain Access)
```

**Windows:**
```powershell
# Use Add/Remove Programs or
msiexec /x {PRODUCT_GUID}

# Remove app data
Remove-Item -Recurse "$env:APPDATA\com.better-cloudflare.app"

# Remove credentials (manual in Credential Manager)
```

**Linux:**
```bash
# Debian/Ubuntu
sudo apt remove better-cloudflare

# Fedora/RHEL
sudo rpm -e better-cloudflare

# Remove app data
rm -rf "~/.local/share/com.better-cloudflare.app"
rm -rf "~/.config/com.better-cloudflare.app"
```

## 19. Known limitations & future work

### Current Limitations

**Platform-Specific:**
- **macOS**: Requires macOS 10.15+ (Catalina or later)
- **Windows**: Requires Windows 10 1809+ or Windows 11
- **Linux**: Requires modern desktop environment (GNOME, KDE, etc.)
- **Mobile**: No iOS/Android support (desktop only)

**Functionality:**
- **Single Device**: No credential sync across devices (by design - security)
- **Local Only**: Requires local installation, cannot run in browser
- **Large Zones**: May be slow with 10,000+ records (pagination planned)
- **Real-time Updates**: No live refresh of DNS changes (manual refresh required)
- **Collaboration**: Single-user app, no multi-user features

**API Coverage:**
- DNS records only - no support for:
  - Page Rules
  - Workers
  - Firewall Rules
  - SSL/TLS settings
  - Analytics
  - (These are out of scope for this DNS-focused app)

**Technical:**
- **Webview Limitations**: Uses system webview (may vary by OS)
- **Passkey Storage**: Credentials tied to device, not portable
- **Offline Mode**: Read-only when offline (cannot create/update records)

### Future Enhancements

**High Priority:**

1. **Record Pagination & Virtualization**
   - Handle zones with 10,000+ records
   - Virtual scrolling for large lists
   - Lazy loading with infinite scroll
   - Server-side filtering and search

2. **Advanced Import/Export**
   - Import from other DNS providers (AWS Route53, Cloudflare bulk format)
   - Export templates
   - Scheduled exports (backup automation)
   - Import preview with conflict resolution

3. **Bulk Operations UI**
   - Multi-select records
   - Batch edit (TTL, proxy status)
   - Batch delete with confirmation
   - Progress indicators for large operations

4. **Enhanced Audit Logging**
   - Searchable audit log UI
   - Export audit logs (JSON, CSV)
   - Retention policies
   - Event filtering

5. **Accessibility Improvements**
   - Full keyboard navigation
   - Screen reader optimization
   - High contrast theme
   - Font size scaling
   - ARIA labels on all interactive elements

**Medium Priority:**

6. **Advanced DNS Features**
   - DNSSEC management
   - Zone templates
   - Record validation (SPF checker, DMARC validator)
   - DNS propagation checker
   - TTL recommendations

7. **Improved Search & Filtering**
   - Regex search
   - Advanced filters (date range, TTL range)
   - Saved filters
   - Quick filters (proxied only, recently modified)

8. **Theme Customization**
   - Multiple built-in themes
   - Custom color schemes
   - Light/dark mode toggle
   - System theme sync

9. **Internationalization (i18n)**
   - Multi-language support
   - RTL language support
   - Locale-specific date/time formats

10. **CLI Companion Tool**
    - Headless CLI for automation
    - Scriptable operations
    - CI/CD integration
    - Batch processing

**Low Priority:**

11. **Cloud Sync (Optional)**
    - End-to-end encrypted sync
    - Conflict resolution
    - Selective sync
    - Must remain opt-in (privacy first)

12. **Plugin System**
    - Custom record types
    - Third-party integrations
    - Custom validation rules
    - Extension marketplace

13. **Advanced Passkey Features**
    - Passkey backup/recovery
    - Cross-device passkey sharing (via iCloud Keychain, etc.)
    - FIDO2 security key support
    - Biometric fallback options

14. **Notification System**
    - Desktop notifications for important events
    - Update notifications
    - Scheduled task reminders
    - DNS propagation alerts

### Considered but Not Planned

**Web Version:**
- Desktop-only by design for maximum security
- Web version would require server infrastructure
- Conflicts with local-first philosophy

**Mobile Apps:**
- DNS management typically done on desktop
- Mobile browser support sufficient for quick changes
- Cloudflare official app exists for mobile

**Multi-User / Team Features:**
- Out of scope for single-user local app
- Would require server infrastructure
- Enterprise users should use Cloudflare Teams

### Community Contributions Welcome

We welcome contributions in the following areas:
- Bug fixes and performance improvements
- New DNS record type support
- UI/UX enhancements
- Documentation improvements
- Translations (i18n)
- Test coverage improvements
- Accessibility enhancements

See `CONTRIBUTING.md` for guidelines.

## Appendix: Useful References and File Locations

**Rust Backend:**
- Entry point: `src-tauri/src/main.rs`
- Command handlers: `src-tauri/src/commands.rs`
- Crypto module: `src-tauri/src/crypto.rs`
- Storage module: `src-tauri/src/storage.rs`
- Cloudflare API client: `src-tauri/src/cloudflare_api.rs`
- Passkey manager: `src-tauri/src/passkey.rs`
- Audit logging: `src-tauri/src/audit.rs`
- Configuration: `src-tauri/tauri.conf.json`
- Dependencies: `src-tauri/Cargo.toml`

**Frontend:**
- Entry: `src/main.tsx`, `app/page.tsx`
- Auth components: `src/components/auth/*`
- DNS components: `src/components/dns/*`
- UI primitives: `src/components/ui/*`
- Tauri client: `src/lib/tauri-client.ts`
- Storage & crypto: `src/lib/storage.ts`, `src/lib/crypto.ts` (web mode legacy)
- Validation: `src/lib/validation.ts`
- Types: `src/types/*`

**Tests:**
- Rust tests: `src-tauri/src/**/tests.rs`, `src-tauri/tests/**`
- Frontend tests: `test/*`
- E2E tests: `e2e/*`

**Documentation:**
- Main README: `README.md`
- Desktop README: `README-TAURI.md`
- Migration guide: `docs/tauri-migration.md`
- TODO list: `TODO-TAURI-MIGRATION.md`
- Spec: `spec.md`

## Examples — Tauri IPC & UI Flows

### IPC Command Examples (Tauri)

**Verify Token:**
```typescript
import { invoke } from '@tauri-apps/api/core';

try {
  const ok = await invoke<boolean>('verify_token', {
    apiKey: 'cf_api_token_here',
    email: null  // null for API token, email for global key
  });
  console.log('Token valid:', ok);
} catch (error) {
  console.error('Verification failed:', error);
}
```

**List Zones:**
```typescript
const zones = await invoke<Zone[]>('get_zones', {
  apiKey: currentToken,
  email: null
});

console.log('Zones:', zones);
// [{ id: "zone_id", name: "example.com", status: "active", ... }]
```

**Get DNS Records:**
```typescript
const records = await invoke<DnsRecord[]>('get_dns_records', {
  apiKey: currentToken,
  email: null,
  zoneId: selectedZoneId
});

console.log('Records:', records);
// [{ id: "rec_id", type: "A", name: "www", content: "1.2.3.4", ... }]
```

**Create DNS Record:**
```typescript
const newRecord = await invoke<DnsRecord>('create_dns_record', {
  apiKey: currentToken,
  email: null,
  zoneId: selectedZoneId,
  record: {
    type: 'A',
    name: 'test',
    content: '1.2.3.4',
    ttl: 300,
    proxied: false
  }
});

console.log('Created:', newRecord);
```

**Store/Decrypt API Key:**
```typescript
// Store a key (encrypted in Rust with the provided password)
const keyId = await invoke<string>('add_api_key', {
  label: 'My token',
  apiKey: 'my_api_token',
  email: null,
  password: 'user_password'
});

// Later: decrypt the stored key
const decrypted = await invoke<string>('decrypt_api_key', {
  id: keyId,
  password: 'user_password'
});

console.log('Decrypted token:', decrypted);
```

**Passkey Registration:**
```typescript
// Get registration options
const options = await invoke<PasskeyRegisterOptions>(
  'get_passkey_registration_options',
  { id: 'user_key_1' }
);

// Use WebAuthn API to create credential
const credential = await navigator.credentials.create({
  publicKey: (options as any).options ?? options
});

// Register credential with backend
await invoke('register_passkey', {
  id: 'user_key_1',
  attestation: credential
});
```

### Common UI Flows (Desktop App)

**Add and Encrypt Key:**
1. User clicks "Add API Key" button in `LoginForm`
2. `AddKeyDialog` opens
3. User fills: label, API token, optional email, encryption password
4. On save:
   - Frontend validates token via `invoke('verify_token', ...)`
   - If valid, frontend stores the key via `invoke('add_api_key', ...)`
   - Stored key metadata is returned from the backend
5. Success toast shown, dialog closes

**Login With Stored Key:**
1. User selects stored key from dropdown
2. User enters decryption password (or uses passkey)
3. On login click:
   - Frontend decrypts via `invoke('decrypt_api_key', ...)`
   - Frontend verifies token via `invoke('verify_token', ...)`
   - If successful, store active session in memory
   - Navigate to DNS Manager view
4. If error: show error toast, clear password field

**Create DNS Record:**
1. User in DNS Manager, zone selected
2. User clicks "Add Record" button
3. `AddRecordDialog` opens
4. User fills record details (type, name, content, TTL, etc.)
5. Client-side validation runs
6. On save:
   - Frontend calls `invoke('create_dns_record', ...)`
   - Backend validates and creates record via Cloudflare API
   - Frontend updates local record list
7. Success toast shown, dialog closes

**Bulk Import:**
1. User clicks "Import" button
2. `ImportExportDialog` opens
3. User pastes CSV/JSON/BIND data
4. Frontend parses and validates records client-side
5. Preview shown with skipped duplicates
6. On confirm:
   - Frontend calls `invoke('create_bulk_dns_records', ...)`
   - Backend creates records in batch
   - Progress indicator updates
   - Results summary shown (success count, errors)
7. Record list refreshed

## Acceptance Criteria

**Desktop App Functionality:**
- ✅ App launches on macOS, Windows, Linux
- ✅ OS keychain integration works on all platforms
- ✅ Credentials stored securely with AES-256-GCM encryption
- ✅ Passkey authentication works with platform authenticators
- ✅ All Tauri commands execute successfully
- ✅ UI responsive and performant
- ✅ No network server required

**DNS Management:**
- ✅ Users can add API tokens with password or passkey authentication
- ✅ Login flow validates credentials before granting access
- ✅ Zones and records match Cloudflare API responses
- ✅ CRUD operations work for all supported record types
- ✅ Import/export handles JSON, CSV, and BIND formats
- ✅ Bulk operations complete without errors
- ✅ Duplicate detection during import works correctly

**Security:**
- ✅ Credentials never logged or exposed
- ✅ Encryption uses recommended parameters (100k iterations minimum)
- ✅ OS keychain access prompts user on first use
- ✅ Fallback to in-memory storage with user warning
- ✅ Passkey counters prevent replay attacks
- ✅ CSP prevents XSS attacks
- ✅ Code signing validates app authenticity

## Edge Cases and Error Scenarios

**Authentication Errors:**
- ❌ Wrong encryption password → Error toast: "Incorrect password"
- ❌ Invalid Cloudflare token → Error toast: "Invalid API token. Check your credentials."
- ❌ Network offline → Error toast: "Cannot reach Cloudflare API. Check your connection."
- ❌ OS keychain denied → Warning: "Using in-memory storage. Credentials will not persist."

**DNS Operation Errors:**
- ❌ Invalid IP address → Validation error: "Invalid IP address format"
- ❌ Duplicate record → Skipped with count: "3 duplicates skipped"
- ❌ Cloudflare rate limit → Retry with backoff, user notification
- ❌ Network timeout → Retry 3 times, then error toast

**App-Level Errors:**
- ❌ Corrupted localStorage → Clear UI state (web mode may need re-add keys)
- ❌ Corrupted keychain entry → Delete and prompt re-add
- ❌ App crash → Audit log preserved, safe restart

**Performance Edge Cases:**
- ⚠️ Large zone (10,000+ records) → May be slow, pagination recommended
- ⚠️ Slow encryption (1M iterations) → Show spinner, consider reducing
- ⚠️ Bulk import (1,000 records) → Progress bar, may take 30-60 seconds


- Single-user oriented: local UI state and keychain storage assume one user per device.

