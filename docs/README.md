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
| [2026-08-30-phase-4-kafka.md](./2026-08-30-phase-4-kafka.md) | Phase 4: what shipped, three bugs only a real broker could find, what was verified |
| [2026-09-01-phase-5-plan.md](./2026-09-01-phase-5-plan.md) | Phase 5 decisions and step plan: summary and tag generation, and how the tag vocabulary is kept from drifting |
| [2026-09-01-phase-5-enrichment.md](./2026-09-01-phase-5-enrichment.md) | Phase 5: what shipped, why the planned model did not exist, and what the real-API run showed. **Start here for the next session.** |

---

## State of play (as of 2026-09-01)

**Phases 1 to 5 are complete.**

Working: project setup, Express API, MongoDB, authentication, bookmark CRUD, collections, tags,
favorites, read/unread, keyword search with filters, the dashboard, URL metadata extraction with
processing status and retries, the appearance pass (dark mode, accent picker, redesigned link
list), an event-driven pipeline on Kafka with extraction in its own worker process, and generated
summaries and tags with tag rename/merge. `server` has 195 passing tests. `client` builds clean.

Phase 4 was verified against a real broker: two processes, a full broker outage and recovery, a
worker killed mid-fetch, and the no-broker path. **Three bugs came out of that, none of which the
unit tests could catch** — a publish that never settles wedging the pipeline permanently, a
producer that never reconnected after an outage, and socket timeouts being treated as permanent
failures. All fixed and covered; details in the Phase 4 session note.

The running theme across Phases 3, 4 and 5: **the unit tests keep passing while the real dependency
misbehaves.** A schema default is not a migration; a client library that retries forever never
rejects; a hand-built error object does not have the flags the real one has; and a model named in a
planning document may not exist at all. Budget time for running the thing, not just testing it.

**Phase 5 shipped as planned, with one correction and two design changes.** The correction: the
plan's model, `gpt-5.6-luna`, **does not exist** — it and its whole cost table were invented, and
listing the account's real models before writing code is the only reason it did not become a 404 at
the first call. The default is now **`gpt-5-mini`**. `gpt-5-nano` was tried first, since the user
asked for a cheap model, and rejected on measured behaviour: it reused an unrelated vocabulary tag
on the very probe the tag-consistency design is built around.

The two design changes: the provider call's timeout moved into `services/enrichment.js`, because a
`Promise.race` in the worker rejects with a plain `Error` and would have re-created Phase 4's
timeout-misclassified-as-permanent bug; and the reaper's enrichment sweep gained a 90-second grace
period, without which it races the live `metadata.extracted` message and doubles every message in
the system. Both are in the Phase 5 session note.

**The real finding of the phase: summaries are frequently empty.** Three of the four verification
pages carry no `og:description`, and the Phase 5 plan restricts the model to title and description,
so the model correctly declined to invent one — it was told never to guess, and it did not. Tags
were good in every one of those cases. **Capturing a cleaned page excerpt is now an evidence-backed
open question rather than a hypothetical**, and it matters before Phase 6, which embeds this text.

Next: **Phase 6 — Sentence Transformer embeddings, MongoDB Vector Search, semantic search.** It
subscribes to `link.enriched`, which the enrichment worker now publishes and nothing consumes yet,
so it adds a consumer without touching Phase 5's code. Open question 1 below blocks it.

The decision worth knowing before reading the code: **tag vocabulary drift is solved by putting the
user's existing tags in the prompt, not by embedding-similarity matching.** Short-string embeddings
measure topical relatedness rather than synonymy, so no threshold separates `postgres`/`postgresql`
(merge) from `react`/`vue` (never merge). Verified end to end: two Redis pages saved in sequence
shared `redis` and `client-libraries` rather than inventing a second spelling. Similarity returns in
Phase 6 as a *recall* step that shortlists candidates for the model, once a vocabulary outgrows the
prompt. Plan section 3.

**Automatic collection allocation** is now due for its revisit: real auto-tagged links exist to
judge against. Collections stayed manual through Phase 5, confirmed again with the user.

## Local environment

`.env` exists at the repo root and is gitignored. It holds a **development-only**
`JWT_SECRET` that must be replaced before anything real.

`OPENAI_API_KEY` is set. It was originally added as `OPEN_API_KEY` — a typo that disables
enrichment **silently**, since a missing key is a supported configuration — and has been renamed.
`OPENAI_MODEL` is `gpt-5-mini`.

The `linkvault` database holds the user's own account and links, plus **one account created by the
Phase 5 end-to-end run** (`phase5-<timestamp>@example.com`, four links), left in place as evidence
of the verification and safe to delete.

`ENABLE_METADATA_WORKER` controls the pipeline. Left unset it is on everywhere except tests, where
a background loop racing the assertions would make the suite non-deterministic.

`ENABLE_ENRICHMENT` controls summary and tag generation, and follows the same rule — but a missing
`OPENAI_API_KEY` vetoes it either way. Startup says which it is, out loud, in one line.

`ENABLE_KAFKA` selects the event bus. **Default is `false`**, which runs the same reaper and both
consumers against an in-process bus inside the API — no broker needed. Set it to `true` after
`docker compose up -d kafka`, and then also run `npm --prefix server run worker`. `.env` was left
with **no `ENABLE_KAFKA` line**, i.e. the in-process bus, which is how it started the session.

**Docker is now in use.** Both `linkvault-mongo` and `linkvault-kafka` were started for the Phase 5
verification and left running. `docker compose up -d` failed the first time with
`network ... not found` — a stale network reference on the mongo container, cleared by
`docker compose up -d --force-recreate mongo`.

Shell notes for this machine, all of which cost time at least once:

- `pkill` does not exist in Git Bash here; `taskkill //F //IM node.exe` works.
- `docker exec` into the Kafka container needs `MSYS_NO_PATHCONV=1`, or Git Bash rewrites
  `/opt/kafka/...` into a Windows path and the exec fails.
- Git Bash mangles the section-sign character inside heredocs. Write files containing it directly
  rather than piping them through a heredoc.
- **Appending to `.env` from the shell bit once**: the file had no trailing newline, so
  `echo ... >>` joined onto the `OPENAI_MODEL` line and silently corrupted it. Check the file after
  appending to it.
- A stale process serving port 4000 invalidated one verification run in an earlier session. Confirm
  the port is free before trusting a result.

Setup and commands are in [`../README.md`](../README.md).

## Open questions, in the order they will be needed

1. **Vector search in local dev** — needed before Phase 6, and now the next thing due. `CLAUDE.md`
   specifies MongoDB Atlas Vector Search but also plain Docker Compose locally, and the standard
   `mongo` image does not support Atlas Vector Search. Atlas Local container, or a real Atlas
   cluster for dev?
2. **Whether to capture a cleaned page excerpt for enrichment.** New, and evidence-backed rather
   than speculative: without one, a page with no `og:description` gets no summary at all. The fix is
   scoped in the Phase 5 plan, section 4 — one function and one schema field — and it matters
   before Phase 6 embeds this text.
3. **Where Kafka runs in production** — a Phase 9 question, with a real cost attached. Managed
   (Confluent, Redpanda, MSK) or self-hosted?
4. **Where enrichment runs in production, and what it costs per user.** The first component with a
   per-use bill attached; it informs Phase 7's rate-limiting design and the local-model question in
   section 1 of the Phase 5 plan.

All four are architectural and deserve the `CLAUDE.md` "Important Rule" treatment: state the
problem, why the current setup is insufficient, what alternatives exist, and why the choice is
right.

Answered and no longer open: collection delete behaviour and tag-filter combination (Phase 2 note);
fetched title vs. user-edited title, image serving, and theme preference storage (Phase 3 plan);
the **worker language split** — Node for every Kafka consumer, Python only as a stateless FastAPI
embedding service called over HTTP (Phase 4 plan section 2); and the **enrichment provider and
model** (Phase 5 note, section 1).

## Automatic collection allocation — asked, deferred, now due

Raised by the user during Phase 4 planning: people paste links while busy and never file them.
**Decided: revisit after Phase 5 ships** — which it now has, so there are real auto-tagged links to
judge against. Auto-tagging gives machine organisation without folders; auto-filing into collections
has a cold-start problem (it needs collections the busy user has not made), and misfiling actively
breaks the product's core promise. The agreed ladder: suggest-only from tag overlap, then suggest
from embedding similarity to a collection centroid (Phase 6), then auto-assign above a threshold,
opt-in and reversible. Uncategorised keeps its name — the "Inbox" reframe was offered and declined.
Full reasoning in the Phase 4 plan, section 12.

## A gap in CLAUDE.md worth raising

`CLAUDE.md` lists "extract author when available" under URL Processing, but the `Link` model it
specifies has no `author` field. Phase 3 added one, and the extractor writes it. **`CLAUDE.md`
should be updated to match** so the spec and the schema agree. Phase 5 widened the gap: the model
now also carries `autoTags`, `tagsEditedByUser` and the `enrichment*` bookkeeping fields, and
`CLAUDE.md` names neither them nor the enrichment state machine.

## The lesson from Phase 5, worth carrying

**A planning document is not a source of truth about an external API.** `gpt-5.6-luna`, its two
invented siblings and their whole per-token cost table read as authoritative and were fiction.
Anything a plan asserts about a vendor — model names, parameters, prices, error classes — gets
checked against the live API before it is built on. The rest of that plan's provider section was
checked, and all of it held.

## Conventions worth carrying forward

- Small, focused commits with conventional prefixes — see `git log`.
- Business logic lives in services, not route handlers. Validation happens at the boundary.
- Every query touching user-owned data is scoped by `userId`.
- One file owns each external vendor. `services/enrichment.js` is the only file that imports the
  OpenAI SDK, and the error class it raises lives apart from it so nothing else has to.
- Write a session note here when decisions get made, and keep this file's state-of-play current.
