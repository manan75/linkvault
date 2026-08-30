import { useState } from 'react';

import { toFormErrors } from '../lib/formErrors';

const parseTags = (value) =>
  value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

/**
 * Manual editing of the fields a user owns. Everything else on a bookmark --
 * summary, embedding, processing status -- belongs to the pipeline.
 */
export function LinkEditor({ link, collections, onSave, onCancel }) {
  const [values, setValues] = useState({
    title: link.title,
    description: link.description,
    tags: link.tags.join(', '),
    collectionId: link.collectionId ?? '',
  });
  const [error, setError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setValues((current) => ({ ...current, [name]: value }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setIsSaving(true);
    setError(null);

    try {
      await onSave({
        title: values.title.trim(),
        description: values.description.trim(),
        tags: parseTags(values.tags),
        collectionId: values.collectionId || null,
      });
      onCancel();
    } catch (cause) {
      const { fieldErrors, formError } = toFormErrors(cause);
      setError(Object.values(fieldErrors)[0] ?? formError ?? 'Could not save those changes.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor={`title-${link.id}`} className="block text-xs font-medium text-ink-muted">
          Title
        </label>
        <input
          id={`title-${link.id}`}
          name="title"
          value={values.title}
          onChange={handleChange}
          maxLength={300}
          placeholder={link.domain}
          className="lv-field mt-1 w-full"
        />
      </div>

      <div>
        <label
          htmlFor={`description-${link.id}`}
          className="block text-xs font-medium text-ink-muted"
        >
          Notes
        </label>
        <textarea
          id={`description-${link.id}`}
          name="description"
          value={values.description}
          onChange={handleChange}
          rows={2}
          maxLength={2000}
          className="lv-field mt-1 w-full resize-y"
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor={`tags-${link.id}`} className="block text-xs font-medium text-ink-muted">
            Tags
          </label>
          <input
            id={`tags-${link.id}`}
            name="tags"
            value={values.tags}
            onChange={handleChange}
            placeholder="comma, separated"
            className="lv-field mt-1 w-full"
          />
        </div>

        <div>
          <label
            htmlFor={`collection-${link.id}`}
            className="block text-xs font-medium text-ink-muted"
          >
            Collection
          </label>
          <select
            id={`collection-${link.id}`}
            name="collectionId"
            value={values.collectionId}
            onChange={handleChange}
            className="lv-field mt-1 w-full"
          >
            <option value="">No collection</option>
            {collections.map((collection) => (
              <option key={collection.id} value={collection.id}>
                {collection.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isSaving}
          className="lv-button px-3 py-1.5"
        >
          {isSaving ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="lv-button-quiet"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
