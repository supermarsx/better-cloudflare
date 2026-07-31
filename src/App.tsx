import { useEffect, useRef, useState, type ReactNode } from "react";
import { LoginForm } from "@/components/auth/LoginForm";
import { DNSManager } from "@/components/dns/DNSManager";
import { Toaster } from "@/components/ui/toaster";
import { storageManager } from "@/lib/storage/storage";
import { LanguageSelector } from "@/components/layout/LanguageSelector";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import {
  TITLEBAR_HEIGHT_PX,
  WindowTitleBar,
} from "@/components/layout/WindowTitleBar";
import { isDesktop } from "@/lib/environment";
import i18n from "@/i18n";
import { TauriClient } from "@/lib/api/tauri-client";
import { cn } from "@/lib/utils";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/layout/ErrorBoundary";
import { RuntimeDiagnosticDetails } from "@/components/layout/RuntimeDiagnosticDetails";
import { reportRuntimeError } from "@/lib/errors/runtime-reporting";
import {
  createTrackedRuntimeResources,
  type TrackedRuntimeResources,
} from "@/lib/runtime/resource-scope";

function reportAppFailure(error: unknown, label: string): void {
  reportRuntimeError(error, { source: "runtime", label });
}

export function DnsWorkspaceSection({
  children,
  onReturnToLogin,
}: {
  children: ReactNode;
  onReturnToLogin: () => void;
}) {
  return (
    <ErrorBoundary
      label="DNS workspace"
      fallback={({ diagnostic, reset }) => (
        <div
          role="alert"
          data-testid="dns-workspace-recovery"
          className="m-4 flex min-h-64 flex-col items-center justify-center gap-3 rounded-xl border border-destructive/50 bg-destructive/5 p-6 text-center"
        >
          <div>
            <h2 className="text-base font-semibold text-destructive">
              DNS workspace stopped unexpectedly
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Your app shell is still available. Retry the workspace or return
              to login.
            </p>
          </div>
          <RuntimeDiagnosticDetails diagnostic={diagnostic} compact />
          <div className="flex flex-wrap justify-center gap-2">
            <Button type="button" size="sm" onClick={reset}>
              Retry DNS workspace
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onReturnToLogin}
            >
              Return to login
            </Button>
          </div>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [apiKey, setApiKey] = useState<string>("");
  const [email, setEmail] = useState<string | undefined>(undefined);
  const [isDesktopEnv, setIsDesktopEnv] = useState(() => isDesktop());
  const [activeView, setActiveView] = useState<"login" | "app">("login");
  const [isVisible, setIsVisible] = useState(true);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [prefsDockOpen, setPrefsDockOpen] = useState(false);
  const runtimeResourcesRef = useRef<TrackedRuntimeResources | null>(null);
  const prefsDockHideTimeout = useRef<number | null>(null);
  const transitionInFlight = useRef(false);

  if (!runtimeResourcesRef.current) {
    runtimeResourcesRef.current = createTrackedRuntimeResources(window);
  }
  const runtimeResources = runtimeResourcesRef.current;

  useEffect(() => {
    // Check if there's an active session
    try {
      const currentSession = storageManager.getCurrentSession();
      if (currentSession) {
        // We have a session but need the password to decrypt the key
        // For now, we'll require login each time for security
      }
    } catch (error) {
      reportAppFailure(error, "Read current login session");
    }
  }, []);

  useEffect(() => {
    setIsDesktopEnv(isDesktop());
  }, []);

  useEffect(() => {
    if (!isDesktop()) return;
    let active = true;
    void (async () => {
      try {
        const prefs = await TauriClient.getPreferences();
        if (!active) return;
        const pref = prefs as { theme?: string; locale?: string };
        if (pref.theme && typeof document !== "undefined") {
          document.documentElement.dataset.theme = pref.theme;
          if (typeof window !== "undefined") {
            try {
              window.localStorage.setItem("theme", pref.theme);
            } catch (error) {
              reportAppFailure(error, "Cache desktop theme preference");
            }
          }
        }
        if (pref.locale) {
          try {
            await i18n.changeLanguage(pref.locale);
          } catch (error) {
            reportAppFailure(error, "Apply desktop language preference");
          }
          if (!active) return;
          if (typeof window !== "undefined") {
            try {
              window.localStorage.setItem("locale", pref.locale);
            } catch (error) {
              reportAppFailure(error, "Cache desktop language preference");
            }
          }
        }
      } catch (error) {
        reportAppFailure(error, "Load desktop application preferences");
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      runtimeResources.dispose();
      prefsDockHideTimeout.current = null;
      transitionInFlight.current = false;
    };
  }, [runtimeResources]);

  const clearPrefsDockHideTimer = () => {
    if (prefsDockHideTimeout.current === null) return;
    runtimeResources.clearTimeout(prefsDockHideTimeout.current);
    prefsDockHideTimeout.current = null;
  };

  const schedulePrefsDockHide = () => {
    clearPrefsDockHideTimer();
    prefsDockHideTimeout.current = runtimeResources.setTimeout(() => {
      setPrefsDockOpen(false);
      prefsDockHideTimeout.current = null;
    }, 1800);
  };

  const beginTransition = (nextView: "login" | "app") => {
    if (transitionInFlight.current || isTransitioning) return;
    transitionInFlight.current = true;
    setIsTransitioning(true);
    setIsVisible(false);
    runtimeResources.setTimeout(() => {
      setActiveView(nextView);
      if (nextView === "login") {
        setApiKey("");
        setEmail(undefined);
        setIsAuthenticated(false);
      } else {
        setIsAuthenticated(true);
      }
      runtimeResources.requestAnimationFrame(() => setIsVisible(true));
      runtimeResources.setTimeout(() => {
        transitionInFlight.current = false;
        setIsTransitioning(false);
      }, 220);
    }, 220);
  };

  const handleLogin = (decryptedApiKey: string, keyEmail?: string) => {
    setApiKey(decryptedApiKey);
    setEmail(keyEmail);
    beginTransition("app");
  };

  const handleLogout = () => {
    beginTransition("login");
  };

  const showingAuthenticatedApp = activeView === "app" && isAuthenticated;
  const languageSelectorTop = isDesktopEnv ? "top-12" : "top-3";
  const mainOffset = isDesktopEnv ? TITLEBAR_HEIGHT_PX : 0;

  return (
    <div className="h-screen overflow-hidden bg-background text-foreground">
      {isDesktopEnv ? <WindowTitleBar /> : null}
      {!showingAuthenticatedApp ? (
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
      ) : null}
      <main
        data-testid="app-viewport"
        className="absolute inset-x-0 bottom-0 flex min-h-0 overflow-hidden"
        style={{ top: mainOffset }}
      >
        <div
          data-auth-scroll-region={showingAuthenticatedApp ? undefined : "body"}
          className={cn(
            "min-h-0 flex-1 transition-opacity duration-300 ease-out",
            showingAuthenticatedApp
              ? "h-full overflow-hidden"
              : "min-h-full overflow-x-hidden overflow-y-auto scrollbar-themed scroll-smooth",
            isVisible ? "opacity-100" : "opacity-0",
          )}
        >
          {showingAuthenticatedApp ? (
            <DnsWorkspaceSection onReturnToLogin={handleLogout}>
              <DNSManager
                apiKey={apiKey}
                email={email}
                onLogout={handleLogout}
              />
            </DnsWorkspaceSection>
          ) : (
            <LoginForm onLogin={handleLogin} desktop={isDesktopEnv} />
          )}
        </div>
      </main>
      <Toaster />
    </div>
  );
}
export default App;
