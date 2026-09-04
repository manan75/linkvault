import { Link } from 'react-router-dom';

import { AppearanceMenu } from '../components/AppearanceMenu';
import { CollectionSidebar } from '../components/CollectionSidebar';
import { FilterBar } from '../components/FilterBar';
import { LinkCard } from '../components/LinkCard';
import { LinkCardSkeleton } from '../components/LinkCardSkeleton';
import { SaveLinkForm } from '../components/SaveLinkForm';
import { TagFilter } from '../components/TagFilter';
import { useAuth } from '../context/auth-context';
import { useVault } from '../hooks/useVault';

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

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <span className="text-lg font-semibold tracking-tight">LinkVault</span>
          <div className="flex items-center gap-2">
            <span className="hidden px-2 text-sm text-ink-muted sm:inline">{user.email}</span>
            <AppearanceMenu />
            <Link to="/settings" className="lv-button-quiet">
              Settings
            </Link>
            <button type="button" onClick={logout} className="lv-button-quiet">
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

        <div className="grid gap-8 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-20 lg:self-start">
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

          <section aria-label="Saved links">
            <FilterBar
              filters={vault.filters}
              searchInput={vault.searchInput}
              onSearchInput={vault.setSearchInput}
              onChange={vault.updateFilters}
              onClear={vault.clearFilters}
              hasActiveFilters={vault.hasActiveFilters}
              total={vault.total}
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
      </main>
    </div>
  );
}
