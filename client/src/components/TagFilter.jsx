import { useEffect, useRef, useState } from 'react';

/**
 * Selected tags narrow the list: a link must carry every one of them. Counts are
 * for the whole vault, not the current filter, so they stay a stable index.
 *
 * Renaming lives here because auto-tags land here. A generated vocabulary is
 * never going to be exactly the one the user would have written, and being able
 * to fix a name in two seconds is what makes that tolerable -- renaming onto a
 * tag that already exists merges the two.
 */
export function TagFilter({ tags, activeTags, onToggle, onRename }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (tags.length === 0) return null;

  const startEditing = (name) => {
    setEditing(name);
    setDraft(name);
    setError(null);
  };

  const stopEditing = () => {
    setEditing(null);
    setError(null);
  };

  const submit = async (event) => {
    event.preventDefault();

    const next = draft.trim();
    if (!next || next === editing) return stopEditing();

    setIsSaving(true);
    try {
      await onRename(editing, next);
      stopEditing();
    } catch (cause) {
      setError(cause?.message ?? 'That rename did not work.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="mt-6">
      <h2 className="px-2.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">Tags</h2>

      <ul className="mt-2 flex flex-wrap gap-1.5 px-1">
        {tags.map(({ name, count }) => {
          const isActive = activeTags.includes(name);

          if (editing === name) {
            return (
              <li key={name} className="w-full">
                <form onSubmit={submit} className="flex items-center gap-1">
                  <input
                    ref={inputRef}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => event.key === 'Escape' && stopEditing()}
                    // Blur is a cancel rather than a save: a rename touches every
                    // link carrying the tag, so it should never happen by
                    // accident on the way to clicking something else.
                    onBlur={stopEditing}
                    disabled={isSaving}
                    maxLength={40}
                    aria-label={`Rename the tag ${name}`}
                    className="min-w-0 flex-1 rounded-md border border-accent bg-surface px-2 py-1 text-xs outline-none"
                  />
                </form>
                {error ? (
                  <p role="alert" className="mt-1 px-1 text-xs text-danger">
                    {error}
                  </p>
                ) : null}
              </li>
            );
          }

          return (
            <li key={name} className="group/tag relative">
              <button
                type="button"
                aria-pressed={isActive}
                onClick={() => onToggle(name)}
                className={`rounded-full border py-1 pl-2.5 pr-6 text-xs transition ${
                  isActive
                    ? 'border-accent bg-accent text-accent-ink'
                    : 'border-line bg-surface text-ink-muted hover:border-line-strong'
                }`}
              >
                {name}
                <span className={isActive ? 'ml-1 opacity-70' : 'ml-1 text-ink-faint'}>{count}</span>
              </button>

              {/*
                A sibling rather than a nested button, which is invalid markup.
                Hidden until the pill is hovered or the control itself is
                focused, so the sidebar stays a list of tags rather than a list
                of controls -- but always reachable by keyboard.
              */}
              {onRename ? (
                <button
                  type="button"
                  aria-label={`Rename the tag ${name}`}
                  title="Rename or merge"
                  onClick={() => startEditing(name)}
                  className={`absolute inset-y-0 right-0 flex items-center rounded-r-full px-1.5 opacity-0 transition focus-visible:opacity-100 group-hover/tag:opacity-100 ${
                    isActive ? 'text-accent-ink' : 'text-ink-faint hover:text-ink'
                  }`}
                >
                  <svg
                    viewBox="0 0 24 24"
                    aria-hidden="true"
                    className="size-3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z" />
                  </svg>
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
