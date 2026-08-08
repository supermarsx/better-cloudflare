---
title: Reference
nav_order: 5
has_children: true
has_toc: false
description: Supporting reference material — build and command details, design tokens, record formats, and planned work.
---

# Reference

Supporting material behind the main guides. Start with [Screens and features](screens.md), [Architecture](architecture.md) and the [Security model](security.md) for the product itself; these pages cover the details underneath.

| Guide                                       | What it covers                                                     |
| ------------------------------------------- | ------------------------------------------------------------------ |
| [Tauri migration guide](tauri-migration.md) | Desktop backend, Tauri command reference, build and bundle output  |
| [Design system](design-system.md)           | Token model, theming, glass/sunset UI conventions                  |
| [SPF and NAPTR notes](spf-naptr.md)         | What the two formats contain, the guided builders, and the SPF CLI |
| [Future work](future-work.md)               | Planned work — not released capability                             |

The [project specification](https://github.com/supermarsx/better-cloudflare/blob/main/spec.md) sits alongside these: it states the target product contract, with implementation-status annotations marking what is and is not built.

Contributor tooling — dev commands, the test runner, CI gates and the documentation screenshot harness — lives on the top-level [Development](development.md) page rather than in this section.
