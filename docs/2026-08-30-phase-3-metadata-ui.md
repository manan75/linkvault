# Session: Phase 3 — Metadata extraction and the UI pass (2026-08-30)

Implements the plan in [`2026-08-30-phase-3-plan.md`](./2026-08-30-phase-3-plan.md), in the order
its step plan sets out. `CLAUDE.md` remains the source of truth for product and architecture; this
records what was built, what was decided while building, and what was verified.

## What shipped

**Appearance**

- Theme tokens as CSS custom properties (`client/src/index.css`), mapped into Tailwind with
  `@theme inline` so `bg-surface` compiles to a `var()` and follows `data-theme` at runtime.
- Tri-state theme (System / Light / Dark) and six accent presets, behind
  `usePreferences` / `lib/preferences.js`, stored in `localStorage`.
- The anti-flash inline script in `index.html`, which applies the stored theme before the bundle
  loads.
- Every hardcoded `slate-*`, `red-*`, `amber-*` and `bg-white` utility replaced with a token.
  Shared control chrome moved to `.lv-field`, `.lv-button` and `.lv-button-quiet`.
- Link row redesign: favicon, thumbnail, tighter hierarchy, icon actions revealed on hover, the
  raw `canonicalUrl` line dropped, read state shown as a left edge rather than dimmed text, and
  skeleton rows on first load.

**Extraction**

- `Link` gains `author`, `processingAttempts`, `processingError`, `processingStartedAt` and
  `processedAt`, plus a `{ processingStatus, savedAt }` index for the worker's claim query.
- `utils/privateAddress.js` — the address guard.
- `services/safeFetch.js` — the single guarded fetch client.
- `utils/sanitize.js` and `services/metadataParser.js` — cleaning and the precedence table.
- `workers/metadataWorker.js` — claim, process, complete, fail, stale reclaim, backoff ladder.
- `POST /api/links/:id/retry`, and the dashboard action that calls it.
- 51 new backend tests (131 total).

## Decisions made while building, not in the plan

- **Node's `http`/`https` rather than `fetch`.** The plan asks the client to connect to the address
  it checked, which closes the DNS-rebinding window. `fetch` gives no way to pin a connection to an
  address without pulling in `undici` as a direct dependency; `http.request` takes a `lookup`
  function and does it in one line. It also makes the streaming size cap natural rather than
  bolted on.

- **The guard is injectable, in exactly one place, for exactly one reason.** Testing redirect
  handling, size caps and timeouts needs a server, and a server can only listen on loopback — which
  the real guard correctly refuses. `createSafeFetch({ isBlocked })` lets the tests narrow the
  predicate to their own address and nothing else, so the redirect re-check is still exercised
  against a real private address. The `safeFetch` export used everywhere in production never
  overrides it.

- **Backoff is a ladder, not a formula.** The delay before a retry depends on the document's own
  attempt count, which is awkward to express in a plain query. `RETRY_DELAYS_MS = [0, 30s, 120s]`
  becomes three `$or` clauses and stays a single indexed `findOneAndUpdate`.

- **The attempt is counted when the link is claimed, not when it completes.** A process that dies
  mid-fetch still burns an attempt, so a link that reliably crashes the worker cannot loop forever.

- **A non-HTML response completes rather than fails.** A PDF or an image is not a broken link;
  there is simply nothing to parse. Marking it `failed` would invite a retry that can only reach
  the same answer.

- **Charset comes from the header, then `<meta charset>`, then UTF-8.** Read from the raw bytes,
  since the document has to be decoded before it can be parsed. An unrecognised label falls back
  rather than throwing: a slightly mangled title beats no bookmark.

- **URLs with embedded credentials are refused.** `http://user:pass@host/` would send those
  credentials to wherever the redirect chain ends, and a bookmark has no reason to carry them.

- **The dashboard polls while anything is processing**, every 3s, and only on the first page —
  reloading would otherwise discard the pages "Load more" has added. It stops on its own once
  every visible link is `ready` or `failed`.

- **Retry resets `processingAttempts` to 0** and is refused with `409` while a link is
  `processing`. Claiming works by moving a link out of `pending`; resetting one a worker holds
  would let a second worker claim it alongside the first.

- **The claim filter matches a missing `processingAttempts`, not just 0.** Found by running the
  worker against the real development database rather than the test one — see below.

Two changes came out of looking at the rendered page rather than from the plan:

- **The read toggle moved into the hover icon group.** It had its own full-width row, which left an
  empty strip under every link with no tags — which, before summaries and generated tags exist, is
  most of them. The left edge already carries the read state, so the control does not need to be
  visible at rest.
- **Hover icons went from `ink-faint` to `ink-muted`.** At `ink-faint` on a dark surface they were
  barely legible once revealed.

## A bug the tests could not have found

`claimLink` originally filtered on `{ processingAttempts: 0 }`. The schema gives that field a
default of 0, so every test passed — `Link.create` applies the default and the filter matches.

Links saved during **Phase 2 have no `processingAttempts` field at all**, because a Mongoose
default only applies to documents as they are created, never to ones already stored. MongoDB does
not match a missing field against `0`. So every bookmark saved before this phase was invisible to
the worker and would have sat at `pending` forever, with no error and nothing in the log to say so.

It surfaced only because the worker was pointed at the real development database, where the user's
own two links stayed `pending` while freshly saved ones processed fine. The filter is now
`{ processingAttempts: { $in: [null, 0] } }`, which matches missing and 0 alike, and
`tests/metadataWorker.test.js` covers it by `$unset`-ing the field on a saved document.

Worth carrying into Phase 4: **a schema default is not a migration.** The same trap is waiting for
any field added to `Link` from here on.

## Worth revisiting

**The domain fallback for `title` interacts badly with "only fill empty fields".** The plan's
precedence table ends `<title>` → fall back to the domain, and that is what shipped. But storing
`example.com` as the title makes the field non-empty, so a later real title can never replace it,
and the editor shows the domain as though the user had typed it. The client already falls back to
the domain for display, so the stored value buys only keyword-search coverage. If the `userEdited`
array from plan section 4 is ever added, drop this fallback at the same time.

**`author` is not in the text index.** Adding it would change an existing index definition, which
Mongo rejects unless the old one is dropped first. Not worth a migration this phase; fold it in
whenever the index next changes.

## Verified

- `npm --prefix server test` — **131 passing**, 0 failing.
- `npm --prefix client run build` and `npx oxlint` — both clean.
- **A live pass against real URLs**, driving the real (unmocked) fetch client:

  | URL | Result |
  | --- | --- |
  | An MDN article | `ready` — title, description, favicon and OG image all extracted |
  | `example.com` | `ready` — title only, `/favicon.ico` guessed |
  | A deliberate 404 | `failed` — "The site returned 404", not retried |
  | `169.254.169.254` | `failed` — "That address is not publicly reachable" |
  | `192.168.1.1` | `failed` — same, not retried |
  | A domain that does not exist | `failed` — "Could not resolve …" |

  Redirects to a private address, the 2 MB cap, the timeout and the redirect limit are covered by
  `tests/safeFetch.test.js` against a local server rather than live.

- **The browser pass from step 9 was done**, in headless Chrome over CDP against both dev servers
  and the real MongoDB, and the screenshots were looked at rather than just captured. A throwaway
  account saved four links — the MDN caching article, `example.com`, a deliberate 404, and
  `http://192.168.1.1/admin` — and the dashboard was rendered in light, dark, and with three
  different accents.

  What it showed: the MDN row renders with its favicon, its OG thumbnail and its description; the
  `example.com` row shows a title and correctly hides the `/favicon.ico` it guessed, because that
  site does not serve one; both failed rows show their reason and a working "Try again"; the unread
  accent edge, the theme toggle and the accent picker all behave. The only console messages were a
  missing app `favicon.ico` and the expected `401` from `/api/auth/me` before signing in.

  Not covered by that pass: the pending shimmer (extraction finished faster than the screenshot),
  keyboard focus rings, and narrow viewports.

- The throwaway accounts and their links were removed afterwards. The user's own account and its
  **two links are now `ready`** — both picked up titles, favicons and thumbnails once the claim-
  filter bug above was fixed.

## Still open after this phase

Unchanged from the plan, and both needed before the phases that depend on them:

1. **Worker language split** — before Phase 4. This phase wrote the extractor in Node, which makes
   "keep the non-embedding workers in Node" the path of least resistance. A nudge, not a decision.
2. **Vector search in local dev** — before Phase 6. Atlas Local container, or a real Atlas cluster.

## The `CLAUDE.md` gap, now real

`CLAUDE.md` lists "extract author when available" under URL Processing but its `Link` model has no
`author` field. The field now exists in the schema and the extractor writes it. **`CLAUDE.md`
should be updated to match**, so the spec and the code agree before Phase 4 builds on either.
