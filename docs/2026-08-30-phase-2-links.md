# Session: Phase 2 — Links, collections, search, dashboard (2026-08-30)

Implements the plan in [`2026-08-29-phase-2-decisions.md`](./2026-08-29-phase-2-decisions.md).
`CLAUDE.md` remains the source of truth for product and architecture; this records what was
built and what was decided along the way.

## What shipped

- `Link` and `Collection` models per the `CLAUDE.md` schema, with the unique
  `(userId, canonicalUrl)` index that Phase 4 will use as its idempotency key.
- URL canonicalization (`server/src/utils/canonicalUrl.js`) with 15 unit tests.
- Link CRUD, plus keyword search and filters by tag, collection, domain, date, favorite
  and read state, with paging.
- Collection CRUD, and assigning a link to a collection.
- Dashboard: save box, link list with per-link actions and inline editing, collection
  sidebar with counts, tag filtering, search and filter bar, empty and error states.
- 64 new backend tests (80 total), most of them about ownership isolation.

## Decisions made this session

The two questions the plan left open were put to the user and answered:

- **Deleting a collection releases its links, it does not delete them.** `collectionId` is
  unset on every link in the collection first, then the collection goes. That order matters:
  failing partway leaves an empty collection, which is harmless, where the other order would
  leave links pointing at something that no longer exists. Deleting a folder should never
  silently destroy bookmarks, especially with no trash to recover them from (Decision 3).
- **Multiple tag filters are AND, not OR.** `?tag=react&tag=testing` returns links carrying
  both. Filters are for narrowing; single-tag filtering behaves the same either way.

Decided while building, not previously specified:

- **A missing scheme is filled in with `https:`.** Pasting `example.com/article` is common and
  should not be a validation error. Only the scheme is added — `url` is otherwise exactly what
  the user pasted, per Decision 2.
- **Only `http:` and `https:` are accepted**, and the hostname must contain a dot. This rejects
  `javascript:`, `data:` and `file:` at the boundary rather than relying on a later phase to
  notice. `CLAUDE.md`'s security section calls for exactly this.
- **Tags are lowercased and de-duplicated on write.** "React" and "react" would otherwise split
  one topic into two sidebar entries and two filters that each return half the links.
- **Collection names are unique per user, case-insensitively**, enforced by a collation
  strength-2 unique index. Two collections called "Reading" and "reading" are indistinguishable
  in a sidebar.
- **Keyword search uses a weighted MongoDB text index** (title 10, tags 8, summary 4,
  description 2, url 1) rather than a regex scan, so it ranks results and stays the keyword
  half of the Phase 8 hybrid search. The trade-off is that it matches whole words, not
  prefixes: "cach" will not find "caching". Worth revisiting in Phase 8 if it grates.
- **Users may edit `title`, `description`, `tags`, `collectionId`, `isFavorite` and `isRead`,
  and nothing else.** `summary`, `embedding` and `processingStatus` belong to the pipeline; a
  patch containing them is ignored rather than rejected. There is a test for this.
- **Favorite and read are part of `PATCH /api/links/:id`**, not their own routes. Less surface
  for the same behaviour.
- **`GET /api/links` returns 20 per page by default, 100 at most.** An over-large `limit` is a
  400 rather than being silently clamped, so a client bug surfaces instead of hiding.

## Revised after manual checking: the save form files links

The user opened the dashboard, noticed that saving always landed a link in Uncategorised, and
asked for a collection picker at save time with the option to create a new collection inline.

This **revises Decision 4** ("the save form takes a URL only") from the Phase 2 decisions doc.
The reasoning there — paste and go is the fastest path — still holds, so the picker defaults to
"No collection" and the one-paste-one-click path is unchanged. Choosing is opt-in. What the
decision got wrong is that filing is cheapest at the moment you save, when you still know where
the link belongs; deferring it to an edit later means it mostly never happens.

Decision 4's other half stands: still no title or note field at save time.

- `POST /api/links` takes an optional `collectionId`, ownership-checked before anything is
  written, so a failed check saves nothing.
- **Omitting `collectionId` means "leave it where it is", not "unfile it".** It is the default
  the form submits, so treating it as an instruction would let a routine re-save quietly pull an
  existing bookmark out of its collection. Only an explicit collection moves anything.
- **An explicit collection on a URL already saved moves it**, and the response says so via
  `moved: true`. Reporting "already saved" while silently discarding the user's choice would be
  the worse failure.
- Typing the name of a collection that already exists reuses it rather than raising the 409.
  The intent is "put it here", and here already exists.

## The privacy rule, and how it is enforced

Every read, update and delete is scoped by `userId` as well as `_id`, in one place per model
(`getOwnedLink`, `getOwnedCollection`), so no handler has to remember it. Assigning a link to a
collection checks that collection's ownership before writing, or a user could file their own
bookmark into someone else's folder and learn that it exists.

Requests for another account's link or collection return **404, not 403** — a 403 would confirm
that the id exists. Fourteen tests assert this directly, including that the target document is
still unmodified afterwards.

## Verified

- `npm --prefix server test` — 80/80 pass.
- `npm --prefix client run build` and `oxlint` — both clean.
- End-to-end over real HTTP with a real cookie jar, against the actual server entrypoint:
  registration, save (201), re-save of a cosmetically different URL for the same page (200,
  same id), rejection of `javascript:` (400) and of an unauthenticated save (401), collection
  creation and case-insensitive duplicate (409), editing, all nine filter shapes including the
  400 on an over-large limit, and the full privacy set — a second user getting 404 on read,
  edit, delete and rename, with the target left untouched. Then collection delete releasing its
  link (`releasedLinks: 1`, link survives with `collectionId: null`), link delete (204), and the
  same URL saving fresh afterwards (201).

Docker was not running this session, so that pass used an ephemeral MongoDB rather than the
`linkvault-mongo` container. Nothing in it depends on which database is behind the API.

**Docker turns out not to be needed locally at all**: this machine runs a native `MongoDB`
Windows service on port 27017, which the API connects to with the `.env` defaults as they stand.
`README.md` still tells you to run `docker compose up -d` first. Either path works; the README is
not wrong, just not the only option.

The user then ran both dev servers and opened the dashboard, which is what surfaced the save-form
change above. That was a partial look, not a full pass — treat the UI as lightly exercised rather
than verified. There are still no frontend automated tests.

The save-into-collection flow was driven end to end through the running Vite proxy afterwards:
filing on save, moving an existing bookmark to a newly chosen collection, a re-save with no
choice leaving the bookmark filed where it was, and a malformed `collectionId` returning 400.

## Still open

1. **Fetched title vs. user-edited title** — needed in Phase 3, now imminent. Expected: user
   input wins. `Link.title` is currently only ever written by hand, so nothing conflicts yet.
2. **Worker language split** — all Kafka workers in Python, or only the embedding worker, and
   how they are invoked. Needed before Phase 4.
3. **Vector search in local dev** — Atlas Local container or a real Atlas cluster. Needed
   before Phase 6.

Questions 2 and 3 are architectural and deserve the `CLAUDE.md` "Important Rule" treatment.

## Next: Phase 3

URL metadata extraction, processing status, error handling. `processingStatus` already defaults
to `pending` on every saved link, and `favicon`, `thumbnail`, `description` and `summary` exist
as empty fields waiting to be filled. Nothing writes them yet.
