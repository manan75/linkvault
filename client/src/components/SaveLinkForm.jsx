import { useState } from 'react';

import { ApiRequestError } from '../lib/api';
import { toFormErrors } from '../lib/formErrors';

/** Sentinel for the "+ New collection…" option, which no real id can collide with. */
const NEW_COLLECTION = '__new__';

const equalNames = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Paste a URL and optionally file it as you save. The collection defaults to
 * none, so the fast path is still one paste and one click; choosing is opt-in.
 */
export function SaveLinkForm({ collections = [], onSave, onCreateCollection }) {
  const [url, setUrl] = useState('');
  const [choice, setChoice] = useState('');
  const [newName, setNewName] = useState('');
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  const isCreating = choice === NEW_COLLECTION;

  /**
   * Resolves the collection to save into, creating it first when the user typed
   * a new name. A name that already exists is reused rather than reported as a
   * conflict: the intent is "put it here", and here already exists.
   */
  const resolveCollectionId = async () => {
    if (!isCreating) return choice || undefined;

    const name = newName.trim();
    if (!name) return undefined;

    const existing = collections.find((entry) => equalNames(entry.name, name));
    if (existing) return existing.id;

    try {
      const created = await onCreateCollection(name);
      return created.id;
    } catch (cause) {
      // Lost a race with another tab creating the same name.
      if (cause instanceof ApiRequestError && cause.status === 409) {
        const clash = collections.find((entry) => equalNames(entry.name, name));
        if (clash) return clash.id;
      }
      throw cause;
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!url.trim() || isSaving) return;

    setIsSaving(true);
    setError(null);
    setStatus(null);

    try {
      const collectionId = await resolveCollectionId();
      const { link, created, moved } = await onSave(url.trim(), collectionId);
      const target = collections.find((entry) => entry.id === link.collectionId);
      const label = link.title || link.domain;

      setUrl('');
      setNewName('');
      // Keep the chosen collection selected: saving several links into the same
      // place is the common case, and re-picking it each time is friction.
      if (isCreating) setChoice(link.collectionId ?? '');

      // Re-saving is not an error, but the user deserves to know nothing new was
      // added rather than wondering why the list looks unchanged.
      if (created) {
        setStatus(target ? `Saved ${link.domain} to ${target.name}` : `Saved ${link.domain}`);
      } else if (moved) {
        setStatus(`Already saved — moved ${label} to ${target?.name ?? 'no collection'}`);
      } else {
        setStatus(`Already in your vault: ${label}`);
      }
    } catch (cause) {
      const { fieldErrors, formError } = toFormErrors(cause);
      setError(fieldErrors.url ?? formError ?? 'Could not save that link.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="Paste a URL to save it"
          aria-label="URL to save"
          aria-invalid={Boolean(error)}
          className="lv-field min-w-0 flex-1"
        />

        <div className="flex gap-2">
          <select
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
            aria-label="Collection to save into"
            className="lv-field min-w-0 flex-1 sm:w-44"
          >
            <option value="">No collection</option>
            {collections.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.name}
              </option>
            ))}
            <option value={NEW_COLLECTION}>+ New collection…</option>
          </select>

          <button
            type="submit"
            disabled={isSaving || !url.trim() || (isCreating && !newName.trim())}
            className="lv-button shrink-0"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {isCreating ? (
        <input
          autoFocus
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              setChoice('');
              setNewName('');
            }
          }}
          placeholder="New collection name"
          aria-label="New collection name"
          maxLength={60}
          className="lv-field mt-2 w-full sm:max-w-xs"
        />
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}

      {status && !error ? <p className="mt-2 text-sm text-ink-muted">{status}</p> : null}
    </form>
  );
}
