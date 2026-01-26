import { useEffect, useRef, useState } from "react";
import { LoginForm } from "@/components/auth/LoginForm";
import { DNSManager } from "@/components/dns/DNSManager";
import { Toaster } from "@/components/ui/toaster";
import { storageManager } from "@/lib/storage";
import { LanguageSelector } from "@/components/ui/LanguageSelector";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { WindowTitleBar } from "@/components/ui/WindowTitleBar";
import { isDesktop } from "@/lib/environment";

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [apiKey, setApiKey] = useState<string>("");
  const [email, setEmail] = useState<string | undefined>(undefined);
  const [isDesktopEnv, setIsDesktopEnv] = useState(false);
  const [activeView, setActiveView] = useState<"login" | "app">("login");
  const [isVisible, setIsVisible] = useState(true);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const timeouts = useRef<number[]>([]);

  useEffect(() => {
    // Check if there's an active session
    const currentSession = storageManager.getCurrentSession();
    if (currentSession) {
      // We have a session but need the password to decrypt the key
      // For now, we'll require login each time for security
    }
  }, []);

  useEffect(() => {
    setIsDesktopEnv(isDesktop());
  }, []);

  useEffect(() => {
    return () => {
      timeouts.current.forEach((id) => clearTimeout(id));
      timeouts.current = [];
    };
  }, []);

  const beginTransition = (nextView: "login" | "app") => {
    if (isTransitioning) return;
    setIsTransitioning(true);
    setIsVisible(false);
    const outId = window.setTimeout(() => {
      setActiveView(nextView);
      if (nextView === "login") {
        setApiKey("");
        setEmail(undefined);
        setIsAuthenticated(false);
      } else {
        setIsAuthenticated(true);
      }
      requestAnimationFrame(() => setIsVisible(true));
      const inId = window.setTimeout(() => {
        setIsTransitioning(false);
      }, 220);
      timeouts.current.push(inId);
    }, 220);
    timeouts.current.push(outId);
  };

  const handleLogin = (decryptedApiKey: string, keyEmail?: string) => {
    setApiKey(decryptedApiKey);
    setEmail(keyEmail);
    beginTransition("app");
  };

  const handleLogout = () => {
    beginTransition("login");
  };

  const languageSelectorTop = isDesktopEnv ? "top-12" : "top-3";

  const mainOffset = isDesktopEnv ? "top-9" : "top-0";

  return (
    <div className="h-screen bg-background text-foreground">
      {isDesktopEnv ? <WindowTitleBar /> : null}
      <div className={`absolute left-3 z-20 ${languageSelectorTop}`}>
        <div className="flex items-center gap-2 rounded-full border border-transparent bg-transparent px-2 py-1 text-[10px] text-muted-foreground/35 opacity-70 backdrop-blur-sm transition hover:opacity-100">
          <LanguageSelector />
          <ThemeToggle />
        </div>
      </div>
      <main
        className={`absolute inset-x-0 bottom-0 ${mainOffset} overflow-y-auto scrollbar-themed scroll-smooth flex`}
      >
        <div
          className={`transition-opacity duration-300 ease-out min-h-full flex-1 ${
            isVisible ? "opacity-100" : "opacity-0"
          }`}
        >
          {activeView === "app" && isAuthenticated ? (
            <DNSManager apiKey={apiKey} email={email} onLogout={handleLogout} />
          ) : (
            <LoginForm onLogin={handleLogin} />
          )}
        </div>
      </main>
      <Toaster />
    </div>
  );
}
export default App;
