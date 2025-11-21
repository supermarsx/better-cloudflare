# SPF and NAPTR Support

This project now includes basic SPF and NAPTR support across the UI, server validation, and utilities.`

## SPF
- New parser and utilities at `src/lib/spf.ts`:
  - parseSPF(content): parses `v=spf1` strings into a structured format
  - composeSPF(record): composes structured SPF into a string
  - validateSPF(content): performs simple server-side checks for correct structure
  - getSPFRecordForDomain(domain): queries DNS TXT for an SPF record

- CLI tool: `scripts/check-spf.ts` - run `npm run check-spf <domain>` to fetch, parse and expand SPF include mechanisms for inspection.

## NAPTR
- NAPTR parsing and composition updated in the UI and server validation to handle quoted `regexp` strings.
  - UI: `AddRecordDialog` and `RecordRow` added NAPTR UI fields with quote-aware parsing & composition.
  - Server: `src/lib/validation.ts` added quote-aware tokenization for NAPTR validation.

## Linting
Small lint fixes were applied to new files and modified code to minimize warnings and errors for changed code.
Large repo lint cleanups remain and should be tackled in a follow-up PR.
