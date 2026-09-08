# Phase 6 — search that works, and search that understands (2026-09-06)

Two things shipped in one session because they turned out to be one thing. The session
opened with *"search is bad, even searching just prefix isn't filtering out the correct
links, let alone normal word matching"* and *"let's start with Phase 6"*. The
[previous note](./2026-09-04-next-steps.md) had already argued those were the same
decision; measuring the search before touching it made that concrete, and worse than
recorded.

---

## 1. What was actually wrong with search

The previous note found one defect. There were three, and the first is the one that was
being felt daily.

Measured against a six-document corpus through the real code path, before any change:

```
"reac"   -> 0 hits      "kafk"  -> 0      "postg" -> 0      "javas" -> 0
"thro"   -> 0 hits      "SQL"   -> 0      "once"  -> 0

"redi"   -> 1 hit   ← works only by accident
"cach"   -> 1 hit   ← same

"redis react"           -> 2 hits (both)
"kafka react postgres"  -> 3 hits (all of them)
```

**1. No prefix matching.** `$text` matches whole words *after stemming*. Typing into a
live search box therefore showed nothing at all until the final character of a word
landed. `redi` and `cach` appearing to work is a coincidence: the English snowball
stemmer maps `redis → redi` and `caching → cach`, so a few prefixes collide with a stem
by luck. That is exactly why the failure read as intermittent and unpredictable rather
than total — it *was* unpredictable, because an invisible transformation was rewriting
both sides of the comparison.

**2. Multi-word queries are OR, not AND.** Adding a word made the result set **larger**.
That is precisely the reported "isn't filtering out the correct links".

**3. Stopwords and compound tokens vanish.** `once` and `the` are stopwords and match
nothing. `SQL` matches nothing because `PostgreSQL` is a single token.

None of this is tunable. `$text` has no prefix operator and no AND. The keyword half had
to be replaced, and since the hybrid search keeps a keyword half, that replacement is
step one of Phase 6 rather than separate work.

Plus the efficiency finding the previous note already had: the text index had no `userId`
prefix, so every search read every matching link belonging to every user and discarded
the rest — 4,040 documents examined to return 20, twice per request because `listLinks`
also runs `countDocuments`.

---

## 2. What replaced it

**Materialised tokens.** `searchTokens` on the document, rebuilt by a `pre('save')` hook
from title, tags, summary, description, author, domain and URL path. Matching is one
anchored-prefix clause per term over a multikey index prefixed by `userId`.

- Prefix matching from the first keystroke.
- Every term must match, so adding words narrows.
- Compound words are split at the camel-case boundary *and* kept whole, so `PostgreSQL`
  is findable as `postgresql`, `postgre` and `sql`.
- No stemming. Prefix matching already covers the common English suffix, and the stemmer
  was what made the old behaviour unpredictable.
- No stopword list. Under AND semantics a stopword can only narrow, and silently dropping
  a word the user typed is a worse surprise than matching it.

After, on the same corpus:

```
"r" -> 4    "re" -> 2    "rea" -> 1    "reac" -> 1    "react" -> 1
"kafk" -> 1   "postg" -> 1   "javas" -> 1   "SQL" -> 1   "once" -> 1
"react server" -> 1     (was ambiguous)
"kafka react postgres" -> 3, flagged RELAXED
```

Index behaviour for `^reac`: **1 returned, 2 keys examined, 1 document examined.**

**The relaxed pass.** Requiring every term is right for a search box and wrong for a
sentence. "how do I make my backend faster" has no document containing all six words, and
returning nothing there reads as broken rather than strict. So the strict pass runs
first, and only if it finds nothing does a looser pass run — and the response says
`search.relaxed: true` so the UI can tell the user rather than quietly showing different
results. Terms shorter than three characters are dropped from the *loose* pass only:
ORing `a` and `do` matched the entire corpus, measured.

---

## 3. Phase 6: the embedding pipeline

### The runtime decision

`CLAUDE.md` names Sentence Transformers and a Python service. The session chose the
hosted OpenAI embeddings API instead, and the argument is recorded at the top of
`server/src/services/embedding.js` per the Important Rule. Briefly:

| Option | Why not |
| --- | --- |
| Python + FastAPI + Sentence Transformers | Render free tier is 750 instance-hours against a 730-hour month: **exactly one always-warm service**, and the API already is it. A second one costs money or cold-starts at 50s. |
| `transformers.js` in the Node worker | Genuinely the same model family and free forever, but onnxruntime plus weights is ~250-350MB resident on a 512MB instance already running the API and three workers. An OOM would only appear in production. |
| **OpenAI `text-embedding-3-small`** | The SDK, the key and the spending-ceiling machinery are already here. This stage is the enrichment stage with a different call in the middle. |

Cost: about **$0.00002 per bookmark**. The whole 100-link per-user cap is a fifth of a
cent. The honest cost of the choice is that semantic search now needs a network call to
embed the query, and cannot run while the provider is down — which is why the search
degrades to keywords and says so rather than failing.

`EMBEDDING_DIMENSIONS=512`, shortened from the model's native 1536. `text-embedding-3-*`
is trained so a prefix of the vector is itself usable, so this trades a little accuracy
for three quarters of the storage — and on a free Atlas tier storage, not accuracy, is
the scarce thing (10,000 links at 1536 dimensions is ~120MB of BSON doubles against a
512MB cap).

### The pipeline

`link.enriched` was published into an empty topic from the moment Phase 5 shipped,
specifically so a consumer could be added later without reopening that worker. **The seam
held.** The enrichment worker was not touched.

```
link.enriched ──► embedding worker ──► MongoDB (embedding) ──► embedding.created
```

Same lease, same three-attempt ladder, same daily-ceiling machinery, and a third stage in
the reaper's sweep for links no live message reached — which is also how links that never
reach enrichment at all (no key, nothing to summarise, a failed call) still get embedded.

**Two cost controls, not one.** The claim stops a redelivered event, as before. A
*fingerprint* of the input text and the model stops paying for a vector identical to one
already stored — which matters because the save hook returns a link to `pending` whenever
a searchable field is rewritten, and enrichment writing the same summary twice is
ordinary. The model name is part of the fingerprint, so changing `EMBEDDING_MODEL` or
`EMBEDDING_DIMENSIONS` invalidates the corpus automatically rather than silently mixing
vectors from two unrelated spaces.

**Embedding is the one stage that returns to `pending` during ordinary life.** Editing a
title or writing a summary changes what a link means. The link keeps its existing vector
and stays fully searchable until the new one lands, so there is no `stale` state — there
would be nothing different to do about it.

### `capture.text` finally gets read

It has been stored, `select: false`, and unread since the extension shipped. This is what
it was stored for. Three of four Phase 5 verification pages had no `og:description` and
so got no summary; for those links the captured page text is the only description of the
page that exists anywhere in the system. Capped at 2,000 characters — a vector averaged
over ten thousand words of navigation and footer says less about a page than one built
from its opening.

---

## 4. Hybrid search

Both halves run concurrently and are fused by **reciprocal rank**, not by score: a
weighted term count and a cosine similarity are not comparable in any units, and RRF
needs no calibration. Keyword is weighted 1.0 and semantic 0.8, because most searches are
someone typing part of a title and being wrong about those is more annoying than being
wrong about a paraphrase.

**A similarity floor (`0.3`) is what gives semantic search a notion of "no results".**
Every vector has *some* similarity to every other, so without it a nonsense query returns
the entire vault in a confident-looking order. **This number is a starting point, not a
measurement** — see §6.

**Vector storage is a brute-force cosine scan in Node**, behind `services/vectorSearch.js`
so it can be swapped. Atlas `$vectorSearch` was not adopted because it is an Atlas-only
aggregation stage: it does not exist in `mongodb-memory-server` or the local Docker
Mongo, so using it would mean the 315-test suite could no longer test search and local
development could not run it. At 100 links per user that is a steep price for latency
nobody has measured a problem with. The thing that changes the answer is **memory, not
time** — the scan reads candidate vectors into the process, and ~10,000 links is where an
index earns its keep.

---

## 5. What is verified, and what is not

**Verified, through the real code path:**

- 315 server tests pass (was 273; 42 added). The client builds.
- The keyword measurements in §1 and §2, run against a real Mongo before and after.
- The index is used: `^reac` examines 2 keys and 1 document to return 1.
- The full pipeline end to end on an in-memory bus: reaper claims → publishes
  `link.enriched` → worker embeds → four links at `done` with 512-dimension vectors →
  `embedding.created` published.
- Fusion, the similarity floor, the degradation path, ownership scoping, the fingerprint
  skip, the budget deferral, both lease recoveries.
- The OpenAI request and response shapes against the installed SDK's own types:
  `dimensions` is a supported parameter, `response.data[0].embedding` is `Array<number>`.

**Not verified, and this is the honest gap:**

- **No real embedding has ever been generated.** Every test uses an injected fake. The
  suite says nothing about embedding *quality*, and it cannot: a real call costs money
  and needs a key. What is tested is the pipeline around the call.
- **`MIN_SIMILARITY = 0.3` is a guess** in the right neighbourhood for
  `text-embedding-3-small`, not a measurement. Too low shows strangers; too high loses
  the paraphrase the feature exists for. **This is the first thing to tune against a real
  vault**, and the way to tune it is to log the similarity scores of a few searches whose
  right answer is known.
- **`SEMANTIC_WEIGHT = 0.8` is likewise a starting point.**

---

## 6. Deploying this

1. **Set the new environment variables on Render.** `EMBEDDING_MODEL`,
   `EMBEDDING_DIMENSIONS`, `ENABLE_EMBEDDINGS`, `EMBEDDING_DAILY_LIMIT` — all have
   working defaults, so strictly none are required, but `EMBEDDING_DIMENSIONS` should be
   set explicitly because changing it later re-embeds the whole corpus.
2. **Run the reindex once, after the new code is live:**
   `MONGODB_URI='...' npm --prefix server run reindex`. It backfills `searchTokens` on
   existing links and drops the old `link_keyword_search` text index. Safe to run twice.
   **Search will return nothing for existing links until this runs** — the tokens do not
   exist yet.
3. **Embeddings need no migration.** The claim filters match a missing `embeddingStatus`
   as well as an explicit `pending` one, so the reaper picks up the existing library on
   its own, two minutes at a time.
4. **Watch the first sweep.** At a 2-second interval and one link per batch slot, a
   100-link library embeds in well under a minute and costs about a fifth of a cent.

The new index is deliberately named `link_keyword_prefix` rather than reusing
`link_keyword_search`. An index name is unique per collection and `autoIndex` creates
missing indexes but never drops a conflicting one, so reusing the name would have made
every existing deployment fail to start with `IndexOptionsConflict`.

---

## 7. Carried forward

Unchanged from the [previous note](./2026-09-04-next-steps.md) unless marked.

- **The extension is still not submitted.** Still $5, a zip, screenshots and a privacy
  policy URL, all in dashboards. Review is wall-clock time that overlaps with everything
  else, which is why it should go first next session.
- **The cron ping on `/api/health` is still not set up.** Fifth session. `/api/health`,
  never `/health/deep`.
- **Two MVP filters are still built on the server and unreachable from the client** —
  `domain` and `savedAfter`/`savedBefore`. `CLAUDE.md` lists both under MVP. The
  expensive half is done; `EMPTY_FILTERS` and `FilterBar` are what is missing.
  Deliberately not done this session: it is not search, and folding it in would have made
  one commit two.
- **`client/.env.example` still carries an uncommitted line that looks like a password.**
- **The `OPENAI_API_KEY` exposed on 2026-09-03 is still of unknown rotation status.** It
  now guards embeddings as well as enrichment, so the blast radius grew.
- **`MAX_LINKS_PER_USER` is 100.**
- **Whether YouTube's oEmbed endpoint answers from Render's address is still unverified.**
  Fourth session carrying this.
- **New:** search result highlighting still does not exist. With prefix-AND matching the
  connection between query and result is much more obvious than it was under stemmed OR,
  so this is less pressing than the previous note made it — but it is not nothing.

---

## 8. After the fact — the migration, and the half of prefix matching that was missing (2026-09-08)

**The reindex ran.** Against the live Atlas database: `link_keyword_search` dropped, four
links rewritten. Step 2 of §6 is done, and the note there about existing links returning
nothing no longer applies to this deployment.

It also confirmed the shape of the complaint that prompted this. The vault held 15 links
and **13 of them had no `searchTokens` at all** — everything saved before the field
existed. The links saved after the deploy carried tokens and were perfectly findable; the
older ones could not be found by anything. That is the migration doing exactly what it
was written for, not a defect in the matching.

**But measuring it turned up a real one.** Prefix matching only runs in one direction: a
document token has to begin with what was typed. Typing *less* than the page says has
always worked, and typing *more* silently found nothing. Against a real bookmark whose
summary read "Listing of open roles":

```
"listing"  -> 1 hit
"listings" -> 0 hits
```

Typing a plural where the page used a singular is an ordinary thing to do, and an empty
result there is indistinguishable from the bug this phase existed to fix.

The fix reduces the **query** to a stem and matches the stem as the prefix. No second
clause is needed, because a stem is already a prefix of the word it came from: `^listing`
matches the token `listing` and the token `listings` both, and it is still one literal
anchored prefix, so it is still one index seek.

Three things about it are deliberate:

- **Query-side only.** The document side stays literal, so what is stored is still exactly
  what was written. Rewriting *both* sides invisibly is what made `$text` unpredictable,
  and this note argues that at length in §1.
- **Not a stemmer.** A short list of English inflections (`ies`, `ing`, `ers`, `es`, `ed`,
  `er`, `s`), the most aggressive one that applies, and nothing that maps a word to
  something no reader would recognise.
- **A four-character floor on the stem, which is the whole safety of it.** Stripping
  widens. Unbounded, `cars` becomes `car` and finds `careers`; `tags` becomes `tag` and
  finds `target`. The floor keeps the genuine inflections and rejects the short words
  where the stem carries too little to be worth the noise.

`scoreKeyword` applies the same reduction, because the filter and the scorer have to
agree — a link matched on a term the scorer did not recognise would score zero against
the very word that found it and sink to the bottom of its own results. Both stem and
typed form count as whole-word matches, so shortening the match cannot cost a link its
exact-match ranking.
