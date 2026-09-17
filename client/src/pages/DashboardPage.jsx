import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { AppearanceMenu } from '../components/AppearanceMenu';
import { CollectionSidebar } from '../components/CollectionSidebar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { DeleteDropZone } from '../components/DeleteDropZone';
import { DragPreview } from '../components/DragPreview';
import { FeedbackMenu } from '../components/FeedbackMenu';
import { FilterBar } from '../components/FilterBar';
import { LinkCard } from '../components/LinkCard';
import { LinkCardSkeleton } from '../components/LinkCardSkeleton';
import { SaveLinkForm } from '../components/SaveLinkForm';
import { TagFilter } from '../components/TagFilter';
import { useAuth } from '../context/auth-context';
import { useVault } from '../hooks/useVault';
import { TRASH_DROP_ID, collectionIdFromDrop } from '../lib/dnd';
import { displayTitle } from '../lib/titleFromUrl';

const NOTICE_MS = 4000;

const SCREEN_READER_INSTRUCTIONS = {
  draggable:
    'Press space or enter to pick up this bookmark. Use the arrow keys to move it over a collection in the sidebar, or over the bin. Press space or enter again to drop it, or escape to cancel.',
};

function EmptyState({ hasActiveFilters, onClear }) {
  if (hasActiveFilters) {
    return (
      <div className="rounded-xl border border-dashed border-line p-10 text-center">
        <p className="text-sm text-ink-muted">Nothing matches those filters.</p>
        <button
          type="button"
          onClick={onClear}
          className="mt-2 text-sm font-medium text-accent-text underline underline-offset-4"
        >
          Clear filters
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-dashed border-line p-10 text-center">
      <p className="font-medium">Your vault is empty.</p>
      <p className="mt-1 text-sm text-ink-muted">
        Paste a URL above. Save it, forget it, find it later.
      </p>
    </div>
  );
}

export function DashboardPage() {
  const { user, logout } = useAuth();
  const vault = useVault();

  const [activeLink, setActiveLink] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [notice, setNotice] = useState(null);

  /*
    Mouse and touch are separate sensors rather than one pointer sensor because
    they need opposite activation rules. A mouse drag starts after 8px, so a
    click on the card's own links and buttons still lands. A touch drag starts
    after a quarter-second hold, so a finger moving down the page scrolls it
    instead of picking a bookmark up.
  */
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );

  /*
    Where the pointer is, and only if it is inside something. The fallback is
    for the keyboard drag, which has no pointer -- it asks whether the card's
    own rectangle overlaps a target instead. Both return nothing when the answer
    is nothing, which is the point: `closestCenter` would file a bookmark into
    whichever collection happened to be nearest when it was dropped on empty
    space.
  */
  const collisionDetection = useCallback((args) => {
    const hits = pointerWithin(args);
    return hits.length > 0 ? hits : rectIntersection(args);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const onDragStart = useCallback(({ active }) => {
    setActiveLink(active.data.current?.link ?? null);
  }, []);

  const onDragCancel = useCallback(() => setActiveLink(null), []);

  const onDragEnd = useCallback(
    async ({ active, over }) => {
      setActiveLink(null);

      const link = active.data.current?.link;
      if (!over || !link) return;

      if (over.id === TRASH_DROP_ID) {
        setPendingDelete(link);
        return;
      }

      const collectionId = collectionIdFromDrop(over.id);
      // Dropped on something that is not a collection at all.
      if (collectionId === undefined) return;
      // Dropped back where it already was. Not an error, just nothing to do.
      if ((link.collectionId ?? null) === collectionId) return;

      const name =
        collectionId === null
          ? 'Uncategorised'
          : (vault.collections.find((entry) => entry.id === collectionId)?.name ??
            'that collection');

      try {
        await vault.updateLink(link.id, { collectionId });
        setNotice(`Moved “${displayTitle(link)}” to ${name}.`);
      } catch (cause) {
        setNotice(cause?.message ?? 'Could not move that bookmark.');
      }
    },
    [vault],
  );

  const cancelDelete = useCallback(() => setPendingDelete(null), []);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;

    setIsDeleting(true);
    try {
      await vault.deleteLink(pendingDelete.id);
      setNotice(`Deleted “${displayTitle(pendingDelete)}”.`);
      setPendingDelete(null);
    } catch (cause) {
      setNotice(cause?.message ?? 'Could not delete that bookmark.');
    } finally {
      setIsDeleting(false);
    }
  }, [pendingDelete, vault]);

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <span className="text-lg font-semibold tracking-tight">LinkVault</span>
          <div className="flex items-center gap-2">
            <span className="hidden px-2 text-sm text-ink-muted sm:inline">{user.email}</span>
            <AppearanceMenu />
            <FeedbackMenu />
            <Link to="/settings" className="lv-button-quiet whitespace-nowrap">
              Settings
            </Link>
            {/*
              Hidden on a phone, where the five header controls do not fit
              across 390px and push the whole page into a sideways scroll.
              Settings is one tap away and signs out from its own header, so
              nothing here becomes unreachable.
            */}
            <button
              type="button"
              onClick={logout}
              className="lv-button-quiet hidden whitespace-nowrap sm:inline-flex"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <div className="mb-8">
          <h1 className="text-xl font-semibold tracking-tight">Hi {user.name.split(' ')[0]}</h1>
          <div className="mt-4 max-w-3xl">
            <SaveLinkForm
              collections={vault.collections}
              onSave={vault.saveLink}
              onCreateCollection={vault.createCollection}
            />
          </div>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          accessibility={{ screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
          onDragCancel={onDragCancel}
        >
          {/*
            `minmax(0,1fr)` on the single-column layout too, not only on the
            wide one. A bare `grid` column is sized by its widest item's
            min-content, so one child that refuses to shrink stretches the
            column -- and with it the sidebar -- past the width of the phone.
          */}
          <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[15rem_minmax(0,1fr)]">
            <aside className="min-w-0 lg:sticky lg:top-20 lg:self-start">
              <CollectionSidebar
                collections={vault.collections}
                uncategorisedCount={vault.uncategorisedCount}
                totalCount={vault.totalCount}
                activeCollectionId={vault.filters.collectionId}
                onSelect={(collectionId) => vault.updateFilters({ collectionId })}
                onCreate={vault.createCollection}
                onRename={vault.renameCollection}
                onDelete={vault.deleteCollection}
              />

              <TagFilter
                tags={vault.tags}
                activeTags={vault.filters.tag}
                onToggle={vault.toggleTag}
                onRename={vault.renameTag}
              />
            </aside>

            <section aria-label="Saved links" className="min-w-0">
              <FilterBar
                filters={vault.filters}
                searchInput={vault.searchInput}
                onSearchInput={vault.setSearchInput}
                onChange={vault.updateFilters}
                onClear={vault.clearFilters}
                hasActiveFilters={vault.hasActiveFilters}
                total={vault.total}
                search={vault.search}
              />

              {vault.error ? (
                <div
                  role="alert"
                  className="mt-4 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger-ink"
                >
                  <p>{vault.error}</p>
                  <button
                    type="button"
                    onClick={vault.reload}
                    className="mt-1 font-medium underline underline-offset-2"
                  >
                    Try again
                  </button>
                </div>
              ) : null}

              {vault.isLoading ? (
                <ul className="mt-4 space-y-3" aria-hidden="true">
                  {[0, 1, 2].map((row) => (
                    <LinkCardSkeleton key={row} />
                  ))}
                </ul>
              ) : null}

              {!vault.isLoading && !vault.error && vault.links.length === 0 ? (
                <div className="mt-4">
                  <EmptyState
                    hasActiveFilters={vault.hasActiveFilters}
                    onClear={vault.clearFilters}
                  />
                </div>
              ) : null}

              <ul className="mt-4 space-y-3">
                {vault.links.map((link) => (
                  <LinkCard
                    key={link.id}
                    link={link}
                    collections={vault.collections}
                    onUpdate={vault.updateLink}
                    onDelete={vault.deleteLink}
                    onRetry={vault.retryLink}
                    onTagClick={vault.toggleTag}
                    onDomainClick={vault.toggleDomain}
                  />
                ))}
              </ul>

              {vault.hasMore ? (
                <button
                  type="button"
                  onClick={vault.loadMore}
                  className="lv-button-quiet mt-4 w-full py-2"
                >
                  Load more
                </button>
              ) : null}
            </section>
          </div>

          <DeleteDropZone isDragging={Boolean(activeLink)} />

          <DragOverlay dropAnimation={null}>
            {activeLink ? (
              <DragPreview link={activeLink} title={displayTitle(activeLink)} />
            ) : null}
          </DragOverlay>
        </DndContext>
      </main>

      {/*
        The result of a move is not always visible: filtered to one collection,
        moving a link out of it makes the row disappear, which on its own reads
        as a bug rather than as the thing that was asked for.
      */}
      <div aria-live="polite" className="sr-only">
        {notice}
      </div>
      {notice ? (
        <div className="fixed bottom-6 right-6 z-40 max-w-sm rounded-lg border border-line bg-surface px-4 py-3 text-sm shadow-lg">
          {notice}
        </div>
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title="Delete this bookmark?"
          body={`“${displayTitle(pendingDelete)}” and everything generated from it — its summary, tags and embedding — are removed permanently. This cannot be undone.`}
          confirmLabel="Delete"
          isBusy={isDeleting}
          onConfirm={confirmDelete}
          onCancel={cancelDelete}
        />
      ) : null}
    </div>
  );
}
