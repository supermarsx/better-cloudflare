# Better Cloudflare documentation

This is the curated documentation hub for [Better Cloudflare](https://github.com/supermarsx/better-cloudflare). Generated API reference is written separately to `docs/api/`, so running `npm run docs` does not overwrite these guides.

## Guides

- [Tauri migration guide](tauri-migration.md) — architecture and migration context, with current-status notes.
- [Passkey architecture](passkey-architecture.md) — legacy server-mode design; not the current desktop implementation contract.
- [SPF and NAPTR notes](spf-naptr.md) — DNS record reference material.
- [Design system notes](design-system.md) — UI conventions.
- [Future work](future-work.md) — planned work rather than released capability.
- [Project specification](../spec.md) — target product contract and its implementation-status annotations.

## Current delivery status

- GitHub Pages publishes the static Next.js export; use the repository and this docs directory for source documentation.
- Touch ID is the only implemented biometric runtime and is macOS-only. Windows Hello is not implemented.
- The Tauri updater is disabled. Code signing and macOS notarization are not configured.
- Package-manager distribution channels are aspirational until automated and verified.
