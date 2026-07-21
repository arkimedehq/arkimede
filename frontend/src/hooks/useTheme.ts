/**
 * @file useTheme.ts
 *
 * App theme management: light | dark | auto.
 *
 *   - Persists the preference in localStorage ('theme')
 *   - Applies/removes the `dark` class on <html> based on the preference
 *   - In "auto" mode it listens to the prefers-color-scheme media query
 *     and updates in real time when the OS settings change
 */
import { useState, useEffect } from 'react';

export type ThemePreference = 'light' | 'dark' | 'auto';

const STORAGE_KEY = 'theme';

export function useTheme() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    try {
      return (localStorage.getItem(STORAGE_KEY) as ThemePreference) ?? 'auto';
    } catch {
      return 'auto';
    }
  });

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');

    const apply = () => {
      const isDark =
        preference === 'dark' ||
        (preference === 'auto' && mq.matches);
      document.documentElement.classList.toggle('dark', isDark);
    };

    apply();
    try { localStorage.setItem(STORAGE_KEY, preference); } catch { /* noop */ }

    if (preference === 'auto') {
      mq.addEventListener('change', apply);
      return () => mq.removeEventListener('change', apply);
    }
  }, [preference]);

  const setPreference = (p: ThemePreference) => setPreferenceState(p);

  return { preference, setPreference };
}
