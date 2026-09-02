# Session: Phase 4 — Kafka and background workers (2026-08-30)

Implements the plan in [`2026-08-30-phase-4-plan.md`](./2026-08-30-phase-4-plan.md), in the order
its step plan sets out. `CLAUDE.md` remains the source of truth for product and architecture; this
records what was built, what changed from the plan, and what was verified.

## What shipped

- **Kafka in Compose** — single-node KRaft, no ZooKeeper, three partitions per topic.
- **`src/events/`** — a bus abstraction with two implementations: `kafkaBus.js` (kafkajs) and
  `memoryBus.js` (in-process). `topics.js` defines `link.created`, `metadata.extracted` and
  `link.processing.failed`.
- **`src/workers/linkQueue.js`** — the state machine, extracted from the Phase 3 worker and shared
  by both sides. Nothing in it imports Kafka.
- **`src/workers/reaper.js`** — the Phase 3 poller with its job changed: it publishes rather than
  fetches, and recovers expired leases.
- **`src/workers/metadataWorker.js`** — now a consumer. The claim → fetch → parse → complete
  sequence is unchanged; only what calls it moved.
- **`src/workers/index.js`** — the worker process, `npm --prefix server run worker`.
- **A `queued` status and `queuedAt`** on `Link`, with a 60-second lease.
- 15 new backend tests (146 total).

## Changed from the plan while building

- **The plan's "keep the Phase 3 poller behind `ENABLE_KAFKA=false`" was dropped, and it turned out
  better.** Making the *bus* swappable rather than the *trigger* means there is one code path, not
  two: with the flag off, the same reaper publishes to an in-process bus and the same consumer
  handles it, inside the API process. Nothing is duplicated and nothing has to be deleted at the
  end of Phase 5.

- **The in-memory bus bounds its delivery concurrency**, because a Kafka consumer's is bounded.
  kafkajs processes one message at a time per partition, so three partitions give at most three
  concurrent handlers. Without a matching bound, flag-off would fire one fetch per saved link
  simultaneously — a regression from Phase 3's `concurrency: 3`.

- **The reaper lives in the API process, not the worker process.** It reads MongoDB and publishes,
  which is the producer side, and it means `saveLink` can nudge it in-process rather than needing a
  way to poke another machine.

- **Attempts are counted at `claimForProcessing`, not at queue time.** A lost message then costs a
  site nothing, while a consumer that dies mid-fetch still burns an attempt.

- **Topic creation lists first and creates only what is missing.** Creating unconditionally made
  every process after the first log a broker-side error for topics that already exist — noise at
  startup that trains you to ignore startup logs.

## Three bugs found by running it, not by testing it

All three passed the entire unit suite. Each needed a real broker, a real outage, or a real page.

### 1. A publish that never settles wedged the pipeline permanently

`kafkajs` does not reject when the broker is unreachable. It retries the seed broker indefinitely,
so `producer.connect()` and `producer.send()` simply never settle — confirmed with an isolated
repro that sat pending for 45 seconds with `retries: 8`.

The reaper awaited `bus.publish` directly. With the broker down that await never returned,
`isTicking` stayed `true`, and **the sweep never ran again**. Stale-lease recovery went down with
it — the mechanism specifically meant to survive this outage was disabled by it. Only an API
restart would clear it, and nothing in the logs said so.

Fixed with `utils/withDeadline.js` around every kafkajs call, a publish cooldown so a dead broker
is not hammered, and `reclaimStale()` moved ahead of the publish loop so recovery can never sit
behind the thing that is broken.

### 2. The producer never reconnected after an outage

Related but separate, and found immediately after fixing the first. `eventBus.start()` was called
once at boot. If it failed — because the API happened to start while the broker was down — the
producer was left disconnected and **every later publish failed forever** with "The producer is
disconnected". The API kept serving, so it looked healthy; the pipeline was simply dead for the
life of the process.

Fixed by routing every entry point through `ensureStarted()`, which connects on demand and only
once at a time, and by marking the connection dead on a send failure so the next publish reconnects.

### 3. Socket timeouts were treated as permanent failures

A Phase 3 bug, surfaced by a Phase 4 end-to-end run. `safeFetch` has two timeout paths: the overall
deadline set `retryable: true`, the per-request socket timeout did not. The socket timeout is the
path a genuinely slow page takes, so **a slow site failed on its first attempt and never used its
other two** — directly contradicting the Phase 3 plan's stated policy that timeouts are transient.

Invisible to the tests because the worker tests constructed `FetchError` by hand with
`retryable: true`, and the `safeFetch` timeout test only asserted the error `kind`. It now asserts
`retryable` too.

**The pattern in all three:** the unit tests were testing the code's own idea of failure. Every one
of these needed the real dependency behaving badly.

## Verified

- `npm --prefix server test` — **146 passing**, 0 failing. `npm --prefix client run build` and
  `npx oxlint` — clean.
- **Broker smoke test before any application code** — topic created, keyed messages produced and
  consumed, same key to the same partition, both from the container and from Node on the host.
- **Two processes, real Kafka.** API and worker separate; four links saved; one was `ready` within
  400ms via the save nudge. Consumer group lag returned to 0 across all three partitions.
- **Broker outage.** With Kafka stopped: `POST /api/links` returned `201` in 7ms (Principle 2
  holds), the API started and served with no broker, links accumulated at `pending`, and the reaper
  logged its backoff. On restart the backlog drained **without an API restart** — 4 ready, 2
  correctly failed.
- **Worker killed mid-fetch.** The link sat at `processing`, the reaper reclaimed it after its
  lease (`1 abandoned claim(s) recovered`), republished it, and a fresh worker consumed and
  finished it. The `queued` lease also cycled correctly while no consumer existed.
- **`ENABLE_KAFKA=false`.** Single API process, in-process bus, backlog drained, and consumer-group
  lag on the broker confirmed untouched at 0.

**A verification run that had to be redone.** `pkill` does not exist in Git Bash on this machine,
so several "stopped" processes were still running and an early flag-off result was served by
whichever API held port 4000. Both affected runs were repeated after confirming zero listeners.
Worth remembering: on this machine, stop processes with PowerShell `Stop-Process` and verify the
port is free before trusting a result.

## Worth revisiting

- **Publish-on-save is not implemented.** The reaper is the only producer, as decided. Latency is
  a sweep interval (2s) worst case, and the save nudge usually beats that. Add it when the latency
  is actually felt, keeping the reaper behind it.
- **Nothing consumes `metadata.extracted` or `link.processing.failed`.** By design — Phase 5
  subscribes to the first without touching this code.
- **The worker process has no health endpoint.** Fine for development; needed before Phase 9 if
  anything is going to supervise it.
- **`link.processing.failed` is published only for terminal failures**, so a link that eventually
  succeeds after retries never emits one. That is intended, but it means the topic is not a
  complete record of every failed attempt.

## Still open

1. **Vector search in local dev** — before Phase 6. Atlas Local container, or a real Atlas cluster.
2. **Where Kafka runs in production** — Phase 9, with real costs. Managed or self-hosted.
3. **Automatic collection allocation** — deferred until Phase 5's auto-tags exist and can be judged
   against. Reasoning in the Phase 4 plan, §12.
