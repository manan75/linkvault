/**
 * Appearance preferences: how they are stored, and how they reach the DOM.
 *
 * `localStorage` rather than the user record, decided in the Phase 3 plan: it
 * paints correctly on the first frame and needs no backend. It does not follow
 * the user to another device, which is accepted. Every read and write lives
 * behind this module and `usePreferences`, so moving to `User.preferences`
 * later touches those two files and nothing else.
 */

export const STORAGE_KEYS = { theme: 'linkvault.theme', accent: 'linkvault.accent' };

/** Tri-state, not a boolean: "system" is the default and follows the OS. */
export const THEMES = ['system', 'light', 'dark'];

/**
 * Accent presets. The values live in index.css keyed by `data-accent`; these
 * swatch colours are only what the picker paints, so they intentionally sit
 * mid-way between the light and dark renderings of each accent.
 */
export const ACCENTS = [
  { id: 'slate', label: 'Slate', swatch: 'oklch(0.55 0.03 265)' },
  { id: 'blue', label: 'Blue', swatch: 'oklch(0.55 0.16 255)' },
  { id: 'violet', label: 'Violet', swatch: 'oklch(0.55 0.15 300)' },
  { id: 'emerald', label: 'Emerald', swatch: 'oklch(0.55 0.13 160)' },
  { id: 'amber', label: 'Amber', swatch: 'oklch(0.55 0.14 65)' },
  { id: 'rose', label: 'Rose', swatch: 'oklch(0.55 0.16 15)' },
];

export const DEFAULT_PREFERENCES = { theme: 'system', accent: 'slate' };

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Storage throws in some privacy modes, so every access is guarded. */
function read(key, allowed, fallback) {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

export function readPreferences() {
  return {
    theme: read(STORAGE_KEYS.theme, THEMES, DEFAULT_PREFERENCES.theme),
    accent: read(
      STORAGE_KEYS.accent,
      ACCENTS.map((accent) => accent.id),
      DEFAULT_PREFERENCES.accent,
    ),
  };
}

export function writePreference(key, value) {
  try {
    localStorage.setItem(STORAGE_KEYS[key], value);
  } catch {
    // The preference still applies for this session; it just will not persist.
  }
}

export function prefersDark() {
  return typeof matchMedia === 'function' && matchMedia(DARK_QUERY).matches;
}

/** Resolves the tri-state choice to what should actually be painted. */
export function resolveTheme(theme) {
  if (theme === 'system') return prefersDark() ? 'dark' : 'light';
  return theme;
}

export function applyPreferences({ theme, accent }) {
  const root = document.documentElement;

  if (resolveTheme(theme) === 'dark') root.dataset.theme = 'dark';
  else delete root.dataset.theme;

  root.dataset.accent = accent;
}

/** Subscribes to OS theme changes. Returns an unsubscribe function. */
export function watchSystemTheme(onChange) {
  if (typeof matchMedia !== 'function') return () => {};

  const query = matchMedia(DARK_QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
