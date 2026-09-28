/**
 * "Renew at <registrar>" — the one place the app hands a domain off to its
 * registrar's own site.
 *
 * It is a button rather than an anchor because the desktop build has to route
 * the URL through the Tauri shell; `openExternalUrl` picks that path or
 * `window.open(…, "noopener,noreferrer")` per build and rejects anything that
 * is not a credential-free HTTP(S) URL. The visible text names the registrar
 * and the accessible name adds the domain and the host being opened, so the
 * destination is never a surprise — and never mistaken for a deep link to the
 * renewal form for that one name.
 */
import { ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import { openExternalUrl } from "@/lib/external-url";
import type { RegistrarSite } from "@/lib/registrar/registrar-site";
import { cn } from "@/lib/utils";

export interface RegistrarSiteLinkProps {
  /** The domain being renewed, for the accessible name. */
  domain: string;
  /** Resolved registrar; callers render nothing when resolution returned null. */
  site: RegistrarSite;
  className?: string;
}

export function RegistrarSiteLink({
  domain,
  site,
  className,
}: RegistrarSiteLinkProps) {
  const { t } = useI18n();
  const accessibleName = t("Renew {{domain}} at {{registrar}} ({{host}})", {
    domain,
    registrar: site.label,
    host: site.host,
    defaultValue: `Renew ${domain} at ${site.label} (${site.host})`,
  });

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="registrar-site-link"
      data-registrar-url={site.url}
      className={cn("h-7 gap-1 px-2 text-xs", className)}
      aria-label={accessibleName}
      title={accessibleName}
      onClick={() => void openExternalUrl(site.url)}
    >
      <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
      {t("Renew at {{registrar}}", {
        registrar: site.label,
        defaultValue: `Renew at ${site.label}`,
      })}
    </Button>
  );
}
