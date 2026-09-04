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
| [2026-09-01-phase-5-enrichment.md](./2026-09-01-phase-5-enrichment.md) | Phase 5: what shipped, why the planned model did not exist, and what the real-API run showed |
| [2026-09-02-deployment-and-extension-plan.md](./2026-09-02-deployment-and-extension-plan.md) | Deployment decisions and cost model, the blockers found by auditing the tree, rate limiting, and the Chrome extension plan |
| [2026-09-02-deploy-v1.md](./2026-09-02-deploy-v1.md) | Deploy v1: what shipped, the cookie decision and what it costs, the spending bounds, graceful shutdown, and the provisioning handover |
| [2026-09-03-deploy-v1-live.md](./2026-09-03-deploy-v1-live.md) | Deploy v1 is live: what the dashboards actually needed, the sites that block a datacenter IP, the URL-derived title fallback, and the fix list and extension path for next time |
| [2026-09-04-extension.md](./2026-09-04-extension.md) | The title and tagging fixes, bearer tokens, page capture ahead of Phase 6 and its Important Rule argument, and the Chrome Web Store deployment checklist. **Start here for the next session.** |

---

## State of play (as of 2026-09-04)

**Phases 1 to 5 are complete, and v1 is deployed and reachable.**

Working: project setup, Express API, MongoDB, authentication, bookmark CRUD, collections, tags,
favorites, read/unread, keyword search with filters, the dashboard, URL metadata extraction with
processing status and retries, the appearance pass (dark mode, accent picker, redesigned link
list), an event-driven pipeline on Kafka with extraction in its own worker process, and generated
summaries and tags with tag rename/merge, bearer-token auth, and a Chrome extension that saves the
current tab with a capture of the page. `server` has 248 passing tests. `client` builds clean.

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

**Deploy v1 is built and waiting on provisioning.** The hardening shipped on 2026-09-02: graceful
shutdown that actually closes the server, drains both workers and disconnects Mongo; `helmet`;
pinned Node 22; a rate limit store behind an interface with a memory implementation; per-IP auth
limits and a per-user save limit; a per-user bookmark cap and a global daily enrichment ceiling.
`server` now has **220 passing tests**, and it was run in `NODE_ENV=production` against a real
mongod, not only tested. Details in the deploy note.

Four decisions there are worth knowing before touching any of it:

- **The session cookie is `sameSite: 'none'` with `secure: true` in production** — the user chose
  this over the Vercel rewrite the plan recommended. The rewrite question is closed; the price is
  that **login will not work in Safari or on iOS**, and that `CLIENT_ORIGIN` is now genuinely
  load-bearing rather than a formality. v1 is Chrome-first on purpose.
- **Registration stays open**, so the caps are the bound. That is why registration is limited to 5
  per hour per IP rather than the plan's 10 per 15 minutes: account creation is otherwise the way
  past every per-user quota.
- **The two limits that bound money live in MongoDB, not the rate limit store.** The memory store
  loses its counters on every restart, and a free instance restarts constantly. Throttles can
  survive that; a spending ceiling cannot.
- **A spent enrichment budget defers links rather than skipping them.** `skipped` is terminal and
  means "nothing here worth summarising"; a budget clears at midnight. The reaper also stops
  publishing enrichment work it cannot pay for, or the backlog would churn all night rediscovering
  the same refusal.

**Deploy v1 went live on 2026-09-03.** Atlas, Render and Vercel are provisioned and the app works end
to end in Chrome. The cron ping on `/api/health` is the one checklist item still outstanding. Six
provisioning traps are written up in the live note, section 2 — the sharpest being that **the Atlas
connection string carries no database name**, so without `/linkvault` appended by hand everything
silently lands in a database called `test`.

**The finding of the deployment is that the network origin changes what the internet returns.**
YouTube serves 200 to a residential IP and **429 to Render**, whose free instances share outbound IPs
across tenants; LeetCode returns **403 to everything**, browser User-Agent included, matching on TLS
fingerprint rather than identity. Identical code, identical URL, different answer — a sharper variant
of the theme above, and one nothing runnable on the development machine could have produced. The
response so far is `titleFromUrl`, which names an unfetchable link from its path (`/problems/two-sum/`
→ "Two Sum") rather than showing the bare domain the line beneath already repeats. The real answers —
an oEmbed pre-step, and extension page capture — are both listed in the live note, section 5.

**The Chrome extension exists, and page capture shipped ahead of Phase 6.** That is a deliberate
deviation from the deployment plan's ordering and it carries the `CLAUDE.md` Important Rule argument
in the 2026-09-04 note, section 2 — the short version being that capture is the only thing that
reaches a page a datacenter IP is refused, and its stored text is the Phase 6 embedding input
anyway. Alongside it: bearer tokens (`Authorization: Bearer lv_…`, SHA-256 hashed, unable to mint
their own replacement), `/settings` in the web app to mint one, and an unpacked-loadable
`extension/` with no build step. **248 server tests pass.** Nothing is on the Chrome Web Store yet;
the checklist for that is section 4 of the same note, and every step of it is the user's to do.

Two fixes landed with it. Extraction no longer writes the domain into `title` — it did, which both
wasted the card's headline on the line beneath it and permanently blocked the real title, since
`completeLink` only fills an empty field. And auto-tags are capped at three rather than five, with a
deterministic guard that drops a tag which only narrows one already kept: `instagram` +
`instagram-reel` + `kpop` + `kpop-idol` was real output.

Then: **Phase 6 — embeddings, MongoDB Vector Search, semantic search.** It subscribes to
`link.enriched`, which the enrichment worker now publishes and nothing consumes yet, so it adds a
consumer without touching Phase 5's code. The embedding runtime is now a live decision rather than
a settled one — the deployment budget (512MB, one always-warm free service) reopens the Phase 4
answer of "Python only as a stateless FastAPI embedding service". Three options are laid out in the
deployment note, section 9.

**The Chrome extension is the user's stated next direction, and the deployment changed the case for
it.** The plan deferred the whole extension until after Phase 6, which still holds for **omnibox
search** — that cannot exist before semantic search does. But **page capture never needed Phase 6**,
and production has now given it a second, independent justification: beyond paywalls, logins and
JavaScript-rendered pages, capture is the only thing that reaches **sites which refuse this server
because of where it is calling from**. It runs from the user's own IP and session, so YouTube's 429
and LeetCode's 403 stop applying. It also remains the evidence-backed answer to open question 3.

The order proposed for next session: **Bearer-token auth path** (small, self-contained, already the
sanctioned early piece, and the eventual answer to Safari), then the **extension skeleton with
capture**, then Phase 6, then omnibox. Capture before Phase 6 deviates from the plan's ordering and
deserves the `CLAUDE.md` Important Rule treatment when proposed — the argument is now evidence rather
than speculation. First blocker to clear: `express.json({ limit: '100kb' })` rejects a capture
payload, and the fix is a per-route limit, not a global one.

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
`JWT_SECRET`, which stays development-only: production has its own freshly generated value set on
Render, and the two are unrelated. `MONGODB_URI` now points at Atlas rather than the local Docker
mongo, and **must end in `/linkvault`** — the string Atlas hands out has no database name, and
without one Mongoose silently uses a database called `test`.

`OPENAI_API_KEY` is set. It was originally added as `OPEN_API_KEY` — a typo that disables
enrichment **silently**, since a missing key is a supported configuration — and has been renamed.
`OPENAI_MODEL` is `gpt-5-mini`. **The key was exposed in a chat transcript on 2026-09-03** via an
editor selection; it never reached git, rotating it was suggested, and whether that happened is
unknown. Treat it as unrotated until confirmed.

The `linkvault` database holds the user's own account and links, plus **one account created by the
Phase 5 end-to-end run** (`phase5-<timestamp>@example.com`, four links), left in place as evidence
of the verification and safe to delete. That is the **local** database; Atlas holds its own separate
copy created during the deployment.

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

1. **The Phase 6 embedding runtime** — Python and Sentence Transformers on a second free service,
   `transformers.js` inside the existing Node worker, or a hosted embedding API. New, and it
   reopens the Phase 4 answer below, because the deployment budget has room for exactly one
   always-warm free service. Deployment note, section 9.
2. **Vector search in local dev** — `CLAUDE.md` specifies MongoDB Atlas Vector Search but also plain
   Docker Compose locally, and the standard `mongo` image does not support Atlas Vector Search.
   Atlas Local container, or a real Atlas cluster for dev? Deploying to Atlas answers the production
   half; the local half stays open. Also unresolved: whether a vector index is warranted at v1 scale
   at all — ten thousand links is about 15MB and a brute-force scan is single-digit milliseconds.
3. **Whether to capture a cleaned page excerpt for enrichment.** Evidence-backed rather
   than speculative: without one, a page with no `og:description` gets no summary at all. The fix is
   scoped in the Phase 5 plan, section 4 — one function and one schema field — and it matters
   before Phase 6 embeds this text.
4. **Where Kafka runs in production** — still a Phase 9 question. The deployment note **defers** it
   rather than answering it: v1 ships with `ENABLE_KAFKA=false` because no managed Kafka has a
   durable free tier, and the reaper moves the durability guarantee from the broker to the document.
   Managed (Confluent, Redpanda, MSK) or self-hosted remains the eventual choice.
5. **What enrichment costs per user at real volume.** Phase 5 measured about $0.60 per 1,000 links
   on `gpt-5-mini`, but per-user volume is unknown and deploying is the only way to learn it. It
   sets the per-user quota and the global daily ceiling in the deployment note, section 7.
6. **Whether open registration survives contact with the internet.** Answered for v1 -- it stays
   **open**, with the caps doing the bounding (100 bookmarks per user, 200 enrichments per day
   globally, 5 registrations per hour per IP). The caps make abuse expensive rather than
   impossible; closing registration remains the strongest single protection if it is ever needed.
7. **When Safari stops being acceptable.** New, and a direct consequence of the cookie decision.
   The fix already exists on paper: the Bearer-token path planned for after Phase 6.
8. **Whether oEmbed survives Render's IP.** New. It is measured and useful from a residential IP —
   868 bytes of JSON carrying title, author and thumbnail — but it is the same `youtube.com` host
   that already returns 429 on the watch page. Untestable except by deploying.
9. **Whether a shared datacenter IP is tolerable at all.** New. If enough popular domains throttle
   Render free, the answer is either capture, which sidesteps the question entirely, or paid hosting
   with a dedicated egress IP. Fly.io is already named as the first upgrade to buy; this is a second,
   independent reason to buy it.
10. **How many saved links the blocking actually affects.** New. Two domains are known bad, which is
    an impression, not a number. The `processingError` strings on `failed` links are the record that
    would settle it, and it decides how urgent the oEmbed and capture work really is.

All ten are architectural and deserve the `CLAUDE.md` "Important Rule" treatment: state the
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
