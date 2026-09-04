# What to do next — the three-way decision (2026-09-04)

Written at the end of the session that shipped the extension, to be talked through at the start of
the next one. The [extension note](./2026-09-04-extension.md) records what was built and how to put
it on the Chrome Web Store; this records **what to spend the next session on**, with the evidence
each option deserves rather than an impression.

The user named three candidates: **finish the extension deployment**, **fix v1** — search is "very
bad and inefficient", the UI "not very user friendly" — or **go to Phase 6**.

The short version: those three are less separable than they look, because *"search is bad" is two
different problems and one of them is Phase 6*.

---

## 1. Where things stand

Everything below is deployed and verified against the live services, not only tested.

| Commit | |
| --- | --- |
| `82c14b1` | Stop naming bookmarks after their own domain |
| `0d97e8f` | Keep auto-tags few and non-overlapping |
| `9327fbf` | Bearer tokens for clients that cannot hold a cookie |
| `bce965b` | Accept a page capture from the extension |
| `9f56297` | The Chrome extension, and where its token comes from |
| `9400184` | A deep health check, separate from the keep-warm ping |
| `e2bbc8f` | Accept compressed responses, capping the inflated bytes |
| `53bcf10` | Ask providers about a link before scraping them |

**273 server tests pass. The client builds.** Render and Vercel are both serving the new code —
confirmed by `/api/health/deep` returning `{"status":"ok","checks":{"database":{"ok":true}}}`, which
is simultaneously the deploy probe and the thing it was built to report.

Verified through the real code path, from a residential address:

```
youtube.com/watch?v=…              via oEmbed  1192ms   title + "Rick Astley" + thumbnail
youtu.be/…                         via oEmbed  1318ms   title + author + thumbnail
open.spotify.com/track/…           via oEmbed   328ms   title + thumbnail
soundcloud.com/…                   via oEmbed   753ms   title + author + thumbnail
en.wikipedia.org/wiki/Bloom_filter via page    1274ms   101KB on the wire, was 574KB
react.dev/learn                    via page    3450ms    43KB on the wire, was 259KB
```

**Still unverified, and it is the assumption this project keeps being punished for:** whether
YouTube's oEmbed endpoint answers from *Render's* address. Everything above was measured from a
home connection. If it is throttled the fallback runs and nothing is worse than before — but the
first thing next session should do is save a YouTube link in production and look.

---

## 2. "Search is bad" is two problems, and they do not live together

This is the finding that should shape the decision, so it comes first.

### 2a. Ranking and recall — this **is** Phase 6, and cannot be fixed in v1

`README.md` states the promise plainly: *"that article about making APIs faster using caching"*
should retrieve *"Redis Caching Strategies"* even when the exact words are absent. Measured against
a corpus containing exactly that document:

```
query                                                 hits
"that article about making APIs faster using caching"    1   ✔ Redis Caching Strategies
"speeding up an api with a cache"                        1   ✔ Redis Caching Strategies
"make my backend snappier"                               0   ✘
```

The first two work **only because the word "caching" or "cache" is literally in the document**;
Mongo's `$text` stems `caching` → `cach`, which is why the paraphrase still lands. Remove every
shared word — "make my backend snappier" — and it returns **nothing at all**.

That is not a tuning problem and no amount of index work fixes it. Describing a thing in your own
words and finding it is the entire product thesis, and it needs embeddings. **Any plan that treats
"make search good" as v1 polish is mis-scoped: it is Phase 6 wearing a different hat.**

### 2b. Efficiency — real, measured, and genuinely cheap

Separately and unrelatedly, the query is far more expensive than it should be. Explained plan for a
search returning 20 of my links from a collection holding 20 of mine and 2,000 belonging to someone
else:

```
returned                20
index keys examined  2,020
documents examined   4,040
```

**Every matching link belonging to every user is read, then discarded by the `userId` filter.** The
cause is one line in `models/Link.js`: the text index is declared as

```js
{ title: 'text', tags: 'text', description: 'text', summary: 'text', url: 'text' }
```

with **no `userId` prefix**, so Mongo cannot scope the scan to the owner and has to filter
afterwards. The cost is `O(every user's links)` per search. At 100 users with 500 links each, one
search reads 50,000 index keys, on an Atlas M0 that is shared and throttled. `listLinks` also runs
`countDocuments` on the same filter, so it pays this **twice per request**.

The fix is a compound text index — MongoDB permits a non-text prefix and requires an equality match
on it, which every query here already has:

```js
{ userId: 1, title: 'text', tags: 'text', description: 'text', summary: 'text', url: 'text' }
```

**One operational catch worth knowing before starting:** MongoDB allows only **one text index per
collection**, so this is a drop-and-recreate, not an add. Mongoose's `autoIndex` will not do it —
it creates missing indexes and never drops a conflicting one, so the new index will silently fail to
build and the old plan will keep being used. It needs a deliberate migration step against Atlas.

This is worth doing **whenever** it is done, because Phase 6's hybrid search keeps the keyword half.
It is not throwaway work.

### 2c. What this means for the decision

Fixing 2b makes search *cheaper*. Only Phase 6 makes it *good*. If the complaint that prompted this
is "I searched for something and did not find it", the answer is Phase 6 and no amount of v1 polish
will satisfy it.

---

## 3. "The UI is not user friendly" — one verifiable gap, and the rest is taste

I can only report what is checkable. Two concrete findings and an honest limit.

**Two MVP filters are built on the server and unreachable from the client.** `linkQuery.js` supports
`domain`, `savedAfter` and `savedBefore`; `EMPTY_FILTERS` in `client/src/hooks/useVault.js` does not
contain them, and `FilterBar` renders no control for either. `CLAUDE.md` lists *"Filters by tag,
collection, **date, domain**, read status, favorite status"* under MVP features. So this is not a
new feature — it is finishing one that is already half-built, and the expensive half is done.

**Search results say nothing about why they matched.** No highlighting, no matched-term indication.
With `$text` doing OR-with-stemming, a multi-word query can return things whose connection to what
was typed is invisible, which reads as "the search is bad" even when the ranking is defensible.

**What I cannot assess:** the rest. The search input is debounced at 250ms, sort and the
favourite/read toggles are wired, "Load more" paginates, and the appearance pass shipped in Phase 3.
Whether the result *feels* good is a judgement about this product for this user, and the next
session should start by having the user name two or three specific things that annoy them rather
than me inventing a list. **A UI complaint without examples is not actionable, and guessing at it is
how a session gets spent redesigning something that was fine.**

---

## 4. The extension deployment — mostly waiting, and mostly not mine

Full checklist in [the extension note](./2026-09-04-extension.md) §4. What matters for *sequencing*:

- The engineering is done. What remains is a **$5 registration, a zip, screenshots, a privacy
  policy URL, and permission justifications** — all of it in dashboards, all of it the user's to do.
- **Review takes hours to two weeks**, and a first submission from a new developer account is
  usually the slow end.
- That waiting is wall-clock time, not working time. **It overlaps with anything else.**

The one engineering-shaped thing left is to confirm capture works against the real blocked domains
*in production*: save a LeetCode problem and an Instagram reel from the extension and check the
titles arrive. That is half an hour, not a session.

---

## 5. Phase 6 — what it still needs decided before it can start

Unchanged and still open, from the [deployment plan](./2026-09-02-deployment-and-extension-plan.md)
§9:

1. **The embedding runtime.** A (Python + Sentence Transformers on a second Render free service),
   B (`transformers.js` in the existing Node worker), or C (a hosted embedding API). The instance-hour
   budget argues hard against A: 750 hours a month against a 730-hour month means **exactly one
   always-warm free service**, and the keep-warm cron spends it. Deciding B or C is a five-minute
   conversation and it unblocks the phase.
2. **Whether Atlas Vector Search is available on M0 at all**, and whether a vector index is warranted
   at this scale — ten thousand links at 384 dimensions is ~15MB and a brute-force cosine scan over
   that is single-digit milliseconds in Node.
3. **Whether `capture.text` becomes the embedding input.** It is already being stored, `select: false`,
   and nothing reads it. This is the Phase 5 finding — three of four verification pages had no
   `og:description` and so got no summary — finally getting its answer.

Phase 6 also has a dependency that just got cheaper: **better extraction is better embedding input**,
and oEmbed plus capture both landed this session.

---

## 6. Recommendation

Not a decision — the user asked to talk it through — but the argument as it stands:

**Submit the extension first, because review is waiting rather than working.** It costs one sitting
and then runs in the background for days regardless of what else happens. Not submitting it just
moves the same wait later.

**Then Phase 6, not v1 polish** — with the search index fix (2b) folded in as its first step, since
Phase 6's hybrid search needs that index anyway and it is a genuine measured problem rather than a
speculative one.

The reasoning is that *the strongest v1 complaint is not a v1 problem*. "Search is very bad" is
mostly 2a, and 2a is Phase 6. Spending a session on keyword-search polish would improve something
that is about to be replaced by a better mechanism, and would leave the actual complaint standing.

**The exception that would change this:** if the UI annoyances (§3) are hurting daily use, they win,
because a vault that is unpleasant to open does not get used, and an unused vault makes Phase 6
pointless — there is nothing to search. That is exactly why §3 needs the user to name specifics
before the session plans around it.

A defensible order, then: **submit the extension → the two MVP filters and the search index (a short
session) → Phase 6.**

---

## 7. Carried forward

- **The cron ping on `/api/health` is still not set up.** Fourth session. `/api/health` is the one to
  point it at — never `/health/deep`, which returns 503 by design and would make a platform health
  check restart the service during an Atlas blip. UptimeRobot or cron-job.org, every 5–10 minutes.
- **`client/.env.example` carries an uncommitted line that looks like a password** (`#PB8hWirdNQD7j9P`).
  It has never been committed. `.env.example` is a *tracked* file, so it is one `git add -A` from
  being public — rotate it if it is real.
- **The `OPENAI_API_KEY` exposed on 2026-09-03 is still of unknown rotation status.** Treat as
  unrotated until confirmed.
- **`MAX_LINKS_PER_USER` is 100.** The extension makes saving cheap enough to reach that much sooner.
- **`capture.text` is stored and unread.** `buildEnrichmentInput` is the one function that changes.
