#!/usr/bin/env tsx
import { promises as dnsPromises } from "node:dns";
import { parseSPF, SPFRecord } from "../src/lib/spf";

async function getSPF(domain: string): Promise<string | null> {
  try {
    const txts = await dnsPromises.resolveTxt(domain);
    for (const rec of txts) {
      const txt = rec.join("");
      if (txt.toLowerCase().startsWith("v=spf1")) return txt;
    }
    return null;
  } catch (e) {
    console.error("dns error", e);
    return null;
  }
}

async function expandIncludes(
  record: SPFRecord,
  seen = new Set<string>(),
  depth = 0,
): Promise<SPFRecord> {
  if (depth > 5) return record;
  const mechPromises = record.mechanisms.map(async (m) => {
    if (m.mechanism === "include" && m.value && !seen.has(m.value)) {
      seen.add(m.value);
      const t = await getSPF(m.value);
      if (t) {
        const parsed = parseSPF(t);
        if (parsed) {
          const expanded = await expandIncludes(parsed, seen, depth + 1);
          return expanded.mechanisms; // flatten
        }
      }
    }
    return [m];
  });
  const mechArrays = await Promise.all(mechPromises);
  return { version: record.version, mechanisms: mechArrays.flat() };
}

async function main() {
  const [, , domain] = process.argv;
  if (!domain) {
    console.error("Usage: check-spf <domain>");
    process.exit(2);
  }
  const txt = await getSPF(domain);
  if (!txt) {
    console.error("No SPF record found for", domain);
    process.exit(1);
  }
  console.log("SPF TXT:", txt);
  const parsed = parseSPF(txt);
  console.log("Parsed:", JSON.stringify(parsed, null, 2));
  const expanded = await expandIncludes(parsed!);
  console.log(
    "Expanded mechanisms:",
    JSON.stringify(expanded.mechanisms, null, 2),
  );
}

main();
