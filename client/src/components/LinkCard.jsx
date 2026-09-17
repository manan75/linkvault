import { useDraggable } from '@dnd-kit/core';
import { useState } from 'react';

import { displayTitle } from '../lib/titleFromUrl';
import { LinkEditor } from './LinkEditor';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

const ICONS = {
  star: 'M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z',
  edit: 'M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17v3z',
  trash: 'M6 7h12M10 7V5h4v2m-7 0 1 13h8l1-13',
  check: 'M20 6 9 17l-5-5',
  retry: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v4h-4',
  // Six dots, drawn as zero-length round-capped segments.
  grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
};

function Icon({ path, filled }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-4"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={path} />
    </svg>
  );
}

function IconButton({ isOn, label, icon, className = '', ...props }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={isOn}
      title={label}
      className={`lv-icon-button ${
        isOn ? 'text-accent-text hover:text-accent-text' : ''
      } ${className}`}
      {...props}
    >
      <Icon path={ICONS[icon]} filled={isOn} />
    </button>
  );
}

/**
 * Hotlinked straight from the origin site, as decided in the Phase 3 plan.
 * `no-referrer` keeps the request from carrying which page it was rendered on,
 * and a broken image is hidden rather than left as a browser placeholder --
 * plenty of sites advertise a favicon they no longer serve.
 */
function RemoteImage({ src, alt, className }) {
  const [failed, setFailed] = useState(false);

  if (!src || failed) return null;

  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setFailed(true)}
      className={className}
    />
  );
}

/** Stand-in for a title that extraction has not produced yet. */
function TitleShimmer() {
  return (
    <span className="lv-shimmer inline-block h-4 w-48 max-w-full rounded bg-surface-sunken align-middle" />
  );
}

function ProcessingNote({ link, onRetry }) {
  if (link.processingStatus === 'failed') {
    return (
      <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span className="rounded-full bg-danger-soft px-2 py-0.5 font-medium text-danger-ink">
          Could not fetch details
        </span>
        <span className="min-w-0 truncate">
          {link.processingError || 'The site did not respond.'}
        </span>
        {onRetry ? (
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex items-center gap-1 font-medium text-accent-text underline underline-offset-2"
          >
            <Icon path={ICONS.retry} />
            Try again
          </button>
        ) : null}
      </p>
    );
  }

  // Only worth saying while there is nothing on screen yet.
  if (link.processingStatus !== 'ready' && !link.description) {
    return <p className="mt-2 text-xs text-ink-faint">Fetching details…</p>;
  }

  return null;
}

export function LinkCard({
  link,
  collections,
  onUpdate,
  onDelete,
  onRetry,
  onTagClick,
  onDomainClick,
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [error, setError] = useState(null);

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: link.id,
    data: { link },
  });

  /*
    The pointer listeners go on the whole card and the key listener goes on the
    grip alone. That split is deliberate: dragging from anywhere on the row is
    what makes the gesture worth having, but a keyboard drag has to start from
    something focusable, and making the row itself focusable would put a
    `role="button"` around the title link and five real buttons.

    Splitting them also avoids the duplicate that spreading `listeners` on both
    would cause -- an event on the grip bubbles to the card, which is where the
    pointer handlers live.
  */
  const { onKeyDown: onGripKeyDown, ...pointerListeners } = listeners ?? {};

  // 'queued' means published to the event log and waiting for a worker; from
  // the reader's point of view it is indistinguishable from the other two.
  const isProcessing = ['pending', 'queued', 'processing'].includes(link.processingStatus);

  // The page's own title when it has a real one, and otherwise what the address
  // itself says. The bare domain used to end up here -- from extraction's old
  // fallback, or from a site that titles itself after its own name -- which
  // told the reader nothing the line underneath was not already showing, and
  // made every leetcode.com bookmark look identical.
  const shownTitle = displayTitle(link);
  const collection = collections.find((entry) => entry.id === link.collectionId);

  const run = (action) => async () => {
    try {
      setError(null);
      await action();
    } catch (cause) {
      setError(cause?.message ?? 'That did not work.');
    }
  };

  if (isEditing) {
    return (
      <li className="rounded-xl border border-line bg-surface p-4">
        <LinkEditor
          link={link}
          collections={collections}
          onSave={(patch) => onUpdate(link.id, patch)}
          onCancel={() => setIsEditing(false)}
        />
      </li>
    );
  }

  return (
    <li
      ref={setNodeRef}
      {...pointerListeners}
      className={`group rounded-xl border border-line bg-surface p-4 transition hover:border-line-strong ${
        // Read state as an edge rather than dimmed text: a read bookmark is
        // still meant to be readable.
        link.isRead ? 'border-l-2 border-l-line' : 'border-l-2 border-l-accent'
      } ${
        // The overlay is carrying the real card; this is the hole it left.
        isDragging ? 'opacity-40' : ''
      }`}
    >
      <div className="flex gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="flex items-center gap-2 font-medium">
                <RemoteImage
                  src={link.favicon}
                  alt=""
                  className="size-4 shrink-0 rounded-sm object-contain"
                />
                <a
                  href={link.url}
                  target="_blank"
                  // Fetched pages are never trusted with a handle on this tab.
                  rel="noreferrer noopener"
                  // Otherwise the browser's own link drag races ours.
                  draggable={false}
                  className="min-w-0 truncate underline-offset-4 hover:underline"
                >
                  {isProcessing && !link.title ? <TitleShimmer /> : shownTitle}
                </a>
              </h3>

              <p className="mt-1 truncate text-xs text-ink-faint">
                {/*
                  The meta line is also where the domain filter is turned on.
                  Filtering to a site is something you want while looking at a
                  link from it, and putting it here means the filter bar does
                  not have to carry a list of every domain in the vault.
                */}
                <button
                  type="button"
                  onClick={() => onDomainClick(link.domain)}
                  title={`Filter by ${link.domain}`}
                  className="underline-offset-2 hover:text-ink hover:underline"
                >
                  {link.domain}
                </button>
                {link.author ? ` · ${link.author}` : ''}
                {` · ${dateFormat.format(new Date(link.savedAt))}`}
                {collection ? ` · ${collection.name}` : ''}
              </p>
            </div>

            {/*
              Actions stay out of the way until the row is hovered or focused.
              The two that carry state -- favourite and read -- stay visible
              once they are on, because hiding them would hide the state.

              `lv-row-action` is what keeps this from being a desktop-only card:
              a touch device never hovers, so without it edit and delete were
              not quiet, they were absent. See index.css.
            */}
            <div className="flex shrink-0 items-center gap-0.5">
              {/*
                The grip is an affordance and a keyboard entry point, not the
                only way in: the pointer handlers are on the whole card. dnd-kit
                supplies the `aria-describedby` that points a screen reader at
                its own instructions.
              */}
              <button
                ref={setActivatorNodeRef}
                type="button"
                {...attributes}
                onKeyDown={onGripKeyDown}
                aria-label={`Move ${shownTitle}`}
                title="Drag to a collection or the bin"
                className="lv-icon-button lv-row-action cursor-grab opacity-0 focus-visible:opacity-100 group-hover:opacity-100 active:cursor-grabbing"
              >
                <Icon path={ICONS.grip} />
              </button>
              <IconButton
                isOn={link.isFavorite}
                icon="star"
                label={link.isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                onClick={run(() => onUpdate(link.id, { isFavorite: !link.isFavorite }))}
                className={
                  link.isFavorite
                    ? ''
                    : 'lv-row-action opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
                }
              />
              <IconButton
                isOn={link.isRead}
                icon="check"
                label={link.isRead ? 'Mark as unread' : 'Mark as read'}
                onClick={run(() => onUpdate(link.id, { isRead: !link.isRead }))}
                className={
                  link.isRead ? '' : 'lv-row-action opacity-0 focus-visible:opacity-100 group-hover:opacity-100'
                }
              />
              <IconButton
                icon="edit"
                label="Edit bookmark"
                onClick={() => setIsEditing(true)}
                className="lv-row-action opacity-0 focus-visible:opacity-100 group-hover:opacity-100"
              />
              <IconButton
                icon="trash"
                label="Delete bookmark"
                onClick={() => setIsConfirmingDelete(true)}
                className="lv-row-action opacity-0 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
              />
            </div>
          </div>

          {/*
            The generated summary wins over the page's own description when it
            exists. It is written for someone who half remembers saving this,
            which is the entire product; the description is written by whoever
            made the page. Showing both would mostly show the same sentence
            twice -- the summary is built from the description.
          */}
          {link.summary || link.description ? (
            <p className="mt-2 line-clamp-2 text-sm text-ink-muted">
              {link.summary || link.description}
            </p>
          ) : null}

          <ProcessingNote link={link} onRetry={onRetry ? run(() => onRetry(link.id)) : undefined} />

          {link.tags.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              {link.tags.map((tag) => {
                // A generated tag reads as a suggestion rather than a fact the
                // user asserted. Only worth distinguishing while the user has
                // not curated this link: once they have, every tag on it is
                // theirs by definition.
                const isAuto = !link.tagsEditedByUser && (link.autoTags ?? []).includes(tag);

                return (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => onTagClick(tag)}
                    title={isAuto ? 'Added automatically — edit the bookmark to change it' : undefined}
                    className={`rounded-full px-2 py-0.5 text-xs transition hover:text-ink ${
                      isAuto
                        ? 'border border-dashed border-line-strong text-ink-faint hover:bg-surface-muted'
                        : 'bg-surface-muted text-ink-muted hover:bg-surface-sunken'
                    }`}
                  >
                    {tag}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <RemoteImage
          src={link.thumbnail}
          alt=""
          className="hidden h-20 w-32 shrink-0 rounded-lg border border-line object-cover sm:block"
        />
      </div>

      {isConfirmingDelete ? (
        <div className="mt-3 flex items-center gap-3 rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger-ink">
          <span>Delete this bookmark permanently?</span>
          <button
            type="button"
            onClick={run(() => onDelete(link.id))}
            className="font-medium underline underline-offset-2"
          >
            Delete
          </button>
          <button
            type="button"
            onClick={() => setIsConfirmingDelete(false)}
            className="text-ink-muted"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}
