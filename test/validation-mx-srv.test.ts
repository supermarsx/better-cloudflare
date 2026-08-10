import assert from "node:assert/strict";
import { test } from "node:test";
import { dnsRecordSchema } from "../src/lib/dns/validation";

test("MX records require integer priority", () => {
  const missing = dnsRecordSchema.safeParse({
    type: "MX",
    name: "mail",
    content: "mail.example.com",
    ttl: 3600,
  });
  assert.equal(missing.success, false);
  const ok = dnsRecordSchema.safeParse({
    type: "MX",
    name: "mail",
    content: "mail.example.com",
    ttl: 3600,
    priority: 10,
  });
  assert.equal(ok.success, true);
  const badContent = dnsRecordSchema.safeParse({
    type: "MX",
    name: "mail",
    content: "bad host",
    ttl: 3600,
    priority: 10,
  });
  assert.equal(badContent.success, false);
});

test('SRV content validated as "priority weight port target"', () => {
  const bad = dnsRecordSchema.safeParse({
    type: "SRV",
    name: "_sip._tcp",
    content: "not-valid",
  });
  assert.equal(bad.success, false);
  const ok = dnsRecordSchema.safeParse({
    type: "SRV",
    name: "_sip._tcp",
    content: "10 5 8080 host.example.com",
  });
  assert.equal(ok.success, true);
});

test("SRV content may omit the priority when it is a separate field", () => {
  // The shape Cloudflare returns: "weight port target", priority in its own
  // column. `record-copy.ts` and `export-api.ts` both branch on it explicitly.
  const cloudflareShape = dnsRecordSchema.safeParse({
    type: "SRV",
    name: "_sip._tcp",
    content: "5 8080 host.example.com",
    priority: 10,
    ttl: 300,
  });
  assert.equal(cloudflareShape.success, true);

  // A priority of 0 is a real priority, not a missing one.
  assert.equal(
    dnsRecordSchema.safeParse({
      type: "SRV",
      name: "_sip._tcp",
      content: "5 8080 host.example.com",
      priority: 0,
    }).success,
    true,
  );

  // Without the separate field the priority is simply absent.
  assert.equal(
    dnsRecordSchema.safeParse({
      type: "SRV",
      name: "_sip._tcp",
      content: "5 8080 host.example.com",
    }).success,
    false,
  );

  // The relaxation only covers "<number> <number> <target>".
  for (const content of [
    "a b host.example.com",
    "5 host.example.com",
    "5 8080 host.example.com extra",
    "",
  ]) {
    assert.equal(
      dnsRecordSchema.safeParse({
        type: "SRV",
        name: "_sip._tcp",
        content,
        priority: 10,
      }).success,
      false,
      `SRV content ${JSON.stringify(content)} should be rejected`,
    );
  }

  // Four fields stay valid whether or not a priority accompanies them.
  assert.equal(
    dnsRecordSchema.safeParse({
      type: "SRV",
      name: "_sip._tcp",
      content: "10 5 8080 host.example.com",
      priority: 10,
    }).success,
    true,
  );
});

test("TTL bounds match the Rust validator: 0 and over 2^31-1 are rejected", () => {
  const withTTL = (ttl: unknown) =>
    dnsRecordSchema.safeParse({
      type: "A",
      name: "host",
      content: "1.2.3.4",
      ttl,
    });

  // "auto" and Cloudflare's automatic TTL of 1 are both fine, as are values
  // outside Cloudflare's plan range — that range is a CLI warning, not an error.
  for (const ttl of ["auto", 1, 30, 300, 86_400, 604_800, 2_147_483_647]) {
    assert.equal(withTTL(ttl).success, true, `ttl ${ttl} should be accepted`);
  }

  for (const ttl of [0, -1, 2_147_483_648]) {
    assert.equal(withTTL(ttl).success, false, `ttl ${ttl} should be rejected`);
  }
  assert.ok(
    withTTL(0).error?.issues.some((issue) => issue.message.includes("TTL")),
  );
});

test("TLSA content validation", () => {
  const bad = dnsRecordSchema.safeParse({
    type: "TLSA",
    name: "_443._tcp",
    content: "bad",
  });
  assert.equal(bad.success, false);
  const ok = dnsRecordSchema.safeParse({
    type: "TLSA",
    name: "_443._tcp",
    content: "3 1 1 a1b2c3",
  });
  assert.equal(ok.success, true);
});

test("SSHFP content validation", () => {
  const bad = dnsRecordSchema.safeParse({
    type: "SSHFP",
    name: "host",
    content: "x y z",
  });
  assert.equal(bad.success, false);
  const ok = dnsRecordSchema.safeParse({
    type: "SSHFP",
    name: "host",
    content: "1 1 123abc",
  });
  assert.equal(ok.success, true);
});

test("A/AAAA records validate IP addresses", () => {
  const aOk = dnsRecordSchema.safeParse({
    type: "A",
    name: "host",
    content: "1.2.3.4",
  });
  assert.equal(aOk.success, true);
  const aBad = dnsRecordSchema.safeParse({
    type: "A",
    name: "host",
    content: "not-ip",
  });
  assert.equal(aBad.success, false);
  const aaaaOk = dnsRecordSchema.safeParse({
    type: "AAAA",
    name: "host",
    content: "::1",
  });
  assert.equal(aaaaOk.success, true);
  const aaaaBad = dnsRecordSchema.safeParse({
    type: "AAAA",
    name: "host",
    content: "1.2.3.4",
  });
  assert.equal(aaaaBad.success, false);
});
