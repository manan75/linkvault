# Before the first invite (2026-09-17)

Written at the end of the session that finished the first iteration, to be read before telling
anyone about LinkVault. The detail of what was built is in
[the UI note](./2026-09-17-ui-touch-and-drag.md); this is the part that matters when real people
arrive.

---

## 1. Where it stands, verified today

| | |
| --- | --- |
| **Server tests** | 327 pass, 0 fail |
| **Client** | builds clean; two pre-existing lint warnings, neither in changed code |
| **Browser checks** | 26 on the vault, 9 on the extension, all passing |
| **Deployed** | Vercel serving today's bundle — confirmed by content, not by hash |
| **API** | `/api/health/deep` 200, database connected |

Functionally the product is complete through Phase 8 apart from hardening.

## 2. What shipped today

**Four commits, in two passes.**

- **Every control is reachable on a phone.** Card actions, collection rename/delete and tag rename
  were behind `opacity-0 group-hover:…`, which on a touch device never fires — so they did not exist.
  Tap targets are 44px under a coarse pointer, and buttons have a pressed state.
- **Two pre-existing phone bugs, fixed.** The dashboard scrolled sideways (a grid column sized by its
  widest child stretched the sidebar to 483px inside a 390px screen) and the header did not fit,
  wrapping "Sign out" onto two lines. Both had been hurting every phone visitor since the dashboard
  was built.
- **Drag to file, drag to delete.** Drop a card on a collection to file it, on Uncategorised to
  un-file it, on the bin to delete it after a confirmation. The handle leads each row and never
  hides. Keyboard and touch both work; dragging is never the only path.
- **Delete moved off the card** into the edit panel, sharing the bin's dialog.
- **Search looks like the point** — 16px text, 50px tall, magnifier, accent focus ring.
- **The extension is a paste box.** Open it (`Ctrl+Shift+L`), `Ctrl+V`, done. It also works on
  `chrome://` pages, PDFs and local files now, because it never needs to read the tab.

---

## 3. Read this before you send the first message

Four things will bite, in rough order of how likely they are tomorrow.

### 3a. Registration is capped at five accounts per hour, per IP address

`server/src/routes/authRoutes.js` — `registerLimiter`, `limit: 5, windowMs: 60 minutes, keyBy: byIp`.

**If your family signs up together on the home wifi, they share one address.** The sixth person in an
hour is told *"Too many accounts created from this address. Try again later."* — which reads as the
product being broken, at the exact moment you are standing there showing it to them.

The limit is correct in principle: registration is open, so minting accounts is the way past every
per-user quota in the system. But five is tuned for a stranger on the internet, not for a living room.

**Three options, and they are not equal:**

1. **Invite in waves of four or fewer per household per hour.** Costs nothing, works today, and is
   the right answer if you are showing two or three people at a time anyway.
2. **Raise the limit.** It is a hardcoded constant, not an environment variable, so this needs a code
   change and a deploy — not a dashboard toggle. Twenty an hour is still ruinous to a script.
3. **Do nothing and watch for it.** Acceptable only if you know everyone is on different networks.

### 3b. The enrichment budget is shared by everyone, not per person

`ENRICHMENT_DAILY_LIMIT = 200`, and `DailyUsage` keys on `enrichment:<day>` — **one counter for the
whole service**, not one per user. Ten people saving twenty links each spends the entire day.

**The failure is soft, which is the good news.** A link that arrives with the budget spent is
*deferred*, not failed: it goes back to `pending` and is retried after midnight, so summaries and
auto-tags turn up the next day rather than never. Nothing is lost.

But on day one that means later links look half-finished — no summary, no auto-tags — and semantic
search over them is weaker until they catch up. Embeddings have their own ceiling of 2,000/day, far
less likely to bite.

Both are environment variables, so they can be raised in the Render dashboard without a deploy. They
also bound a real bill, so raise them deliberately.

### 3c. `MAX_LINKS_PER_USER = 100`

The first wall an enthusiastic person hits, and the one most likely to be hit by whoever likes it
most. Environment variable, raisable in Render without a deploy.

### 3d. The cold start, and when it happens

The keep-warm ping runs 06:00–02:00 IST, so the service sleeps 02:00–06:00 IST — **which is afternoon
and evening in the Americas**. A first click in that window waits about thirty seconds on a blank
page. The landing page was built to survive this (it does not wait on the session lookup), but the
wait is still real.

**Still open, still one character:** the cron job reads `*/10 0-1,6-22 * * *` and should read
`*/10 0-1,6-23 * * *`. As written, 23:00–23:59 is unpinged at a perfectly ordinary hour to be
reading, and the 00:00 ping then hits a cold instance and is recorded as failed.

Also expected and not a fault: **one failed ping notification every morning at 06:00**, because the
first ping after the quiet window gets Render's holding page while the instance wakes.

---

## 4. What to watch once people are in

- **The `feedbacks` collection in Atlas.** Newest first; the email is on the document. This is the
  only channel that exists.
- **Whether anyone searches twice.** One search is curiosity. A second search means the first one
  worked.
- **Whether the extension gets loaded at all.** It is the difference between saving being one gesture
  and being four.

**You will not be able to see what they searched for.** There is no analytics of any kind. The
feedback box catches only what someone bothers to type, which is the loud failures. This is the
single biggest blind spot going into outreach.

---

## 5. What is next

### First: the thing everything else waits on

**Tune the semantic search constants.** `MIN_SIMILARITY = 0.3` and `SEMANTIC_WEIGHT = 0.8` in
`server/src/services/search.js` have been guesses since the day they were written, and they are what
your friends will actually judge. Describing a half-remembered thing and finding it *is* the product;
everything else is a bookmark folder.

The method, unchanged from the [Session A brief](./2026-09-15-ready-for-users.md) §7:

1. Build a vault of 30–40 links you genuinely care about.
2. Write down **ten queries whose right answer you already know**, weighted toward the paraphrase and
   the half-memory — the *"that thing about making APIs faster"* shape. Include two or three that
   *should* return nothing, because a floor that never rejects anything is not a floor.
3. **Log the similarity scores** of each search's candidates next to the known right answer. That one
   number is the whole experiment.
4. Move `MIN_SIMILARITY` on the evidence, then `SEMANTIC_WEIGHT`, one at a time. Record before and
   after as measurements, not impressions.

**Decide this before writing any of it:** the logging means recording query text, and the privacy
page currently states that searches are not stored. Either the logging is a local, temporary
instrument that never ships, or the page changes. It does not get to be neither.

### Then, in rough order of value

- **Analytics.** Shares the query-logging decision above, which is why they belong together.
- **Search result highlighting.** The clearest way to show *why* something matched.
- **Verify capture against the real blocked domains in production** — carried since 2026-09-04. Half
  an hour, and it is the entire argument for the extension.
- **Bulk actions.** Dragging one bookmark at a time is right for now and stops being right the first
  time someone files thirty.

### What not to do

**No Redis. No Atlas `$vectorSearch`.** Both arguments are recorded in the notes that made them and
neither has changed. `CLAUDE.md` is explicit that infrastructure arrives when it has a purpose.

---

## 6. Everything still pending, in one list

| | Where it is fixed | Cost |
| --- | --- | --- |
| Cron hours `6-22` should be `6-23` | cron-job.org dashboard | One character |
| Search constants are guesses | `services/search.js` | A session, and the most valuable one |
| No analytics at all | New work | — |
| `MAX_LINKS_PER_USER = 100` | Render env var | Minutes |
| Enrichment budget shared, 200/day | Render env var | Minutes, and it is money |
| Register capped at 5/hour/IP | `routes/authRoutes.js` — code, not env | Small change + deploy |
| Extension not published | $5 developer registration | Load unpacked meanwhile — free, and documented in `extension/README.md` |
| Capture unverified against blocked domains in production | — | Half an hour |
| `OPENAI_API_KEY` from 2026-09-03 — rotation status unknown | — | The repository was ruled out as the leak |
| YouTube oEmbed from Render's address — unverified | — | — |
| Search result highlighting does not exist | — | — |
| +15KB gzipped now loads on the landing page too | Route split | Only if measured slow |

## 7. The honest limits of what has been checked

- **Nothing has been used by a person who is not you.** Every check so far is a script.
- **The drag gesture has never been tried with a real finger.** Emulation reported `hover: none` and
  `pointer: coarse` correctly, so the layout and visibility claims hold — but a 250ms hold-to-drag is
  a feel judgement and emulation cannot make it. One number in `DashboardPage.jsx` if it is wrong.
- **The extension has never run as a real Chrome extension.** The checks drive the real
  `popup.html` and `popup.js` against a real API, but over http with stubs for the three `chrome.*`
  calls it makes. `chrome.storage.local`, the real clipboard, and whether `Ctrl+Shift+L` is already
  taken on your machine are all unverified. Loading it unpacked is the five-minute check that closes
  this, and it is free.
