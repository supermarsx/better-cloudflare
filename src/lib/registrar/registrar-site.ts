/**
 * Where a domain's registrar can be reached on the web.
 *
 * Nothing in the app learns a renewal URL from the network. The registrar
 * clients know API endpoints only, and the RDAP lookup parses the expiration
 * date and discards the rest of the response — including the registrar's own
 * links. The single piece of registrar identity the app holds is
 * `DomainInfo.registrar`, which the backend sets for the domains a configured
 * registrar credential actually lists, so a site link is offered for exactly
 * those domains and comes from the fixed table below.
 *
 * The table holds each registrar's management entry point and goes no deeper.
 * A renewal deep link that has moved since it was written would strand someone
 * whose domain is days from lapsing, and guessing is worse still: a provider
 * with no correct destination is simply absent — Google Domains was retired
 * and its registrations moved to another company — and so is any domain whose
 * registrar the app does not know. `null` means "no link", never "best guess".
 */

import { normalizeExternalHttpUrl } from "@/lib/external-url";
import {
  REGISTRAR_LABELS,
  type DomainInfo,
  type RegistrarProvider,
} from "@/types/registrar";

const REGISTRAR_SITES: Partial<Record<RegistrarProvider, string>> = {
  cloudflare: "https://dash.cloudflare.com/",
  porkbun: "https://porkbun.com/",
  namecheap: "https://www.namecheap.com/",
  godaddy: "https://www.godaddy.com/",
  namecom: "https://www.name.com/",
};

/** A registrar the app can send someone to, with a URL already validated. */
export interface RegistrarSite {
  provider: RegistrarProvider;
  /** Human-facing registrar name, e.g. `Porkbun`. */
  label: string;
  /** Absolute `https:` URL, credential-free. */
  url: string;
  /** Host alone, so a label can say where the link leads. */
  host: string;
}

/** Folds away case and the root's trailing dot; nothing else is normalised. */
export function normalizeDomainKey(domain: string): string {
  return domain.trim().replace(/\.+$/, "").toLowerCase();
}

/**
 * The site for a known provider, or `null` when the provider is unknown, has
 * no entry, or its entry fails validation (which would be a bug in the table,
 * caught here rather than handed to the shell).
 */
export function registrarSite(
  provider: RegistrarProvider | null | undefined,
): RegistrarSite | null {
  if (!provider) return null;
  const candidate = REGISTRAR_SITES[provider];
  if (!candidate) return null;
  const url = normalizeExternalHttpUrl(candidate);
  if (!url) return null;
  const parsed = new URL(url);
  // Renewal means signing in: plaintext is not an acceptable fallback.
  if (parsed.protocol !== "https:") return null;
  return {
    provider,
    label: REGISTRAR_LABELS[provider],
    url,
    host: parsed.host,
  };
}

/**
 * The provider a configured credential reports for `domain`. The match is
 * exact after normalisation — a suffix match would happily claim that
 * `evil.example.com` is registered wherever `example.com` is.
 */
export function findRegistrarProvider(
  domain: string,
  domains: readonly DomainInfo[],
): RegistrarProvider | null {
  const key = normalizeDomainKey(domain);
  if (!key) return null;
  for (const entry of domains) {
    if (normalizeDomainKey(entry.domain) === key) return entry.registrar;
  }
  return null;
}

/** `findRegistrarProvider` resolved to a site, or `null` at either step. */
export function findRegistrarSite(
  domain: string,
  domains: readonly DomainInfo[],
): RegistrarSite | null {
  return registrarSite(findRegistrarProvider(domain, domains));
}
