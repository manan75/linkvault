import { useCallback, useEffect, useRef } from 'react';

const FOCUSABLE = 'button:not([disabled])';

/**
 * A modal confirmation, for the one action in the vault that cannot be undone.
 *
 * Deleting by dragging to the bin is fast enough to be done by accident, and
 * the link and everything derived from it -- summary, tags, embedding -- goes
 * with it. That is what earns the interruption here when the rest of the app
 * confirms inline.
 */
export function ConfirmDialog({ title, body, confirmLabel, onConfirm, onCancel, isBusy }) {
  const panelRef = useRef(null);
  const confirmRef = useRef(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  // Escape closes, and Tab cycles inside rather than wandering off into the
  // page behind -- with two buttons the whole trap is the pair of edges.
  const onKeyDown = useCallback(
    (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = [...(panelRef.current?.querySelectorAll(FOCUSABLE) ?? [])];
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onCancel],
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onKeyDown={onKeyDown}
      // A click that starts and ends on the backdrop itself dismisses; one that
      // began inside the panel and drifted out does not.
      onMouseDown={(event) => event.target === event.currentTarget && onCancel()}
    >
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="lv-confirm-title"
        aria-describedby="lv-confirm-body"
        className="w-full max-w-sm rounded-xl border border-line bg-surface p-5 shadow-2xl"
      >
        <h2 id="lv-confirm-title" className="text-base font-semibold">
          {title}
        </h2>
        <p id="lv-confirm-body" className="mt-2 text-sm text-ink-muted">
          {body}
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="lv-button-quiet">
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            onClick={onConfirm}
            disabled={isBusy}
            className="lv-button bg-danger hover:bg-danger disabled:hover:bg-danger"
          >
            {isBusy ? 'Deleting…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
