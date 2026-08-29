# Start here

Index of session notes for LinkVault. **`../CLAUDE.md` is the source of truth** for product,
architecture, data models, and phasing — these documents only record what it does not:
decisions made, why, and what state the work is in.

Read in this order when picking the project back up.

| Document | What it holds |
| --- | --- |
| [2026-08-29-overview-architecture.md](./2026-08-29-overview-architecture.md) | Repo layout decision, first open questions |
| [2026-08-29-phase-1-auth.md](./2026-08-29-phase-1-auth.md) | Phase 1: what shipped, auth/security decisions, what was verified |
| [2026-08-29-phase-2-decisions.md](./2026-08-29-phase-2-decisions.md) | Phase 2 decisions agreed with the user, plus the step plan. **Start here for the next session.** |

---

## State of play (as of 2026-08-29)

**Phase 1 is complete and committed.** Phase 2 has not been started — no code written for it.

Working: project setup, Express API, MongoDB connection, and authentication end to end.
`server` has 16 passing tests. `client` builds and lints clean, and the auth flow was walked
through once by hand in a browser with no problems reported.

Next: **Phase 2 — link CRUD, collections, tags, favorites, read/unread, dashboard.**
The four decisions it needs are already made and recorded; the plan is written. It can start
immediately without asking the user anything further.

## Local environment

`.env` exists at the repo root and is gitignored. It holds a **development-only**
`JWT_SECRET` that must be replaced before anything real.

The `linkvault-mongo` Docker container may still be running from the last session, and the
`linkvault` database contains **one test account** created during manual testing. Both are
harmless; `docker compose down` stops the container, and the account can be deleted from
`users` whenever it is in the way.

Setup and commands are in [`../README.md`](../README.md).

## Open questions, in the order they will be needed

1. **Collection delete behaviour** — needed during Phase 2, step 3. Expected: deleting a
   collection unsets `collectionId` on its links rather than deleting them. Confirm before building.
2. **Fetched title vs. user-edited title** — needed in Phase 3. Expected: user input wins.
3. **Worker language split** — needed before Phase 4. Are all Kafka workers Python, or only the
   embedding worker, with the rest in Node? And how are they invoked?
4. **Vector search in local dev** — needed before Phase 6. `CLAUDE.md` specifies MongoDB Atlas
   Vector Search but also plain Docker Compose locally, and the standard `mongo` image does not
   support Atlas Vector Search. Atlas Local container, or a real Atlas cluster for dev?

Questions 1 and 2 are small and can be asked in passing. Questions 3 and 4 are architectural
and deserve the `CLAUDE.md` "Important Rule" treatment: state the problem, why the current
setup is insufficient, what alternatives exist, and why the choice is right.

## Conventions worth carrying forward

- Small, focused commits with conventional prefixes — see `git log`.
- Business logic lives in services, not route handlers. Validation happens at the boundary.
- Every query touching user-owned data is scoped by `userId`.
- Write a session note here when decisions get made, and keep this file's state-of-play current.
