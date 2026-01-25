import { useState, useEffect } from "react";
import { LoginForm } from "@/components/auth/LoginForm";
import { DNSManager } from "@/components/dns/DNSManager";
import { Toaster } from "@/components/ui/toaster";
import { storageManager } from "@/lib/storage";
import { LanguageSelector } from "@/components/ui/LanguageSelector";
import { WindowTitleBar } from "@/components/ui/WindowTitleBar";
import { isDesktop } from "@/lib/environment";

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [apiKey, setApiKey] = useState<string>("");
  const [email, setEmail] = useState<string | undefined>(undefined);
  const [isDesktopEnv, setIsDesktopEnv] = useState(false);

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

  const handleLogin = (decryptedApiKey: string, keyEmail?: string) => {
    setApiKey(decryptedApiKey);
    setEmail(keyEmail);
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    setApiKey("");
    setIsAuthenticated(false);
  };

  const languageSelectorTop = isDesktopEnv ? "top-12" : "top-3";

  return (
    <div className="min-h-screen bg-background text-foreground">
      {isDesktopEnv ? <WindowTitleBar /> : null}
      <div className={`absolute right-3 z-20 ${languageSelectorTop}`}>
        <LanguageSelector />
      </div>
      <div className={isDesktopEnv ? "pt-9" : ""}>
        {isAuthenticated ? (
          <DNSManager apiKey={apiKey} email={email} onLogout={handleLogout} />
        ) : (
          <LoginForm onLogin={handleLogin} />
        )}
      </div>
      <Toaster />
    </div>
  );
}
export default App;
