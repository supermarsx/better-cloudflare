/**
 * The dev-server identity tag, as the root layout renders it.
 *
 * Every tool that points something at the dev server — the Tauri window, which
 * loads it with this application's native command surface attached; Playwright;
 * the screenshot harness — has to be sure the server on that port is *this
 * checkout's*. Looking for Next.js or the application name cannot establish that:
 * every Next.js app serves `/_next/`, and every checkout of this repository
 * serves the name.
 *
 * So `scripts/dev-server.mjs` generates a random token for each launch, passes
 * it to `next dev` in {@link DEV_IDENTITY_ENV}, and records it once the server is
 * verified. The layout renders it as `<meta name={@link DEV_IDENTITY_META}>`, and
 * a server is "ours" only when it serves that exact token.
 *
 * Nothing here can reach a production build:
 *
 * - the variable has no `NEXT_PUBLIC_` prefix, so Next never inlines it into a
 *   browser bundle, and
 * - the tag is emitted only when `NODE_ENV` is `development`, so even a static
 *   export built from a shell that happens to have the variable set renders
 *   nothing.
 *
 * These constants are duplicated in `scripts/dev-port.mjs`, which cannot import
 * TypeScript. `test/dev-identity.test.ts` holds the two copies together.
 */

/** Carries the per-launch token into `next dev`. Server-only by construction. */
export const DEV_IDENTITY_ENV = "BETTER_CLOUDFLARE_DEV_IDENTITY";

/** The `name` of the `<meta>` tag the token is rendered into. */
export const DEV_IDENTITY_META = "better-cloudflare-dev-identity";

/** 32 random bytes, base64url, no padding. */
export const DEV_IDENTITY_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The fragment of Next's `Metadata` this module contributes.
 *
 * Declared here rather than imported from `next`, deliberately. Importing
 * Next's types pulls in its ambient `NodeJS.ProcessEnv` augmentation, which
 * makes `NODE_ENV` a required property. That is right for app code and wrong
 * for the tooling project (`tsconfig.tools.json`), which compiles this module
 * through its tests and legitimately builds partial env objects.
 */
export interface DevIdentityMetadata {
  other?: Record<string, string>;
}

/**
 * The `metadata` fragment that renders the identity tag, or nothing.
 *
 * A malformed value renders nothing rather than being passed through: the tag
 * is only useful if it can match, and a value that fails the pattern never can.
 */
export function devIdentityMetadata(
  env: Readonly<Record<string, string | undefined>> = process.env,
): DevIdentityMetadata {
  if (env.NODE_ENV !== "development") return {};
  const token = env[DEV_IDENTITY_ENV];
  if (typeof token !== "string" || !DEV_IDENTITY_TOKEN_PATTERN.test(token)) {
    return {};
  }
  return { other: { [DEV_IDENTITY_META]: token } };
}
