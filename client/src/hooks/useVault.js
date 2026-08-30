import { useCallback, useEffect, useMemo, useState } from 'react';

import { collectionsApi, linksApi } from '../lib/api';

/** `collectionId` uses this to mean "links that are in no collection". */
export const UNCATEGORISED = 'none';

export const EMPTY_FILTERS = {
  q: '',
  tag: [],
  collectionId: null,
  isFavorite: undefined,
  isRead: undefined,
};

function messageFor(error) {
  return error?.message ?? 'Something went wrong.';
}

/**
 * Owns everything the dashboard reads and writes: the current filters, the page
 * of links they select, and the collection and tag lists beside them.
 *
 * Mutations apply the server's response locally for immediate feedback and then
 * reload, because a change can move a link out of the active filter or shift the
 * sidebar counts.
 */
export function useVault() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  // The search box is uncontrolled by `filters` so typing stays responsive; the
  // debounce below is what promotes it into a filter and a request.
  const [searchInput, setSearchInput] = useState('');

  const [links, setLinks] = useState([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  const [collections, setCollections] = useState([]);
  const [uncategorisedCount, setUncategorisedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);
  const [tags, setTags] = useState([]);

  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((token) => token + 1), []);

  useEffect(() => {
    let cancelled = false;

    linksApi
      .list({ ...filters, page: 1 })
      .then((data) => {
        if (cancelled) return;
        setLinks(data.links);
        setTotal(data.total);
        setHasMore(data.hasMore);
        setPage(1);
        setError(null);
      })
      .catch((cause) => {
        if (!cancelled) setError(messageFor(cause));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [filters, reloadToken]);

  useEffect(() => {
    let cancelled = false;

    Promise.all([collectionsApi.list(), linksApi.tags()])
      .then(([collectionData, tagData]) => {
        if (cancelled) return;
        setCollections(collectionData.collections);
        setUncategorisedCount(collectionData.uncategorisedCount);
        setTotalCount(collectionData.totalCount);
        setTags(tagData.tags);
      })
      .catch(() => {
        // The link list reports its own failure; a stale sidebar is not worth a
        // second error banner over the same outage.
      });

    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // Searching costs a round trip, so wait for a pause in typing.
  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === filters.q) return undefined;

    const timer = setTimeout(() => setFilters((current) => ({ ...current, q: trimmed })), 250);
    return () => clearTimeout(timer);
  }, [searchInput, filters.q]);

  const updateFilters = useCallback((patch) => {
    setFilters((current) => ({ ...current, ...patch }));
  }, []);

  const clearFilters = useCallback(() => {
    setSearchInput('');
    setFilters(EMPTY_FILTERS);
  }, []);

  const toggleTag = useCallback((name) => {
    setFilters((current) => ({
      ...current,
      tag: current.tag.includes(name)
        ? current.tag.filter((tag) => tag !== name)
        : [...current.tag, name],
    }));
  }, []);

  const loadMore = useCallback(async () => {
    const next = page + 1;
    const data = await linksApi.list({ ...filters, page: next });

    setLinks((current) => [...current, ...data.links]);
    setPage(next);
    setHasMore(data.hasMore);
  }, [filters, page]);

  const saveLink = useCallback(
    async (url, collectionId) => {
      const result = await linksApi.save(url, collectionId);
      reload();
      return result;
    },
    [reload],
  );

  const updateLink = useCallback(
    async (id, patch) => {
      const { link } = await linksApi.update(id, patch);
      setLinks((current) => current.map((entry) => (entry.id === id ? link : entry)));
      reload();
      return link;
    },
    [reload],
  );

  const retryLink = useCallback(
    async (id) => {
      const { link } = await linksApi.retry(id);
      setLinks((current) => current.map((entry) => (entry.id === id ? link : entry)));
      return link;
    },
    [],
  );

  const deleteLink = useCallback(
    async (id) => {
      await linksApi.remove(id);
      setLinks((current) => current.filter((entry) => entry.id !== id));
      reload();
    },
    [reload],
  );

  const createCollection = useCallback(
    async (name) => {
      const { collection } = await collectionsApi.create(name);
      reload();
      return collection;
    },
    [reload],
  );

  const renameCollection = useCallback(
    async (id, name) => {
      await collectionsApi.rename(id, name);
      reload();
    },
    [reload],
  );

  const deleteCollection = useCallback(
    async (id) => {
      await collectionsApi.remove(id);
      // The links survive; anyone filtered into the deleted collection needs
      // somewhere to land.
      setFilters((current) =>
        current.collectionId === id ? { ...current, collectionId: null } : current,
      );
      reload();
    },
    [reload],
  );

  // Extraction happens in the background, so a link saved a moment ago has no
  // title yet. Poll while anything on screen is still being processed, and stop
  // as soon as it settles. Only on the first page: reloading would otherwise
  // discard the pages "Load more" has added.
  const isAnyProcessing = links.some((link) =>
    ['pending', 'queued', 'processing'].includes(link.processingStatus),
  );

  useEffect(() => {
    if (!isAnyProcessing || page !== 1) return undefined;

    const timer = setTimeout(reload, 3000);
    return () => clearTimeout(timer);
  }, [isAnyProcessing, page, reload, links]);

  const hasActiveFilters = useMemo(
    () =>
      Boolean(filters.q) ||
      filters.tag.length > 0 ||
      filters.collectionId !== null ||
      filters.isFavorite !== undefined ||
      filters.isRead !== undefined,
    [filters],
  );

  return {
    filters,
    searchInput,
    setSearchInput,
    updateFilters,
    clearFilters,
    toggleTag,
    hasActiveFilters,

    links,
    total,
    hasMore,
    loadMore,
    isLoading,
    error,
    reload,

    collections,
    uncategorisedCount,
    totalCount,
    tags,

    saveLink,
    updateLink,
    deleteLink,
    retryLink,
    createCollection,
    renameCollection,
    deleteCollection,
  };
}
