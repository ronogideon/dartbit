'use client';
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  tenantId?: string;
  mustChangePassword?: boolean;
}

interface AuthContextType {
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  clearMustChangePassword: () => void;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const storedToken = localStorage.getItem('dartbit_token');
    const storedUser = localStorage.getItem('dartbit_user');
    if (storedToken && storedUser) {
      setToken(storedToken);
      setUser(JSON.parse(storedUser));
    }
    setIsLoading(false);
  }, []);

  const setAuth = (user: User, token: string) => {
    localStorage.setItem('dartbit_token', token);
    localStorage.setItem('dartbit_user', JSON.stringify(user));
    setUser(user);
    setToken(token);
  };

  // Called once the user sets a new password (or skips) so the prompt doesn't reappear this session.
  const clearMustChangePassword = () => {
    setUser(prev => {
      if (!prev) return prev;
      const next = { ...prev, mustChangePassword: false };
      localStorage.setItem('dartbit_user', JSON.stringify(next));
      return next;
    });
  };

  const logout = () => {
    localStorage.removeItem('dartbit_token');
    localStorage.removeItem('dartbit_user');
    setUser(null);
    setToken(null);
    window.location.href = '/auth/login';
  };

  return (
    <AuthContext.Provider value={{ user, token, setAuth, clearMustChangePassword, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
