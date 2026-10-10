import type { Metadata } from "next";
import { devIdentityMetadata } from "@/lib/dev-identity";
import { DocumentDirection } from "@/components/i18n/DocumentDirection";
import { LOCALE_DIRECTION_BOOT_SCRIPT } from "@/components/i18n/locale-direction";
import "../src/index.css";

export const metadata: Metadata = {
  title: {
    default: "Better Cloudflare",
    template: "%s | Better Cloudflare",
  },
  applicationName: "Better Cloudflare",
  description: "Cloudflare DNS management for the web and Tauri desktop app.",
  // Development only: proves to the dev tooling that the server on a port is
  // this checkout's. Renders nothing in a static export. See the helper.
  ...devIdentityMetadata(),
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // `lang`/`dir` here are the no-preference defaults, matching the `en-US`
    // bundle `src/i18n.ts` initialises with. This is a static export, so these
    // two attributes are baked once at build time for all twelve locales --
    // the boot script below corrects them from the stored preference before
    // the first paint, and `<DocumentDirection />` keeps them on the active
    // locale afterwards. `suppressHydrationWarning` is what makes that legal:
    // it tells React to keep the DOM's attributes rather than overwriting them
    // with the ones in this JSX when it hydrates.
    <html lang="en-US" dir="ltr" className="dark" suppressHydrationWarning>
      <head>
        {/* A synchronous inline script is the only thing that runs before the
            first paint, which is what keeps an Arabic user from watching the
            app lay out left-to-right and then flip. The content is generated
            from a module constant, not from anything a user can influence;
            see LOCALE_DIRECTION_BOOT_SCRIPT. */}
        <script
          dangerouslySetInnerHTML={{ __html: LOCALE_DIRECTION_BOOT_SCRIPT }}
        />
      </head>
      <body suppressHydrationWarning>
        {/* Wraps rather than sits beside the app: it publishes the direction
            to Radix through a React context as well as to `<html dir>`, and a
            provider has to be an ancestor of its consumers. */}
        <DocumentDirection>
          {/* Subtle background overlays for glassy effect */}
          <div aria-hidden="true" className="app-glow" />
          {children}
        </DocumentDirection>
      </body>
    </html>
  );
}
