import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState, useEffect } from 'react';
import { LoginForm } from '@/components/auth/login-form';
import { DNSManager } from '@/components/dns/dns-manager';
import { Toaster } from '@/components/ui/toaster';
import { storageManager } from '@/lib/storage';
function App() {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [apiKey, setApiKey] = useState('');
    const [email, setEmail] = useState(undefined);
    useEffect(() => {
        // Check if there's an active session
        const currentSession = storageManager.getCurrentSession();
        if (currentSession) {
            // We have a session but need the password to decrypt the key
            // For now, we'll require login each time for security
        }
    }, []);
    const handleLogin = (decryptedApiKey, keyEmail) => {
        setApiKey(decryptedApiKey);
        setEmail(keyEmail);
        setIsAuthenticated(true);
    };
    const handleLogout = () => {
        setApiKey('');
        setIsAuthenticated(false);
    };
    return (_jsxs("div", { className: "min-h-screen bg-background text-foreground", children: [isAuthenticated ? (_jsx(DNSManager, { apiKey: apiKey, email: email, onLogout: handleLogout })) : (_jsx(LoginForm, { onLogin: handleLogin })), _jsx(Toaster, {})] }));
}
export default App;
