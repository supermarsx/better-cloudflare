---
title: Retired
nav_order: 99
has_children: true
has_toc: false
description: Superseded documents, kept for history. Do not treat these as descriptions of current behaviour.
---

# Retired

Documents in this section describe designs that were **superseded or never shipped**. They are kept because they explain how earlier decisions were reasoned about, not because they describe how Better Cloudflare works today.

Do not infer current behaviour from anything in this section. The [Architecture](architecture.md) and [Security model](security.md) pages are authoritative.

| Document                                        | Status                                                                                                                                                       |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Passkey architecture](passkey-architecture.md) | **Retired.** Describes an Express/SQLite server design that was never the desktop implementation. See [Security](security.md#passkeys-are-disabled) instead. |

Passkey login and registration are **disabled** in the shipped desktop application; both fail closed by design, and only listing and deleting legacy credentials works, for recovery.
