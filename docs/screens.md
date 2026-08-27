---
title: Screens and features
nav_order: 2
description: All 26 screens with screenshots and what you do on each.
---

# Screens and features

Every screen in Better Cloudflare, what it is for, and what you can do there.

The application is a **single route**. There are no per-screen URLs — you move around by opening zone workspaces, switching the action segment inside a workspace, or opening a utility workspace from the command bar. That is why this guide is organised by task rather than by path.

**About the screenshots.** All images use synthetic demo data: a fictional freight company, "Harborline Freight Systems", on RFC 2606 `.test` domains with RFC 5737 and RFC 3849 documentation IP ranges. No real account, zone or credential appears anywhere.

Screens are shown in the default **sunset** dark theme. A light-theme gallery closes each section; `oled` is a third theme, captured for the records table only. Contributors regenerating the set will want the [screenshot harness notes](development.md#the-documentation-screenshot-harness).

---

## Contents

- [Signing in](#signing-in)
- [The zone workspace](#the-zone-workspace)
- [Editing records](#editing-records)
- [Moving records around](#moving-records-around)
- [Understanding a zone](#understanding-a-zone)
- [Cloudflare zone controls](#cloudflare-zone-controls)
- [Portfolio and history](#portfolio-and-history)
- [Preferences](#preferences)

---

## Signing in

### Login

![Authentication card with an API Key dropdown, a masked password field, a Login button, Add New Key / Manage Key / Settings buttons, and a passkey security status panel](screenshots/dark/login.png)

Pick a stored credential from **API Key**, type its vault password, and press **Login** (Enter submits). The eye button unmasks the field while you check a typo.

The three secondary buttons add a new key, edit or delete an existing one (deletion is confirm-gated), and open the encryption settings dialog. While authentication runs, a spinner overlay covers the card.

The **Passkey security status** panel is the honest part of this screen: passkey registration and authentication are **disabled**, and the panel says so rather than offering a button that fails. See [Security](security.md#passkeys-are-disabled) for why. Biometric unlock appears only on macOS, where Touch ID is the sole implemented runtime.

### Encryption settings

![Encryption Settings modal with a PBKDF2 iterations field set to 310000, disabled key length and algorithm selects, Benchmark and Update buttons, an Enable OS Vault switch, and a last-benchmark reading](screenshots/dark/encryption-settings.png)

Tune how your stored API keys are protected. **PBKDF2 iterations** is the only free parameter — it is clamped to the range printed underneath (100,000 to 1,000,000). **Key length** and **algorithm** are shown but deliberately fixed at 256-bit AES-GCM.

**Benchmark** times a derivation at the current setting and reports it, so you can raise iterations until unlock takes as long as you are willing to wait. **Update** applies the change.

**Enable OS Vault** stores decrypted keys in the system vault. It exists to support passkey login, which is currently unavailable, so leaving it off costs you nothing today.

<details>
<summary>Light theme</summary>

![Login screen, light theme](screenshots/light/login.png)

![Encryption settings, light theme](screenshots/light/encryption-settings.png)

</details>

---

## The zone workspace

### Workspace tabs

![A row of workspace tabs for four zones, each with a drag grip and close button, with a drop indicator showing a tab being reordered](screenshots/dark/workspace-tabs.png)

Each open zone — and each utility view such as Settings, Tags, Audit or Registry — is a tab. Drag a tab by its grip to reorder it; a vertical indicator shows where it will land. Click to activate, use the × to close, or middle-click to close if you have enabled that preference.

Reordering works from the keyboard too: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>←</kbd> / <kbd>→</kbd> moves through tabs, and every reorder is announced in a screen-reader live region. With nothing open the strip reads "Select a domain to open a DNS workspace."

### DNS records table

![The DNS records table for harborline.test showing assigned nameservers, a search and filter row, Add Record, Copy selected and Paste buttons, and a table of A, AAAA and CNAME records with comments, TTLs and proxy toggles](screenshots/dark/dns-records-table.png)

The centre of the application, and where most work happens.

The zone's **assigned nameservers** sit at the top. Below them a filter row gives you a **search** box, a record **type** filter, a per-page selector (25 through 500, plus a bounded "All"), a refresh button, **Clear**, and page controls.

The action row holds **Add Record**, **Copy selected** and **Paste**, plus a copy-buffer chip with **Clear buffer** and a **Clear selection** control once a selection exists.

In the table itself, the Type, Name, Content, TTL and Proxy headers are click-to-sort. Each row offers a selection checkbox, truncated name and content that expand when clicked, inline editing, a proxy toggle, and copy-name / copy-content buttons. The status bar tracks record and visible counts. If the interface has had to bound how many records it retains or renders, an amber notice says so rather than silently truncating.

### Row actions

![A right-click context menu over a record row offering Edit, Copy, Open in browser, Clone and Delete](screenshots/dark/record-row-context-menu.png)

Right-click any row for **Edit**, **Copy**, **Open in browser** (only when the record resolves to something openable), **Clone**, and a destructive **Delete** below a separator.

The optional Actions column renders the same menu from the same definition in `src/components/dns/record-actions.ts`, so the right-click menu and the dropdown can never drift apart.

### Bulk edit bar

![A sticky bottom bar reading 5 records selected, with Set TTL, Proxy On, Proxy Off, Export, Deselect All and Delete 5 controls, above a table with five rows checked](screenshots/dark/bulk-edit-bar.png)

Tick one or more rows and a sticky bar appears. From it you can **Set TTL** across the selection (Auto, 1 min, 5 min, 1 hour, 1 day), turn proxying **on** or **off**, **Export** the selection as JSON, or **Deselect All**.

Deletion is two-step by design: **Delete N** arms the action, **Confirm Delete (N)** performs it, and **Cancel** backs out.

<details>
<summary>Light theme</summary>

![Workspace tabs, light theme](screenshots/light/workspace-tabs.png)

![DNS records table, light theme](screenshots/light/dns-records-table.png)

![Record row context menu, light theme](screenshots/light/record-row-context-menu.png)

![Bulk edit bar, light theme](screenshots/light/bulk-edit-bar.png)

</details>

---

## Editing records

### Add record dialog

![Add DNS Record dialog with TXT selected, a TTL preset row with suggested chips, a name field, a content area noting that quotes are balanced automatically, and a DMARC builder with labelled policy fields](screenshots/dark/add-record-dialog.png)

This is where the record builders live, and it is the screen that most distinguishes the app from a generic DNS editor.

Choose a **type** from a searchable select, a **TTL** from presets (with one-click suggested values and a custom numeric option), a **name** — `@` for the apex — and the **content**. Comments are optional; **Priority** appears only for MX, and the **Proxied through Cloudflare** switch only for A, AAAA and CNAME.

For structured types, a guided builder replaces freehand text. TXT additionally offers a **helper** select (Auto-detect, Generic, SPF, DKIM, DMARC) — pick DMARC and you get labelled `p=`, `rua=`, `ruf=`, `adkim=`, `aspf=`, `pct=`, `sp=`, `fo=`, `ri=` and `rf=` fields with inline explanations, instead of composing a semicolon-delimited string by hand. There are 24 builders covering 25 record types; HTTPS and SVCB share one.

Content is stored as RFC 1035 character-strings: quotes are balanced and escaped automatically, values over 255 bytes are split into adjacent quoted strings, and **Normalize quotes** applies the repair on demand so you can see what will be saved.

Validation is live. Warnings collect in an amber box and the submit button changes to **Review Warnings** → **Create Anyway**, with **Go Back** available — you are never blocked from creating a record the tool merely dislikes, but you cannot do it by accident. Closing a dirty draft prompts before discarding.

<details>
<summary>Light theme</summary>

![Add record dialog, light theme](screenshots/light/add-record-dialog.png)

</details>

---

## Moving records around

### Import and export

![Import DNS Records dialog with a format selector set to JSON and a textarea containing record JSON](screenshots/dark/import-export.png)

The Import/Export segment has two cards. **Export Records** writes the zone as JSON, CSV or BIND. **Import Records** opens the dialog above: choose a **format**, paste your data, and press **Import Records** to parse it. Oversized input is refused with a diagnostic rather than being truncated.

Parsing never writes anything directly — it always hands off to the preview.

### Import preview

![Import Preview dialog showing parsed, retained, valid and selected counts, a warning that two records were rejected by safety limits, per-record checkboxes, and Dry Run, Import Selected and Cancel controls](screenshots/dark/import-preview.png)

The safety gate between a pasted blob and your zone.

The summary line reports what happened to every input record — **parsed**, **retained**, **valid**, **selected** — and the counts rarely match, which is the point. A yellow notice explains anything rejected by safety limits, with diagnostics beneath it.

Tick the records you actually want (invalid rows are disabled and cannot be selected), or use **Select all retained valid** / **Clear selection**. Imports over 200 rows paginate. Tick **Dry Run** to walk the whole path without writing, then **Import Selected** to commit.

### Zone compare

![Zone Compare showing harborline.test against shipwright.test with count chips for identical, different and zone-exclusive records, a Show identical toggle, a Copy 7 missing link, and a diff table with status badges](screenshots/dark/zone-compare.png)

Pick a zone in **Compare With**, press **Compare**, and get a diff. Count chips summarise identical, different, and records exclusive to each side; **Show identical** expands the noise when you want it.

When the other zone has records yours lacks, a **Copy N missing → current** link brings them across in one action — with the same cross-zone hostname rewriting used by copy and paste. The table shows a coloured status badge per record and renders changed TTLs as `old → new`.

<details>
<summary>Light theme</summary>

![Import and export, light theme](screenshots/light/import-export.png)

![Import preview, light theme](screenshots/light/import-preview.png)

![Zone compare, light theme](screenshots/light/zone-compare.png)

</details>

---

## Understanding a zone

### Zone topology

![Zone topology graph in light theme: the zone node fans out to Email and Web area groups, and docs.shipwright.test follows a CNAME chain through two hostnames to A and AAAA addresses annotated with country geolocation and a PTR result, with pan, zoom, annotate, copy and export controls above](screenshots/light/zone-topology.png)

Renders the zone as a graph: records are grouped into Web, Email, Infra and Other areas, and CNAME chains are followed all the way to their terminal addresses. The graph fits and centres itself in the viewport when it first renders. Shown here in the light theme, which suits the Mermaid rendering particularly well.

Pan and zoom the viewport, normalise back to 100%, or open **Full window** for a lightbox view. The refresh button re-resolves; **Discover services** probes TCP services on the resolved addresses. Resolution enriches nodes with PTR results and geolocation from the `bc-topology` crate.

**Copy** and **Export** menus offer the Mermaid source, SVG, PNG and PDF — each individually enabled in settings, with file export handled by the Rust backend. A search and filter panel finds nodes by name or record type with a live match count and a clickable result list that reveals the node in the graph. Annotations can be attached to the diagram unless disabled.

The Mermaid output is sanitized before rendering (`sanitizeTopologySvg` in `ZoneTopologyTab.tsx`), since node labels are built from zone data.

A **Full / Email / Services** switch above the controls picks which graph is drawn; the summary header names the active one, and Copy and Export always act on the graph currently shown.

![Email graph in the light theme, full window: the zone node leads to five groups - Inbound mail with two MX hosts labelled by priority, Authentication with the SPF record fanning out to ip4 and include mechanisms plus DKIM selectors and the DMARC policy with its aggregate-report address, Transport & reporting with MTA-STS and TLS-RPT, Client autodiscovery with the autoconfig CNAME and autodiscover SRV resolved to geolocated addresses, and Cloudflare Email Routing with four rules forwarding to destination addresses, the disabled catch-all drawn dashed](screenshots/light/zone-topology-email.png)

The **Email** graph reads the zone's mail story left to right: inbound MX hosts and their resolved addresses, then the authentication records (SPF parsed into its `ip4`, `ip6`, `include`, `a`, `mx` and `redirect` mechanisms with the `all` qualifier and lookup count in the node, DKIM selectors, DMARC policy and report addresses), the transport and reporting policies (MTA-STS, TLS-RPT, BIMI) when present, client autodiscovery names and SRV endpoints, and finally the zone's Cloudflare Email Routing rules with their forward, worker or drop actions. Disabled rules are dashed. A zone with no MX, SPF, DKIM or DMARC records shows an empty-state note in place of the graph.

![Services graph in the dark theme, full window: hostnames grouped into Proxied by Cloudflare and DNS-only origins boxes, each linked by A, AAAA, CNAME and SRV edges to shared address nodes and CNAME targets that chain on to geolocated addresses, and a Workers box where route patterns lead to their scripts](screenshots/dark/zone-topology-services.png)

The **Services** graph leaves mail out and groups the remaining hostnames by how they are delivered: proxied through Cloudflare, served from DNS-only origins, pointed at a recognised third-party platform (CloudFront, Fastly, Vercel, Netlify and the like, one provider node each), or routed to a Worker. Each hostname shows its proxy state and TTL, edges are labelled by record type, an address that several names share appears once, and after **Discover services** the open ports found on an address hang off it (solid for confirmed, dotted for inferred).

### Domain audit

![Domain audits panel with Email, Security and Hygiene check-group checkboxes, a Show passed switch, a Refresh records button, and findings badged INFO or WARNING each with an Override action](screenshots/dark/domain-audit.png)

Best-practice checks run against the records currently loaded for the zone — no extra queries, no data leaving the app.

Three groups can be toggled independently: **Email** (SPF, DKIM, DMARC, MX), **Security** (CAA policy), and **Hygiene** (private and bogon IPs, TTL outliers, CNAME conflicts, chains and cycles, NS redundancy, SOA review, TXT sprawl, SRV format, deprecated SPF record types, domain expiry). **Show passed** reveals the checks that succeeded.

Every finding carries a severity — fail, warn, info or pass — and an **Override** action that acknowledges it; overridden findings are struck through and tagged, and **Restore** undoes it. Where a check can suggest a fix, **Add suggested record…** prefills the Add Record dialog. A **Clear N overrides** button appears once you have any.

The panel states its own limitation at the bottom: these are heuristics based only on records present in the zone.

### Propagation checker

![DNS Propagation Checker with a domain field, type selector, Check button, interval selector and Watch button, showing a Fully Propagated badge and per-resolver results from Cloudflare, Google, Quad9, OpenDNS, CleanBrowsing and AdGuard with latencies](screenshots/dark/propagation-checker.png)

Query one name across several independent public resolvers at once and see whether they agree.

Enter a **domain**, pick a record **type**, press **Check**. The badge reads **Fully Propagated** (or **Propagated (≥ N%)** when a lower consensus threshold is set) or **Inconsistent**, followed by how many resolvers agreed out of how many answered; resolvers that timed out or refused the query are listed but do not count toward the threshold. Each resolver gets a row with its address, response code, answer and latency; rows can also report "No records", and failures offer **Retry**.

The collapsible **Resolver options** card below the query chooses what gets asked and how. A catalogue of 23 public resolvers is grouped by provider with the address and region beside each checkbox; 12 are enabled by default (the rest are secondaries, regional or slower resolvers you can opt into), and **Defaults**, **All** and **None** reset the selection in one click. **Custom resolvers** accepts bare IPv4/IPv6 addresses (up to 32) and lists them as removable chips — every enabled resolver, custom ones included, sees the hostname you query. **Timeout** (500–15000 ms) and **Attempts** (1–3) apply per resolver; **Consensus** (100, 90, 75 or 50 %) is the share of answering resolvers that must agree before the check counts as propagated. Everything here persists with your other preferences.

Set an **interval** (5 seconds to 5 minutes) and press **Watch** to poll until you press **Stop** — useful while waiting out a TTL after a cutover. A footer records the time and sequence number of the last check.

### Analytics

![Zone Analytics with a time-range selector, summary cards for requests, bandwidth, threats and page views, two sparkline charts, and a timeseries table](screenshots/dark/analytics-panel.png)

Read-only traffic figures from Cloudflare for the selected range: summary cards for **requests**, **bandwidth**, **threats** and **page views**, sparklines for requests and bandwidth over time, and a scrollable **timeseries** table.

Notices appear when a large result has been downsampled for the chart or when the table is showing a representative subset, so the numbers are never quietly misleading.

<details>
<summary>Other themes for this section</summary>

Zone topology is shown above in the light theme; here it is in the default dark theme.

![Zone topology, dark theme](screenshots/dark/zone-topology.png)

![Email graph, dark theme](screenshots/dark/zone-topology-email.png)

![Services graph, light theme](screenshots/light/zone-topology-services.png)

![Domain audit, light theme](screenshots/light/domain-audit.png)

![Propagation checker, light theme](screenshots/light/propagation-checker.png)

![Analytics panel, light theme](screenshots/light/analytics-panel.png)

</details>

---

## Cloudflare zone controls

### Zone settings

![Zone settings card with per-page override, unsupported record types and reopen-on-launch controls](screenshots/dark/zone-settings.png)

Despite the position in the zone tab strip, these are **local application overrides for this zone**, not Cloudflare zone configuration.

**Per-page override** overrides the global default record page size for this zone only. **Unsupported record types** controls whether non-Cloudflare record types appear in the Add Record type dropdown here. **Reopen on launch** decides whether this zone comes back when tabs restore. Each change confirms with a toast.

### Cache

![Cache card with a development mode switch, a cache level selector explaining Basic, Aggressive and Simplified, and a purge section with Purge everything and a purge-URLs textarea](screenshots/dark/cache.png)

Real Cloudflare cache controls. **Development mode** temporarily bypasses the cache — Cloudflare re-disables it automatically after a few hours. **Cache level** switches between Basic, Aggressive and Simplified, with the trade-off of each spelled out inline and the active one highlighted.

**Purge cache** offers a confirm-gated **Purge everything**, or a textarea for specific URLs, one per line. URL validation warns but does not block, so you can still force a purge the validator dislikes.

### SSL/TLS

![SSL/TLS card with encryption mode and minimum TLS version selectors and switches for TLS 1.3, Always Use HTTPS, Automatic HTTPS Rewrites and opportunistic encryption](screenshots/dark/ssl-tls.png)

**Encryption mode** (Off, Flexible, Full, Full strict) controls how Cloudflare connects to your origin. **Minimum TLS version** (1.0–1.3) constrains client connections to the edge. Switches cover **TLS 1.3**, **Always Use HTTPS**, **Automatic HTTPS Rewrites** and **opportunistic encryption**, each with a one-line explanation. Settings that cannot be read render as "Unavailable" rather than as a misleading default.

### Firewall and WAF

![Firewall and WAF panel with Rules, IP Access and WAF sub-tabs, an Add Firewall Rule form, and a rule list with action badges for BLOCK, MANAGED_CHALLENGE, JS_CHALLENGE and ALLOW](screenshots/dark/firewall-panel.png)

Three sub-tabs, each with a live count.

**Rules** takes a filter expression, an action and an optional description, and creates a firewall rule. Existing rules show an action badge, description, paused marker and expression, and can be edited inline or deleted. **IP Access** manages address and range rules with a mode and notes. **WAF** lists rulesets read-only.

### Workers

![Worker Routes panel with a New Route form taking a pattern and script name, and four existing routes each with a delete button](screenshots/dark/workers-panel.png)

Map URL patterns to Worker scripts for this zone. Enter a **pattern** and a **script name**, press **Create Route**. Each existing route shows `pattern → script` with a delete button.

### Email routing

![Email Routing panel with an enabled status pill, a New Routing Rule form taking a rule name, match address and forward-to address, and two existing rules](screenshots/dark/email-routing-panel.png)

Shows whether Cloudflare Email Routing is enabled for the zone and its readiness status, then lets you create forwarding rules: a **rule name**, a **match address**, a **forward to** address, and an enabled switch. Existing rules display `matcher → action` with their active state and a delete button.

<details>
<summary>Light theme</summary>

![Zone settings, light theme](screenshots/light/zone-settings.png)

![Cache, light theme](screenshots/light/cache.png)

![SSL/TLS, light theme](screenshots/light/ssl-tls.png)

![Firewall panel, light theme](screenshots/light/firewall-panel.png)

![Workers panel, light theme](screenshots/light/workers-panel.png)

![Email routing panel, light theme](screenshots/light/email-routing-panel.png)

</details>

---

## Portfolio and history

### Registry monitor

![Registry Monitoring listing five domains across Porkbun and Namecheap credentials with health icons, status tags, days to expiry, and transfer-lock and auto-renew indicators](screenshots/dark/registry-monitor.png)

Domain expiry across every registrar you use, in one list — Cloudflare, Porkbun, Namecheap, GoDaddy, Google Cloud Domains and Name.com.

**Add Registrar** stores a credential; configured registrars appear as chips you can remove. Domains sort critical → warning → healthy, then by expiry date, so whatever is about to lapse is at the top. Each row shows a health icon, the domain, its registrar, a status tag such as `PENDING_TRANSFER`, colour-coded days-to-expiry, and transfer-lock and auto-renew indicators.

Expanding a row reveals registration dates, DNSSEC and privacy state, nameservers, per-check health results, and a **Copy** button for the summary. Every registrar client lives in the `bc-registrar` crate, so this view is served entirely by the Rust backend.

### Tag manager

![Tag manager with a zone selector, a new-tag field, and a table of tags showing usage counts, linked records and rename or delete actions](screenshots/dark/tag-manager.png)

Tags are **local-only** labels you attach to records — they are stored by this application and never sent to Cloudflare, which makes them useful for the categories Cloudflare has no field for.

Pick a **zone**, type a name, press **Add tag**. The table lists each tag with how many records use it, up to two linked record names plus a "+N more" summary, and inline rename or delete. Tags can also be created from a record's expanded panel in the records table.

### Audit log

![Audit log with Refresh, Clear, JSON and CSV buttons, a search box, a limit selector, quick filter presets, and a table of timestamped operations such as dns.record.update and api_key.decrypt](screenshots/dark/audit-log.png)

A local record of what this application did — `dns.record.create`, `dns.record.update`, `dns.record.delete`, `dns.records.export`, `api_key.decrypt`, `firewall.rule.create` and so on — with timestamp, operation, resource and expandable details.

Search across entries, cap the row **limit**, and use the one-click presets: Errors, Auth Ops, DNS Ops, API Keys, Zone Settings, Cache Ops, Last 24h, Last 7d, Today. **Add filter** builds precise conditions from a field (Operation, Resource, Timestamp, Details), an operator (equals, contains, starts with, matches regex, comparison operators, and their negations) and a value. Columns sort.

**JSON** and **CSV** export the current view; the confirmation toast offers to open the containing folder. **Clear** empties the log and can be confirm-gated in settings.

The log is persisted by the Rust backend. When the frontend is rendered outside the desktop shell — under the dev server, or in the jsdom tests — the panel simply reads "Audit log is only available in the desktop app."

### Notifications

![Notifications tab with the Inbox view selected: a status line reading last checked, zones and next check, Check now / Mark all read / Archive all read buttons, All / Unread / Archived filters, kind and zone selectors, a search box, and items grouped under Today and Yesterday — a critical domain-expiry notice and a record change showing the before and after value](screenshots/dark/notifications.png)

A **bell** in the command bar carries the unread count and opens the Notifications tab. The desktop backend runs a background monitor while the app is open (and a catch-up pass at login) that watches two things: **domain expiry** — registrar data when a registrar is configured, public RDAP otherwise, announced at configurable milestones (90, 60, 30, 14, 7, 3 and 1 days by default, plus expiry itself) — and **record changes made outside this app**, found by comparing each zone against its last snapshot so the notice can show the old and new value. Edits made from this app are recognised and skipped; edits made through the local MCP server are reported like any other external change.

The **Inbox** groups items by day. Each one shows a severity dot, kind, zone, relative time (full timestamp on hover) and, for record changes, the fields that changed with `before → after`. Per-item actions: **Mark read** / **Mark unread**, **Archive** (kept under the Archived filter, pruned after 90 days by default) or **Unarchive**, **Dismiss** (deletes), and **Go to record**, which opens the zone tab, narrows the table to the record and flashes its row — or **Go to zone** for expiry notices. The header offers **Check now**, **Mark all read** and **Archive all read**; the filters are All / Unread / Archived, kind, zone and free text.

The **Settings** view of the same tab configures everything, in six sections:

| Section   | Controls                                                                                                                                                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service   | Master switch, Pause / Resume, Run now (records, expiry or both), catch-up on launch, record poll interval (5 min to 24 h), expiry refresh, RDAP cache, max zones per pass, max backoff, a live status block and confirm-gated resets of the expiry ledger, snapshots and inbox. |
| Kinds     | Per kind (domain expiry, record changes, service): enabled, severity (auto / info / warning / critical), OS notification. Record changes add Added / Changed / Removed toggles and the list of fields that count as a change.                                                    |
| Expiry    | Editable milestone chips (1–365 days, up to twelve), notify when expired, data source (auto / RDAP / registrar), warning and critical thresholds.                                                                                                                                |
| Zones     | All zones or only selected, Monitor all / none, and a table with per-zone monitoring, expiry and record-change switches, mute with 1 h / 8 h / 24 h / 7 d quick picks or a custom deadline, last check, snapshot size and last error.                                            |
| Delivery  | Quiet hours (window, days, time zone, silence or hold), OS notifications (enabled and minimum severity; shown as unavailable in builds without the plugin), in-app toast threshold and the bell badge.                                                                           |
| Retention | Auto-archive read items after N days or never, delete archived items after N days or never, maximum inbox size, keep record snapshots.                                                                                                                                           |

Switches save immediately; typed values save 400 ms after the last keystroke, are clamped to their allowed range and say so inline. Every change is written as one normalized object, so the Rust service and the panel always agree. **Restore defaults** asks first.

Outside the desktop shell the bell is not rendered and the tab reads "Notifications are only available in the desktop app."

<details>
<summary>Light theme</summary>

![Registry monitor, light theme](screenshots/light/registry-monitor.png)

![Tag manager, light theme](screenshots/light/tag-manager.png)

![Audit log, light theme](screenshots/light/audit-log.png)

![Notifications, light theme](screenshots/light/notifications.png)

</details>

---

## Preferences

### Session settings

![Session settings with General, Columns, Topology, Audit, MCP and Profiles sub-tabs, showing general options including rewrite copied record domains, preview pasted records, auto refresh and per-page defaults](screenshots/dark/settings.png)

Opens as its own workspace tab, with six sub-tabs.

**General** covers **Rewrite copied record domains** (the opt-out for cross-zone hostname rewriting), **Preview pasted records**, **Auto refresh** — which pauses while you are editing — **Default per-page**, **Loader timeout**, **Unsupported record types**, **Reopen last tabs**, **Middle-click closes tabs**, **Confirm logout**, **Confirm window close**, and idle **Auto logout**. Every change saves immediately with a toast.

**Topology** holds around twenty resolver, geolocation and export options: hop limits, resolver mode, DNS or DoH provider, lookup timeouts, opt-outs for PTR and geo lookups, TCP service lists, and export folder presets. **Audit** configures audit categories, export folder and destination-confirmation behaviour. **Profiles** exports and imports the whole settings set. **Columns** and **MCP** are covered below.

### Column picker

![Settings Columns tab showing per-table column groups for DNS records, zone compare and audit log, with counts, reset buttons, and column checkboxes where identity columns are marked Always on](screenshots/dark/column-picker.png)

Choose which columns each table shows, per table.

Each group — DNS records, zone compare, audit log — has an "X of Y shown" counter, a description of the table it controls, a **Reset** button, and one checkbox per column with an explanation of what it holds.

Two guards prevent you making a table useless: identity columns that let you recognise a row are locked and tagged **Always on**, and if you get down to a single visible column, that last one is locked too and tagged **Last column**.

### MCP tool permissions

![MCP settings showing server status with its local URL, an enable switch, bind host and port fields, and a searchable tool permission list reading 34 of 53 classified tools enabled](screenshots/dark/mcp-tool-permissions.png)

Better Cloudflare can expose its Cloudflare operations to local MCP clients over JSON-RPC, protocol version `2024-11-05`. **The server is off by default.**

The rows above the permission panel show **server status** with its URL, the **enable** switch, and the **bind host** and port — `127.0.0.1:8787` by default — applied with **Apply + restart**. Authentication is by bearer token.

The permission panel is the important part. Search by tool, capability, category, risk or ID; a live summary reads "N of M classified tools enabled". Tools are grouped by category with **Select visible** and **Clear visible** shortcuts, and each carries risk labels such as `CREDENTIAL ACCESS`.

Enabling anything write, bulk, destructive, credential-touching or administrative raises a modal that lists exactly which tools you are about to grant, requiring **Confirm enable**. Unclassified tools are always denied and cannot be enabled at all — an unrecognised tool fails closed rather than inheriting a permissive default.

<details>
<summary>Light theme</summary>

![Session settings, light theme](screenshots/light/settings.png)

![Column picker, light theme](screenshots/light/column-picker.png)

![MCP tool permissions, light theme](screenshots/light/mcp-tool-permissions.png)

</details>

---

## Themes

Three themes ship: **sunset** (the dark default), **light**, and **oled** (deep black). The `T` button in the title bar cycles them.

<details>
<summary>The records table in all three themes</summary>

![Records table, sunset theme](screenshots/dark/dns-records-table.png)

![Records table, light theme](screenshots/light/dns-records-table.png)

![Records table, OLED theme](screenshots/oled/dns-records-table.png)

</details>

See [the design system notes](design-system.md) for the token model behind them.

---

## See also

- [Architecture](architecture.md) — the desktop shell, the crate map, how data flows
- [Security model](security.md) — encryption, storage, and what does not work
- [Development](development.md) — how these screenshots are produced, and the rest of the contributor tooling
- [Documentation hub](index.md)
