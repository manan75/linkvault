import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Open/closed state for a panel anchored to a button, plus the two ways a user
 * expects to get out of one: clicking away, and pressing Escape.
 *
 * Shared rather than repeated because both panels in the app want identical
 * behaviour, and the part that is easy to get subtly wrong -- unsubscribing the
 * document listeners, and only listening while open -- is the part worth having
 * in one place.
 *
 * `ref` goes on the element wrapping *both* the button and the panel: a click
 * on the button is not an outside click, or opening would immediately close.
 */
export function useDismissablePanel() {
  const ref = useRef(null);
  const [isOpen, setIsOpen] = useState(false);

  const close = useCallback(() => setIsOpen(false), []);
  const toggle = useCallback(() => setIsOpen((open) => !open), []);

  useEffect(() => {
    if (!isOpen) return undefined;

    const onPointerDown = (event) => {
      if (!ref.current?.contains(event.target)) close();
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') close();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen, close]);

  return { ref, isOpen, close, toggle };
}
