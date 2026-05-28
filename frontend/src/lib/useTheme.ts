'use client';
import { useEffect, useState, useCallback } from 'react';

type Theme = 'light' | 'dark';

// Applies the theme class to <html> and persists the choice. Reads the saved theme (or the
// OS preference) on first load. Returns the current theme and a toggle function.
export function useTheme() {
  const [theme, setThemeState] = useState<Theme>('light');

  useEffect(() => {
    const saved = (typeof window !== 'undefined' && localStorage.getItem('dartbit_theme')) as Theme | null;
    const prefersDark = typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    const initial: Theme = saved || (prefersDark ? 'dark' : 'light');
    apply(initial);
    setThemeState(initial);
  }, []);

  const apply = (t: Theme) => {
    const root = document.documentElement;
    if (t === 'dark') root.classList.add('dark');
    else root.classList.remove('dark');
  };

  const setTheme = useCallback((t: Theme) => {
    apply(t);
    localStorage.setItem('dartbit_theme', t);
    setThemeState(t);
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }, [theme, setTheme]);

  return { theme, setTheme, toggle };
}
