/**
 * Where a dependency's own page lives.
 *
 * The About screen lists 27 direct npm packages, 22 workspace crates and
 * several hundred transitive entries, and a reader who wants to know what one
 * of them *is* currently has to retype its name into a search engine. These
 * builders turn each name into the page that answers that, which the card then
 * opens through `openExternalUrl` — so it lands in the OS browser rather than
 * inside the app's own webview.
 *
 * # Why each builder can return `null`
 *
 * A name arrives from a generated manifest, which is read from lockfiles. It is
 * data, not a literal in this repository, so it is not this module's place to
 * assume it is well-formed. Every builder validates against the registry's own
 * naming rules and returns `null` otherwise, and the card renders a `null` as
 * plain text. The alternative — percent-encoding whatever arrives — produces a
 * URL that is well-formed and wrong, which is worse than no link: a link that
 * 404s looks like the registry lost the package.
 *
 * Encoding is deliberately *not* applied to a name that passes validation.
 * `@radix-ui/react-direction` must keep both its `@` and its `/` to resolve on
 * npm; `encodeURIComponent` would make it `%40radix-ui%2Freact-direction`,
 * which does not. Since the allowlists below admit no character that needs
 * escaping, literal interpolation is both safe and correct here.
 */

import { GITHUB_REPOSITORY } from "./app-info";

/**
 * npm's rules, narrowed to what cannot be mistaken for URL syntax: an optional
 * `@scope/` followed by a name of unreserved characters. This rejects the
 * uppercase and URL-significant characters that legacy names may carry, which
 * is the intended trade — such a package renders unlinked rather than linked
 * somewhere unintended.
 */
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u;

/** crates.io names: alphanumerics with `-` and `_`, never a path separator. */
const CRATE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u;

/** This project's own crate, which lives at the Tauri root, not under `crates/`. */
const ROOT_CRATE = "better-cloudflare";

/** The npm page for a package, or `null` if the name is not clearly safe. */
export function npmPackageUrl(name: string): string | null {
  if (!NPM_NAME.test(name)) return null;
  return `https://www.npmjs.com/package/${name}`;
}

/** The crates.io page for a published crate. */
export function cratesIoUrl(name: string): string | null {
  if (!CRATE_NAME.test(name)) return null;
  return `https://crates.io/crates/${name}`;
}

/**
 * The source directory for a crate in this workspace.
 *
 * Workspace crates are unpublished, so crates.io would 404 on every one of
 * them. The useful destination is the code. The layout this encodes — every
 * crate but the root one under `src-tauri/crates/<name>` — is asserted against
 * the real directory tree by `test/registryUrls.test.ts`, so moving a crate
 * breaks a test rather than a link.
 */
export function workspaceCrateUrl(name: string): string | null {
  if (!CRATE_NAME.test(name)) return null;
  const path = name === ROOT_CRATE ? "src-tauri" : `src-tauri/crates/${name}`;
  return `https://github.com/${GITHUB_REPOSITORY}/tree/main/${path}`;
}

/**
 * The page for a crate, chosen by whether this workspace owns it.
 *
 * `RustDependency.workspace` is the discriminator and it comes from the
 * manifest generator, so this never has to guess from the name's prefix — a
 * `bc-` prefix is a convention, not a fact.
 */
export function crateUrl(name: string, workspace: boolean): string | null {
  return workspace ? workspaceCrateUrl(name) : cratesIoUrl(name);
}
