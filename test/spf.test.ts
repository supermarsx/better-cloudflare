import assert from "node:assert/strict";
import React from "react";
import { afterEach, test } from "node:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { SpfBuilder } from "../src/components/dns/builders/SpfBuilder";
import type { RecordDraft } from "../src/components/dns/builders/types";
import {
  parseSPF,
  composeSPF,
  validateSPF,
  SPFRecord,
  setDnsResolverForTest,
  ipMatchesCIDR,
} from "../src/lib/dns/spf";
/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  buildSPFGraphFromContent,
  validateSPFContentAsync,
  simulateSPF,
  expandSPFMacro,
} from "../src/lib/dns/spf";

function normalizeHostToken(token: string): string | null {
  const candidate = token.trim();
  if (!candidate) return null;
  for (const character of candidate) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x20 ||
      codePoint === 0x7f ||
      "/\\?#@:[]".indexOf(character) >= 0
    ) {
      return null;
    }
  }

  try {
    const parsed = new URL(`https://${candidate}/`);
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      return null;
    }
    return parsed.hostname;
  } catch {
    return null;
  }
}

function hasExactHttpHost(url: string, expectedHostToken: string): boolean {
  const expectedHost = normalizeHostToken(expectedHostToken);
  if (!expectedHost) return false;

  try {
    const parsed = new URL(url);
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password
    ) {
      return false;
    }
    return parsed.hostname === expectedHost;
  } catch {
    return false;
  }
}

afterEach(() => {
  cleanup();
});

test("parseSPF should parse mechanisms", () => {
  const input = "v=spf1 ip4:1.2.3.0/24 include:example.com -all";
  const parsed = parseSPF(input);
  assert.ok(parsed);
  assert.equal(parsed?.version, "v=spf1");
  assert.equal(parsed?.mechanisms.length, 3);
  assert.equal(parsed?.mechanisms[0].mechanism, "ip4");
  assert.equal(parsed?.mechanisms[1].mechanism, "include");
});

test("composeSPF should create spf string from record", () => {
  const rec: SPFRecord = {
    version: "v=spf1",
    mechanisms: [
      { mechanism: "ip4", value: "1.2.3.0/24" },
      { mechanism: "all" },
    ],
  };
  const s = composeSPF(rec);
  assert.ok(s.startsWith("v=spf1"));
});

test("validateSPF should flag errors when missing prefix", () => {
  const res = validateSPF("ip4:1.2.3.4");
  assert.equal(res.ok, false);
});

test("validateSPF should accept valid spf", () => {
  const res = validateSPF("v=spf1 ip4:1.2.3.0/24 -all");
  assert.equal(res.ok, true);
});

test("simulateSPF should detect ip4 pass", async () => {
  const domain = "example.local";
  const mockResolver: import("../src/lib/spf").DNSResolver = {
    resolveTxt: async (_d: string) => {
      void _d;
      return [["v=spf1 ip4:1.2.3.0/24 -all"]];
    },
    resolve4: async (_d: string) => {
      void _d;
      return ["1.2.3.5"];
    },
    resolve6: async (_d: string) => {
      void _d;
      return [];
    },
    resolveMx: async (_d: string) => {
      void _d;
      return [];
    },
    reverse: async (_ip: string) => {
      void _ip;
      return [];
    },
  };
  setDnsResolverForTest(mockResolver);
  try {
    const res = await simulateSPF({ domain, ip: "1.2.3.5" });
    assert.equal(res.result, "pass");
  } finally {
    setDnsResolverForTest(undefined);
  }
});

test("ipMatchesCIDR should support IPv6 CIDR matching", () => {
  assert.ok(ipMatchesCIDR("2001:db8::1", "2001:db8::/32"));
  assert.ok(!ipMatchesCIDR("2001:db9::1", "2001:db8::/32"));
});

test("composeSPF and parseSPF support add/edit/remove operations", () => {
  const base = "v=spf1 ip4:1.2.3.0/24 -all";
  const parsed = parseSPF(base);
  assert.ok(parsed);
  // add an include
  const mechs = [...(parsed?.mechanisms ?? [])];
  mechs.push({ mechanism: "include", value: "inc.example" });
  const composed = composeSPF({
    version: parsed?.version ?? "v=spf1",
    mechanisms: mechs as SPFRecord["mechanisms"],
  });

  const parsed2 = parseSPF(composed);

  assert.equal(
    parsed2?.mechanisms.some(
      (m) => m.mechanism === "include" && m.value === "inc.example",
    ),
    true,
  );
  // edit the include to ip6 value
  const idx =
    parsed2?.mechanisms.findIndex((m) => m.mechanism === "include") ?? -1;
  if (idx >= 0 && parsed2) {
    const mechs2 = [...parsed2.mechanisms];
    mechs2[idx] = { mechanism: "ip6", value: "::1/128" };
    const composed2 = composeSPF({
      version: parsed2.version,
      mechanisms: mechs2 as SPFRecord["mechanisms"],
    });
    const parsed3 = parseSPF(composed2);
    assert.equal(
      parsed3?.mechanisms.some(
        (m) => m.mechanism === "ip6" && m.value === "::1/128",
      ),
      true,
    );
    // remove the ip6
    const mechs3 = mechs2.filter((_, i) => i !== idx);
    const composed3 = composeSPF({
      version: parsed3.version,
      mechanisms: mechs3 as SPFRecord["mechanisms"],
    });
    const parsed4 = parseSPF(composed3);
    assert.equal(
      parsed4?.mechanisms.some(
        (m) => m.mechanism === "ip6" && m.value === "::1/128",
      ),
      false,
    );
  }
});

test("buildSPFGraphFromContent should build include nodes", async () => {
  const domain = "example.org";
  const content = "v=spf1 include:inc.example -all";
  const mockResolver: import("../src/lib/spf").DNSResolver = {
    resolveTxt: async (d: string) => {
      void d;
      return d === "inc.example" ? [["v=spf1 ip4:1.2.3.0/24 -all"]] : [];
    },
    resolve4: async (_d: string) => {
      void _d;
      return [];
    },
    resolve6: async (_d: string) => {
      void _d;
      return [];
    },
    resolveMx: async (_d: string) => {
      void _d;
      return [];
    },
    reverse: async (_ip: string) => {
      void _ip;
      return [];
    },
  };
  setDnsResolverForTest(mockResolver);
  try {
    const graph = await buildSPFGraphFromContent(domain, content);
    assert.equal(graph.nodes.length >= 1, true);
    const includes = graph.edges.filter((e: any) => e.type === "include");
    assert.equal(includes.length, 1);
  } finally {
    setDnsResolverForTest(undefined);
  }
});

test("validateSPFContentAsync should reject lookup limit", async () => {
  const domain = "example.org";
  const content =
    "v=spf1 include:one include:two include:three include:four include:five include:six include:seven include:eight include:nine include:ten include:eleven -all";
  const mockResolver: import("../src/lib/spf").DNSResolver = {
    resolveTxt: async (_d: string) => {
      void _d;
      return [["v=spf1 -all"]];
    },
    resolve4: async (_d: string) => {
      void _d;
      return [];
    },
    resolve6: async (_d: string) => {
      void _d;
      return [];
    },
    resolveMx: async (_d: string) => {
      void _d;
      return [];
    },
    reverse: async (_ip: string) => {
      void _ip;
      return [];
    },
  };
  setDnsResolverForTest(mockResolver);
  try {
    const res = await validateSPFContentAsync(content, domain, {
      maxLookups: 10,
    });
    assert.equal(res.ok, false);
    assert.ok(
      res.problems.some(
        (p: string) =>
          p.indexOf("requires") !== -1 ||
          p.indexOf("exceeds") !== -1 ||
          p.indexOf("DNS lookups") !== -1,
      ),
    );
  } finally {
    setDnsResolverForTest(undefined);
  }
});

test("simulateSPF should honor ptr with forward-confirmation", async () => {
  const domain = "ptr.example";
  const mockResolver: import("../src/lib/spf").DNSResolver = {
    resolveTxt: async (_d: string) => {
      void _d;
      return [["v=spf1 ptr:example.com -all"]];
    },
    reverse: async (_ip: string) => {
      void _ip;
      return ["example.com"];
    },
    resolve4: async (d: string) => (d === "example.com" ? ["1.2.3.4"] : []),
    resolve6: async (_d: string) => {
      void _d;
      return [];
    },
    resolveMx: async (_d: string) => {
      void _d;
      return [];
    },
  };
  setDnsResolverForTest(mockResolver);
  try {
    const res = await simulateSPF({ domain, ip: "1.2.3.4" });
    assert.equal(res.result, "pass");
  } finally {
    setDnsResolverForTest(undefined);
  }
});

test("simulateSPF should not match ptr without forward-confirmation", async () => {
  const domain = "ptr.example";
  const mockResolver: import("../src/lib/spf").DNSResolver = {
    resolveTxt: async (_d: string) => {
      void _d;
      return [["v=spf1 ptr:example.com -all"]];
    },
    reverse: async (_ip: string) => {
      void _ip;
      return ["example.com"];
    },
    resolve4: async (_d: string) => {
      void _d;
      return [];
    },
    resolve6: async (_d: string) => {
      void _d;
      return [];
    },
    resolveMx: async (_d: string) => {
      void _d;
      return [];
    },
  };
  setDnsResolverForTest(mockResolver);
  try {
    const res = await simulateSPF({ domain, ip: "1.2.3.4" });
    assert.equal(res.result, "fail");
  } finally {
    setDnsResolverForTest(undefined);
  }
});

test("expandSPFMacro basic tokens", () => {
  const out = expandSPFMacro("%{s} hello %{l} %{d} %{i} %% %_", {
    domain: "example.com",
    ip: "1.2.3.4",
    sender: "user@example.com",
  });
  const tokens = out.trim().split(/\s+/u);
  assert.equal(tokens[0], "user@example.com");
  assert.equal(tokens[1], "hello");
  assert.equal(tokens[2], "user");
  assert.equal(normalizeHostToken(tokens[3] ?? ""), "example.com");
  assert.equal(tokens[4], "1.2.3.4");
  assert.equal(tokens[5], "%");
});

test("SPF URL host checks use parsed normalized exact hosts", () => {
  assert.equal(
    hasExactHttpHost("https://example.com/path", "example.com"),
    true,
  );
  assert.equal(
    hasExactHttpHost("http://EXAMPLE.COM:8080/path", "example.com"),
    true,
  );
  assert.equal(
    hasExactHttpHost("https://%65xample.com/path", "example.com"),
    true,
  );

  assert.equal(
    hasExactHttpHost("https://example.com@evil.test/", "example.com"),
    false,
  );
  assert.equal(
    hasExactHttpHost("https://example.com.evil.test/", "example.com"),
    false,
  );
  assert.equal(
    hasExactHttpHost("https://example%2Ecom.evil.test/", "example.com"),
    false,
  );
  assert.equal(
    hasExactHttpHost("https://sub.example.com/", "example.com"),
    false,
  );
  assert.equal(
    hasExactHttpHost("https://evil.test/%65xample.com", "example.com"),
    false,
  );
  assert.equal(
    hasExactHttpHost(
      "https://example.com%40evil.test@attacker.test/",
      "example.com",
    ),
    false,
  );
  assert.equal(hasExactHttpHost("not a URL", "example.com"), false);
  assert.equal(
    hasExactHttpHost("javascript:example.com", "example.com"),
    false,
  );

  assert.equal(normalizeHostToken("EXAMPLE.COM"), "example.com");
  assert.equal(normalizeHostToken("example.com:443"), null);
  assert.equal(normalizeHostToken("user@example.com"), null);
  assert.equal(normalizeHostToken("sub.example.com"), "sub.example.com");
  assert.equal(normalizeHostToken("example.com%2Fevil.test"), null);
});

test("SPF builder UI renders the canonical record with an exact host token", async () => {
  const content = "v=spf1 include:example.com -all";
  const record: RecordDraft = {
    type: "TXT",
    name: "@",
    content,
  };

  await act(async () => {
    render(
      React.createElement(SpfBuilder, {
        record,
        zoneName: "example.com",
        onRecordChange: () => {},
      }),
    );
  });

  assert.ok(screen.getByText("SPF builder"));
  assert.equal(
    screen.getByText(content, { selector: "pre" }).textContent,
    content,
  );
});

test("simulateSPF should include exp TXT explanation on fail", async () => {
  const domain = "exp.example";
  const mockResolver: import("../src/lib/spf").DNSResolver = {
    resolveTxt: async (d: string) => {
      if (d === "explain.exp.example") return [["Explanation text"]];
      if (d === domain) return [["v=spf1 -all exp=explain.%{d}"]];
      return [];
    },
    resolve4: async (_d: string) => {
      void _d;
      return [];
    },
    resolve6: async (_d: string) => {
      void _d;
      return [];
    },
    resolveMx: async (_d: string) => {
      void _d;
      return [];
    },
    reverse: async (_ip: string) => {
      void _ip;
      return [];
    },
  };
  setDnsResolverForTest(mockResolver);
  try {
    const res = await simulateSPF({ domain, ip: "1.2.3.4" });
    assert.equal(res.result, "fail");
    assert.ok(
      res.reasons.some((r) => String(r).includes("explain=Explanation")),
    );
  } finally {
    setDnsResolverForTest(undefined);
  }
});

test("ipMatchesCIDR should treat IPv4-mapped IPv6 as IPv4 for IPv4 CIDRs", () => {
  assert.ok(ipMatchesCIDR("::ffff:1.2.3.5", "1.2.3.0/24"));
  assert.ok(!ipMatchesCIDR("::ffff:2.2.3.5", "1.2.3.0/24"));
});
