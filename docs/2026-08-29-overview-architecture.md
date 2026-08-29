# Session: Overview & Architecture (2026-08-29)

`CLAUDE.md` is the source of truth for product/architecture/phasing. This just records what this session established beyond it.

## Context at session start
Repo had only `README.md` and a freshly written `CLAUDE.md` (product spec, architecture, data models, phased roadmap). No code yet.

## Decisions made
- **Repo layout**: single repo, plain sibling folders `client/` and `server/` — no npm workspaces, no separate repos. Chosen for simplicity per "start simple" principle.

## Open questions (not blocking Phase 1)
- **Vector search vs. local dev**: `CLAUDE.md` specifies MongoDB Atlas Vector Search but also plain Docker Compose for local dev — standard `mongo` image doesn't support Atlas Vector Search. Needs a call (Atlas Local container vs. real Atlas cluster in dev) before Phase 6.
- **Worker language split**: backend is Node/Express, but ML stack is separately listed as Python/FastAPI/Sentence Transformers. Unclear whether all Kafka workers are Python or just the embedding worker, and how they'd be invoked. Needs a call before Phase 4.
- **Collection cardinality**: `Link.collectionId` is singular; confirm bookmarks belong to one collection, not many.

## Phase 1 plan (agreed)
Scope: project setup, React frontend, Express backend, MongoDB connection, auth only — no Kafka/workers/Redis/embeddings.

1. `client/` (Vite + React + Tailwind + React Router) and `server/` (Express + Mongoose) as sibling folders; root `docker-compose.yml` for local MongoDB; root `.env.example`.
2. Express skeleton: routes / business-logic / models separated; Mongoose connection; central error handling; boundary validation.
3. `User` model per `CLAUDE.md` schema; bcrypt password hashing.
4. Auth endpoints: register, login, logout, JWT issuance, protect-route middleware attaching `req.userId`.
5. Client skeleton: routing, auth context/hook, register/login pages, protected-route wrapper.
6. Wire client → server auth flow end-to-end.
7. Backend tests for auth logic (validation, hashing, login success/failure, protected-route rejection).
