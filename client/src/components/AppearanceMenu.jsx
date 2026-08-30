import { useEffect, useRef, useState } from 'react';

import { ACCENTS, THEMES } from '../lib/preferences';
import { usePreferences } from '../hooks/usePreferences';

const THEME_LABELS = { system: 'System', light: 'Light', dark: 'Dark' };

function ThemeIcon({ resolvedTheme }) {
  // Shows what is currently painted, so the control reads as "appearance"
  // rather than as a toggle whose next state has to be guessed.
  if (resolvedTheme === 'dark') {
    return (
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-current">
        <path d="M21 13.2A9 9 0 1 1 10.8 3a7.2 7.2 0 0 0 10.2 10.2Z" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-current">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10 2.1 2.1m0-14.2-2.1 2.1m-10 10-2.1 2.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  );
}

export function AppearanceMenu() {
  const { theme, accent, resolvedTheme, setTheme, setAccent } = usePreferences();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;

    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) setIsOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setIsOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label="Appearance"
        title="Appearance"
        className="flex size-9 items-center justify-center rounded-lg border border-line bg-surface text-ink-muted transition hover:bg-surface-muted hover:text-ink"
      >
        <ThemeIcon resolvedTheme={resolvedTheme} />
      </button>

      {isOpen ? (
        <div
          role="dialog"
          aria-label="Appearance settings"
          className="absolute right-0 z-20 mt-2 w-60 rounded-xl border border-line bg-surface p-3 shadow-lg"
        >
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Theme</p>
          <div className="mt-2 flex rounded-lg bg-surface-muted p-0.5">
            {THEMES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setTheme(option)}
                aria-pressed={theme === option}
                className={`flex-1 rounded-md px-2 py-1 text-xs font-medium transition ${
                  theme === option
                    ? 'bg-accent text-accent-ink'
                    : 'text-ink-muted hover:text-ink'
                }`}
              >
                {THEME_LABELS[option]}
              </button>
            ))}
          </div>

          <p className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            Accent
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {ACCENTS.map((option) => (
              <button
                key={option.id}
                type="button"
                onClick={() => setAccent(option.id)}
                aria-pressed={accent === option.id}
                aria-label={option.label}
                title={option.label}
                style={{ backgroundColor: option.swatch }}
                className={`size-7 rounded-full transition ${
                  accent === option.id
                    ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface'
                    : 'ring-1 ring-line hover:ring-line-strong'
                }`}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
