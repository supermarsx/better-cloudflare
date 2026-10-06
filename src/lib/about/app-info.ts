/**
 * What the About section says about the application itself.
 *
 * Three kinds of fact, from three sources, and none of them restated:
 *
 * - **the version**, from `bc_update::embedded_release_tag()` by way of
 *   `app_host_facts`. That is the only version mechanism this project has, and
 *   {@link describeVersion} is the only place that decides how to word a build
 *   with no stamp.
 * - **the dependencies and their licences**, from `./dependencies`, which
 *   reads the artefact generated from the real lockfiles.
 * - **the project's own identity** — name, licence, links — which is the only
 *   part written here, because it is not derivable from anything.
 */
import {
  describeVersion,
  type DiagnosticsBuildSection,
} from "@/lib/diagnostics/diagnostics-report";
import { fetchHostFacts, type HostFacts } from "@/lib/diagnostics/host-facts";
import { isDesktop } from "@/lib/environment";

import { DEPENDENCY_TOTALS } from "./dependency-totals.generated";

/** `productName` in `src-tauri/tauri.conf.json`. */
export const APP_DISPLAY_NAME = "Better Cloudflare";

/**
 * Mirrors `bc_update::GITHUB_REPO` (`bc-update/src/github.rs`).
 *
 * Duplicated rather than fetched: a static web build has no host to ask, and a
 * Tauri command for a compile-time constant would be a round trip for a string
 * that cannot change at runtime. `test/aboutAppInfo.test.ts` reads the Rust
 * source and fails if the two spellings drift.
 */
export const GITHUB_REPOSITORY = "supermarsx/better-cloudflare";

/** Where the About section's links point. All on `github.com`. */
export const PROJECT_LINKS = {
  repository: `https://github.com/${GITHUB_REPOSITORY}`,
  issues: `https://github.com/${GITHUB_REPOSITORY}/issues`,
  releases: `https://github.com/${GITHUB_REPOSITORY}/releases`,
  license: `https://github.com/${GITHUB_REPOSITORY}/blob/main/license.md`,
} as const;

/** The project's own licence, as `license.md` states it. */
export const PROJECT_LICENSE = {
  spdx: "MIT",
  holder: "Mariana M",
  file: "license.md",
} as const;

/** The About header's data. */
export interface AboutAppInfo {
  name: string;
  /** The `YY.N` release tag, or `null` for an unstamped local build. */
  releaseTag: string | null;
  /** What to show: the tag, or an explicit phrase for an unstamped build. */
  versionLabel: string;
  /**
   * `tauri.conf.json`'s version.
   *
   * This is `0.0.0` and always will be. It is surfaced so the About screen can
   * label it as the placeholder it is, rather than leaving a user to find it
   * elsewhere and believe it.
   */
  bundleVersion: string | null;
  buildProfile: string | null;
  shell: "desktop" | "browser";
  tauriVersion: string | null;
  webviewVersion: string | null;
  /** The compile target, e.g. `"windows x86_64"`, or `null` on the web. */
  target: string | null;
  license: typeof PROJECT_LICENSE;
  links: typeof PROJECT_LINKS;
  dependencies: typeof DEPENDENCY_TOTALS;
}

/**
 * Describe the running build from host facts.
 *
 * Pure, so the About screen's wording can be tested without a desktop shell,
 * and shared with the diagnostics payload's build section — `versionLabel`
 * means the same thing in both places because it is computed once.
 */
export function describeAppBuild(
  hostFacts: HostFacts | null,
  shell: "desktop" | "browser",
): AboutAppInfo {
  const releaseTag =
    typeof hostFacts?.releaseTag === "string" &&
    hostFacts.releaseTag.trim().length > 0
      ? hostFacts.releaseTag.trim()
      : null;
  const target = [hostFacts?.os, hostFacts?.arch]
    .filter(
      (part): part is string => typeof part === "string" && part.length > 0,
    )
    .join(" ");
  return {
    name: APP_DISPLAY_NAME,
    releaseTag,
    versionLabel: describeVersion(releaseTag),
    bundleVersion: hostFacts?.bundleVersion ?? null,
    buildProfile: hostFacts?.buildProfile ?? null,
    shell,
    tauriVersion: hostFacts?.tauriVersion ?? null,
    webviewVersion: hostFacts?.webviewVersion ?? null,
    target: target.length > 0 ? target : null,
    license: PROJECT_LICENSE,
    links: PROJECT_LINKS,
    dependencies: DEPENDENCY_TOTALS,
  };
}

/**
 * The About header, with the host asked for what only it knows.
 *
 * Never rejects: on the web, and on a desktop build whose probe failed, the
 * version-dependent fields are `null` and the rest of the section still
 * renders. {@link describeVersion} then says "local build (no release tag
 * stamped)", which is accurate for a web preview too.
 */
export async function loadAboutAppInfo(
  signal?: AbortSignal,
): Promise<AboutAppInfo> {
  return describeAppBuild(
    await fetchHostFacts(signal),
    isDesktop() ? "desktop" : "browser",
  );
}

/**
 * The build section of a diagnostics payload, as About data.
 *
 * Lets a UI render the same header from an already-collected report without
 * asking the host a second time.
 */
export function aboutInfoFromDiagnostics(
  build: DiagnosticsBuildSection,
): AboutAppInfo {
  return {
    name: APP_DISPLAY_NAME,
    releaseTag: build.releaseTag,
    versionLabel: build.versionLabel,
    bundleVersion: build.bundleVersion,
    buildProfile: build.buildProfile,
    shell: build.shell,
    tauriVersion: build.tauriVersion,
    webviewVersion: build.webviewVersion,
    target: null,
    license: PROJECT_LICENSE,
    links: PROJECT_LINKS,
    dependencies: DEPENDENCY_TOTALS,
  };
}
