# Passkey & Credential Management Architecture

This document outlines the design and implementation details for passkey support, credential storage, RBAC, audit logging, attestation policy enforcement, migration approach, and testing for the Better Cloudflare project.

## Overview

Passkeys provide a secure, phishing-resistant alternative to passwords leveraging WebAuthn. For Better Cloudflare, passkeys are optional and complement the existing password-based encryption of API keys.

Key design goals:

- Provide a secure and configurable server-side credential store (vault or optional DB) for passkeys and secrets, with OS keychain fallback.
- Support multiple passkey credentials (multi-device) per stored key `id`.
- Validate attestation and assertion using `@simplewebauthn/server` with configurable attestation policies and enforce `origin`/`rpID` per deployment.
- Add passkey management endpoints and UI controls to list, label, and revoke credentials.
- Introduce optional role-based access (RBAC) and an audit trail for sensitive ops.
- Offer a migration path for moving from vault to a persistent DB while preserving backward compatibility.

## Credential storage modes

1. Vault (default)
   - Uses `keytar` for OS-provided secure storage when available and enabled (`KEYTAR_ENABLED=1`).
   - Backed by in-memory `Map` when `keytar` is unavailable (dev/test), consistent with current implementation.
   - Vault storage keys:
     - `passkey:{id}` - JSON (array) of credential objects registered for a given `id`.
     - `vault:{id}` - arbitrary secret stored by storage API.

2. Persistent DB (optional)
   - Use a file-based DB (SQLite) with encryption at rest (recommended, e.g., `sqlcipher` or encrypt the DB file with a server-managed key). Alternatively, use an encrypted JSON file with strong OS permissions.
   - Enables multi-user and RBAC scenarios, persistent credential store across server restarts and across hosts when using a central DB.
   - Introduce `CREDENTIAL_STORE` env var: `vault` | `sqlite` | `memory`.

### Recommended DB Schema (SQLite - simplified)

- `credentials` table
  - `id` TEXT PRIMARY KEY
  - `owner_id` TEXT -- corresponds to `id` param (user/key id)
  - `credential_id` TEXT
  - `credential_public_key` TEXT
  - `counter` INTEGER
  - `created_at` TIMESTAMP
  - `label` TEXT (friendly device name)

- `audit_log` table
  - `id` INTEGER PRIMARY KEY AUTOINCREMENT
  - `actor` TEXT
  - `operation` TEXT
  - `resource` TEXT
  - `details` TEXT
  - `timestamp` TIMESTAMP

- `users` table (optional for multi-user)
  - `user_id` TEXT
  - `email` TEXT
  - `roles` TEXT (CSV or JSON)

## Passkey API (revisited)

Existing endpoints:
- `GET /api/passkeys/register/options/:id` - returns options and challenge for registration
- `POST /api/passkeys/register/:id` - verifies attestation and stores credential(s)
- `GET /api/passkeys/authenticate/options/:id` - returns challenge for assertion
- `POST /api/passkeys/authenticate/:id` - verifies assertion and updates counter
- `GET /api/passkeys/:id` - lists registered credentials (metadata only)
- `DELETE /api/passkeys/:id/:cid` - deletes a credential by ID

Authentication & access control:
- All passkey endpoints require Cloudflare API credentials to be present in request headers (`Authorization` or `x-auth-key`/`x-auth-email`), ensuring only a user with valid Cloudflare access can register or read secrets for that `id`.
- For RBAC-enabled deployments, additional middleware verifies role membership and API request permissions.

## Attestation & Assertion Policies

- Use `@simplewebauthn/server` to verify registration and authentication responses.
- Config flags:
  - `ATTESTATION_POLICY` - `none` | `direct` | `indirect` | `enterprise`.
  - `REQUIRE_U2F` - whether to accept legacy U2F authenticator types.
- Enforce `expectedOrigin` and `expectedRPID` based on `SERVER_ORIGIN` (or `VITE_SERVER_ORIGIN`).
- On successful registration, persist `credentialPublicKey`, `credentialID`, and initial `counter`.
- On authentication, verify signature and update `counter` — reject if signature invalid or counter doesn't increase.

## RBAC

- Roles: `admin`, `user` (minimum). Admin can manage all credentials and run server-wide operations; `user` can manage their `id`-scoped credentials.
- Modular middleware to check user roles from request headers (e.g., `X-User` or short-lived token). This can be integrated later with a real identity system.
- Add endpoints:
  - `POST /api/users` - create user (admin only)
  - `GET /api/users/:id` - get user info
  - `PUT /api/users/:id/roles` - manage roles

## Audit logging

- Events to record:
  - `key:add`, `key:update`, `key:delete` (API key operations)
  - `passkey:register`, `passkey:authenticate`, `passkey:delete` (passkey ops)
  - `vault:store`, `vault:retrieve`, `vault:delete`
- Log structure: JSON with `actor`, `operation`, `resource`, `timestamp`, `meta`.
- Storage options: stdout, file with rotation, or DB table `audit_log`.

## Migration Plan

Goal: Provide a clear path for administrators to migrate from vault to a persistent DB store when moving to multi-user deployments.

1. Migration modes:
   - **Online migration**: The server reads all secrets from the vault and inserts them into the DB atomically, marking the vault as deprecated for each key. Requires the DB to be properly encrypted.
   - **Manual export/import**: Export credentials as encrypted JSON, import into the DB with CLI script.

2. Migration script responsibilities:
   - Read every `passkey:{id}` secret value from the current vault.
   - Insert into `credentials` table while ensuring sensitive fields are handled properly (no plaintext keys stored). Consider keeping `credentialPublicKey` & `credentialID` only.
   - Optionally create a backup file encrypted with a server-managed key.

3. Backward compatibility:
   - `CREDENTIAL_STORE` defaults to `vault` when a DB isn't configured.
   - If DB is configured, the server checks DB first, falls back to vault if not found, and updates DB on read to migrate gradually.
   - Clear the vault after verifying DB consistency.

## Testing and CI

- Add E2E tests using Playwright/Cypress covering the following flows:
  - Add API key, encrypt, and login.
  - Passkey registration and login via WebAuthn stubs (simulate attestation/assertion because real device tests are complex).
  - CRUD DNS record operations and import/export flows.

- Add GitHub Actions CI pipeline:
  - `unit-tests` job: run `npm test`.
  - `e2e-tests` job: run Playwright E2E tests.
  - `lint` job: run `npm run lint`.
  - `accessibility` job: run `axe-core` checks.

## Implementation roadmap

Phase 1 (low effort):
- Add passkey list & delete API and tests (done).
- Add DB abstraction layer (interface for `vault` or `sqlite`).
- Update `spec.md` and docs.

Phase 2 (medium effort):
- Implement SQLite credential store with migration script.
- RBAC skeleton and protected endpoints.
- UI: list & revoke passkeys per key, device labels.
- Add audit logging.

Phase 3 (high effort):
- Implement multi-tenant server DB with roles and user management.
- Add E2E tests and CI integration.
- Add policies for attestation verification and attestation enforcement.

## Backwards compatibility & security considerations

- Vault will continue to be supported and remain the default. When enabling DB, ensure DB is encrypted and accessible only to trusted server deployments.
- Avoid storing any private key material that breaks the core non-persistence property of the server for API tokens — CRITICAL: do not change server flows where API tokens are stored beyond the vault if deployment requires ephemeral tokens.

## Open questions

- For multi-user support, what identity/auth model is desired (local users vs SSO)?
- Do we want to store passkey device labels and last-used timestamps in the DB? This helps with UX and management.
- Are we comfortable moving from vault-only to DB for initial deployments, or should we keep DB optional behind a feature flag?

## Next steps

- Review and confirm implementation approach and environment variables.
- Add DB abstraction layer (interface), and plugin implementation.
- Implement RBAC & audit logging.
- Implement UI changes to list and revoke device credentials.
- Decide on CI tooling and include E2E tests.


---

Document created: automated by the assistant. Implementations and changes will follow.