/**
 * Selected tags narrow the list: a link must carry every one of them. Counts are
 * for the whole vault, not the current filter, so they stay a stable index.
 */
export function TagFilter({ tags, activeTags, onToggle }) {
  if (tags.length === 0) return null;

  return (
    <div className="mt-6">
      <h2 className="px-2.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">Tags</h2>

      <ul className="mt-2 flex flex-wrap gap-1.5 px-1">
        {tags.map(({ name, count }) => {
          const isActive = activeTags.includes(name);

          return (
            <li key={name}>
              <button
                type="button"
                aria-pressed={isActive}
                onClick={() => onToggle(name)}
                className={`rounded-full border px-2.5 py-1 text-xs transition ${
                  isActive
                    ? 'border-accent bg-accent text-accent-ink'
                    : 'border-line bg-surface text-ink-muted hover:border-line-strong'
                }`}
              >
                {name}
                <span className="ml-1 text-ink-faint">{count}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
