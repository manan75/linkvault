# Deployment and extension plan (2026-09-02)

Agreed with the user in discussion before Phase 6. `CLAUDE.md` remains the source of truth for
product and architecture; this records the decisions it does not cover, two deliberate deviations
from its phase order, and the order the work should happen in.

Scope: **deploy v1 to Render and Vercel with Kafka off, add a Redis-backed rate limit layer, and
plan the Chrome extension.** No embeddings, no semantic search — those stay Phase 6.

---

## 1. Two deliberate deviations from CLAUDE.md, stated up front

`CLAUDE.md` puts deployment at Phase 9 and lists "Browser extension" under **Future Features**,
which it says should not be implemented until the core product is working. This plan does both
early. That needs justifying rather than assuming.

**Deploying at Phase 5 instead of Phase 9.** The argument for early deployment is that every
problem found below — the cross-site cookie, the missing production API base, the shutdown that
severs in-flight requests, cold starts — is a *configuration* problem, and configuration problems
are cheapest to find when the surface is small. Deploying after Phase 8 means finding all of them
at once, on a system with vector indexes and a cache layer in the way. Deploying now also puts a
real per-link cost in front of real usage, which is what open question 4 in `docs/README.md` asks
for and which nothing local can answer.

The cost of deviating is low: nothing in this plan is throwaway. The rate limiter, the abuse
ceiling and the graceful shutdown are all Phase 7 and 8 work brought forward, not work invented to
serve the deploy.

**The extension before the core product is finished.** This one is only partly justified. The
extension's two best features — omnibox search over the vault, and capturing page text that makes
embeddings better — both depend on Phase 6 existing. Building the extension UI now would be
building it against a product that cannot yet do the thing it exists to reach.

**Decision: split it.** The Bearer-token auth path (section 9) is small, self-contained, and
unblocks the extension, a future mobile client, and any scripted access. Do it now. The extension
itself waits until Phase 6 has landed, which keeps `CLAUDE.md`'s ordering rule intact in substance
even though the planning happens here.

---

## 2. Deployment target: Render + Vercel, Kafka off

**What problem it solves.** The product needs to be reachable by someone who is not sitting at this
machine, at a cost the user set at effectively zero for v1, with the only real bill being LLM calls.

**Why the current architecture is insufficient.** It runs on `docker compose` and `localhost`.
Nothing about it is wrong; it simply has no production form yet.

**Alternatives considered.**

- *Render + Vercel free tiers.* Chosen. Genuinely $0, no card required for the pieces that matter,
  and the shapes match: Vercel serves a static Vite build, Render runs a long-lived Node process
  with background work in it.
- *Fly.io.* Better cold starts by a wide margin — machines auto-stop and wake in a second or two,
  against Render's roughly fifty. But Fly no longer has a real free tier; a mostly-idle small
  machine lands in the low single dollars per month. **This is the first upgrade to buy** if cold
  starts become annoying, but it is not $0 and so is not v1.
- *Oracle Cloud Always Free.* Four ARM cores and 24GB, free indefinitely, and large enough to run
  the entire `docker-compose.yml` including Kafka. Rejected for v1 on operational cost: capacity is
  famously hard to obtain, there are no managed backups, and it makes the user a sysadmin for a
  project whose point is the pipeline. Revisit at Phase 9 if Kafka in production matters more than
  the ops burden.
- *Railway.* Clean developer experience, but a $5/month floor. Not $0.

**Why Render + Vercel is appropriate.** It is the only option on the list that is actually free,
and the constraint it imposes — one process, 512MB, spins down when idle — is one the codebase
already accommodates, because `ENABLE_KAFKA=false` was built in Phase 4 for exactly this shape.

### Kafka stays off in production

`ENABLE_KAFKA=false` selects `createMemoryBus()` (`server/src/events/index.js:13`) and the same
reaper and both consumers run inside the API process. No managed Kafka has a durable free tier —
Upstash Kafka was discontinued, and Confluent, Aiven and Redpanda are trial credits followed by a
bill.

What this gives up is durability across restarts: an event in flight when the process dies is gone.
What makes that survivable is the reaper, which sweeps MongoDB for links stuck in `pending` and
`queued` and republishes them. A link saved just before spin-down is not lost; it waits in the
database and is picked up on the next wake. **The durability guarantee moved from the broker to the
document, which is where Phase 4 deliberately put the retry state anyway.**

Kafka remains fully exercised locally via `docker compose`, and turning it on in production is a
one-variable change plus a second Render service. That is a Phase 9 decision with a real cost
attached, and it stays open question 3 in `docs/README.md`.

---

## 3. Cost model

| Piece | Provider | Tier | Cost |
| --- | --- | --- | --- |
| React SPA | Vercel | Hobby | $0 |
| Express API + in-process workers | Render | Free web service, 512MB, 0.1 CPU | $0 |
| MongoDB | Atlas | M0, 512MB | $0 |
| Redis | Upstash | Free, ~500K commands/month | $0 |
| Kafka | — | Not deployed | $0 |
| Domain | `*.vercel.app` / `*.onrender.com` | — | $0 |
| Enrichment | OpenAI `gpt-5-mini` | Measured in Phase 5 | ~$0.60 / 1,000 links |
| Embeddings (if hosted — see section 8) | OpenAI `text-embedding-3-small` | — | ~$0.005 / 1,000 links |
| Chrome Web Store | Google | One-time developer fee | $5 once |

At a few hundred links a month this is **under two dollars a month, all in**, and the user's
expectation of "zero except the LLM calls" holds.

Atlas M0 storage math: a 384-dimension embedding stored as BSON doubles is roughly 3KB, plus
metadata and summary at roughly 2KB. Call it 5KB per link, so **about 100,000 links fit in 512MB**.
Not a constraint. Section 10 adds a captured-text field which changes this number and is sized
there deliberately.

---

## 4. The production API base, and why it also fixes the cookie problem

`client/src/lib/api.js:1` sets `API_BASE = '/api'`, and `client/vite.config.js` proxies `/api` to
`localhost:4000` so that development is same-origin and the session cookie needs no special
handling. There is no production equivalent of that proxy yet.

The naive fix — point the client at the Render URL directly — breaks authentication. The session
cookie is set `sameSite: 'lax'` (`server/src/config/cookies.js:11`), and `linkvault.vercel.app`
calling `linkvault-api.onrender.com` is cross-site. Both hosts are on the public suffix list, so
there is no shared parent domain to fall back to. The cookie would simply not be sent, and login
would appear to succeed and then not work.

**Decision: a Vercel rewrite, which reproduces the dev proxy in production.**

```json
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://linkvault-api.onrender.com/api/:path*" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

The browser only ever talks to `linkvault.vercel.app`, so every request is same-origin, `sameSite:
'lax'` keeps working unchanged, and no domain purchase is required. Rule order matters: the SPA
catch-all must come second or it swallows the API route.

Two things to verify at deploy time rather than assume: that Vercel Hobby permits rewrites to
external destinations at the volume needed, and how they are metered. **Fallback if it does not
work out:** a `VITE_API_BASE` environment variable pointing at Render directly, plus
`sameSite: 'none'` with `secure: true` in production. That works but makes the session a
third-party cookie, which browser vendors are steadily making less reliable. Prefer the rewrite.

A custom domain (roughly $12/year) is the third option and the most robust —
`app.example.com` and `api.example.com` are same-site, so `lax` works with no proxy at all. Worth
buying eventually; not needed for v1.

---

## 5. Blockers before v1 can deploy

Found by auditing the current tree. None are architectural.

1. **`vercel.json`** as in section 4. Set Vercel's Root Directory to `client`, Render's to `server`.
2. **`CLIENT_ORIGIN`** set to the Vercel URL. With the rewrite in place the browser request is
   same-origin so CORS is not the enforcing mechanism, but the value should still be correct rather
   than left at the localhost default.
3. **Graceful shutdown is incomplete.** `shutdown()` (`server/src/index.js:79`) stops the reaper and
   the bus and then calls `process.exit(0)` immediately. It never closes the HTTP server, never
   disconnects MongoDB, and **never stops `metadataWorker` or `enrichmentWorker`**. Render sends
   SIGTERM on every single deploy, so in-flight requests are severed and a link can be left holding
   a lease it will only escape via the reaper's stale sweep. Close the server, stop both workers,
   disconnect Mongo, and keep a timeout backstop so a hung close cannot block the exit forever.
4. **No `engines` field** in `server/package.json`. Render will choose a Node version. Pin `22.x`,
   which is what the code is developed and tested against.
5. **Atlas network access** must be `0.0.0.0/0`, because Render free has no static outbound IP.
   Compensate with a generated password of real length and a database user scoped to the one
   database. This is a genuine widening of exposure and is accepted knowingly.
6. **A real `JWT_SECRET`.** The `.env` value is development-only and `docs/README.md` already says
   it must be replaced before anything real. This is that moment.
7. **`helmet`.** One line of middleware, and the app serves user-supplied content.

---

## 6. Rate limiting, and an honest answer about Redis

`CLAUDE.md` puts both at Phase 7 and says plainly: "Do not use Redis merely for the sake of having
Redis." That rule applies to this section and it is worth applying honestly.

**Rate limiting earns its place immediately.** Registration is open to the world and
`POST /api/links` triggers a page fetch and a paid model call. Without a limit, one script empties
the OpenAI account. The limits that matter:

- `/api/auth/login` and `/api/auth/register` — roughly 10 per 15 minutes per IP. Brute-force and
  signup-flood protection.
- `POST /api/links` — roughly 20 per hour **per user, not per IP**. The expensive resource is billed
  per account, so the limit belongs on the account.

**Redis earns its place less clearly, and the honest position is this:** on a single Render free
instance there is exactly one process, so an in-memory counter is functionally sufficient today.
There is no search to cache yet. Adding Upstash now, purely to have Redis in the diagram, is the
thing `CLAUDE.md` warns against.

**Decision: build a `rateLimitStore` behind one interface, exactly mirroring the `eventBus`
pattern.** A memory implementation and an Upstash implementation, selected by `ENABLE_REDIS` the
way `ENABLE_KAFKA` selects the bus. The defensible reasons this is not premature:

- Counters survive deploys and restarts, which on a free instance that spins down is not nothing.
- Phase 7's search cache and Phase 7's processing deduplication both need a Redis client, and this
  puts one behind an interface rather than reaching for a new dependency mid-phase.
- It costs nothing to run in memory, so the abstraction is free until it is switched on.

The seam is the point, the same as it was for the bus. Callers must not learn which store they got.

---

## 7. Abuse and wallet protection

Rate limiting slows abuse. It does not bound it. Anyone can register, and every saved link costs
money.

- **A per-user link quota** — 500 for v1. This is the actual bound.
- **A global daily enrichment ceiling** that trips a breaker and lets links land un-enriched rather
  than un-billed. Enrichment already has `skipped` as a real terminal state
  (`server/src/models/Link.js`), so degrading cleanly is a path the model already understands.
- **Closed registration** — an invite code or an email allowlist — until there is a reason to open
  it. This is the strongest single protection and the cheapest to build.

`safeFetch` is already hardened against SSRF, DNS rebinding, oversized bodies and redirect chains,
which is the part of a public deploy that would otherwise be alarming. That work is done.

---

## 8. Cold starts

Render free spins down after roughly 15 minutes idle and takes roughly 50 seconds to wake. The
first login after a quiet period will look broken to anyone being shown the project.

Mitigation: a free external cron pinging `/api/health` — which already exists
(`server/src/routes/index.js:9`) — every 10 minutes. Render's free allowance is 750 instance-hours
per month and a month is about 730 hours, so **one always-warm free service fits inside the budget,
exactly one.** That is a further argument against a second free service for a Python embedding
worker, and feeds directly into the next section.

---

## 9. The Phase 6 embedding runtime — decision still open

Not decided here, but the deployment constraints narrow it, so it is recorded now.

Render free gives 512MB of RAM and one always-warm service. `docs/README.md` records the Phase 4
answer to the worker-language split as "Node for every Kafka consumer, Python only as a stateless
FastAPI embedding service called over HTTP". That answer was given without a deployment budget in
view, and the budget changes it.

- **A. Python + Sentence Transformers on a second Render free service.** Matches `CLAUDE.md`
  literally. Needs ONNX Runtime rather than torch to fit in 512MB, needs the model baked into the
  image or it re-downloads on every cold start, and consumes the instance-hour budget that
  section 8 shows has room for exactly one warm service.
- **B. `transformers.js` with `Xenova/all-MiniLM-L6-v2` inside the existing Node worker.** The same
  model weights and the same 384 dimensions as the Sentence Transformers default; quantized ONNX is
  about 23MB. No second service, no second language, no second deploy. Deviates from `CLAUDE.md`'s
  Python/FastAPI line and would need the Important Rule treatment in the Phase 6 plan.
- **C. A hosted embedding API** (`text-embedding-3-small`). About half a cent per thousand links, no
  RAM cost, no cold start, and the OpenAI client is already wired in
  `server/src/services/enrichment.js`. Cheapest in effort; adds a second per-link vendor bill.

**Whichever is chosen, store the model name alongside every embedding.** Vectors from different
models are not comparable, so changing the model means re-embedding the whole corpus — which the
Phase 4 plan already anticipated. Recording the model makes that migration detectable instead of
silent, and silent is how it would otherwise present: search quality quietly degrading with no error
anywhere.

Related, and worth deciding in the same breath: **a vector index may not be needed at v1 scale.**
Ten thousand links at 384 dimensions is about 15MB, and a brute-force cosine scan over that in
Node takes single-digit milliseconds. Atlas Vector Search on M0 should be confirmed as available
before the Phase 6 plan depends on it. Using it to learn the real mechanism is a legitimate reason;
needing it at this scale is not.

---

## 10. The Chrome extension

### Why it is worth building

The product promise is save, forget, describe, find. **Saving currently costs the user four
actions**: copy the URL, switch tabs, find LinkVault, paste. That friction lands at the exact moment
of intent, and it is the reason bookmark tools die — people do not save enough for the vault to
become valuable, and a vault that is not valuable does not get searched.

Beyond convenience there is one capability the server structurally cannot have:

**`safeFetch` cannot see what the user can see.** Paywalled articles, pages behind a login,
JavaScript-rendered applications — Twitter threads, Notion documents, internal wikis — all extract
to nothing today. The extension holds the *rendered DOM of the page the user is actually looking
at*. This directly answers open question 2 in `docs/README.md`, which Phase 5 turned from a
hypothesis into an evidence-backed finding: three of four verification pages carried no
`og:description` and therefore got no summary at all. Better extraction input is better summaries,
and better summaries are better embeddings, which is the entire ceiling on Phase 6.

Two further features, both dependent on Phase 6:

- **Omnibox integration** — `lv <query>` in the address bar runs a semantic search over the vault.
  That puts "describe, find" in the most-used text input in the browser.
- **An "already saved" badge** on the extension icon when the current page is in the vault.

### What changes in the pipeline

One branch in one worker. Nothing downstream of `metadata.extracted` is touched.

```
web app     --> POST /api/links { url }
extension   --> POST /api/links { url, capture: { title, description, ogImage, text } }
                        |
                  save `pending` --> reaper --> link.created
                                                     |
                                             metadataWorker
                                                     |
                                     +---------------+---------------+
                                capture?                        no capture
                                     |                               |
                           parse capture (no I/O)          safeFetch --> parseMetadata
                                     +---------------+---------------+
                                               completeLink
                                                     |
                                             metadata.extracted --> enrichmentWorker --> link.enriched --> [Phase 6]
```

**The branch belongs in `metadataWorker.handle`, not in `saveLink`.** It is tempting to complete a
captured link synchronously, since there is no I/O to wait for — but that would duplicate
`completeLink`, fork the state machine, and violate `CLAUDE.md` principle 2. Branching inside the
worker keeps one completion path, one lease, one retry policy. The capture case simply skips the
`fetchPage` call.

### Four consequences worth writing down

1. **`express.json({ limit: '100kb' })` (`server/src/app.js:17`) becomes a blocker.** A page capture
   exceeds it. This needs a per-route body limit on `POST /api/links`, not a global increase —
   everything else should stay tight.

2. **The trust boundary is a trap.** `CLAUDE.md` says never trust fetched webpage content. A capture
   *is* fetched webpage content; it merely arrives with a valid session attached, which makes it
   feel trusted. It is arbitrary DOM from a page that may be attacker-controlled. It must pass
   through the identical `utils/sanitize.js` path and the same length caps as `parseMetadata`
   output. Same rules, different door.

3. **Storage must be bounded.** Raw page text at 100KB per link would exhaust M0 quickly. Truncate
   to roughly 4KB of extracted text in a `capturedText` field with `select: false` — enough for
   enrichment and for Phase 6 embedding input, and about 40MB at ten thousand links. Keeping it
   rather than discarding it after use is deliberate: it makes re-embedding the corpus possible
   without re-fetching every page when the model changes.

4. **Duplicate saves stop being exceptional.** An offline retry queue in the extension makes them
   routine. The unique `(userId, canonicalUrl)` index already handles this — protection paid for in
   Phase 2 and now collecting. One decision remains: when a retry arrives *with* a capture for a
   link that already exists and whose extraction failed, re-run it. That is the extension rescuing a
   page `safeFetch` could not reach, which is the point.

### Authentication

The session is an httpOnly cookie with `sameSite: 'lax'`. An extension popup runs on
`chrome-extension://`, which is cross-site, so the cookie will not attach.

**Decision: add a Bearer-token path rather than loosening the cookie.** `POST /api/auth/tokens`
issues a long-lived opaque token; the hash is stored, never the token. `requireAuth`
(`server/src/middleware/requireAuth.js`) accepts `Authorization: Bearer` **in addition to** the
cookie, leaving the web app's behaviour untouched. Loosening to `sameSite: 'none'` would weaken the
web application's posture to serve a different client, which is the wrong trade.

This is the piece to build now, per section 1. It also unblocks a mobile client and scripted access.

---

## 11. Repository layout: one repo, new `extension/` folder

**Decision: monorepo.** `client/`, `server/`, `extension/` as siblings, each with its own
`package.json`, which is the pattern already in place.

- **The contract changes on both sides at once.** The capture payload shape, the token endpoints,
  the tag and collection types. Split repositories make every contract change two pull requests
  with a window in between where the two halves disagree.
- **There is real shared code.** `utils/canonicalUrl.js` normalisation must be byte-identical on
  both sides, because the extension needs to answer "have I already saved this?" locally before it
  posts. In one repository that is a `shared/` folder; across two it is a published npm package that
  must be versioned to change a regular expression.
- **Deployment stays independent regardless.** Vercel builds `client/`, Render builds `server/`, the
  extension builds to a zip uploaded by hand. Three targets, one repository, which is ordinary. Both
  platforms need a Root Directory setting, which is required today anyway.
- **The `docs/` history is one narrative.** Splitting it fragments the record this project depends
  on for continuity.

Split only if the extension acquires its own release cadence and team, or if one half is
open-sourced. Neither applies.

---

## 12. The web app is not replaced

"Deploy as a Chrome extension" has a stronger reading worth naming and rejecting explicitly: drop
Vercel, let the extension popup and a full-page extension view be the entire interface, and leave
Render serving pure JSON.

It is genuinely tempting — no proxy, no cross-site cookie question, the UI loads instantly because
it is local, and Vercel's non-commercial Hobby licence stops mattering.

**Rejected.** It loses the shareable URL, which matters for a project meant to be shown to people;
it is Chrome-only; signup would require installing an extension first; and every UI change would
wait days on store review.

**The extension is a thin capture surface plus omnibox search. The web app remains the vault UI.**
That is the shape Pocket, Raindrop and Instapaper all converged on, and it keeps a link that can be
sent to someone.

---

## 13. Order of work

**Deploy v1 (a day, roughly):**

1. Fix `shutdown()` — close the server, stop both workers, disconnect Mongo, timeout backstop.
2. Add `engines: node 22.x`; add `helmet`.
3. `rateLimitStore` behind an interface, memory implementation, `ENABLE_REDIS` selecting Upstash.
4. Apply limits: auth endpoints per IP, `POST /api/links` per user.
5. Per-user link quota and the global enrichment ceiling.
6. Closed registration — invite code or allowlist.
7. Atlas M0 cluster, `0.0.0.0/0`, generated password, scoped user.
8. Render service from `server/`, real `JWT_SECRET`, `ENABLE_KAFKA=false`.
9. `vercel.json` with both rewrites; Vercel project from `client/`; `CLIENT_ORIGIN` set.
10. Cron ping on `/api/health` every 10 minutes.
11. Verify end to end against the deployed instance — register, save, watch it reach `ready` with a
    summary, search. **Phases 3 through 5 each produced bugs that only appeared against the real
    dependency; assume this one will too.**

**Then, before the extension:**

12. Bearer-token auth path — `POST /api/auth/tokens`, hashed storage, `requireAuth` accepting both.
13. Phase 6.

**Then the extension**, per section 1.

---

## 14. Open questions this plan does not close

1. **The Phase 6 embedding runtime** — A, B or C in section 9. Needed before the Phase 6 plan.
2. **Atlas Vector Search availability on M0**, and whether a vector index is warranted at v1 scale
   at all. This supersedes the "Atlas Local container or real cluster" framing of open question 1 in
   `docs/README.md`: deploying to Atlas answers the production half, and the local-development half
   remains genuinely open.
3. **Whether Vercel Hobby permits and how it meters external rewrites** — section 4, with a
   documented fallback.
4. **Whether registration stays closed**, and what opens it.

Carried forward unchanged from `docs/README.md`: where Kafka runs in production (section 2 defers
it, and does not answer it), and what enrichment costs per user at real volume — which deploying is
the only way to learn.
