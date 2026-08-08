---
title: SPF and NAPTR notes
parent: Reference
nav_order: 3
description: What SPF and NAPTR records actually contain, the guided builders for both, and the check-spf CLI.
---

# SPF and NAPTR

Two record formats that are pure text on the wire, easy to get subtly wrong, and unpleasant to debug once wrong. Better Cloudflare gives each a guided builder, a validator, and — for SPF — a resolver-backed simulator. This page explains the formats first, then the tooling.

## Contents

- [SPF](#spf)
- [The SPF builder](#the-spf-builder)
- [The check-spf CLI](#the-check-spf-cli)
- [NAPTR](#naptr)
- [The NAPTR builder](#the-naptr-builder)
- [Where the code lives](#where-the-code-lives)

Both formats are edited through the same dialog. Structured types replace the freehand content box with labelled fields, and the field set is chosen from the record type — with TXT additionally offering a helper select, since a TXT record may be an SPF policy, a DKIM key, a DMARC policy, or nothing in particular:

<img src="screenshots/dark/add-record-dialog.png" width="720" alt="The Add DNS Record dialog with TXT selected: a searchable type select, a TTL preset row of one-click chips, a name field, a content area noting that quotes are balanced automatically, and a guided builder below it exposing labelled policy fields instead of a single freehand string">

The screenshot shows the DMARC helper. Choosing **SPF** from the same select swaps in the SPF builder described below; choosing the **NAPTR** record type swaps in the NAPTR builder. In every case the builder composes the string, and the composed string is what gets saved — you can always see and hand-edit the result.

## SPF

An SPF record (RFC 7208) is a TXT record at the domain apex that states which hosts are allowed to send mail as that domain. It is one line, and it is read strictly left to right:

```
v=spf1 ip4:203.0.113.0/24 include:_spf.harborline.test mx -all
```

**The version prefix `v=spf1` is mandatory** and must come first. A TXT record without it is not an SPF record, and the parser here treats its absence as a hard failure rather than guessing.

Everything after it is a sequence of **mechanisms**, each optionally preceded by a **qualifier**, followed by any **modifiers**.

### Qualifiers

A qualifier says what happens when a mechanism _matches_. It is a single character in front of the mechanism, and `+` is the default when you omit it.

| Qualifier | Result     | Meaning                                                          |
| --------- | ---------- | ---------------------------------------------------------------- |
| `+`       | `pass`     | This host is authorised. The default, and usually left implicit. |
| `-`       | `fail`     | This host is not authorised; reject.                             |
| `~`       | `softfail` | Not authorised, but accept and mark. The usual rollout setting.  |
| `?`       | `neutral`  | No assertion either way.                                         |

The qualifier that matters most is the one on the trailing `all`, because `all` matches everything: `-all` means "nothing else may send", `~all` means "nothing else should, but do not reject yet", and `?all` asserts nothing at all and is close to having no policy.

### Mechanisms

Evaluation stops at the first mechanism that matches, so **order is significant** and `all` belongs last.

| Mechanism | Takes           | Matches when                                                               |
| --------- | --------------- | -------------------------------------------------------------------------- |
| `ip4`     | address or CIDR | The sending IP is in that IPv4 range. Requires a value.                    |
| `ip6`     | address or CIDR | The sending IP is in that IPv6 range. Requires a value.                    |
| `a`       | optional domain | The sending IP is an A/AAAA address of the domain.                         |
| `mx`      | optional domain | The sending IP is an MX host of the domain.                                |
| `include` | domain          | The domain's own SPF record passes. Requires a value.                      |
| `exists`  | domain          | The (possibly macro-expanded) name resolves to anything. Requires a value. |
| `ptr`     | optional domain | Reverse lookup of the sending IP matches. Discouraged by RFC 7208.         |
| `all`     | —               | Always. Put it last, with the qualifier you mean.                          |

`include` is not textual inclusion. It runs a full SPF evaluation against the other domain and matches only if _that_ evaluation passes — which is why a broken record at a mail provider silently becomes your problem.

### Modifiers

Modifiers are `key=value` pairs and are not positional. Two are defined: `redirect=` replaces the whole policy with another domain's (only meaningful without an `all`, and **only one is permitted**), and `exp=` names a domain whose TXT record supplies the explanation string for a `fail`.

### The 10-lookup limit

This is the rule that breaks real deployments. RFC 7208 §4.6.4 caps an evaluation at **ten DNS-querying terms** — `include`, `a`, `mx`, `ptr`, `exists` and `redirect` all count, _including the ones inside the records you include_. Exceed it and conforming receivers return `permerror`, which in practice means your SPF stops working without any single record looking wrong.

Because the limit is a property of the whole include tree rather than of your record, you cannot see it by reading your own TXT string. The asynchronous validators here resolve the tree and count for you: `validateSPFAsync(domain)` and `validateSPFContentAsync(content, domain)` build the include/redirect graph and report when it would require more than ten lookups (the ceiling is a parameter, defaulting to 10). The same pass reports two other whole-tree faults: an include/redirect **cycle**, and **more than one SPF TXT record** published on the domain, which is itself a `permerror` regardless of what the records say.

## The SPF builder

Selecting **SPF** from the TXT helper replaces the content box with a mechanism editor. You add one term at a time from three controls — a **Qualifier** select (`+ pass`, `- fail`, `~ softfail`, `? neutral`), a **Mechanism** select (`ip4`, `ip6`, `a`, `mx`, `include`, `exists`, `ptr`, `all`), and a **Value** field whose placeholder changes to suit the mechanism — and the composed record is rebuilt and shown as you go. Existing content is parsed back into the same editor, so the builder is equally usable for editing a record you did not write.

Validation runs in two tiers:

**Synchronous**, on every keystroke, from `validateSPF`: unknown mechanisms, `ip4`/`ip6` without a value, `include`/`exists`/`redirect` without a domain, and more than one `redirect` modifier. Hostname and CIDR values are additionally sanity-checked, IPv4 and IPv6 both.

**Resolver-backed**, on demand, from the two buttons at the foot of the builder:

- **Graph** walks the `include` and `redirect` chain from the zone's domain and returns the dependency graph — nodes, edges, the total lookup count, and whether the graph is cyclic. This is how you find out you are at nine lookups before a provider pushes you to eleven.
- **Simulate** evaluates the policy against an IP address you supply and reports the result the way a receiving mail server would. It is the difference between believing `include:` covers your sender and demonstrating it.

In the desktop app both are answered by the Rust `bc-spf` crate, through the `simulate_spf` and `spf_graph` Tauri commands — the resolver work happens in Rust, not in the webview. The crate mirrors the TypeScript surface (`parse_spf`, `ip_matches_cidr`, `simulate_spf`, `build_spf_graph`), and the same operations are exposed to MCP clients as SPF tools, subject to the [per-tool permission model](security.md#mcp-server).

Macro expansion (`%{s}`, `%{d}`, `%{i}` and friends, used by `exists:` policies) is implemented in `expandSPFMacro` and applied during simulation, so a macro-based record simulates as it would evaluate rather than being skipped.

## The check-spf CLI

For inspecting a domain you do not administer — or from a terminal, without launching the app:

```bash
npm run check-spf harborline.test
```

`scripts/check-spf.ts` fetches the domain's TXT records, picks the one beginning `v=spf1`, prints it raw, prints the parsed structure as JSON, and then prints the mechanism list with every `include` recursively expanded and flattened. Expansion is depth-limited to five levels and tracks already-seen domains, so a cyclic policy terminates instead of spinning.

Reading the flattened output is the fastest way to answer "what does this record actually authorise", because it collapses a tree of provider includes into a single list of terms.

## NAPTR

NAPTR (RFC 3403) is a rewriting rule. A client looking up a name gets back one or more NAPTR records, sorts them, and applies the first whose service and flags it understands — most commonly to turn a telephone number into a SIP URI (ENUM, RFC 6116).

The content is **six space-separated fields, in a fixed order**:

```
order preference flags service regexp replacement
```

```
100 10 "U" "E2U+sip" "!^.*$!sip:info@harborline.test!" .
```

| Field         | What it is                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------- |
| `order`       | Integer. Rules are processed in ascending order; a lower order must be tried first.                       |
| `preference`  | Integer. Tie-break within the same `order`. Purely advisory to the client.                                |
| `flags`       | Terminal-rule marker. See below.                                                                          |
| `service`     | The service this rule resolves, e.g. `E2U+sip`.                                                           |
| `regexp`      | A delimited substitution applied to the input string, or empty (`""`) when `replacement` is used instead. |
| `replacement` | A domain name to query next, or `.` meaning "none — use the regexp result".                               |

**`regexp` and `replacement` are mutually exclusive.** A rule either rewrites the input with a regular expression or points at another name; using both is malformed.

### Flags

Any flag makes the rule _terminal_ — the client stops the DDDS loop and uses the result directly. The builder offers the four common ones:

| Flag | Meaning                                                              |
| ---- | -------------------------------------------------------------------- |
| `U`  | The regexp replacement produces a URI.                               |
| `S`  | The replacement points at an SRV record.                             |
| `A`  | The replacement points at an A/AAAA record.                          |
| `P`  | Protocol-specific processing; the meaning is defined by the service. |

An empty flags field (`""`) means the rule is non-terminal: the replacement names another NAPTR to look up, and the loop continues.

### The regexp field, and why quoting matters

The `regexp` field is a `sed`-style substitution — a delimiter, a pattern, the delimiter, a replacement, the delimiter — and it is full of characters that mean something to the DNS presentation format:

```
"!^.*$!sip:info@harborline.test!"
```

The exclamation marks are the delimiter (any character may be used, as long as it is used consistently and does not appear unescaped inside). Backreferences are `\1` through `\9`. Because the field routinely contains spaces, backslashes and dollar signs, it is **quoted**, and a naive split on whitespace destroys it.

That is exactly the bug the tokenizer in this repository exists to avoid. `splitNaptrTokens` (in `src/lib/dns/dns-parsers.ts`, mirrored for validation in `src/lib/dns/validation.ts`) is quote-aware: it tracks whether it is inside a quoted string, honours backslash escapes including three-digit `\DDD` decimal escapes, preserves escaping in the `replacement` position where it is semantically significant, rejects raw control characters, and requires exactly six fields. Input length and per-token length are bounded (16,384 and 4,096 characters) so a pathological paste cannot be used to hang the parser.

Validation then checks the parts: `order` and `preference` must be integers, `flags` must be a non-empty token, and `service` must be a non-empty token with no spaces.

## The NAPTR builder

Selecting the NAPTR record type gives you the six fields as six labelled controls rather than one string to count spaces in.

**Order** and **Preference** are numeric inputs with example placeholders. **Flags** and **Service** are each a preset select over a free-text field, so the common values are one click away and anything else remains typable: the flag presets are `U`, `S`, `A` and `P` with their meanings spelled out, and the service presets cover the ENUM set — `E2U+sip`, `E2U+sips`, `E2U+email`, `E2U+sms`, `E2U+tel`, `E2U+fax`, `E2U+web:http` and `E2U+web:https`. **Regexp** and **Replacement** are text fields with worked examples in the placeholder.

The builder composes the six fields into correctly quoted content, and parses existing content back into the fields using the same quote-aware tokenizer, so round-tripping an existing record does not mangle its `regexp`.

The `regexp` field gets its own checks, since it is where the mistakes are: the substitution must open with a non-alphanumeric delimiter, must contain at least two of them, must have a non-empty pattern and a non-empty replacement, and must not carry stray text after the final delimiter. Each failure is reported as a warning in plain language rather than as a rejection — and, as everywhere else in the Add Record dialog, a warning changes the submit button to **Review Warnings** rather than blocking you. You can still create a record the tool merely dislikes; you just cannot do it by accident.

Hostname-shaped fields are checked against DNS label rules (63-byte labels, 253-byte names, no empty labels, no leading or trailing hyphens) and the known-TLD list, which catches the typo class that is otherwise invisible until a client fails to resolve.

## Where the code lives

| Concern                        | File                                           |
| ------------------------------ | ---------------------------------------------- |
| SPF parse / compose / validate | `src/lib/dns/spf.ts`                           |
| SPF graph, macros, simulation  | `src/lib/dns/spf.ts`, and the `bc-spf` crate   |
| SPF builder UI                 | `src/components/dns/builders/SpfBuilder.tsx`   |
| SPF CLI                        | `scripts/check-spf.ts`                         |
| NAPTR parse / compose          | `src/lib/dns/dns-parsers.ts`                   |
| NAPTR validation               | `src/lib/dns/validation.ts`                    |
| NAPTR builder UI               | `src/components/dns/builders/NaptrBuilder.tsx` |
| Tauri commands                 | `parse_spf`, `simulate_spf`, `spf_graph`       |

Quoting and length handling for TXT content generally — not just SPF — lives in `src/lib/dns/character-string.ts`; see [Architecture](architecture.md#frontend-layout).

## See also

- [Screens and features](screens.md#add-record-dialog) — the Add Record dialog in full, and the rest of the per-type builders
- [Development](development.md#everyday-commands) — running the CLI and the rest of the tooling
