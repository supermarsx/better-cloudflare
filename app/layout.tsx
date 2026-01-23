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
        <div aria-hidden="true" style={{position:'fixed',inset:0,pointerEvents:'none',zIndex:-10}} suppressHydrationWarning>
          <div suppressHydrationWarning style={{position:'absolute',left:'-15%',top:'-10%',width:'60%',height:'60%',filter:'blur(80px)',background:'radial-gradient(circle at 20% 20%, rgba(255, 80, 0, 0.15), rgba(255, 80, 0, 0) 30%)'}}></div>
          <div suppressHydrationWarning style={{position:'absolute',right:'-10%',bottom:'-10%',width:'50%',height:'50%',filter:'blur(56px)',background:'radial-gradient(circle at 80% 80%, rgba(200, 0, 0, 0.15), rgba(200, 0, 0, 0) 30%)'}}></div>
          <div suppressHydrationWarning style={{position:'absolute',inset:0,background:'linear-gradient(90deg, rgba(255, 100, 0, 0.05), rgba(255, 50, 0, 0))',opacity:0.12,transform:'rotate(12deg)',mixBlendMode:'screen'}}></div>
        </div>
        {children}
      </body>
    </html>
  );
}
