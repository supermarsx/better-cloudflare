# Tauri Desktop App Migration Guide

This guide explains the conversion of Better Cloudflare from a web application to a Tauri-based desktop application with Rust backend.

## Architecture Overview

### Before (Web App)
- **Frontend**: Next.js React application
- **Backend**: Express.js Node server
- **Communication**: HTTP/REST API
- **Storage**: IndexedDB + OS Keychain (via keytar)

### After (Desktop App)
- **Frontend**: Next.js React application (same)
- **Backend**: Rust with Tauri framework
- **Communication**: Tauri IPC (Inter-Process Communication)
- **Storage**: OS Keychain (via keyring crate) + in-memory fallback

## Key Changes

### 1. Backend Migration (TypeScript → Rust)

**Express Routes → Tauri Commands**
```typescript
// Before: Express endpoint
app.post('/api/verify-token', async (req, res) => {
  const { apiKey, email } = req.body;
  // ...
});

// After: Tauri command
#[tauri::command]
pub async fn verify_token(api_key: String, email: Option<String>) -> Result<bool, String> {
  // ...
}
```

### 2. Frontend Changes

**HTTP Calls → Tauri Invoke**
```typescript
// Before: HTTP fetch
const response = await fetch('/api/verify-token', {
  method: 'POST',
  body: JSON.stringify({ apiKey, email })
});

// After: Tauri invoke
import { invoke } from '@tauri-apps/api/core';
const result = await invoke('verify_token', { apiKey, email });
```

### 3. Storage Changes

**Node.js keytar → Rust keyring**
- Same OS-level keychain integration
- Automatic fallback to in-memory storage
- Compatible credential format

## Installation & Setup

### Prerequisites
```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Install Tauri CLI
cargo install tauri-cli

# Or use npm
npm install -D @tauri-apps/cli
```

### Development
```bash
# Install dependencies
npm install

# Run in development mode
npm run tauri:dev

# This will:
# 1. Start Next.js dev server (localhost:3000)
# 2. Build Rust backend
# 3. Launch desktop app window
```

### Building for Production
```bash
# Build desktop app
npm run tauri:build

# Output will be in src-tauri/target/release/bundle/
# - macOS: .dmg and .app
# - Windows: .msi and .exe
# - Linux: .deb, .AppImage
```

## Project Structure

```
better-cloudflare/
├── src-tauri/               # Rust backend
│   ├── src/
│   │   ├── main.rs         # Tauri app entry point
│   │   ├── commands.rs     # Tauri command handlers
│   │   ├── crypto.rs       # Encryption (AES-256-GCM + PBKDF2)
│   │   ├── storage.rs      # OS keychain integration
│   │   ├── cloudflare_api.rs  # Cloudflare API client
│   │   ├── passkey.rs      # WebAuthn passkey support
│   │   └── audit.rs        # Audit logging
│   ├── Cargo.toml          # Rust dependencies
│   └── build.rs            # Build script
├── src/                    # Frontend (unchanged)
│   └── lib/
│       └── tauri-client.ts # Tauri IPC wrapper
├── app/                    # Next.js app router (unchanged)
├── tauri.conf.json         # Tauri configuration
└── package.json            # Updated with Tauri scripts
```

## Configuration

### tauri.conf.json
Key configuration options:
```json
{
  "build": {
    "devUrl": "http://localhost:3000",    // Next.js dev server
    "frontendDist": "../out"               // Next.js export output
  },
  "app": {
    "windows": [{
      "title": "Better Cloudflare DNS Manager",
      "width": 1280,
      "height": 800
    }]
  }
}
```

### next.config.mjs
Updated for static export:
```javascript
const nextConfig = {
  output: 'export',           // Required for Tauri
  images: {
    unoptimized: true,        // No server-side image optimization
  },
};
```

## API Conversion Reference

### Tauri Client Usage

```typescript
import { TauriClient } from '@/lib/tauri-client';

// Check if running in Tauri
if (TauriClient.isTauri()) {
  // Use Tauri IPC
  const keys = await TauriClient.getApiKeys();
} else {
  // Fall back to HTTP (for web version)
  const response = await fetch('/api/keys');
}
```

### Available Commands

**Authentication & Keys**
- `verify_token(apiKey, email)` - Verify Cloudflare API token
- `get_api_keys()` - List stored API keys
- `add_api_key(label, apiKey, email, password)` - Add encrypted key
- `update_api_key(id, ...)` - Update key metadata
- `delete_api_key(id)` - Remove key
- `decrypt_api_key(id, password)` - Decrypt stored key

**DNS Operations**
- `get_zones(apiKey, email)` - List Cloudflare zones
- `get_dns_records(apiKey, email, zoneId)` - List DNS records
- `create_dns_record(apiKey, email, zoneId, record)` - Create record
- `update_dns_record(...)` - Update record
- `delete_dns_record(...)` - Delete record
- `create_bulk_dns_records(...)` - Bulk create
- `export_dns_records(apiKey, email, zoneId, format)` - Export

**Vault & Passkeys**
- `store_vault_secret(id, secret)` - Store in OS keychain
- `get_vault_secret(id)` - Retrieve from keychain
- `delete_vault_secret(id)` - Delete from keychain
- `get_passkey_registration_options(id)` - Start passkey registration
- `register_passkey(id, attestation)` - Complete registration
- `authenticate_passkey(id, assertion)` - Authenticate with passkey
- `list_passkeys(id)` - List registered passkeys
- `delete_passkey(id, credentialId)` - Revoke passkey

**Encryption**
- `get_encryption_settings()` - Get current settings
- `update_encryption_settings(config)` - Update settings
- `benchmark_encryption(iterations)` - Performance test

**Audit**
- `get_audit_entries()` - Get audit log

## Security Improvements

### Desktop App Benefits
1. **No Network Exposure**: Backend runs locally, no server to attack
2. **Native OS Integration**: Uses system keychain (Keychain on macOS, Credential Manager on Windows, Secret Service on Linux)
3. **Sandboxed**: Tauri security model restricts file system and network access
4. **Code Signing**: Can sign the app for distribution
5. **Auto-Updates**: Built-in updater plugin available

### Encryption
- **Algorithm**: AES-256-GCM (Galois/Counter Mode)
- **Key Derivation**: PBKDF2-HMAC-SHA256
- **Default Iterations**: 100,000
- **Salt**: Random 16 bytes per encryption
- **Nonce**: Random 12 bytes (96-bit)

## Testing

### Development Testing
```bash
# Run unit tests (Rust)
cd src-tauri
cargo test

# Run e2e tests (Playwright)
npm run test:e2e
```

### Manual Testing
1. Launch with `npm run tauri:dev`
2. Test API key storage and encryption
3. Test DNS record operations
4. Test passkey registration and authentication
5. Verify audit logging

## Troubleshooting

### Build Issues

**Rust compilation errors**
```bash
# Update Rust
rustup update stable

# Clean and rebuild
cd src-tauri
cargo clean
cargo build
```

**Frontend not loading**
```bash
# Ensure Next.js is building correctly
npm run build
# Check output in 'out' directory
```

### Runtime Issues

**Keyring not available**
- App will automatically fall back to in-memory storage
- Data will not persist between restarts
- Check system keychain permissions

**WebAuthn not working**
- Passkeys require HTTPS or localhost
- Desktop app runs on localhost internally
- Ensure system supports WebAuthn (biometric/security keys)

## Distribution

### macOS
```bash
npm run tauri:build
# Output: src-tauri/target/release/bundle/dmg/
# Sign with: codesign --sign "Developer ID" app.app
```

### Windows
```bash
npm run tauri:build
# Output: src-tauri/target/release/bundle/msi/
# Sign with: signtool sign /f cert.pfx app.exe
```

### Linux
```bash
npm run tauri:build
# Output: src-tauri/target/release/bundle/
# - .deb for Debian/Ubuntu
# - .AppImage for universal distribution
```

## Migration Checklist

- [ ] Install Rust toolchain
- [ ] Install Tauri CLI
- [ ] Update Next.js config for static export
- [ ] Create Rust backend modules
- [ ] Implement Tauri commands
- [ ] Create frontend Tauri client wrapper
- [ ] Update components to use TauriClient
- [ ] Test all features in dev mode
- [ ] Build production bundles
- [ ] Test on target platforms
- [ ] Set up code signing
- [ ] Create installer/DMG assets
- [ ] Document deployment process

## Benefits of Tauri Architecture

1. **Performance**: Rust backend is significantly faster than Node.js
2. **Security**: Native OS integration, no exposed web server
3. **Size**: Smaller bundle size compared to Electron (~3-5 MB vs ~50-100 MB)
4. **Native Feel**: True native window management
5. **Cross-Platform**: Single codebase for macOS, Windows, Linux
6. **WebView**: Uses system webview (no bundled Chromium)
7. **Updates**: Built-in auto-updater support
8. **Offline**: Fully functional without internet (after initial auth)

## Additional Resources

- [Tauri Documentation](https://tauri.app/)
- [Tauri Command Guide](https://tauri.app/v1/guides/features/command)
- [Rust Book](https://doc.rust-lang.org/book/)
- [keyring-rs](https://github.com/hwchen/keyring-rs)
- [AES-GCM](https://docs.rs/aes-gcm/)

## Support

For issues specific to the Tauri implementation:
1. Check Tauri logs: `~/.config/better-cloudflare/logs/`
2. Enable debug mode in `tauri.conf.json`
3. Review Rust console output during `tauri:dev`
4. Check browser console for frontend errors
