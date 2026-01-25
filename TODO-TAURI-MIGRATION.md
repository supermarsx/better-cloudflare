# Tauri Migration TODO List

> **Status**: Tauri architecture implemented, frontend migration in progress
> **Last Updated**: January 23, 2026

## 🚀 Phase 1: Development Environment Setup

### Prerequisites
- [ ] **Install Rust toolchain**
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  source $HOME/.cargo/env
  rustc --version  # Verify installation
  ```
- [ ] **Install system dependencies** (platform-specific)
  - macOS: `xcode-select --install`
  - Linux: `sudo apt install libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev`
  - Windows: WebView2 (usually pre-installed on Windows 10/11)
- [ ] **Install npm dependencies**
  ```bash
  npm install
  ```
- [ ] **Verify Tauri CLI**
  ```bash
  npm run tauri --version
  ```

### Icon Generation
- [ ] **Create 1024x1024 app icon** (PNG format with transparency)
  - Design app icon or use placeholder
  - Save as `icon.png` in project root
- [ ] **Generate icon variants**
  ```bash
  npm run tauri icon icon.png
  ```
- [ ] **Verify icons generated** in `src-tauri/icons/`
  - Check all platform variants (png, ico, icns)
  - Validate icon appears in dev build

---

## 🔧 Phase 2: Rust Backend Development

### Key Management
- [x] **Re-encrypt API keys when updating password** (Tauri `update_api_key`)

### Testing & Validation
- [x] **Add storage unit tests** (in-memory keyring off)
- [x] **Add SPF parser/unit tests** (parse + CIDR checks)
- [x] **Add crypto error-case tests** (invalid base64/short payload)
- [ ] **Test crypto module** (`src-tauri/src/crypto.rs`)
  ```bash
  cd src-tauri
  cargo test crypto::tests
  ```
  - [ ] Verify encryption/decryption round-trip
  - [ ] Test with various password lengths
  - [ ] Test error cases (wrong password, corrupted data)
  - [ ] Benchmark performance vs Node.js implementation

- [ ] **Test storage module** (`src-tauri/src/storage.rs`)
  ```bash
  cargo test storage::tests
  ```
  - [ ] Test on macOS (Keychain)
  - [ ] Test on Windows (Credential Manager)
  - [ ] Test on Linux (Secret Service)
  - [ ] Verify fallback mechanism works
  - [ ] Test concurrent access patterns

- [ ] **Test Cloudflare API client** (`src-tauri/src/cloudflare_api.rs`)
  - [ ] Test with real Cloudflare API (use test account)
  - [ ] Test error handling (network errors, rate limits, auth failures)
  - [ ] Verify all DNS record types are supported
  - [ ] Test bulk operations performance
  - [ ] Test pagination for large zone lists

- [ ] **Test passkey module** (`src-tauri/src/passkey.rs`)
  - [x] Test challenge generation/validation
  - [x] Test passkey registration flow
  - [x] Test passkey authentication flow
  - [x] Test device management (list, delete)
  - [ ] Cross-platform passkey compatibility

### Code Quality
- [ ] **Add comprehensive error handling**
  - [ ] Review all `.unwrap()` and `.expect()` calls
  - [ ] Replace with proper error propagation
  - [ ] Add context to errors using `anyhow::Context`
  - [ ] Create custom error types where needed

- [ ] **Add logging throughout Rust code**
  - [ ] Add `tracing` crate for structured logging
  - [ ] Log all Tauri command invocations
  - [ ] Log Cloudflare API requests/responses
  - [ ] Log encryption operations
  - [ ] Configure log levels (debug, info, warn, error)

- [ ] **Add comprehensive unit tests**
  - [ ] Achieve >80% code coverage in crypto module
  - [ ] Add property-based tests for encryption
  - [ ] Test edge cases in DNS parsing
  - [ ] Test error conditions
  - [ ] Add integration tests for command handlers

### Storage & Encryption Parity
- [x] **Persist encryption settings in Rust storage** (Tauri)

- [ ] **Security audit**
  - [ ] Review all crypto implementations
  - [ ] Audit password handling (no logging, secure memory)
  - [ ] Review Tauri command permissions
  - [ ] Check for potential injection vulnerabilities
  - [ ] Validate input sanitization
  - [ ] Review CSP configuration in `tauri.conf.json`

- [ ] **Performance optimization**
  - [ ] Profile command execution times
  - [ ] Optimize large payload handling
  - [ ] Consider caching for frequently accessed data
  - [ ] Optimize Cloudflare API batch operations
  - [ ] Benchmark vs Node.js backend

### Additional Features
- [ ] **Implement audit logging** (`src-tauri/src/audit.rs`)
  - [ ] Design audit log format (JSON lines?)
  - [ ] Log all sensitive operations (login, key changes, DNS modifications)
  - [x] Log key/vault operations to local audit storage
  - [x] Log DNS, passkey, encryption operations to local audit storage
  - [x] Add audit log export/download (CSV/JSON)
  - [x] Add rotation policy for audit logs (retain last 1000)
  - [x] Implement log viewing UI
  - [x] Add export functionality

### Passkey Storage
- [x] **Persist passkey credentials in secure storage** (keychain with memory fallback)
- [x] **Share storage between PasskeyManager and Tauri Storage state** (avoid split keychains)
- [ ] **Verify passkey assertions/attestations** (full WebAuthn verification)
- [x] **Enforce passkey token gating for vault reads** (desktop mode)

- [ ] **Add backup/restore functionality**
  - [ ] Export all vaults to encrypted file
  - [ ] Import vaults from backup
  - [ ] Add automatic backup before major operations
  - [ ] Cloud backup integration (optional)

- [ ] **Implement auto-updater**
  - [ ] Configure Tauri updater in `tauri.conf.json`
  - [ ] Set up update server/CDN
  - [ ] Implement update checking logic
  - [ ] Add UI for update notifications
  - [ ] Test update flow on all platforms

---

## 💻 Phase 3: Frontend Migration

### Core Infrastructure
- [ ] **Update `src/lib/server-client.ts`**
  - [x] Detect Tauri environment vs web environment
  - [x] Route requests to TauriClient when in desktop mode
  - [x] Fallback to HTTP client for web mode (if needed)
  - [x] Update all method signatures to match TauriClient

- [x] **Create environment detection utility**
  ```typescript
  // src/lib/environment.ts
  export const isDesktop = () => window.__TAURI__ !== undefined;
  export const isWeb = () => !isDesktop();
  ```

- [ ] **Update error handling**
  - [ ] Map Tauri errors to existing error types
  - [ ] Ensure error messages are user-friendly
  - [ ] Add retry logic where appropriate
  - [ ] Handle offline scenarios gracefully

### Component Migration (by feature)

#### Authentication Components
- [ ] **`src/components/auth/LoginForm.tsx`**
  - [x] Replace `serverClient` with `TauriClient` or abstraction
  - [ ] Test login with password flow
  - [ ] Test login with API key flow
  - [ ] Test error scenarios

- [ ] **`src/components/auth/LoginPasskeySection.tsx`**
  - [ ] Test passkey registration in Tauri
  - [ ] Test passkey authentication in Tauri
  - [ ] Verify platform authenticator detection works
  - [x] Test device management dialog

- [ ] **`src/components/auth/AddKeyDialog.tsx`**
  - [x] Update API key storage calls
  - [ ] Test encryption settings
  - [ ] Verify OS keychain integration

- [ ] **`src/components/auth/EncryptionSettingsDialog.tsx`**
  - [ ] Update encryption enable/disable logic
  - [ ] Test password change flow
  - [ ] Verify re-encryption of all vaults

#### DNS Management Components
- [ ] **DNS zone listing**
  - [ ] Update zone fetching logic
  - [ ] Test with multiple accounts
  - [ ] Test filtering and search
  - [ ] Test zone switching

- [ ] **DNS record management**
  - [x] Tauri backend parity for pagination + bind export + bulk dry-run
  - [x] Tauri SPF simulate/graph commands
  - [ ] Update record CRUD operations
  - [ ] Test all record types (A, AAAA, CNAME, MX, TXT, etc.)
  - [ ] Test bulk operations
  - [ ] Test import/export
  - [ ] Test SPF/DKIM/DMARC helpers

- [ ] **`src/components/dns/*` components**
  - [ ] Review all DNS-related components
  - [ ] Update API calls to use TauriClient
  - [ ] Test each component individually
  - [ ] Update tests to work with Tauri

#### Vault & Storage Components
- [ ] **Vault management UI**
  - [ ] Test vault creation
  - [ ] Test vault listing
  - [ ] Test vault deletion
  - [ ] Test vault switching
  - [ ] Verify encryption status indicators

- [ ] **Settings/Preferences**
  - [ ] Update storage calls for preferences
  - [ ] Test language selection persistence
  - [ ] Test theme persistence
  - [ ] Test other user preferences

### Hooks Migration
- [ ] **`src/hooks/use-cloudflare-api.ts`**
  - [x] Update to use TauriClient
  - [ ] Test all hook methods
  - [ ] Update error handling
  - [ ] Test React Query integration (if used)

- [ ] **`src/hooks/use-toast.ts`**
  - [ ] Verify works with Tauri events
  - [ ] Test toast notifications from Rust backend

- [ ] **Other custom hooks**
  - [ ] Review all hooks for API calls
  - [ ] Update to use TauriClient where needed
  - [ ] Test hook state management

### API Route Removal (if using App Router API routes)
- [ ] **Remove `app/api/*` routes** (no longer needed in desktop app)
  - [ ] Remove all API route handlers
  - [ ] Update imports that reference API routes
  - [ ] Clean up server-side only code

---

## 🧪 Phase 4: Testing

### Unit Tests
- [ ] **Update existing tests** (test/ directory)
  - [ ] `cloudflareApi.test.ts` - Mock Tauri invoke
  - [ ] `cryptoManager.test.ts` - Test against Rust crypto
  - [ ] `serverClient.test.ts` - Update for TauriClient
  - [ ] `sqliteCredentialStore.test.ts` - Test Rust storage
  - [ ] `serverPasskey.test.ts` - Test Rust passkey manager
  - [ ] Review all other tests for needed updates

- [ ] **Add Tauri-specific tests**
  - [x] Test TauriClient wrapper functions
  - [ ] Test error mapping
  - [x] Test environment detection
  - [x] Mock Tauri API in tests

- [ ] **Run test suite**
  ```bash
  npm run test
  ```
  - [ ] Achieve >80% frontend code coverage
  - [ ] All tests passing

### Integration Tests
- [ ] **Create Tauri integration tests**
  - [ ] Test complete login flow (password + API key)
  - [ ] Test complete passkey registration flow
  - [ ] Test DNS record CRUD operations
  - [ ] Test vault operations
  - [ ] Test encryption enable/disable
  - [ ] Test bulk import/export

- [ ] **E2E tests with Playwright**
  - [ ] Update `playwright.config.ts` for Tauri
  - [ ] Test all user workflows
  - [ ] Test error scenarios
  - [ ] Test cross-platform compatibility
  - [ ] Run: `npm run test:e2e`

### Manual Testing
- [ ] **Test on macOS**
  - [ ] Build: `npm run tauri:dev`
  - [ ] Test all features end-to-end
  - [ ] Test OS keychain integration
  - [ ] Test passkeys with Touch ID
  - [ ] Test performance
  - [ ] Check for memory leaks

- [ ] **Test on Windows**
  - [ ] Build on Windows machine
  - [ ] Test all features end-to-end
  - [ ] Test Credential Manager integration
  - [ ] Test passkeys with Windows Hello
  - [ ] Test MSI installer

- [ ] **Test on Linux**
  - [ ] Build on Linux machine (Ubuntu/Debian)
  - [ ] Test all features end-to-end
  - [ ] Test Secret Service integration
  - [ ] Test AppImage/Deb package
  - [ ] Test on different desktop environments (GNOME, KDE)

---

## 📦 Phase 5: Build & Distribution

### Code Signing Setup
- [ ] **macOS code signing**
  - [ ] Obtain Apple Developer account
  - [ ] Create App ID and certificates
  - [ ] Configure in `tauri.conf.json`
  - [ ] Test signed build
  - [ ] Notarize app for macOS 10.15+

- [ ] **Windows code signing**
  - [ ] Obtain code signing certificate
  - [ ] Configure in `tauri.conf.json`
  - [ ] Test signed MSI installer
  - [ ] Test SmartScreen behavior

- [ ] **Linux** (optional code signing)
  - [ ] Configure GPG signing for repos
  - [ ] Test package installation

### Release Configuration
- [ ] **Update version numbers**
  - [ ] `package.json` version
  - [ ] `src-tauri/Cargo.toml` version
  - [ ] `tauri.conf.json` version
  - [ ] Ensure all versions match

- [ ] **Configure updater**
  - [ ] Set up update server URL in `tauri.conf.json`
  - [ ] Create update manifest format
  - [ ] Test update checking
  - [ ] Test update installation

- [ ] **Create installers**
  ```bash
  npm run tauri:build
  ```
  - [ ] macOS: `.dmg` and `.app` bundle
  - [ ] Windows: `.msi` and `.exe` installers
  - [ ] Linux: `.AppImage`, `.deb`, `.rpm`

- [ ] **Test installation process**
  - [ ] Fresh install on clean systems
  - [ ] Upgrade from previous version
  - [ ] Uninstall process
  - [ ] Verify file associations
  - [ ] Test app appears in launcher/start menu

### CI/CD Setup
- [ ] **GitHub Actions workflow**
  - [ ] Create `.github/workflows/build-tauri.yml`
  - [ ] Build on multiple platforms (ubuntu, macos, windows)
  - [ ] Run tests before building
  - [ ] Upload artifacts
  - [ ] Create GitHub releases automatically

- [ ] **Release automation**
  - [ ] Automate version bumping
  - [ ] Generate changelogs
  - [ ] Tag releases in git
  - [ ] Deploy to update server
  - [ ] Notify users of updates

---

## 📝 Phase 6: Documentation Updates

### Project Documentation
- [ ] **Update `README.md`**
  - [x] Replace web app instructions with desktop app
  - [x] Add platform-specific installation instructions
  - [ ] Update screenshots
  - [x] Add system requirements
  - [x] Update development setup instructions
  - [x] Link to README-TAURI.md for detailed desktop info

- [ ] **Update `spec.md`** ⚠️ **CRITICAL**
  - [ ] Change architecture from web app to desktop app
  - [ ] Replace Express.js backend with Tauri/Rust backend
  - [x] Update API section (HTTP REST → Tauri Commands/IPC)
  - [ ] Update authentication flow diagrams
  - [x] Update encryption implementation details
  - [x] Update storage architecture (keyring vs keytar)
  - [ ] Update deployment model (installers vs Docker)
  - [ ] Remove server deployment sections
  - [ ] Add desktop app distribution section
  - [ ] Update security considerations for desktop app
  - [ ] Update tech stack section
  - [ ] Add Rust modules documentation
  - [ ] Update diagrams and architecture charts

- [ ] **Create/update developer docs**
  - [ ] Architecture overview diagram
  - [ ] IPC communication patterns
  - [ ] Adding new Tauri commands guide
  - [ ] Debugging guide for Rust backend
  - [ ] Contributing guidelines update

- [ ] **API Reference Documentation**
  - [ ] Document all Tauri commands
  - [ ] Document command parameters and return types
  - [ ] Add examples for each command
  - [ ] Document error codes
  - [ ] Generate TypeDoc for TauriClient

### User Documentation
- [ ] **Create user manual**
  - [ ] Installation guide per platform
  - [ ] First-time setup walkthrough
  - [ ] Feature guide with screenshots
  - [ ] Troubleshooting section
  - [ ] FAQ

- [ ] **Create video tutorials** (optional)
  - [ ] Installation and setup
  - [ ] Basic DNS management
  - [ ] Passkey setup
  - [ ] Advanced features

---

## 🔒 Phase 7: Security & Compliance

### Security Review
- [ ] **Conduct security audit**
  - [ ] Review Tauri permissions configuration
  - [ ] Audit all IPC commands for security
  - [ ] Review CSP policy
  - [ ] Check for XSS vulnerabilities
  - [ ] Verify secure storage implementation
  - [ ] Review crypto implementation against OWASP guidelines

- [ ] **Penetration testing**
  - [ ] Test local privilege escalation
  - [ ] Test IPC message injection
  - [ ] Test sensitive data exposure
  - [ ] Test against OWASP Top 10
  - [ ] Document findings and fixes

- [ ] **Dependency audit**
  ```bash
  cargo audit
  npm audit
  ```
  - [ ] Review and update vulnerable dependencies
  - [ ] Set up automated dependency scanning

### Privacy & Compliance
- [ ] **Review data handling**
  - [ ] Document what data is stored locally
  - [ ] Document what data is sent to Cloudflare
  - [ ] Ensure no telemetry without consent
  - [ ] Review logging for sensitive data

- [ ] **Update privacy policy** (if applicable)
  - [ ] Clarify desktop app vs web app data handling
  - [ ] Document local storage locations
  - [ ] Document encryption practices

- [ ] **License compliance**
  - [ ] Review all Rust crate licenses
  - [ ] Review all npm package licenses
  - [ ] Update LICENSES.md
  - [ ] Ensure GPL compatibility (if relevant)

---

## 🚢 Phase 8: Migration Cleanup

### Remove Obsolete Code
- [ ] **Remove server-only code**
  - [ ] Remove `server.ts` (Express server)
  - [ ] Remove `src/server/*` directory
  - [ ] Remove server-side encryption code (Node.js)
  - [ ] Remove keytar integration
  - [ ] Remove server-side WebAuthn code

- [ ] **Remove Docker artifacts**
  - [ ] Remove `Dockerfile`
  - [ ] Remove `docker-compose.yml`
  - [ ] Update `.dockerignore` or remove it
  - [ ] Remove Docker-related scripts

- [ ] **Clean up npm dependencies**
  - [ ] Remove Express and related middleware
  - [ ] Remove keytar
  - [ ] Remove server-only dependencies
  - [ ] Remove unused packages
  - [ ] Run `npm prune`

- [ ] **Update `.gitignore`**
  - [ ] Verify `src-tauri/target/` is ignored ✅ (already done)
  - [ ] Verify `Cargo.lock` handling
  - [ ] Verify `out/` directory is ignored ✅

### Configuration Cleanup
- [ ] **Archive web app configs** (if keeping dual mode)
  - [ ] Move old server configs to `archive/` folder
  - [ ] Document migration path in archive

- [ ] **Remove if not needed**
  - [ ] Remove old API route handlers
  - [ ] Remove server-side middleware
  - [ ] Remove SSR-specific Next.js configs

---

## 📊 Phase 9: Performance & Optimization

### Benchmarking
- [ ] **Benchmark critical operations**
  - [ ] App startup time
  - [ ] Login flow duration
  - [ ] DNS zone load time
  - [ ] DNS record operations (CRUD)
  - [ ] Bulk import performance
  - [ ] Encryption/decryption speed
  - [ ] Memory usage over time
  - [ ] Compare to web app baseline

- [ ] **Profile Rust backend**
  ```bash
  cargo build --release --features profiling
  ```
  - [ ] Identify bottlenecks
  - [ ] Optimize hot paths
  - [ ] Reduce allocations
  - [ ] Optimize Cloudflare API calls

- [ ] **Profile frontend**
  - [ ] Use React DevTools Profiler
  - [ ] Identify slow components
  - [ ] Optimize re-renders
  - [ ] Lazy load components where appropriate

### Optimization Tasks
- [ ] **Bundle size optimization**
  - [ ] Analyze bundle with `npm run build -- --analyze`
  - [ ] Remove unused dependencies
  - [ ] Code split large components
  - [ ] Optimize images and assets

- [ ] **Rust binary size reduction**
  - [ ] Enable LTO (Link-Time Optimization)
  - [ ] Strip debug symbols in release builds
  - [ ] Review dependency bloat
  - [ ] Consider `opt-level = "z"` for size

- [ ] **Startup optimization**
  - [ ] Lazy load non-critical modules
  - [ ] Defer initialization of heavy services
  - [ ] Cache frequently accessed data
  - [ ] Optimize initial render

---

## 🎯 Phase 10: Launch Preparation

### Pre-Launch Checklist
- [ ] **Feature completeness**
  - [ ] All features from web app ported
  - [ ] All tests passing
  - [ ] All documentation complete
  - [ ] All known bugs fixed

- [ ] **Beta testing**
  - [ ] Recruit beta testers (5-10 users)
  - [ ] Create beta testing guide
  - [ ] Set up feedback collection mechanism
  - [ ] Address beta feedback

- [ ] **Marketing materials**
  - [ ] Create app landing page
  - [ ] Prepare announcement blog post
  - [ ] Create promotional screenshots/videos
  - [ ] Update social media profiles

### Launch
- [ ] **Release v1.0.0**
  - [ ] Tag release in git
  - [ ] Build final installers
  - [ ] Sign all builds
  - [ ] Upload to distribution channels
  - [ ] Create GitHub release with notes
  - [ ] Update documentation links

- [ ] **Distribution**
  - [ ] Upload to GitHub Releases
  - [ ] Submit to Homebrew (macOS) - optional
  - [ ] Submit to Chocolatey (Windows) - optional
  - [ ] Create APT/RPM repositories (Linux) - optional
  - [ ] Consider Mac App Store (requires review)
  - [ ] Consider Microsoft Store (requires review)

- [ ] **Announcement**
  - [ ] Publish blog post
  - [ ] Post on social media
  - [ ] Submit to Product Hunt / Hacker News
  - [ ] Notify existing users (if migration from web)
  - [ ] Update project homepage

### Post-Launch
- [ ] **Monitor metrics**
  - [ ] Track downloads/installs
  - [ ] Monitor crash reports (if telemetry enabled)
  - [ ] Track user feedback
  - [ ] Monitor GitHub issues

- [ ] **Support setup**
  - [ ] Create support documentation
  - [ ] Set up issue templates
  - [ ] Define support SLA
  - [ ] Create troubleshooting guides

- [ ] **Roadmap planning**
  - [ ] Prioritize feature requests
  - [ ] Plan next version features
  - [ ] Schedule regular updates
  - [ ] Plan deprecation of old web app (if applicable)

---

## 🎨 Optional Enhancements

### UI/UX Improvements
- [ ] **Native menus**
  - [ ] Add macOS menu bar
  - [ ] Add Windows system tray
  - [ ] Add context menus
  - [ ] Add keyboard shortcuts

- [ ] **System integration**
  - [ ] Add protocol handler (e.g., `cloudflare://`)
  - [ ] Add file associations
  - [ ] Add quick actions / jump list
  - [ ] Add Touch Bar support (macOS)

- [ ] **Accessibility**
  - [ ] Full keyboard navigation
  - [ ] Screen reader support
  - [ ] High contrast theme
  - [ ] Font size scaling

### Advanced Features
- [ ] **CLI companion tool**
  - [ ] Create CLI for automation
  - [ ] Support batch operations from terminal
  - [ ] Export/import via CLI

- [ ] **Plugin system**
  - [ ] Design plugin API
  - [ ] Allow custom DNS record types
  - [ ] Allow custom workflows
  - [ ] Create plugin marketplace

- [ ] **Cloud sync** (optional)
  - [ ] Sync vaults across devices
  - [ ] End-to-end encrypted sync
  - [ ] Conflict resolution
  - [ ] Backup to cloud storage

---

## ⚠️ Critical Path Items

These items MUST be completed for the desktop app to be functional:

1. ✅ Rust toolchain installation
2. ✅ Icon generation
3. 🔲 Test development build (`npm run tauri:dev`)
4. 🔲 Frontend migration (at least core auth + DNS features)
5. 🔲 Update `spec.md` to reflect new architecture
6. 🔲 Cross-platform testing (macOS, Windows, Linux)
7. 🔲 Code signing setup (at least for one platform)
8. 🔲 Production build and distribution

---

## 📋 Progress Tracking

### Completion Summary
- **Phase 1**: ⬜ 0% (0/9 tasks)
- **Phase 2**: ⬜ 0% (0/35 tasks)
- **Phase 3**: ⬜ 0% (0/28 tasks)
- **Phase 4**: ⬜ 0% (0/18 tasks)
- **Phase 5**: ⬜ 0% (0/18 tasks)
- **Phase 6**: ⬜ 0% (0/14 tasks)
- **Phase 7**: ⬜ 0% (0/12 tasks)
- **Phase 8**: ⬜ 5% (1/19 tasks) - .gitignore updated
- **Phase 9**: ⬜ 0% (0/13 tasks)
- **Phase 10**: ⬜ 0% (0/18 tasks)

**Overall Progress**: ~0.5% (1/184 core tasks)

---

## 🔗 Related Documentation

- [Migration Guide](docs/tauri-migration.md) - Comprehensive API conversion reference
- [Desktop App README](README-TAURI.md) - Quick start and architecture guide
- [Tauri Documentation](https://tauri.app/v2/) - Official Tauri docs
- [Rust Book](https://doc.rust-lang.org/book/) - Learn Rust

---

## 📞 Support & Questions

- **Issue Tracker**: GitHub Issues
- **Discussions**: GitHub Discussions
- **Email**: [your-email@example.com]
- **Documentation**: See `docs/` folder

---

## ✏️ Notes

- This is a living document - update as tasks are completed
- Mark tasks with ✅ when done, 🚧 when in progress, ⚠️ when blocked
- Add dates next to completed major milestones
- Keep related tasks grouped for context
- Review and re-prioritize regularly
