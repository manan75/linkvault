# Deploy v1 is live, and what the internet said back (2026-09-03)

The provisioning half of [the deploy v1 handover](./2026-09-02-deploy-v1.md) is done. The app is
reachable, registration and saving work end to end, and the first real links have been through the
pipeline.

This note records what the dashboards actually needed (several things the handover did not say), the
production findings that no local run could have produced, the one code change made in response, and
what the next session should pick up.

Scope: steps 7, 8 and 10 of the deployment plan's order of work. Step 5 of the handover checklist --
the cron ping -- is **still outstanding**.

---

## 1. It is live

| Piece | Where |
| --- | --- |
| API | `https://linkvault-api-uenh.onrender.com` |
| Client | `https://linkvault-livid-two.vercel.app` |
| Database | Atlas M0, network access `0.0.0.0/0`, user scoped to `linkvault` |

Verified in Chrome: register, log in, save a link, watch it move through `pending` to a terminal
state. The cross-site cookie arrives as `HttpOnly; Secure; SameSite=None` and CORS echoes the exact
Vercel origin with `credentials: true` -- the two things section 1 of the deploy note made
load-bearing, both confirmed against a real browser rather than a smoke test.

## 2. Six things the provisioning needed that the handover did not say

Each of these cost real time. They are listed because the next deployment of anything in this project
will hit the same class of problem.

**The Atlas connection string has no database name in it.** The string the Atlas dashboard hands you
ends at the host: `...mongodb.net/`. `connectDatabase` passes no `dbName` (`server/src/config/db.js:8`),
so Mongoose falls back to a database literally called `test` -- and a user scoped to `linkvault` may
not even have rights to it. The URI needs `/linkvault` appended by hand. **This fails silently in the
worst way**: it connects, it works, and the data is in the wrong place.

**Do not set `PORT` on Render.** Render injects it. Setting it by hand makes the health check fail.

**`CLIENT_ORIGIN` must parse as a URL even when it is a placeholder.** The schema validates it with
zod's `.url()` (`server/src/config/env.js:14`), so the API refuses to boot on `TBD` or an empty
string. The ordering trap in the handover -- each side needs the other's URL -- therefore requires a
*plausible* placeholder, not a blank.

**`VITE_API_BASE` must include `/api`, and it is baked in at build time.** Set without the suffix,
every request went to `/auth/me` and returned 404 with otherwise perfect CORS headers, which reads
like an auth failure and is not one. Because Vite inlines `import.meta.env` into the bundle
(`client/src/lib/api.js:18`), correcting the variable changes nothing until a **rebuild** -- a restart
or a cache-reused redeploy still serves the old value compiled into the JavaScript.

**Do not mark `VITE_API_BASE` as a Vercel "Secret".** Vercel's newer environment UI offers Secret
(write-only) and Config. A `VITE_`-prefixed value is compiled into a bundle any visitor can read, so
there is nothing to protect, and write-only means it cannot be read back to check or edited to fix --
which matters precisely because the first value was wrong. Use Config. The genuinely secret values in
this project (`JWT_SECRET`, `MONGODB_URI`, `OPENAI_API_KEY`) all live on Render and never touch
Vercel.

**Vercel rejects unknown keys in `vercel.json`.** The file carried a `comment` property inside the
rewrite explaining why there is no `/api` rewrite; Vercel's schema validation refused the deploy
outright. JSON has no comment syntax to fall back on, so the rationale moved into section 5 of the
deploy note. Fixed in `18b5393`.

## 3. The real finding: the network origin changes what the internet returns

**YouTube links worked in development and fail in production, with identical code.**

Probed directly, using the same request `safeFetch` makes:

| Target | From a residential IP | From Render |
| --- | --- | --- |
| `youtube.com/watch?v=...` | **200**, 1,365KB | **429** |
| `leetcode.com/problems/two-sum/` | **403** | **403** |
| `instagram.com/...` | fast | fast (login wall) |

**YouTube rate-limits datacenter egress**, and Render free instances share outbound IPs across
tenants -- so the 429 is partly earned by other people's traffic, and no request rate of yours would
lower it. **LeetCode returns 403 to everything**: tested with `LinkVaultBot/0.1` *and* with a real
Chrome User-Agent, both refused. That is Cloudflare matching on TLS fingerprint and IP reputation,
not on the User-Agent string, so changing the bot's identity would neither help nor be honest.

Two measurements taken while chasing this, worth keeping because they rule things out:

- The YouTube watch page is **1.3MB uncompressed** -- `Accept-Encoding: identity` is deliberate
  (`safeFetch.js:190`), because a size cap cannot mean anything against a compressed stream.
- `cheerio.load()` on that document is **115ms on a full-speed core**, so roughly a second at
  Render's 0.1 CPU. Real, but not the bottleneck. The 429 is.

**This extends the running theme of Phases 3, 4 and 5 with a new variant.** The theme has been that
unit tests keep passing while the real dependency misbehaves. The new variant is sharper: *the same
code, making the same request to the same URL, gets a different answer because of where it is calling
from.* Nothing runnable on the development machine could have found this. Deploying early was
justified on exactly this argument, and this is the argument collecting.

**A logging note that looks like a bug and is not.** One link produced five `[metadata] ... 429` lines
while `MAX_ATTEMPTS` is 3. `retryProcessing` resets `processingAttempts` to 0 (`linkService.js:147`)
because a manual retry is a fresh decision by the user, not a continuation of the automatic ladder.
Three automatic attempts plus a clicked "Try again" is five. Working as designed, and worth knowing
before reading production logs.

## 4. What shipped in response

`3e5ee8b` -- **unfetchable links are named from their URL instead of their domain.**

The card previously showed `link.domain` when extraction failed, which the metadata line directly
beneath it already displayed. So every blocked leetcode.com bookmark looked identical and named
nothing -- the failure mode the product exists to prevent.

`client/src/lib/titleFromUrl.js` reads the path instead. Verified against real URL shapes:

```
Two Sum                     leetcode.com/problems/two-sum/
Bloom Filter                en.wikipedia.org/wiki/Bloom_filter
How to Use Redis Caching    .../blog/2026/03/how-to-use-redis-caching.html
Top 10 Databases            example.com/top-10-databases

falls back to the URL:      youtube.com/watch?v=dQw4w9WgXcQ
falls back to the URL:      twitter.com/someone/status/1234567890123
falls back to the URL:      instagram.com/p/C8xYz1AbCdE
```

Three decisions in it:

- **It is display-only and is never written back.** `completeLink` fills a field only when it is still
  empty (`linkQueue.js:117`), so a guess stored as `title` would permanently block the real one: a
  later retry would fetch the page successfully, find the title occupied, and keep the guess.
- **A generic path segment ends the walk.** `watch`, `status`, `p`, `item` signal that what follows is
  an identifier and what precedes is a container. Without that rule `/someone/status/1234567890123`
  becomes "Someone" -- the author's handle presented as the article's name, which is wrong and
  duplicates a field that already exists.
- **The final fallback is the URL without its scheme, never the bare domain.** The domain is already
  on the line below; repeating it spends a line to say nothing.

## 5. What the next session should do

### Fixes, roughly in order of value

1. **The cron ping on `/api/health` every 10 minutes.** Still not done, and it is step 5 of the
   handover checklist. Render free spins down after ~15 idle minutes and takes ~50 seconds to wake,
   which sits in front of every other latency complaint and makes them hard to reason about. Free, and
   the instance-hour budget covers exactly one always-warm service (deployment plan, section 8).
2. **An oEmbed path for providers that publish one.** Measured during this session:
   `youtube.com/oembed?url=...&format=json` returns **868 bytes of JSON** carrying `title`,
   `author_name` and `thumbnail_url` -- three of the five fields `FIELDS_FROM_PAGE` wants, against
   1.3MB of HTML that currently returns 429. Vimeo, SoundCloud, Spotify and Flickr expose the same
   shape, so one provider table generalises. It belongs as a pre-step in `metadataWorker.runOne`
   before `fetchPage`; unknown domains keep the existing path untouched. **Caveat: it was tested from
   a residential IP.** It is the same `youtube.com` host and may throttle datacenter traffic too --
   which, given section 3, is exactly the kind of assumption this project keeps being punished for.
   Deploying is the only test that counts.
3. **Decide what a 429 means for a permanently blocked domain.** It is classified retryable
   (`safeFetch.js:213`), which is right in general and wrong here: the ladder spends 2.5 minutes
   (0s, 30s, 120s) reaching a conclusion that was fixed at the first response.
4. **Accept gzip in `safeFetch`.** Inflate through a `zlib` stream and enforce the byte cap on the
   *decompressed* bytes as they arrive -- this keeps the guarantee `Accept-Encoding: identity` exists
   to protect, and cuts a page like YouTube's from 1.3MB to roughly 250KB on the wire.
5. **Reconsider the 8-second fetch deadline.** It covers DNS, TLS, transfer and redirects together
   (`safeFetch.js:161`) and was chosen against a full CPU, not against 0.1 of one.
6. **Confirm enrichment is actually running in production.** Unverified as of this note. The
   `DailyUsage` documents keyed `enrichment:<YYYY-MM-DD>` are the record to read, and they also begin
   answering open question 5 -- what enrichment costs per user at real volume.

### Toward the extension

The user's stated direction is the Chrome extension. The plan defers the extension itself until after
Phase 6 (deployment plan, section 1), and that reasoning still holds for **omnibox search**, which
cannot exist before semantic search does. Two pieces do not depend on Phase 6 and are the right things
to build next:

1. **The Bearer-token auth path.** Already the sanctioned early piece (plan sections 1 and 10):
   `POST /api/auth/tokens` issues a long-lived opaque token, the hash is stored and never the token,
   and `requireAuth` accepts `Authorization: Bearer` **in addition to** the existing cookie so the web
   app is untouched. Small, self-contained, and it unblocks the extension, a mobile client and
   scripted access. It is also the eventual answer to open question 7, Safari.

2. **Page capture -- and section 3 has just strengthened the case for pulling it forward.** The plan
   justified capture on paywalls, logins and JavaScript-rendered pages. Production has now added a
   fourth and larger category: **sites that refuse this server specifically because of where it is
   calling from.** The extension holds the rendered DOM of the page the user is already looking at,
   from the user's own IP and session -- so YouTube's 429 and LeetCode's 403 simply stop applying. No
   server-side technique reaches those pages; this one does. It also remains the evidence-backed
   answer to open question 3, the cleaned page excerpt that Phase 5 showed enrichment needs.

   The known consequence to handle first: `express.json({ limit: '100kb' })` (`server/src/app.js:36`)
   blocks a capture payload, and the fix is a per-route limit on `POST /api/links` rather than a global
   increase. The other three consequences -- the trust boundary, bounded storage, and duplicate saves
   becoming routine -- are written up in plan section 10 and unchanged.

A defensible order, then: **Bearer token, extension skeleton with capture, then Phase 6, then
omnibox.** Capture before Phase 6 is a deviation from the plan's ordering and deserves the `CLAUDE.md`
Important Rule treatment when it is proposed -- but the argument for it is now evidence, not
speculation.

## 6. Housekeeping carried into the next session

- **The cron ping is not set up.** Repeated because it is the cheapest win on the list.
- **`JWT_SECRET` on Render is a freshly generated value.** The one in the local `.env` remains
  development-only, as `docs/README.md` has said since Phase 1.
- **The `OPENAI_API_KEY` was exposed in a chat transcript on 2026-09-03**, via an editor selection. It
  never reached git -- `.gitignore` covers `.env` -- and rotating it was suggested. **Whether it was
  rotated is unknown**; treat it as unrotated until confirmed.
- **LeetCode links are not recoverable by any server-side change.** No oEmbed, blocked at the TLS
  layer. Until capture exists, "Two Sum" derived from the URL is the best that link will ever show.

## 7. Open questions

Unchanged: the Phase 6 embedding runtime, vector search in local dev, the page excerpt, where Kafka
runs, enrichment cost at real volume, and when Safari stops being acceptable.

New, from this session:

1. **Whether oEmbed survives Render's IP.** Untestable from here; it is the same host that already
   returns 429 on a different path.
2. **Whether a shared datacenter IP is tolerable at all.** If enough popular domains throttle Render
   free, the answer is either capture (which sidesteps it entirely) or paid hosting with a dedicated
   egress IP. The deployment plan already names Fly.io as the first upgrade to buy; this is a second,
   independent reason to buy it.
3. **How many saved links this actually affects.** Two domains are known bad. The `processingError`
   strings on `failed` links are the record that would turn this from an impression into a number, and
   it decides how urgent the oEmbed and capture work really is.
