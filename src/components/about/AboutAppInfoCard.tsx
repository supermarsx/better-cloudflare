/**
 * The About section's read-only half: what this build is, and what it is made
 * of.
 *
 * Kept out of `DNSManager.tsx` because none of it is a setting. The update
 * checking controls that share the About subtab *are* settings and live there,
 * where `settings-search.ts` and its registry test can see them; everything
 * here is a fact about the running binary.
 *
 * # The version is `versionLabel`, never `bundleVersion`
 *
 * `tauri.conf.json` carries `0.0.0` and always will — the release a build
 * carries is the `YY.N` tag stamped into it. So `bundleVersion` is shown only
 * under a label that says it is a placeholder, and the version a user reads is
 * {@link AboutAppInfo.versionLabel}, which already reads "local build (no
 * release tag stamped)" when nothing was stamped.
 *
 * # Why the manifest load is deferred
 *
 * The dependency list is ~175 KB of generated JSON — 565 npm packages and 712
 * crates, which is the honest size of a complete licence notice.
 * `loadDependencyManifest()` reaches it through a dynamic import so the
 * bundler emits it as its own chunk, and this component only calls it when the
 * user opens the dependency disclosure. Until then the counts come from
 * `DEPENDENCY_TOTALS`, which is a few bytes. Loading it on mount would throw
 * that away for every user who opens About to read the version.
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { ChevronRight, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import { loadAboutAppInfo, type AboutAppInfo } from "@/lib/about/app-info";
import {
  directNpmDependencies,
  directRustDependencies,
  licenseBreakdown,
  loadDependencyManifest,
  workspaceCrates,
  type DependencyManifest,
  type DependencyRow,
} from "@/lib/about/dependencies";
import { openExternalUrl } from "@/lib/external-url";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";

/** One `dt`/`dd` pair, or nothing at all when the host could not answer. */
function Fact({
  label,
  value,
  hint,
}: {
  label: string;
  value: string | null;
  hint?: string;
}) {
  if (value === null || value.length === 0) return null;
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="break-words text-sm text-foreground">
        {value}
        {hint ? (
          <span className="ml-1 text-xs text-muted-foreground">{hint}</span>
        ) : null}
      </dd>
    </div>
  );
}

function DependencyTable({
  caption,
  rows,
  emptyText,
}: {
  caption: string;
  rows: readonly DependencyRow[];
  emptyText: string;
}) {
  return (
    <div className="min-w-0">
      <h5 className="mb-1 text-xs font-semibold text-foreground">{caption}</h5>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyText}</p>
      ) : (
        <ul role="list" className="space-y-0.5">
          {rows.map((row) => (
            <li
              key={row.name}
              className="flex flex-wrap items-baseline gap-x-2 text-xs"
            >
              <span className="font-mono text-foreground">{row.name}</span>
              <span className="text-muted-foreground">
                {row.versions.join(", ")}
              </span>
              <span className="text-muted-foreground">
                {row.licenses.length > 0 ? row.licenses.join(" / ") : "—"}
              </span>
              {row.developmentOnly ? (
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                  dev
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AboutAppInfoCard() {
  const { t } = useI18n();
  const [info, setInfo] = useState<AboutAppInfo | null>(null);
  const [manifest, setManifest] = useState<DependencyManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [manifestLoading, setManifestLoading] = useState(false);
  const [dependenciesOpen, setDependenciesOpen] = useState(false);
  const [fullListOpen, setFullListOpen] = useState(false);
  const mountedRef = useRef(true);
  const dependencyPanelId = useId();
  const fullListPanelId = useId();

  useEffect(() => {
    mountedRef.current = true;
    const controller = new AbortController();
    // Never rejects: a web build and a desktop build whose probe failed both
    // resolve with the version-dependent fields null, and the rest renders.
    void loadAboutAppInfo(controller.signal).then((loaded) => {
      if (mountedRef.current) setInfo(loaded);
    });
    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, []);

  /** Open the disclosure, and fetch the chunk the first time it is opened. */
  const toggleDependencies = useCallback(() => {
    const next = !dependenciesOpen;
    setDependenciesOpen(next);
    if (!next || manifest !== null || manifestLoading) return;
    setManifestLoading(true);
    setManifestError(null);
    void loadDependencyManifest()
      .then((loaded) => {
        if (mountedRef.current) setManifest(loaded);
      })
      .catch((error: unknown) => {
        // A chunk-load failure is retryable — `loadDependencyManifest` does not
        // cache a rejection — so say so rather than leaving an empty panel.
        reportRuntimeError(error, {
          source: "runtime",
          label: "Load the dependency manifest",
        });
        if (mountedRef.current) {
          setManifestError(
            t(
              "The dependency list could not be loaded. Close and reopen this section to try again.",
              "The dependency list could not be loaded. Close and reopen this section to try again.",
            ),
          );
        }
      })
      .finally(() => {
        if (mountedRef.current) setManifestLoading(false);
      });
  }, [dependenciesOpen, manifest, manifestLoading, t]);

  const openLink = useCallback((url: string) => {
    void openExternalUrl(url).catch((error: unknown) =>
      reportRuntimeError(error, {
        source: "runtime",
        label: "Open an About link",
      }),
    );
  }, []);

  const totals = info?.dependencies ?? null;
  const links = info?.links ?? null;
  const license = info?.license ?? null;

  /** The four `PROJECT_LINKS`, in the order a reader is likely to want them. */
  const linkButtons: readonly { label: string; url: string }[] =
    links === null
      ? []
      : [
          { label: "Repository", url: links.repository },
          { label: "Releases", url: links.releases },
          { label: "Report an issue", url: links.issues },
          { label: "Licence", url: links.license },
        ];

  return (
    <div
      className="space-y-4 rounded-xl border border-border/60 bg-card/60 p-4"
      data-testid="about-app-info"
    >
      <div className="min-w-0">
        <h3 className="text-base font-semibold text-foreground">
          {info?.name ?? t("Better Cloudflare", "Better Cloudflare")}
        </h3>
        {/* The version. `versionLabel` is the only string that gets to be one:
            it says "local build (no release tag stamped)" for an unstamped
            build, which is true and useful, where `0.0.0` would be neither. */}
        <p
          data-testid="about-version"
          className="text-sm text-muted-foreground"
        >
          {info === null
            ? t("Reading build information…", "Reading build information…")
            : info.versionLabel}
        </p>
      </div>

      <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Fact
          label={t("Release tag", "Release tag")}
          value={info?.releaseTag ?? null}
        />
        <Fact
          label={t("Build profile", "Build profile")}
          value={info?.buildProfile ?? null}
        />
        <Fact
          label={t("Shell", "Shell")}
          value={
            info === null
              ? null
              : info.shell === "desktop"
                ? t("Desktop app", "Desktop app")
                : t("Browser", "Browser")
          }
        />
        <Fact label={t("Target", "Target")} value={info?.target ?? null} />
        <Fact label={t("Tauri", "Tauri")} value={info?.tauriVersion ?? null} />
        <Fact
          label={t("Webview", "Webview")}
          value={info?.webviewVersion ?? null}
        />
        {/* Shown, and labelled for what it is. It is in `tauri.conf.json`, a
            user who goes looking will find it, and finding `0.0.0` with no
            explanation is worse than being told it means nothing. */}
        <Fact
          label={t("Bundle version", "Bundle version")}
          value={info?.bundleVersion ?? null}
          hint={t(
            "(placeholder, not the release)",
            "(placeholder, not the release)",
          )}
        />
        <Fact
          label={t("Licence", "Licence")}
          value={
            license === null ? null : `${license.spdx} · ${license.holder}`
          }
        />
      </dl>

      {linkButtons.length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {linkButtons.map((link) => (
            <Button
              key={link.label}
              type="button"
              variant="outline"
              size="sm"
              className="gap-1 text-xs"
              onClick={() => openLink(link.url)}
            >
              <ExternalLink aria-hidden="true" className="h-3.5 w-3.5" />
              {t(link.label, link.label)}
            </Button>
          ))}
        </div>
      ) : null}

      <div className="min-w-0 border-t border-border/40 pt-3">
        <button
          type="button"
          aria-expanded={dependenciesOpen}
          aria-controls={dependencyPanelId}
          data-testid="about-dependencies-toggle"
          className="flex w-full items-center gap-2 text-left text-sm font-medium text-foreground"
          onClick={toggleDependencies}
        >
          <ChevronRight
            aria-hidden="true"
            className={
              dependenciesOpen
                ? "h-4 w-4 rotate-90 transition-transform"
                : "h-4 w-4 transition-transform"
            }
          />
          {t("Dependencies and licences", "Dependencies and licences")}
          {totals === null ? null : (
            <span className="text-xs font-normal text-muted-foreground">
              {t("{{npm}} npm packages, {{rust}} crates", {
                npm: totals.npm.total,
                rust: totals.rust.total,
                defaultValue: `${totals.npm.total} npm packages, ${totals.rust.total} crates`,
              })}
            </span>
          )}
        </button>

        {dependenciesOpen ? (
          <div id={dependencyPanelId} className="mt-3 space-y-4">
            {manifestLoading ? (
              <p className="text-xs text-muted-foreground">
                {t(
                  "Loading the dependency list…",
                  "Loading the dependency list…",
                )}
              </p>
            ) : null}
            {manifestError ? (
              <p role="alert" className="text-xs text-destructive">
                {manifestError}
              </p>
            ) : null}
            {manifest === null ? null : (
              <div className="space-y-4" data-testid="about-dependency-lists">
                {/* Direct first, and on their own: "what is this built on" is
                    answered by the packages this project names, not by the
                    hundreds they pull in. */}
                <DependencyTable
                  caption={t(
                    "Direct npm dependencies",
                    "Direct npm dependencies",
                  )}
                  rows={directNpmDependencies(manifest)}
                  emptyText={t("None", "None")}
                />
                <DependencyTable
                  caption={t("Direct crates", "Direct crates")}
                  rows={directRustDependencies(manifest)}
                  emptyText={t("None", "None")}
                />
                <div className="min-w-0">
                  <h5 className="mb-1 text-xs font-semibold text-foreground">
                    {t("Crates in this workspace", "Crates in this workspace")}
                  </h5>
                  <p className="text-xs text-muted-foreground">
                    {workspaceCrates(manifest)
                      .map((crate) => crate.name)
                      .join(", ") || t("None", "None")}
                  </p>
                </div>

                <div className="min-w-0 border-t border-border/40 pt-3">
                  <button
                    type="button"
                    aria-expanded={fullListOpen}
                    aria-controls={fullListPanelId}
                    data-testid="about-full-dependencies-toggle"
                    className="flex w-full items-center gap-2 text-left text-sm font-medium text-foreground"
                    onClick={() => setFullListOpen((open) => !open)}
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={
                        fullListOpen
                          ? "h-4 w-4 rotate-90 transition-transform"
                          : "h-4 w-4 transition-transform"
                      }
                    />
                    {t(
                      "Every package in this build",
                      "Every package in this build",
                    )}
                  </button>
                  {fullListOpen ? (
                    <div
                      id={fullListPanelId}
                      data-testid="about-full-dependencies"
                      className="mt-3 space-y-4"
                    >
                      <div className="min-w-0">
                        <h5 className="mb-1 text-xs font-semibold text-foreground">
                          {t("Licences present", "Licences present")}
                        </h5>
                        <ul role="list" className="space-y-0.5">
                          {licenseBreakdown(manifest).map((entry) => (
                            <li key={entry.license} className="text-xs">
                              <span className="text-foreground">
                                {entry.license}
                              </span>{" "}
                              <span className="text-muted-foreground">
                                {t("{{count}} packages", {
                                  count: entry.packages,
                                  defaultValue: `${entry.packages} packages`,
                                })}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="min-w-0">
                        <h5 className="mb-1 text-xs font-semibold text-foreground">
                          {t("All npm packages", "All npm packages")}
                        </h5>
                        <ul role="list" className="space-y-0.5">
                          {manifest.npm.packages.map((entry) => (
                            <li
                              key={`${entry.name}@${entry.version}`}
                              className="flex flex-wrap items-baseline gap-x-2 text-xs"
                            >
                              <span className="font-mono text-foreground">
                                {entry.name}
                              </span>
                              <span className="text-muted-foreground">
                                {entry.version}
                              </span>
                              <span className="text-muted-foreground">
                                {entry.license ?? "—"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                      <div className="min-w-0">
                        <h5 className="mb-1 text-xs font-semibold text-foreground">
                          {t("All crates", "All crates")}
                        </h5>
                        <ul role="list" className="space-y-0.5">
                          {manifest.rust.packages.map((entry) => (
                            <li
                              key={`${entry.name}@${entry.version}`}
                              className="flex flex-wrap items-baseline gap-x-2 text-xs"
                            >
                              <span className="font-mono text-foreground">
                                {entry.name}
                              </span>
                              <span className="text-muted-foreground">
                                {entry.version}
                              </span>
                              <span className="text-muted-foreground">
                                {entry.license ?? "—"}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
