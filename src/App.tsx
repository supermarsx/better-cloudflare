import { useState, useEffect } from 'react';
import { LoginForm } from '@/components/auth/login-form';
import { DNSManager } from '@/components/dns/dns-manager';
import { Toaster } from '@/components/ui/toaster';
import { storageManager } from '@/lib/storage';

function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [apiKey, setApiKey] = useState<string>('');
  const [email, setEmail] = useState<string | undefined>(undefined);

  useEffect(() => {
    // Check if there's an active session
    const currentSession = storageManager.getCurrentSession();
    if (currentSession) {
      // We have a session but need the password to decrypt the key
      // For now, we'll require login each time for security
    }
  }, []);

  const handleLogin = (decryptedApiKey: string, keyEmail?: string) => {
    setApiKey(decryptedApiKey);
    setEmail(keyEmail);
    setIsAuthenticated(true);
  };

  const handleLogout = () => {
    setApiKey('');
    setIsAuthenticated(false);
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      {isAuthenticated ? (
        <DNSManager apiKey={apiKey} email={email} onLogout={handleLogout} />
      ) : (
        <LoginForm onLogin={handleLogin} />
      )}
      <Toaster />
    </div>
  );
}
export default App;
