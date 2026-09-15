import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { feedbackApi } from '../lib/api';
import { useDismissablePanel } from '../hooks/useDismissablePanel';

const MAX_LENGTH = 2000;

/*
  How long the "Thanks" panel stays up before closing itself. Long enough to
  read, short enough that it never becomes a thing to dismiss.
*/
const THANKS_MS = 1600;

export function FeedbackMenu() {
  const { ref, isOpen, close, toggle } = useDismissablePanel();
  const { pathname } = useLocation();

  const [message, setMessage] = useState('');
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  const textareaRef = useRef(null);

  // Opening a box to type in and then having to click it is a small rudeness
  // that costs responses.
  useEffect(() => {
    if (isOpen) textareaRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    if (status !== 'sent') return undefined;

    const timer = setTimeout(() => {
      close();
      // Reset after the panel is gone, so the text does not visibly vanish
      // while the user is still looking at it.
      setStatus('idle');
      setMessage('');
    }, THANKS_MS);

    return () => clearTimeout(timer);
  }, [status, close]);

  async function onSubmit(event) {
    event.preventDefault();
    if (!message.trim() || status === 'sending') return;

    setStatus('sending');
    setError('');

    try {
      await feedbackApi.send(message.trim(), pathname);
      setStatus('sent');
    } catch (sendError) {
      // The typed message is deliberately left in the box. Losing what someone
      // wrote because the network blinked is how you stop hearing from them.
      setStatus('idle');
      setError(sendError.message ?? 'Could not send that. Try again in a moment.');
    }
  }

  const remaining = MAX_LENGTH - message.length;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className="lv-button-quiet"
      >
        Feedback
      </button>

      {isOpen ? (
        <div
          role="dialog"
          aria-label="Send feedback"
          className="absolute right-0 z-20 mt-2 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-3 shadow-lg"
        >
          {status === 'sent' ? (
            <p className="px-1 py-6 text-center text-sm text-ink-muted">
              Thanks — that landed.
            </p>
          ) : (
            <form onSubmit={onSubmit}>
              <label htmlFor="feedback-message" className="text-sm font-medium">
                What is not working?
              </label>
              <p className="mt-1 text-xs text-ink-faint">
                Rough notes are fine. Half-finished thoughts are fine.
              </p>

              <textarea
                id="feedback-message"
                ref={textareaRef}
                value={message}
                onChange={(event) => setMessage(event.target.value.slice(0, MAX_LENGTH))}
                rows={4}
                placeholder="Searched for my Kafka notes and got nothing…"
                className="lv-field mt-2 w-full resize-y"
              />

              {error ? <p className="mt-2 text-xs text-danger-ink">{error}</p> : null}

              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs text-ink-faint">
                  {remaining < 200 ? `${remaining} left` : 'Sent with your email'}
                </span>
                <button
                  type="submit"
                  disabled={!message.trim() || status === 'sending'}
                  className="lv-button"
                >
                  {status === 'sending' ? 'Sending…' : 'Send'}
                </button>
              </div>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
}
