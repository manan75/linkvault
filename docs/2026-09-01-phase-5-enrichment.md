# Phase 5: summary and tag generation (2026-09-01)

What shipped, what changed from the plan, and what the real-API run actually showed.
[The plan](./2026-09-01-phase-5-plan.md) holds the reasoning; this holds the outcome.

---

## 1. The model in the plan does not exist

`gpt-5.6-luna` is not a real model, and neither are the `terra` and `sol` siblings the plan's §2
cost table names. The whole table was invented. This was caught by listing the account's actual
models before writing any code, which is the only reason it did not become a 404 at step 2.

**Recorded as a lesson, not as an aside: a model name is exactly the kind of fact that reads as
authoritative in a planning document and is worthless unless it was checked against the API.**
Everything else in §2 — Responses API over Chat Completions, `zodTextFormat`, the zod peer bump,
`reasoning.effort`, no `temperature` — was verified and held up.

**Decided: `gpt-5-mini`,** the default for `OPENAI_MODEL`. The user asked for a cheap model for
development, so `gpt-5-nano` was tried first and rejected on measured behaviour rather than taste:

| Model | Input / output per 1M | Per 1,000 links | Result on the §3 probe |
| --- | --- | --- | --- |
| `gpt-5-nano` | $0.05 / $0.40 | ~$0.12 | Returned `postgresql, performance, frontend` for a Redis/Postgres caching article — reused an unrelated vocabulary tag and missed `redis` and `caching` entirely |
| **`gpt-5-mini`** | **$0.25 / $2.00** | **~$0.60** | Returned `postgresql, performance, redis, caching` — reused the two that fit, added the two that were missing, dropped `frontend` |

Nano failing exactly the judgment §3 is built on is disqualifying: constrained generation is the
entire tag-consistency strategy, and a model that reuses a vocabulary tag because it is *nearby*
rather than because it *fits* is the embedding-similarity failure the plan rejected, reintroduced
by the back door. `gpt-5-mini` is still roughly seven times cheaper than the Sonnet option the plan
originally carried, and one env var away from `gpt-5.2` if quality ever needs it.

Two other API facts worth recording, both verified rather than assumed:

- **`reasoning.effort` is GPT-5-family only.** `gpt-4.1-mini` returns
  `400 Unsupported parameter: 'reasoning.effort'`. Since `OPENAI_MODEL` is deliberately free-form,
  the request adapts to the model rather than assuming one.
- **The SDK's own request timeout raises `APIConnectionTimeoutError`**, which sits under
  `APIConnectionError` under `APIError` — so the most-specific-first ordering in `classify` is what
  makes a timeout retryable. See §3 below for why this mattered.

## 2. The key was in `.env` as `OPEN_API_KEY`

A typo, and the failure it produces is silent: `env.js` sees no `OPENAI_API_KEY`, `ENABLE_ENRICHMENT`
resolves to false, and every link arrives `ready` with no summary. Renamed.

The startup line the plan asked for exists precisely for this, and it is worth its space:

```
Enrichment disabled: no OPENAI_API_KEY set — links will have no summary or auto-tags
```

## 3. Two design changes made while building

**The call's deadline lives in the service, not the worker.** The worker first wrapped the provider
call in `withDeadline`, matching the reaper. That was wrong, and wrong in a specific way the project
has already been bitten by: `withDeadline` rejects with a plain `Error`, so `failEnrichment` would
classify a timeout as **permanent** — Phase 4's third bug, reintroduced verbatim. It also leaves the
request running and still billable. The timeout is now the SDK's own request option, which cancels
the call and raises a typed, correctly-retryable error.

**`EnrichmentError` lives in its own module.** With it exported from `services/enrichment.js`, the
import chain `reaper → enrichmentQueue → enrichment.js → openai` pulled the whole SDK into the API
process, which never makes a model call. Splitting the error class out keeps `enrichment.js` the
only file that imports the SDK — which is the containment §7 of the plan is built on.

## 4. The enrichment sweep needs a grace period

Not in the plan, and it would have been a real annoyance. The metadata worker publishes
`metadata.extracted` itself, and the reaper's new sweep republishes it for anything still awaiting
enrichment. Without a delay the reaper races that live message on its very next 2-second sweep and
publishes a duplicate for **every link in the system** — harmless, because the claim is idempotent,
but pure noise on every topic and in every log.

`ENRICHMENT_QUEUE_GRACE_MS` (90s, measured from `processedAt`) makes the sweep what it is meant to
be: a recovery mechanism that acts only once the live path has visibly not worked.

Related, and also not in the plan: the reaper's enrichment sweep is **off when enrichment is off.**
With no key there is no consumer, so republishing would cycle every link in the library through the
queued lease and back, forever.

## 5. What shipped

Backend:

- **`services/enrichment.js`** — prompt, structured output via `responses.parse` + `zodTextFormat`,
  typed-error classification, request timeout. The only file importing the OpenAI SDK.
- **`services/enrichmentError.js`** — the error class, so the queue can read `retryable` without
  the SDK.
- **`utils/tags.js`** — normalisation, the case-insensitive vocabulary snap, and order-preserving
  merge. Pure, and fully tested.
- **`workers/enrichmentQueue.js`** — claim, lease, attempts, terminal states, mirroring
  `linkQueue.js`.
- **`workers/enrichmentWorker.js`** — consumes `metadata.extracted`, publishes `link.enriched`.
- **`link.enriched`** added to `topics.js`; it now has a producer, and Phase 6 gets a seam it can
  subscribe to without touching this worker.
- The reaper extended for both the enrichment sweep and its stale leases.
- `Link` gained `autoTags`, `tagsEditedByUser`, `enrichmentStatus` and its bookkeeping fields. All
  additive; `tags` keeps its type, so every index and `$all` filter kept working with no migration.
- `PATCH /api/links/tags/:name` — rename, which **is** the merge.
- `tagsEditedByUser` set from `PATCH /api/links/:id`, on `isModified('tags')` rather than on the
  field being present — re-submitting an unchanged edit form must not silently opt a link out of
  future auto-tagging.

Frontend: the summary shows on the card in preference to the description; auto-tags render with a
dashed outline while the user has not curated that link; the tag sidebar has an inline rename;
polling continues while enrichment is in flight.

**195 tests pass**, up from 146. `client` builds clean.

## 6. The real-API run — and the one honest disappointment

Run twice: once against an in-process MongoDB with real page fetches and the real provider, then
end to end through **real Kafka with the API and worker in separate processes**.

What worked:

- **Vocabulary reuse across links is real.** Two Redis pages saved in sequence ended up sharing
  `redis` and `client-libraries` rather than inventing a second spelling. This is the core §3 bet
  and it paid off.
- **Idempotency verified against real usage, not a mock.** Redelivering every event after the run
  left the provider call count unchanged at 5.
- **A PDF was `skipped`, not failed** — nothing to parse, so nothing to send, and nothing billed.
- **A forced provider failure left the bookmark `ready`** and perfectly usable, which is §8.
- Rename/merge through the API: `nodejs` → `javascript` reported `merged: true` and the vocabulary
  collapsed correctly.

**What did not work, and it is the thing the plan predicted:** three of four pages produced **no
summary at all**, because they carry no `og:description` and §4 restricts the model to title and
description. The model behaved correctly — it was told never to invent, and it did not — but
"correctly refuses" and "useful" are different things. Tags were good in every one of those cases,
exactly as §4 predicted they would be.

**This makes the plan's §14 revisit item the real finding of the phase, not a hypothetical.** The
fix is the one §4 already scoped: capture a cleaned excerpt in the metadata worker, which is a
change to `buildEnrichmentInput` plus one schema field. Worth doing before Phase 6, because Phase 6
embeds this text and a bookmark whose only content is its title embeds badly.

Minor and not worth acting on yet: the model occasionally reaches for a source rather than a topic
(`wikipedia`) or something generic (`patterns`, `development`). Tag rename exists for exactly this.

## 7. Still open

Unchanged from the plan, plus one:

1. **Vector search in local dev** — the next thing due, before Phase 6. Atlas Local container, or a
   real Atlas cluster for dev.
2. **Where Kafka runs in production** — Phase 9.
3. **Where enrichment runs in production, and what it costs per user** — informs Phase 7's rate
   limiting.
4. **New: whether to capture a page excerpt**, per §6 above. This is now evidence-backed rather
   than speculative.
