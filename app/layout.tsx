import type { Metadata } from "next";
import "../src/index.css";

export const metadata: Metadata = {
  title: {
    default: "Better Cloudflare",
    template: "%s | Better Cloudflare",
  },
  applicationName: "Better Cloudflare",
  description: "Cloudflare DNS management for the web and Tauri desktop app.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body suppressHydrationWarning>
        {/* Subtle background overlays for glassy effect */}
        <div aria-hidden="true" className="app-glow" />
        {children}
      </body>
    </html>
  );
}
