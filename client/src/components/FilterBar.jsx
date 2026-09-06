function Chip({ isActive, children, ...props }) {
  return (
    <button
      type="button"
      aria-pressed={isActive}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
        isActive
          ? 'border-accent bg-accent text-accent-ink'
          : 'border-line bg-surface text-ink-muted hover:border-line-strong'
      }`}
      {...props}
    >
      {children}
    </button>
  );
}

/** Cycles the read filter: any → read only → unread only → any. */
function nextReadState(current) {
  if (current === undefined) return true;
  if (current === true) return false;
  return undefined;
}

function readStateLabel(current) {
  if (current === true) return 'Read only';
  if (current === false) return 'Unread only';
  return 'Read state';
}

/**
 * Says what the search actually did, when it did something the results alone
 * would not explain.
 *
 * Both cases are ones where staying silent makes the search look broken rather
 * than honest. A relaxed query returns links that share only some of the typed
 * words, which is inexplicable without a line saying so. A failed semantic half
 * silently removes the ability to search by description, and the only visible
 * symptom is that a query that worked yesterday finds nothing today.
 */
function SearchNote({ search, query }) {
  if (!search || !query) return null;

  if (search.semanticFailed) {
    return (
      <p className="text-xs text-ink-muted">
        Searching by words only &mdash; matching by meaning is unavailable right now.
      </p>
    );
  }

  if (search.relaxed) {
    return (
      <p className="text-xs text-ink-muted">
        No link matches every word, so these match some of them.
      </p>
    );
  }

  return null;
}

export function FilterBar({
  filters,
  searchInput,
  onSearchInput,
  onChange,
  onClear,
  hasActiveFilters,
  total,
  search,
}) {
  return (
    <div className="space-y-3">
      <input
        type="search"
        value={searchInput}
        onChange={(event) => onSearchInput(event.target.value)}
        placeholder="Search your links, or describe one"
        aria-label="Search your links"
        className="lv-field w-full"
      />

      <SearchNote search={search} query={filters.q} />

      <div className="flex flex-wrap items-center gap-2">
        <Chip
          isActive={filters.isFavorite === true}
          onClick={() => onChange({ isFavorite: filters.isFavorite === true ? undefined : true })}
        >
          ★ Favorites
        </Chip>

        <Chip
          isActive={filters.isRead !== undefined}
          onClick={() => onChange({ isRead: nextReadState(filters.isRead) })}
        >
          {readStateLabel(filters.isRead)}
        </Chip>

        <select
          value={filters.sort ?? ''}
          onChange={(event) => onChange({ sort: event.target.value || undefined })}
          aria-label="Sort links"
          className="rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink-muted outline-none focus:border-accent"
        >
          <option value="">{filters.q ? 'Most relevant' : 'Newest first'}</option>
          <option value="newest">Newest first</option>
          <option value="oldest">Oldest first</option>
        </select>

        <span className="ml-auto text-xs text-ink-muted">
          {total} {total === 1 ? 'link' : 'links'}
        </span>

        {hasActiveFilters ? (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-ink-muted underline underline-offset-2 hover:text-ink"
          >
            Clear filters
          </button>
        ) : null}
      </div>
    </div>
  );
}
