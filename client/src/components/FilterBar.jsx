import { useDismissablePanel } from '../hooks/useDismissablePanel';

function chipClass(isActive) {
  return `rounded-full border px-3 py-1 text-xs font-medium transition ${
    isActive
      ? 'border-accent bg-accent text-accent-ink'
      : 'border-line bg-surface text-ink-muted hover:border-line-strong'
  }`;
}

function Chip({ isActive, children, ...props }) {
  return (
    <button type="button" aria-pressed={isActive} className={chipClass(isActive)} {...props}>
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

/** Midnight this morning, `days` ago. A preset means whole days, not "168 hours". */
function startOfDaysAgo(days) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

const DATE_PRESETS = [
  { label: 'Past week', days: 7 },
  { label: 'Past month', days: 30 },
  { label: 'Past year', days: 365 },
];

function formatBoundary(iso) {
  const date = new Date(iso);
  const isThisYear = date.getFullYear() === new Date().getFullYear();

  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    ...(isThisYear ? {} : { year: 'numeric' }),
  }).format(date);
}

/**
 * The chip label is derived from the boundaries themselves rather than from a
 * remembered "Past week" choice, so it stays true after a custom date is typed
 * over a preset, and after midnight moves what "past week" would mean.
 */
function dateRangeLabel({ savedAfter, savedBefore }) {
  if (savedAfter && savedBefore) {
    return `${formatBoundary(savedAfter)} – ${formatBoundary(savedBefore)}`;
  }
  if (savedAfter) return `Since ${formatBoundary(savedAfter)}`;
  if (savedBefore) return `Until ${formatBoundary(savedBefore)}`;
  return 'Any time';
}

/**
 * `<input type="date">` speaks local calendar days and the API speaks instants,
 * so both directions convert through local date parts.
 *
 * `toISOString().slice(0, 10)` is the obvious way to fill the input and is wrong
 * everywhere but UTC: midnight on the 13th in Kolkata is 18:30 on the 12th in
 * UTC, and the picker would open on the wrong day.
 */
function toDateInput(iso) {
  if (!iso) return '';

  const date = new Date(iso);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A picked day becomes the start of that day when it opens a range and the end
 * of it when it closes one, so choosing the same date for both means that whole
 * day rather than a single empty instant at its start.
 */
function fromDateInput(value, edge) {
  if (!value) return null;

  const [year, month, day] = value.split('-').map(Number);
  return edge === 'end'
    ? new Date(year, month - 1, day, 23, 59, 59, 999).toISOString()
    : new Date(year, month - 1, day).toISOString();
}

function DateRangeFilter({ filters, onChange }) {
  const { ref, isOpen, toggle, close } = useDismissablePanel();
  const isActive = Boolean(filters.savedAfter || filters.savedBefore);

  const applyPreset = (days) => {
    // A preset is a floor with no ceiling: "past week" means since then, not
    // between then and now, and carrying a stale ceiling over would silently
    // hide everything saved since.
    onChange({ savedAfter: startOfDaysAgo(days), savedBefore: null });
    close();
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        className={chipClass(isActive)}
      >
        {dateRangeLabel(filters)}
      </button>

      {isOpen ? (
        <div
          role="dialog"
          aria-label="Filter by save date"
          className="absolute left-0 z-20 mt-2 w-64 rounded-xl border border-line bg-surface p-3 shadow-lg"
        >
          <div className="flex flex-wrap gap-2">
            {DATE_PRESETS.map((preset) => (
              <Chip key={preset.days} isActive={false} onClick={() => applyPreset(preset.days)}>
                {preset.label}
              </Chip>
            ))}
          </div>

          <div className="mt-3 space-y-2">
            <label className="block text-xs text-ink-muted">
              From
              <input
                type="date"
                value={toDateInput(filters.savedAfter)}
                max={toDateInput(filters.savedBefore) || undefined}
                onChange={(event) =>
                  onChange({ savedAfter: fromDateInput(event.target.value, 'start') })
                }
                className="lv-field mt-1 w-full text-xs"
              />
            </label>

            <label className="block text-xs text-ink-muted">
              To
              <input
                type="date"
                value={toDateInput(filters.savedBefore)}
                min={toDateInput(filters.savedAfter) || undefined}
                onChange={(event) =>
                  onChange({ savedBefore: fromDateInput(event.target.value, 'end') })
                }
                className="lv-field mt-1 w-full text-xs"
              />
            </label>
          </div>

          <button
            type="button"
            onClick={() => {
              onChange({ savedAfter: null, savedBefore: null });
              close();
            }}
            disabled={!isActive}
            className="mt-3 text-xs text-ink-muted underline underline-offset-2 hover:text-ink disabled:no-underline disabled:opacity-50"
          >
            Any time
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Only rendered while a domain filter is on, because the way one is turned *on*
 * is clicking the domain on a link. That keeps this bar from having to carry a
 * list of every site in the vault, but it also makes this chip the only visible
 * sign the filter exists — so it has to say what it narrowed to, and offer the
 * way back out.
 */
function DomainChip({ domain, onClear }) {
  return (
    <button
      type="button"
      onClick={onClear}
      title={`Stop showing only links from ${domain}`}
      className={`${chipClass(true)} inline-flex items-center gap-1.5`}
    >
      {domain}
      <span aria-hidden="true">✕</span>
      <span className="sr-only">Remove domain filter</span>
    </button>
  );
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

        <DateRangeFilter filters={filters} onChange={onChange} />

        {filters.domain ? (
          <DomainChip domain={filters.domain} onClear={() => onChange({ domain: null })} />
        ) : null}

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
