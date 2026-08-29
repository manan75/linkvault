# LinkVault

An intelligent bookmark manager for the moment you think *"I know I saved that link somewhere."*

Save a URL, forget about it, then describe it later in your own words and get it back.
See [`CLAUDE.md`](./CLAUDE.md) for the full product spec and architecture.

## Status

**Phase 1 complete** — project setup, Express API, MongoDB connection, and authentication.
Bookmark CRUD is next.

## Layout

```
client/   React + Vite + Tailwind frontend
server/   Express + Mongoose API
docs/     Session notes and decisions
```

## Requirements

- Node.js 22+
- Docker (for local MongoDB)

## Getting started

```bash
# 1. Configure environment
cp .env.example .env
# then edit .env and set JWT_SECRET to a long random value

# 2. Start MongoDB
docker compose up -d

# 3. Install dependencies
npm --prefix server install
npm --prefix client install

# 4. Run both dev servers (in separate terminals)
npm --prefix server run dev    # http://localhost:4000
npm --prefix client run dev    # http://localhost:5173
```

Open http://localhost:5173 and create an account.
The Vite dev server proxies `/api` to the API, so the session cookie stays same-origin.

## Tests

```bash
npm --prefix server test
```

Auth tests run against an ephemeral in-memory MongoDB — no running database required.

## API

| Method | Endpoint             | Auth | Description                        |
| ------ | -------------------- | ---- | ---------------------------------- |
| GET    | `/api/health`        | –    | Liveness check                     |
| POST   | `/api/auth/register` | –    | Create an account and sign in      |
| POST   | `/api/auth/login`    | –    | Sign in                            |
| POST   | `/api/auth/logout`   | –    | Clear the session                  |
| GET    | `/api/auth/me`       | ✓    | Current user                       |

The session is a JWT in an `httpOnly` cookie, so page scripts cannot read it and
logout is a real server-side action.
