## Future improvements & next steps

This file lists suggested improvements, enhancements, and higher-priority next steps for the project. Use this as a roadmap for future PRs and the CI pipeline.

### UI & Validation

- Add per-type specialized UI fields for record types that have structured content (SRV, TLSA, SSHFP, NAPTR). (Partially implemented for SRV.)
- Display an example/tooltip for content format per record type.
- Add stricter `content` validations for `CNAME`, `NS`, `PTR`, `MX` hostnames using public hostname validation.
- Allow enabling/disabling types in UI based on zone/provider capabilities (some providers disallow `ANAME/ALIAS` or require plan-level features).

### Backend & Testing

- Add a lightweight in-memory sqlite integration test that runs with real `sqlite3` and toggles `better-sqlite3` absence to exercise both drivers.
- Add a CI job to run tests in a `sqlite3`-only environment (simulate `better-sqlite3` being missing).
- Add E2E tests with Playwright that create/edit/target DNS records including SRV and TLSA.

### Import/Export & Data Handling

- Improve import format parsing for less-common record types and validate them on import.
- Add CSV-based examples & clean error reporting for import failures.

### Security & Hardening

- Add `@types/*` type dependencies for express & third-party libs to avoid ambient shims.
- Add CI secrets scanning to prevent accidental leakage of API keys in PRs.

### Observability & Audit

- Provide better audit metadata for user actions (source IP, user agent) when available.
- Convert fire-and-forget audit writes to batched writes with retries to reduce risk of lost audit entries in the event of transient DB errors.

### Misc

- Add dynamic documentation pages for supported record types & examples in the app UI.
- Add a lightweight CLI to import/export records, run migrations, and validate configs.

---

If you want any of the items above implemented next, tell me which ones and I'll start by adding a plan and breaking down tasks into the repository issues and PRs.
