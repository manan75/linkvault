# Phase 2 decisions (2026-08-29)

Agreed with the user before starting Phase 2 (Link CRUD, collections, tags,
favorites, read/unread, dashboard). `CLAUDE.md` remains the source of truth for
product and architecture.

## 1. A bookmark belongs to exactly one collection

`Link.collectionId` stays singular, as `CLAUDE.md` specifies. Collections behave like
folders; tags carry the many-to-many use case, so nothing is lost. Moving to
`collectionIds[]` later is a cheap migration if evidence demands it.

This closes the "collection cardinality" question left open by the previous two sessions.

## 2. Re-saving a URL returns the existing bookmark

Not a 409, and not a second document. The URL is canonicalized on save and a unique
index on `(userId, canonicalUrl)` enforces one bookmark per URL per user.

Rationale: the core loop is "Save → Forget → Describe → Find". A user who does not
remember saving something should not be scolded for it. This also gives Phase 4 workers
a natural idempotency key, which Architecture Principle 4 requires.

**Canonicalization rules** (chosen here, not previously specified):
- lowercase the scheme and host, strip a leading `www.`
- drop the fragment
- strip known tracking parameters (`utm_*`, `fbclid`, `gclid`, `ref`, `mc_eid`)
- drop a trailing slash on a non-empty path
- otherwise preserve query parameters and their order — they frequently carry meaning
  (`?v=` on YouTube, `?id=` on docs), so blanket query stripping would merge distinct pages

`url` keeps exactly what the user pasted; `canonicalUrl` is what uniqueness compares.

## 3. Delete is permanent

No `deletedAt`, no trash. Every future query would otherwise have to exclude deleted
documents, and forgetting that filter once is precisely how private bookmarks leak —
an unacceptable failure mode given the privacy requirement. Add a trash later if users
ask for undo.

## 4. The save form takes a URL only

No title or note field at save time. Paste and go is the fastest path and matches the
product loop. Until Phase 3 extraction lands, the dashboard falls back to showing the
domain as the label. Users can edit a bookmark afterward to set anything by hand.

Deferred consequence: when Phase 3 arrives, decide whether a fetched title may overwrite
a user-edited one. Expected answer is no — user input wins — but it is not needed yet.

## Unchanged and still not blocking

- Vector search in local dev (Atlas Local container vs. real Atlas cluster) — before Phase 6.
- Worker language split: all Kafka workers in Python, or only the embedding worker — before Phase 4.
