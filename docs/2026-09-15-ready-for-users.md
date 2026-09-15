# Session A — making the front door work (2026-09-15)

The session opened with a status question — *are we done with Phase 6, is semantic search done,
what is next* — and turned into the first work aimed at people who are not the author.

The status answer, verified rather than read off the notes: **Phase 6 is done.** 318 tests passed
before this session's changes, production answered `/api/health/deep` with a connected database,
and the hybrid search described in the [Phase 6 note](./2026-09-06-phase-6-search.md) is live. By
phase number the project is through Phase 8 apart from hardening — Redis is deliberately absent
(the seam exists, `CLAUDE.md` warns against adding it for its own sake, and one process with no
search cache does not need it), and deployment happened out of order back on 2026-09-03.

So the blocker was never the phase list. It was that nothing had been built for a stranger.

---

## 1. What was actually in the way

Measured this session, not assumed:

| | |
| --- | --- |
| **Cold start** | `/api/health` answered in **23.2 seconds** from cold. The warm follow-up took 0.55s. |
| **`/` was behind `ProtectedRoute`** | Every signed-out visitor was redirected to a bare login form. Nothing on it said what LinkVault is. |
| **No feedback path** | None. Inviting people to give feedback with no way to give it. |
| **`CONTACT_EMAIL` empty** | The privacy page rendered a paragraph explaining that the contact was missing. |

The extension submission was **deliberately deferred** — it needs a $5 registration fee that is not
being spent right now. Everything below is independent of it.

---

## 2. The landing page, and the bug in the first version of it

`/` now resolves by who is asking: the vault for a signed-in user, a landing page for everyone
else. Keeping both on `/` rather than moving the dashboard to its own path means the URL people
bookmark does not change and `PublicOnlyRoute`'s redirect target stays correct.

The page leads with the search example from `CLAUDE.md` — the query *"that article about making
APIs faster using caching"* returning *"Redis Caching Strategies"*, which share no words. That is
the entire difference between this and a folder of bookmarks, and it is more convincing shown than
claimed.

**The first version of `HomeRoute` was wrong, and wrong in exactly the way the page existed to
fix.** It waited on `isLoading` before deciding what to render. `isLoading` is the session lookup,
the session lookup is an API call, and the API takes 23 seconds to wake — so a first-time visitor
would have watched a spinner for 23 seconds before being told what the product was. The landing
page would have made the first impression *worse*, by adding a page nobody got to see.

It cannot be fixed by reading the cookie, because the session is httpOnly and JavaScript
deliberately cannot see it. So `lib/session.js` records a **hint**: the fact that this browser once
held a session. A browser with no hint has nothing to wait for and gets the page immediately; a
returning user gets the spinner, which is correct — they asked for their vault, and flashing a
marketing page on the way would be worse than a moment of waiting.

Three things about the hint are deliberate:

- **It is not a credential.** It grants nothing and the server never sees it. Forging it buys an
  attacker a spinner.
- **Only a definite 401 clears it.** A network failure or a sleeping server proves nothing about
  whether a session exists, and forgetting it there would send a returning user to the landing page
  every time the API was briefly unreachable.
- **Storage failure reads as "no session".** A private window throws rather than returning null.
  The safe direction is showing the landing page for the moment the real check takes.

This matters more than the local timezone suggests. The keep-warm ping runs 06:00–02:00 IST, so the
cold window is 02:00–06:00 IST — which is **late afternoon and evening in the Americas**. The first
person outside India to click a shared link is the most likely to hit a cold start.

## 3. Feedback

`POST /api/feedback`, behind `requireAuth`, limited to 10 per 10 minutes per account. A popover in
the dashboard header with one text box.

The alternative was a `mailto:` link, which is free and collects almost nothing: feedback arrives
in the second someone is annoyed, and anything that interrupts that second to open a mail client
gets the two most motivated users and silence from everyone else.

- **The email is read from the account, never from the request.** `requireAuth` has already proved
  who is asking; letting the client name whose feedback this is would be pointless and forgeable.
  There is a test for it.
- **It is stored denormalised anyway.** These documents get read in the Atlas UI, where a bare
  `ObjectId` means a second lookup before the owner knows who to reply to. Capturing the address as
  it was when the message was written is also the more correct thing for feedback: it is who to
  answer about *this message*.
- **The limit is generous on purpose.** Somebody working through a list of annoyances is exactly
  the user worth hearing from; cutting them off at the third note would be self-inflicted. The
  limit is there so a stuck retry loop cannot fill the collection unattended.
- **A failed send leaves the typed text in the box.** Losing what someone wrote because the network
  blinked is how you stop hearing from them.

The privacy page now discloses that messages are stored, because it does not get to drift from what
the server does.

## 4. What is verified, and what is not

**Verified:**

- **327 server tests pass** (was 318; 9 added). The client builds and lints with only the two
  pre-existing warnings, neither in changed code.
- Production was probed live: 23.2s cold, 0.55s warm, database connected.
- Every new and changed module transforms through Vite without error, and the contact address is
  present in the production bundle.
- Feedback ownership, the spoofing refusal, both validation bounds, the 401, and the rate limit.
- **The deploy itself, against production.** `POST /api/feedback` answers
  `401 {"error":{"message":"Authentication required"}}` — before the deploy that path was a 404, so
  the status is a clean yes/no on whether the new server code is live. The Vercel bundle was checked
  by **content**: it contains the landing hero, the search demo, `linkvault.hasSession`, the
  feedback prompt and the contact address, and `VITE_API_BASE` is baked in correctly.

  The first attempt at that check compared the deployed bundle's **hash** against a local build, and
  that was the wrong probe. Vercel sets `VITE_API_BASE`, which is inlined at build time, so the same
  source produces different bytes and therefore a different content hash there than here. A hash
  match would have proved it; a mismatch proves nothing. Grep the deployed bundle for strings only
  the new code contains.

**Not verified — and this is the third consecutive note carrying it:** *none of this has been seen
in a browser.* Docker was not running, so there was no local Mongo for a dashboard, and no browser
tooling was available this session.

**It is now much cheaper than the previous two notes made it.** Everything is deployed, so the check
no longer needs Docker, a dev server, or a local database — a private window on
`https://linkvault-livid-two.vercel.app/` shows the landing page exactly as a stranger gets it, and
signing in shows the feedback popover against the real API. Fifteen seconds, no setup. **Do it
first next session.**

## 5. What the owner has to do

Code cannot do these.

1. ~~**Set up the keep-warm ping.**~~ **Done this session.** [cron-job.org](https://cron-job.org),
   free, no card. URL `https://linkvault-api-uenh.onrender.com/api/health` — the shallow one,
   **never** `/health/deep`, which hits the database on every run. Schedule
   `*/10 0-1,6-23 * * *` in `Asia/Kolkata`. GitHub Actions was considered and rejected: it delays
   scheduled workflows under load, sometimes past the 15-minute idle window that causes the
   spin-down it is meant to prevent.

   **Two things learned setting it up, both worth keeping.**

   The first test run failed with *"output too large"*, which is a confusing way for the platform
   to report a cold start. `/api/health` returns 15 bytes warm — measured, with headers — so that
   error cannot have come from the endpoint. While Render wakes, the request is answered by an HTML
   holding page instead, and it is that page which exceeds the limit. Waking the service by loading
   the site first made the same test pass.

   Which means **one failure notification every morning at 06:00 is expected and correct**. After
   the 02:00–06:00 quiet window the instance is asleep, so the first ping of the day gets the
   holding page and is recorded as failed — while still doing its job of waking the service, so
   06:10 succeeds. Turn failure notifications off for this job or learn to ignore that one. The
   original schedule omitted hour 23, which would have produced a second such failure at 00:00 and
   left 23:00–23:59 unpinged; `6-23` is deliberate.
2. ~~**Deploy.**~~ **Done this session.** `7ead6f5..f51d5fe` pushed to `main`; Vercel and Render
   both build from it and both were verified live, per section 4. No new environment variables —
   nothing added this session reads one.
3. **Correct the cron hours to `0-1,6-23`.** **Still open.** The job was created as
   `*/10 0-1,6-22 * * *`, which omits hour 23: the service sleeps around 23:15, 23:00–23:59 is
   unpinged at what is a perfectly ordinary hour to be reading, and the 00:00 ping then hits a cold
   instance and fails the same way the first test run did. One character.
4. **Check it in a browser**, per section 4.
5. **Watch the `feedbacks` collection in Atlas.** Newest first; the email is on the document.

Nothing here needs money.

## 6. Carried forward

Unchanged from the [privacy policy note](./2026-09-14-privacy-policy.md) except where marked.

- **`MIN_SIMILARITY = 0.3` and `SEMANTIC_WEIGHT = 0.8` are still guesses.** Still the first thing
  worth tuning against a real vault, and now the most valuable thing left: the next session's
  users will judge the product by it. The way to do it is unchanged — log the similarity scores of
  a few searches whose right answer is known.
- **The extension is still not submitted.** **Deferred deliberately**, not blocked: the $5 fee is
  not being spent now. The engineering has been done since 2026-09-04 and the privacy URL exists.
- ~~The cron ping on `/api/health` is still not set up.~~ **Closed** after eight sessions. Running
  on cron-job.org. One correction outstanding — see section 5, item 3 — and one failed run every
  morning at 06:00 is expected rather than a fault.
- ~~`CONTACT_EMAIL` is empty.~~ **Closed.**
- **Capture has still never been verified against the real blocked domains in production.** Carried
  since 2026-09-04. Half an hour, and it is the entire argument for the extension.
- **The `OPENAI_API_KEY` exposed on 2026-09-03 is still of unknown rotation status.** Worth noting
  what was checked this session: `git log --all -S "sk-"` across the full history returns nothing
  and `.env` has never been tracked, so **the repository is not the leak** and never was. Whatever
  exposed it was outside git.
- **`MAX_LINKS_PER_USER` is 100.** Fine for a handful of invited users; worth revisiting before
  anyone is asked to move a real library in.
- **Whether YouTube's oEmbed endpoint answers from Render's address is still unverified.**
- **Search result highlighting still does not exist.**
- **New: there is no analytics of any kind.** Users are about to arrive and nothing records what
  they search for or whether it worked. The feedback box catches what people bother to type, which
  is the loud failures only. Pairs naturally with the similarity tuning above, since that needs
  query logging anyway — and both need a decision about storing query text, which the privacy page
  currently says is not stored.

---

## 7. Next session — the brief

**Session A is done and deployed.** The product now has a front door: a stranger who opens the link
is told what it is, a signed-in user can say what is wrong without leaving the page, and the
instance is awake when they arrive. Nothing about that was a phase on the list, and it was the whole
of what stood between the code and a person.

### Do these three first, in order. They cost minutes.

1. **Fix the cron hours** — section 5, item 3. One character.
2. **Open the site in a private window.** Section 4 says why this is finally cheap. Three sessions
   have now carried "not seen in a browser"; it is no longer a Docker problem, it is a thirty-second
   problem.
3. **Save five links you actually care about**, from the real deployed app, and let them enrich.
   This is setup for the main work, not a detour — the tuning below is meaningless against a corpus
   nobody cares about.

### Then: Session B — make semantic search earn its place

**This is the highest-value work remaining, and it is the thing early users will judge.**
`MIN_SIMILARITY = 0.3` and `SEMANTIC_WEIGHT = 0.8` in `services/search.js` have been guesses since
the day they were written, and the [Phase 6 note](./2026-09-06-phase-6-search.md) §5 has said so
twice. Every session since has shipped around them.

The method has not changed and does not need inventing:

- Build a vault of 30–40 real links. Write down **ten queries whose right answer you already know**,
  weighted toward the ones the product exists for — the paraphrase, the half-memory, the "that
  thing about making APIs faster" shape. Include two or three queries that *should* return nothing,
  because a floor that never rejects anything is not a floor.
- **Log the similarity scores** of each search's candidates next to the known right answer. That one
  number is the whole experiment: too low and strangers appear, too high and the paraphrase the
  feature exists for is lost.
- Move `MIN_SIMILARITY` on the evidence, then `SEMANTIC_WEIGHT`, one at a time. Record the before
  and after the way §1 and §2 of the Phase 6 note recorded the keyword numbers — measured, in the
  note, not an impression.

**The thing to decide before writing any of it:** that logging means recording query text, and the
privacy page currently states searches are not stored. Either the logging is a local, temporary
instrument that never ships, or the page changes. It does not get to be neither — §2 of the
[privacy note](./2026-09-14-privacy-policy.md) is explicit that a policy which drifts from the code
is a public false statement about someone's data.

### After that, in rough order of value

- **Analytics** — see the last bullet of section 6. Users are arriving and nothing records whether
  search worked for them. Shares the query-logging decision above, which is why the two belong
  together.
- **Search result highlighting.** Carried since Phase 6, less pressing under prefix-AND matching
  than it was under stemmed OR, but still the clearest way to show *why* a result matched.
- **Verify capture against the real blocked domains** — carried since 2026-09-04, half an hour, and
  it is the entire argument for the extension whenever the $5 gets spent.
- **`MAX_LINKS_PER_USER = 100`** is the first wall an enthusiastic early user hits. Worth raising
  before inviting anyone to move a real library in, not after.

### What not to do

**Do not start Phase 7's Redis.** The seam in `rateLimit/index.js` exists and fails loudly if
enabled, which is correct and finished. One process, no search cache, and no measurement saying
either is a problem — `CLAUDE.md` is explicit that Redis arrives when it has a purpose. The same
goes for Atlas `$vectorSearch`: the Phase 6 note records why a brute-force scan is right at this
size, and the thing that changes that answer is memory at ~10,000 links, which is two orders of
magnitude away.
