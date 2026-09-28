/**
 * The registrar-site table is the app's only answer to "where does this domain
 * get renewed", and it is allowed to answer "I don't know". These tests pin
 * both halves: that a known provider resolves to a validated `https:` URL, and
 * that every path with any doubt in it returns null instead of a guess.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  findRegistrarProvider,
  findRegistrarSite,
  normalizeDomainKey,
  registrarSite,
} from "../src/lib/registrar/registrar-site";
import { REGISTRAR_LABELS } from "../src/types/registrar";
import type { DomainInfo, RegistrarProvider } from "../src/types/registrar";

function domain(
  name: string,
  registrar: RegistrarProvider,
  expiresAt = "2026-10-01T00:00:00Z",
): DomainInfo {
  return {
    domain: name,
    registrar,
    status: "active",
    created_at: "2020-01-01T00:00:00Z",
    expires_at: expiresAt,
    nameservers: { current: [], is_custom: false },
    locks: { transfer_lock: true, auto_renew: false },
    dnssec: { enabled: false },
    privacy: { enabled: true },
  };
}

test("a known provider resolves to a validated https site with its label", () => {
  const site = registrarSite("porkbun");
  assert.ok(site);
  assert.equal(site.provider, "porkbun");
  assert.equal(site.label, REGISTRAR_LABELS.porkbun);
  assert.equal(site.url, "https://porkbun.com/");
  assert.equal(site.host, "porkbun.com");
});

test("every site in the table is an absolute https URL with no credentials", () => {
  const providers: RegistrarProvider[] = [
    "cloudflare",
    "porkbun",
    "namecheap",
    "godaddy",
    "google",
    "namecom",
  ];
  for (const provider of providers) {
    const site = registrarSite(provider);
    if (!site) continue;
    const url = new URL(site.url);
    assert.equal(url.protocol, "https:", `${provider} must be https`);
    assert.equal(url.username, "", `${provider} must carry no username`);
    assert.equal(url.password, "", `${provider} must carry no password`);
    assert.equal(site.host, url.host);
    assert.equal(site.label, REGISTRAR_LABELS[provider]);
  }
});

test("a provider with no correct destination yields no link at all", () => {
  // Google Domains was retired and its registrations moved elsewhere, so there
  // is nothing truthful to open. Absent beats invented.
  assert.equal(registrarSite("google"), null);
  assert.equal(registrarSite(null), null);
  assert.equal(registrarSite(undefined), null);
});

test("a domain no configured registrar lists has no provider and no site", () => {
  const listed = [domain("example.com", "porkbun")];
  assert.equal(findRegistrarProvider("elsewhere.test", listed), null);
  assert.equal(findRegistrarSite("elsewhere.test", listed), null);
  assert.equal(findRegistrarSite("example.com", []), null);
  assert.equal(findRegistrarSite("", listed), null);
});

test("matching folds case and the root dot but never matches a subdomain", () => {
  const listed = [domain("Example.COM", "namecheap")];
  assert.equal(normalizeDomainKey("  Example.COM.  "), "example.com");
  assert.equal(findRegistrarProvider("example.com.", listed), "namecheap");
  assert.equal(findRegistrarProvider("EXAMPLE.com", listed), "namecheap");
  // A suffix match here would claim someone else's name is registered at the
  // registrar holding the parent.
  assert.equal(findRegistrarProvider("evil.example.com", listed), null);
  assert.equal(findRegistrarProvider("notexample.com", listed), null);
});

test("the first listing wins and each provider keeps its own site", () => {
  const listed = [
    domain("one.test", "godaddy"),
    domain("two.test", "google"),
    domain("three.test", "namecom"),
  ];
  assert.equal(findRegistrarSite("one.test", listed)?.host, "www.godaddy.com");
  // Listed, but its provider has no site: still no link.
  assert.equal(findRegistrarProvider("two.test", listed), "google");
  assert.equal(findRegistrarSite("two.test", listed), null);
  assert.equal(findRegistrarSite("three.test", listed)?.host, "www.name.com");
});
