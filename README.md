# LinkVault

An intelligent bookmark manager for the moment you think *"I know I saved that link somewhere."*

Save a URL, forget about it, then describe it later in your own words and get it back.
See [`CLAUDE.md`](./CLAUDE.md) for the full product spec and architecture.

## Status

**Phase 5 complete, and hardened for deployment** — everything from Phase 4, plus
generated summaries and tags. A second worker consumes `metadata.extracted`, asks a
model for a short summary and up to five tags, and writes them back.

The deployment pass on top of it added rate limiting, a per-user bookmark cap, a global
daily enrichment ceiling, `helmet`, and a graceful shutdown that drains both workers
rather than severing them. See [`docs/2026-09-02-deploy-v1.md`](./docs/2026-09-02-deploy-v1.md).
Embeddings and semantic search are next.

## Layout

```
client/   React + Vite + Tailwind frontend
server/   Express + Mongoose API
docs/     Session notes and decisions
```

## Requirements

- Node.js 22+
- Docker (for local MongoDB and Kafka)

Kafka is optional for development. With `ENABLE_KAFKA=false` the same reaper and
worker run against an in-process event bus, so the whole pipeline works in a single
process with no broker.

## Getting started

```bash
# 1. Configure environment
cp .env.example .env
# then edit .env and set JWT_SECRET to a long random value.
# OPENAI_API_KEY is optional: leave it empty and enrichment disables itself
# cleanly -- links just arrive without a summary or auto-tags.

# 2. Start MongoDB (and Kafka, if you want the real event pipeline)
docker compose up -d mongo
docker compose up -d kafka     # optional — see ENABLE_KAFKA below

# 3. Install dependencies
npm --prefix server install
npm --prefix client install

# 4. Run the dev servers (in separate terminals)
npm --prefix server run dev    # http://localhost:4000
npm --prefix client run dev    # http://localhost:5173

# 5. Only with ENABLE_KAFKA=true — the workers run in their own process
npm --prefix server run worker
```

Open http://localhost:5173 and create an account.
The Vite dev server proxies `/api` to the API, so the session cookie stays same-origin.

## Tests

```bash
npm --prefix server test
```

Tests run against an ephemeral in-memory MongoDB — no running database required.

## API

| Method | Endpoint                | Auth | Description                             |
| ------ | ----------------------- | ---- | --------------------------------------- |
| GET    | `/api/health`           | –    | Liveness check                          |
| POST   | `/api/auth/register`    | –    | Create an account and sign in           |
| POST   | `/api/auth/login`       | –    | Sign in                                 |
| POST   | `/api/auth/logout`      | –    | Clear the session                       |
| GET    | `/api/auth/me`          | ✓    | Current user                            |
| POST   | `/api/links`            | ✓    | Save a URL, optionally into a collection (`201` new, `200` already saved) |
| GET    | `/api/links`            | ✓    | List and search, with filters and paging |
| GET    | `/api/links/tags`       | ✓    | The user's tags with counts             |
| PATCH  | `/api/links/tags/:name` | ✓    | Rename a tag everywhere; renaming onto an existing tag merges them |
| GET    | `/api/links/:id`        | ✓    | One bookmark                            |
| PATCH  | `/api/links/:id`        | ✓    | Edit title, notes, tags, collection, favorite, read |
| DELETE | `/api/links/:id`        | ✓    | Delete permanently                      |
| POST   | `/api/links/:id/retry`  | ✓    | Queue a failed link for extraction again |
| GET    | `/api/collections`      | ✓    | Collections with link counts            |
| POST   | `/api/collections`      | ✓    | Create a collection                     |
| PATCH  | `/api/collections/:id`  | ✓    | Rename a collection                     |
| DELETE | `/api/collections/:id`  | ✓    | Delete a collection; its links stay     |

`POST /api/links` takes `url` and an optional `collectionId`. Omitting the collection leaves an
already-saved bookmark filed where it is; passing one moves it there and reports `moved: true`.

`GET /api/links` accepts `q`, `tag` (repeatable, all must match), `collectionId`
(an id or `none`), `domain`, `isFavorite`, `isRead`, `savedAfter`, `savedBefore`,
`sort` (`newest`, `oldest`, `relevance`), `page` and `limit`.

## The processing pipeline

Saving a URL returns immediately; everything else happens in the background.

```
POST /api/links ──► MongoDB (pending)
                        │
              reaper sweeps and publishes
                        ▼
                  link.created ──► metadata worker ──► MongoDB (ready)
                                          │
                                          ├─► link.processing.failed
                                          │
                                          └─► metadata.extracted
                                                     │
                                                     ▼
                                            enrichment worker ──► MongoDB (summary, autoTags)
                                                     │
                                                     ├─► link.enriched   (Phase 6 consumes)
                                                     └─► link.processing.failed
```

A link moves `pending → queued → processing → ready | failed`. The **reaper** claims
pending links, marks them `queued`, and publishes; the **worker** claims `queued` links,
fetches and parses them, and writes back. Extraction fills only fields the user left
empty, so typed values are never overwritten.

**Enrichment is a separate state machine, on purpose.** A link reaches `ready` on
extraction alone and `enrichmentStatus` advances beside it, because a bookmark whose
summary failed is still a perfectly good bookmark — it has a title, a favicon and a URL,
and it opens. The dashboard shows a summary when there is one and shows nothing where
there is not; there is no error state for a failed enrichment, and retrying is the
reaper's job rather than a button.

Redelivery is stopped by the same status-based claim extraction uses, which here is also
the cost control: a repeated event bills nothing. A link with no description whose title
is merely its own domain is `skipped` without a call at all — there is nothing to
summarise, and asking anyway is the strongest temptation there is to invent.

**Why a reaper instead of publishing on save.** Committing to MongoDB and then publishing
is a dual write: if the publish fails, the event never exists and the link waits at
`pending` forever with nothing logged. Sweeping the database instead makes the `links`
collection its own outbox — no outbox table, no transactions, no relay.

Every lease is recoverable. A `queued` link whose message never arrived returns to
`pending` after 60s; a `processing` claim abandoned by a crashed worker returns after two
minutes, or fails once its three attempts are spent. Transient failures (timeout, `429`,
`5xx`) back off and retry; permanent ones (`404`, a blocked address, a non-HTML response)
fail immediately, and the dashboard offers `POST /api/links/:id/retry`.

Every fetch goes through one guarded client (`server/src/services/safeFetch.js`) that
resolves the hostname, refuses private, loopback, link-local and CGNAT addresses,
re-checks each redirect hop, connects to the address it checked, caps the response at
2 MB while streaming, and parses without ever executing page scripts.

**Configuration.** `ENABLE_KAFKA=true` uses the broker and expects
`npm --prefix server run worker` alongside the API. `ENABLE_KAFKA=false` (the default)
swaps in an in-process bus and runs the worker inside the API — the same reaper, the same
consumer, the same state machine, just no broker and no process boundary.
`ENABLE_METADATA_WORKER=false` turns the pipeline off entirely.

`OPENAI_API_KEY` enables enrichment; without one it disables itself and every other
stage keeps working. `OPENAI_MODEL` selects the model and defaults to `gpt-5-mini`.
`ENABLE_ENRICHMENT=false` turns it off with a key present. Startup logs which of these
is in effect, so links are never left un-enriched with nothing in the log explaining why.

## Tags

Generated tags reuse the vocabulary a user already has: their existing tags go into the
prompt, and the model is asked to reuse one whenever it genuinely fits. Two deterministic
guards sit outside the call — normalisation, and a case-insensitive snap onto the existing
vocabulary — so `React` and `react` cannot become two entries in the sidebar even if the
model slips.

Once a link's tags have been edited by hand, enrichment writes its summary and never
touches its tags again: an auto-tag you deleted must not reappear. `PATCH
/api/links/tags/:name` renames a tag across the whole library, and renaming onto a tag
that already exists is the merge.

## Appearance

Theme (System / Light / Dark) and one of six accent colours, stored in `localStorage`
and applied to `<html>` before React mounts so there is no flash of the wrong theme.

## Privacy and sessions

Every bookmark and collection route is scoped to the signed-in user. Asking for
something another account owns returns `404`, not `403`, so the API never confirms
that someone else's link exists.

The session is a JWT in an `httpOnly` cookie, so page scripts cannot read it and
logout is a real server-side action.

In production the cookie is `Secure` and `SameSite=None`, because the client is served
from a different domain than the API. That makes it a third-party cookie: **Safari and
iOS browsers block it, so v1 is Chrome-first.** A Bearer-token path is planned after
Phase 6 and removes the constraint. It also makes `CLIENT_ORIGIN` load-bearing rather
than decorative — it must name the client's exact origin.

## Limits

Registration is open, so the caps are what bound cost and abuse:

| Limit | Value | Scope |
| --- | --- | --- |
| Sign-in attempts | 10 / 15 min | per IP |
| Registrations | 5 / hour | per IP |
| Link saves | 20 / hour | per user |
| Bookmarks | `MAX_LINKS_PER_USER` (100) | per user |
| Enrichment calls | `ENRICHMENT_DAILY_LIMIT` (200) | global, per day |

The first three are throttles and live in memory. The last two bound real money and live
in MongoDB, so they survive the restarts a free instance does constantly. Over the daily
ceiling, links wait at `pending` and are enriched the next day rather than abandoned;
saving a URL already in the library still works at the bookmark cap, because it creates
nothing.
