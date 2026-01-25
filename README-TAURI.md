# Better Cloudflare - Tauri Desktop Application

A secure, desktop application for managing Cloudflare DNS records with passkey authentication support.

## 🚀 Quick Start

### Prerequisites
- [Node.js](https://nodejs.org/) (v18 or later)
- [Rust](https://rustup.rs/) (latest stable)
- [Tauri CLI](https://tauri.app/)

```bash
# Install Rust (if not already installed)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Clone the repository
git clone https://github.com/yourusername/better-cloudflare.git
cd better-cloudflare

# Install dependencies
npm install

# Run in development mode
npm run tauri:dev

# Build for production
npm run tauri:build
```

## 📋 Features

- ✅ **Secure Key Storage**: Encrypted API keys stored in OS keychain
- ✅ **Passkey Support**: Passwordless authentication with WebAuthn
- ✅ **DNS Management**: Full CRUD operations for DNS records
- ✅ **Bulk Operations**: Import/export and bulk create records
- ✅ **Multi-Zone Support**: Manage multiple Cloudflare zones
- ✅ **Audit Logging**: Track all operations
- ✅ **Offline Capable**: Works without internet (after initial setup)
- ✅ **Cross-Platform**: macOS, Windows, Linux

## 🏗️ Architecture

### Frontend
- **Framework**: Next.js 16 (React 19)
- **UI**: Radix UI + Tailwind CSS
- **State Management**: React Hooks
- **i18n**: react-i18next

### Backend
- **Runtime**: Tauri (Rust)
- **Encryption**: AES-256-GCM + PBKDF2-HMAC-SHA256
- **Storage**: OS Keychain (keyring-rs)
- **HTTP Client**: reqwest
- **WebAuthn**: Custom implementation

### Security
- End-to-end encryption for API keys
- OS-level secure storage
- No exposed web server
- Sandboxed application
- Code signing ready

## 📦 Project Structure

```
better-cloudflare/
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── main.rs        # Entry point
│   │   ├── commands.rs    # Tauri commands
│   │   ├── crypto.rs      # Encryption
│   │   ├── storage.rs     # Keychain integration
│   │   └── ...
│   └── Cargo.toml
├── src/                    # Frontend source
│   ├── components/        # React components
│   ├── hooks/            # Custom hooks
│   ├── lib/              # Utilities
│   └── ...
├── app/                   # Next.js app router
└── package.json
```

## 🛠️ Development

### Available Scripts

```bash
# Development
npm run tauri:dev          # Run desktop app in dev mode
npm run dev                # Run Next.js only (web mode)

# Building
npm run tauri:build        # Build desktop app
npm run build              # Build Next.js static export (out/)
npm run preview            # Serve the static export for verification

# Testing
npm test                   # Run unit tests
npm run test:e2e          # Run Playwright tests

# Linting & Formatting
npm run lint              # ESLint
npm run format:check      # Prettier check
npm run format:fix        # Prettier fix
```

### Testing Tauri Commands

You can test Rust backend commands directly:

```bash
cd src-tauri
cargo test
```

## 🔒 Security Features

### Encryption
- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key Derivation**: PBKDF2-HMAC-SHA256 (100,000 iterations)
- **Random Salt**: 16 bytes per encryption
- **Random Nonce**: 12 bytes (96-bit)

### Storage
- **macOS**: Keychain
- **Windows**: Credential Manager
- **Linux**: Secret Service (libsecret)
- **Fallback**: In-memory (non-persistent)

### Passkeys
- **Standard**: WebAuthn / FIDO2
- **Biometrics**: Touch ID, Face ID, Windows Hello
- **Security Keys**: YubiKey, etc.

## 📚 Documentation

- [Tauri Migration Guide](docs/tauri-migration.md) - Detailed conversion guide
- [Passkey Architecture](docs/passkey-architecture.md) - WebAuthn implementation
- [SPF Documentation](docs/spf-naptr.md) - SPF record validation

## 🚢 Distribution

### macOS
```bash
npm run tauri:build
# Output: src-tauri/target/release/bundle/dmg/

# Code signing
codesign --sign "Developer ID Application: Your Name" \
  "src-tauri/target/release/bundle/macos/Better Cloudflare.app"

# Notarization (for distribution outside App Store)
xcrun notarytool submit Better-Cloudflare.dmg \
  --apple-id your@email.com \
  --team-id TEAMID \
  --password app-specific-password
```

### Windows
```bash
npm run tauri:build
# Output: src-tauri/target/release/bundle/msi/

# Code signing
signtool sign /f certificate.pfx /p password \
  /t http://timestamp.digicert.com \
  Better-Cloudflare.msi
```

### Linux
```bash
npm run tauri:build
# Output:
# - src-tauri/target/release/bundle/deb/     (Debian/Ubuntu)
# - src-tauri/target/release/bundle/appimage/ (Universal)
```

## 🐛 Troubleshooting

### Rust Build Issues
```bash
# Update Rust
rustup update stable

# Clean build
cd src-tauri
cargo clean
cargo build
```

### Frontend Not Loading
```bash
# Rebuild Next.js
npm run build

# Check output directory
ls -la out/
```

### Keyring Access Denied
- **macOS**: Check System Preferences > Security & Privacy > Privacy > Accessibility
- **Windows**: Run as Administrator once to set up credentials
- **Linux**: Ensure libsecret is installed: `sudo apt install libsecret-1-dev`

### Passkeys Not Working
- Ensure you're on a supported platform
- Check browser console for WebAuthn errors
- Verify system has biometric or security key support

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

See [LICENSE](license.md) for details.

## 🙏 Acknowledgments

- [Tauri](https://tauri.app/) - Desktop app framework
- [Next.js](https://nextjs.org/) - React framework
- [Cloudflare](https://www.cloudflare.com/) - DNS API
- [Radix UI](https://www.radix-ui.com/) - UI components
- [SimpleWebAuthn](https://simplewebauthn.dev/) - WebAuthn library

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/yourusername/better-cloudflare/issues)
- **Discussions**: [GitHub Discussions](https://github.com/yourusername/better-cloudflare/discussions)

---

Built with ❤️ using Tauri + Rust + Next.js
