import { useEffect, useRef, useState } from "react";
import { LoginForm } from "@/components/auth/LoginForm";
import { DNSManager } from "@/components/dns/DNSManager";
import { Toaster } from "@/components/ui/toaster";
import { storageManager } from "@/lib/storage";
import { LanguageSelector } from "@/components/ui/LanguageSelector";
import { ThemeToggle } from "@/components/ui/ThemeToggle";
import { WindowTitleBar } from "@/components/ui/WindowTitleBar";
import { isDesktop } from "@/lib/environment";
import i18n from "@/i18n";
import { TauriClient } from "@/lib/tauri-client";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [apiKey, setApiKey] = useState<string>("");
  const [email, setEmail] = useState<string | undefined>(undefined);
  const [isDesktopEnv, setIsDesktopEnv] = useState(false);
  const [activeView, setActiveView] = useState<"login" | "app">("login");
  const [isVisible, setIsVisible] = useState(true);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [prefsDockOpen, setPrefsDockOpen] = useState(false);
  const timeouts = useRef<number[]>([]);
  const prefsDockHideTimeout = useRef<number | null>(null);

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
    if (!isDesktop()) return;
    TauriClient.getPreferences()
      .then((prefs) => {
        const pref = prefs as { theme?: string; locale?: string };
        if (pref.theme && typeof document !== "undefined") {
          document.documentElement.dataset.theme = pref.theme;
          if (typeof window !== "undefined") {
            window.localStorage.setItem("theme", pref.theme);
          }
        }
        if (pref.locale) {
          void i18n.changeLanguage(pref.locale);
          if (typeof window !== "undefined") {
            window.localStorage.setItem("locale", pref.locale);
          }
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    return () => {
      timeouts.current.forEach((id) => clearTimeout(id));
      timeouts.current = [];
      if (prefsDockHideTimeout.current) {
        window.clearTimeout(prefsDockHideTimeout.current);
        prefsDockHideTimeout.current = null;
      }
    };
  }, []);

  const clearPrefsDockHideTimer = () => {
    if (!prefsDockHideTimeout.current) return;
    window.clearTimeout(prefsDockHideTimeout.current);
    prefsDockHideTimeout.current = null;
  };

  const schedulePrefsDockHide = () => {
    clearPrefsDockHideTimer();
    prefsDockHideTimeout.current = window.setTimeout(() => {
      setPrefsDockOpen(false);
      prefsDockHideTimeout.current = null;
    }, 1800);
  };

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
        <div
          className="flex items-center rounded-full border border-transparent bg-transparent px-1 py-0.5 text-[10px] text-muted-foreground/35 opacity-80 backdrop-blur-sm transition hover:opacity-100"
          onMouseEnter={() => {
            clearPrefsDockHideTimer();
            setPrefsDockOpen(true);
          }}
          onMouseLeave={schedulePrefsDockHide}
        >
          <Button
            variant="ghost"
            size="icon"
            className="ui-icon-button h-6 w-6"
            aria-label="Preferences"
            onClick={() => {
              clearPrefsDockHideTimer();
              setPrefsDockOpen((prev) => !prev);
            }}
          >
            <ChevronRight
              className={cn(
                "h-3 w-3 transition-transform duration-200",
                prefsDockOpen && "rotate-90",
              )}
            />
          </Button>
          <div
            className={cn(
              "flex items-center gap-2 overflow-hidden transition-all duration-300",
              prefsDockOpen
                ? "ml-1 max-w-[140px] opacity-100"
                : "ml-0 max-w-0 opacity-0 pointer-events-none",
            )}
          >
            <LanguageSelector compact />
            <ThemeToggle compact />
          </div>
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
