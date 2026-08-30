# Start here

Index of session notes for LinkVault. **`../CLAUDE.md` is the source of truth** for product,
architecture, data models, and phasing — these documents only record what it does not:
decisions made, why, and what state the work is in.

Read in this order when picking the project back up.

| Document | What it holds |
| --- | --- |
| [2026-08-29-overview-architecture.md](./2026-08-29-overview-architecture.md) | Repo layout decision, first open questions |
| [2026-08-29-phase-1-auth.md](./2026-08-29-phase-1-auth.md) | Phase 1: what shipped, auth/security decisions, what was verified |
| [2026-08-29-phase-2-decisions.md](./2026-08-29-phase-2-decisions.md) | Phase 2 decisions agreed with the user, plus the step plan it was built from |
| [2026-08-30-phase-2-links.md](./2026-08-30-phase-2-links.md) | Phase 2: what shipped, decisions made while building, what was verified |
| [2026-08-30-phase-3-plan.md](./2026-08-30-phase-3-plan.md) | Phase 3 decisions and step plan: metadata extraction plus the UI pass |
| [2026-08-30-phase-3-metadata-ui.md](./2026-08-30-phase-3-metadata-ui.md) | Phase 3: what shipped, decisions made while building, what was verified |
| [2026-08-30-phase-4-plan.md](./2026-08-30-phase-4-plan.md) | Phase 4 decisions and step plan: Kafka, workers as separate processes |
| [2026-08-30-phase-4-kafka.md](./2026-08-30-phase-4-kafka.md) | Phase 4: what shipped, three bugs only a real broker could find, what was verified. **Start here for the next session.** |

---

## State of play (as of 2026-08-30)

**Phases 1 to 4 are complete.**

Working: project setup, Express API, MongoDB, authentication, bookmark CRUD, collections, tags,
favorites, read/unread, keyword search with filters, the dashboard, URL metadata extraction with
processing status and retries, the appearance pass (dark mode, accent picker, redesigned link
list), and an event-driven pipeline on Kafka with extraction in its own worker process.
`server` has 146 passing tests. `client` builds and lints clean.

Phase 4 was verified against a real broker: two processes, a full broker outage and recovery, a
worker killed mid-fetch, and the no-broker path. **Three bugs came out of that, none of which the
146 unit tests could catch** — a publish that never settles wedging the pipeline permanently, a
producer that never reconnected after an outage, and socket timeouts being treated as permanent
failures. All fixed and covered; details in the Phase 4 session note.

The running theme across Phases 3 and 4: **the unit tests keep passing while the real dependency
misbehaves.** A schema default is not a migration; a client library that retries forever never
rejects; a hand-built error object does not have the flags the real one has. Budget time for
running the thing, not just testing it.

Next: **Phase 5 — summary and tag generation.** It subscribes to `metadata.extracted`, which the
metadata worker already publishes and nothing consumes yet, so it should add a consumer without
touching Phase 4's code. Decide the summarisation approach first — that is an LLM/provider choice
`CLAUDE.md` does not make, and it deserves the "Important Rule" treatment.

Phase 5 is also the point at which **automatic collection allocation** gets revisited, with real
auto-tagged links to judge against.

## Local environment

`.env` exists at the repo root and is gitignored. It holds a **development-only**
`JWT_SECRET` that must be replaced before anything real.

**Docker is not required on this machine.** A native `MongoDB` Windows service listens on 27017,
which the API connects to using the `.env` defaults unchanged. `README.md` still documents
`docker compose up -d`; both paths work, but the container was not running for any of this
session's verification.

The `linkvault` database holds **one account and two links** belonging to the user. Every account
created by scripted checking has been removed. Both links have now been through extraction and are
`ready`, with titles, favicons and thumbnails.

`ENABLE_METADATA_WORKER` controls the pipeline. Left unset it is on everywhere except tests, where
a background loop racing the assertions would make the suite non-deterministic.

`ENABLE_KAFKA` selects the event bus. **Default is `false`**, which runs the same reaper and
consumer against an in-process bus inside the API — no broker needed. Set it to `true` after
`docker compose up -d kafka`, and then also run `npm --prefix server run worker`.

**Docker was not previously used on this machine** (MongoDB runs as a native Windows service). It
is now needed for Kafka. Docker Desktop must be started before `docker compose up -d kafka`; the
Kafka container was left stopped at the end of this session.

`pkill` does not exist in Git Bash here. Stop background processes with PowerShell `Stop-Process`
and confirm the port is free — a stale process serving port 4000 invalidated one verification run
this session.

Setup and commands are in [`../README.md`](../README.md).

## Open questions, in the order they will be needed

1. **Vector search in local dev** — needed before Phase 6. `CLAUDE.md` specifies MongoDB Atlas
   Vector Search but also plain Docker Compose locally, and the standard `mongo` image does not
   support Atlas Vector Search. Atlas Local container, or a real Atlas cluster for dev?
2. **Where Kafka runs in production** — a Phase 9 question, with a real cost attached. Managed
   (Confluent, Redpanda, MSK) or self-hosted?

Both are architectural and deserve the `CLAUDE.md` "Important Rule" treatment: state the problem,
why the current setup is insufficient, what alternatives exist, and why the choice is right.

Answered and no longer open: collection delete behaviour and tag-filter combination (Phase 2 note);
fetched title vs. user-edited title, image serving, and theme preference storage (Phase 3 plan);
and the **worker language split** — Node for every Kafka consumer, Python only as a stateless
FastAPI embedding service called over HTTP (Phase 4 plan §2).

## Automatic collection allocation — asked, deferred on purpose

Raised by the user during Phase 4 planning: people paste links while busy and never file them.
**Decided: revisit after Phase 5 ships.** Auto-tagging is already committed for Phase 5 and gives
machine organisation without folders; auto-filing into collections is in no phase, has a cold-start
problem (it needs collections the busy user has not made), and misfiling actively breaks the
product's core promise. Uncategorised keeps its name — the "Inbox" reframe was offered and
declined. Full reasoning in the Phase 4 plan, §12.

## A gap in CLAUDE.md worth raising

`CLAUDE.md` lists "extract author when available" under URL Processing, but the `Link` model it
specifies has no `author` field. Phase 3 added one, and the extractor writes it. **`CLAUDE.md`
should be updated to match** so the spec and the schema agree before Phase 4 builds on either.

## Conventions worth carrying forward

- Small, focused commits with conventional prefixes — see `git log`.
- Business logic lives in services, not route handlers. Validation happens at the boundary.
- Every query touching user-owned data is scoped by `userId`.
- Write a session note here when decisions get made, and keep this file's state-of-play current.
