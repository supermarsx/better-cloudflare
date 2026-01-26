import type { Metadata } from "next";
import "../src/index.css";

export const metadata: Metadata = {
  title: "Cloudflare DNS Manager",
  description: "Manage your Cloudflare DNS records securely",
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
