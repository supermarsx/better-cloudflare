---
title: Future work
parent: Reference
nav_order: 4
description: Planned work — not released capability.
---

# Future improvements and next steps

{: .warning }
Nothing on this page is released capability. These are candidate work items, kept here so the intended direction is visible; read [Screens and features](screens.md) for what the application actually does today.

The items below are grouped by area and are deliberately small enough to become individual pull requests. Some are follow-ups to work documented elsewhere — the record-type gaps under **UI & Validation**, for instance, are the remaining edges of the builder work described in the [SPF and NAPTR notes](spf-naptr.md).

This list has not been pruned as items landed, so a few are now historical; where that is the case it is marked inline. [Development](development.md#what-ci-gates-on) is the authoritative description of what CI runs today.

## UI & Validation

- Add per-type specialized UI fields for record types that have structured content (SRV, TLSA, SSHFP, NAPTR). (Partially implemented for SRV.)
- Display an example/tooltip for content format per record type.
- Add stricter `content` validations for `CNAME`, `NS`, `PTR`, `MX` hostnames using public hostname validation.
- Allow enabling/disabling types in UI based on zone/provider capabilities (some providers disallow `ANAME/ALIAS` or require plan-level features).

## Backend & Testing

- Add a lightweight in-memory sqlite integration test that runs with real `sqlite3` and toggles `better-sqlite3` absence to exercise both drivers.
- ~~Add a CI job to run tests in a `sqlite3`-only environment (simulate `better-sqlite3` being missing).~~ **Done** — the `unit_tests` job runs a `sqlite3-only` matrix leg with `better-sqlite3` removed.
- Add E2E tests with Playwright that create/edit/target DNS records including SRV and TLSA. (Playwright itself is in place; this is about extending coverage to the structured record types.)

## Import/Export & Data Handling

- Improve import format parsing for less-common record types and validate them on import.
- Add CSV-based examples & clean error reporting for import failures.

## Security & Hardening

- Add CI secrets scanning to prevent accidental leakage of API keys in PRs.

## Observability & Audit

- Provide better audit metadata for user actions (source IP, user agent) when available.
- Convert fire-and-forget audit writes to batched writes with retries to reduce risk of lost audit entries in the event of transient DB errors.

## Misc

- Add dynamic documentation pages for supported record types & examples in the app UI.
- Add a lightweight CLI to import/export records, run migrations, and validate configs.

---

## Not on this list

Three absences are deliberate, because they are limitations of the current design rather than backlog items:

- **Passkey login** is not "planned work in progress" — it is [disabled by design](security.md#passkeys-are-disabled), and returning it requires a verified WebAuthn implementation, not a scheduled task.
- **Windows Hello and Linux biometrics** are [not implemented](security.md#biometrics); only macOS Touch ID is.
- **An AI assistant in the UI.** Backend groundwork exists in four Rust crates and an unused React hook, but [nothing in the interface reaches it](architecture.md#the-ai-crates), and shipping it is not scheduled here.

Signing, notarization, an enabled updater, and package-manager channels are all likewise unbuilt; see [Distribution](security.md#distribution) for the current state.
