import { useCallback, useEffect, useState } from 'react';

import {
  applyPreferences,
  readPreferences,
  resolveTheme,
  watchSystemTheme,
  writePreference,
} from '../lib/preferences';

/**
 * The single owner of appearance state. Initialised from storage, applied to
 * `<html>` on every change, and re-applied when the OS theme moves while the
 * user is on "system".
 */
export function usePreferences() {
  const [preferences, setPreferences] = useState(readPreferences);

  useEffect(() => {
    applyPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    if (preferences.theme !== 'system') return undefined;
    return watchSystemTheme(() => applyPreferences(preferences));
  }, [preferences]);

  const set = useCallback((key, value) => {
    writePreference(key, value);
    setPreferences((current) => ({ ...current, [key]: value }));
  }, []);

  return {
    ...preferences,
    resolvedTheme: resolveTheme(preferences.theme),
    setTheme: (theme) => set('theme', theme),
    setAccent: (accent) => set('accent', accent),
  };
}
