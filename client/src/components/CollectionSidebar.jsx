import { useState } from 'react';

import { UNCATEGORISED } from '../hooks/useVault';

function SidebarButton({ isActive, count, children, ...props }) {
  return (
    <button
      type="button"
      aria-current={isActive ? 'true' : undefined}
      className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition ${
        isActive ? 'bg-accent text-accent-ink' : 'text-ink hover:bg-surface-muted'
      }`}
      {...props}
    >
      <span className="truncate">{children}</span>
      <span className={`shrink-0 text-xs ${isActive ? 'text-accent-ink/70' : 'text-ink-faint'}`}>
        {count}
      </span>
    </button>
  );
}

function CollectionRow({ collection, isActive, onSelect, onRename, onDelete }) {
  const [mode, setMode] = useState('view');
  const [name, setName] = useState(collection.name);
  const [error, setError] = useState(null);

  const submitRename = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();

    if (!trimmed || trimmed === collection.name) {
      setMode('view');
      setName(collection.name);
      return;
    }

    try {
      await onRename(collection.id, trimmed);
      setMode('view');
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? 'Could not rename.');
    }
  };

  if (mode === 'rename') {
    return (
      <li>
        <form onSubmit={submitRename} className="px-1 py-1">
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onBlur={submitRename}
            aria-label={`Rename ${collection.name}`}
            className="w-full rounded-md border border-line px-2 py-1 text-sm outline-none focus:border-accent"
          />
          {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
        </form>
      </li>
    );
  }

  if (mode === 'confirm-delete') {
    return (
      <li className="rounded-lg bg-warn-soft px-2.5 py-2 text-xs text-warn-ink">
        <p>
          Delete “{collection.name}”? Its {collection.linkCount}{' '}
          {collection.linkCount === 1 ? 'link stays' : 'links stay'} in your vault.
        </p>
        <div className="mt-1.5 flex gap-2">
          <button
            type="button"
            onClick={() => onDelete(collection.id)}
            className="font-medium text-danger-ink underline underline-offset-2"
          >
            Delete
          </button>
          <button type="button" onClick={() => setMode('view')} className="text-warn-ink">
            Cancel
          </button>
        </div>
      </li>
    );
  }

  return (
    <li className="group relative">
      <SidebarButton
        isActive={isActive}
        count={collection.linkCount}
        onClick={() => onSelect(collection.id)}
      >
        {collection.name}
      </SidebarButton>

      <div className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-1 opacity-0 transition group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
        <button
          type="button"
          onClick={() => setMode('rename')}
          aria-label={`Rename ${collection.name}`}
          className={`rounded px-1 text-xs ${isActive ? 'text-accent-ink/80 hover:text-accent-ink' : 'text-ink-muted hover:text-ink'}`}
        >
          Rename
        </button>
        <button
          type="button"
          onClick={() => setMode('confirm-delete')}
          aria-label={`Delete ${collection.name}`}
          className={`rounded px-1 text-xs ${isActive ? 'text-accent-ink/80 hover:text-accent-ink' : 'text-ink-muted hover:text-danger'}`}
        >
          Delete
        </button>
      </div>
    </li>
  );
}

function NewCollectionForm({ onCreate }) {
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    try {
      await onCreate(trimmed);
      setName('');
      setIsOpen(false);
      setError(null);
    } catch (cause) {
      setError(cause?.message ?? 'Could not create that collection.');
    }
  };

  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="mt-1 w-full rounded-lg px-2.5 py-1.5 text-left text-sm text-ink-muted transition hover:bg-surface-muted hover:text-ink"
      >
        + New collection
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="mt-1 px-1">
      <input
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && setIsOpen(false)}
        placeholder="Collection name"
        aria-label="New collection name"
        maxLength={60}
        className="w-full rounded-md border border-line px-2 py-1 text-sm outline-none focus:border-accent"
      />
      {error ? <p className="mt-1 text-xs text-danger">{error}</p> : null}
    </form>
  );
}

export function CollectionSidebar({
  collections,
  uncategorisedCount,
  totalCount,
  activeCollectionId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}) {
  return (
    <nav aria-label="Collections">
      <h2 className="px-2.5 text-xs font-semibold uppercase tracking-wide text-ink-faint">
        Collections
      </h2>

      <ul className="mt-2 space-y-0.5">
        <li>
          <SidebarButton
            isActive={activeCollectionId === null}
            count={totalCount}
            onClick={() => onSelect(null)}
          >
            All links
          </SidebarButton>
        </li>
        <li>
          <SidebarButton
            isActive={activeCollectionId === UNCATEGORISED}
            count={uncategorisedCount}
            onClick={() => onSelect(UNCATEGORISED)}
          >
            Uncategorised
          </SidebarButton>
        </li>

        {collections.map((collection) => (
          <CollectionRow
            key={collection.id}
            collection={collection}
            isActive={activeCollectionId === collection.id}
            onSelect={onSelect}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
      </ul>

      <NewCollectionForm onCreate={onCreate} />
    </nav>
  );
}
