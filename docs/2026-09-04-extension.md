# The extension, and what shipping it actually costs (2026-09-04)

Three things happened this session: two fixes to what bookmarks are called and how they are tagged,
and the extension, built through the Bearer-token path the
[deployment plan](./2026-09-02-deployment-and-extension-plan.md) reserved for exactly this moment.

This note records the one architectural deviation and its argument, and then the deployment
checklist — what only the user can do, in order, with what each step actually needs.

---

## 1. The two fixes

### Bookmarks named after their own domain

`3e5ee8b` last session made the *client* name an unfetchable link from its URL path. It did not
work as often as it should have, and the reason was upstream: **`parseMetadata` wrote `domain` into
`title`** whenever a page declared none. The client's fallback only fires on an empty title, so a
stored `leetcode.com` looked exactly like a real title and suppressed it.

Worse than cosmetic. `completeLink` only fills a field that is still empty, so the domain occupied
`title` permanently — a later successful retry would fetch the real title, find the field taken, and
keep the guess forever.

Extraction now leaves the title empty, and the client derives a name it can revise. Two further
gaps closed at the same time:

- **A title that only names the site is treated as absent.** A blocked Instagram page comes back
  titled `Instagram`; the domain is already printed on the line directly beneath. The comparison
  strips the suffix, which costs something real and is accepted: a page at `redis.io` genuinely
  called "Redis" now gets named from its path instead. The path is more specific in every case where
  the two differ.
- **`reel`, `reels`, `shorts`, `clip`, `embed`** and the rest joined `watch` as routing furniture.
  `instagram.com/reel/C8xYz1AbCdE/` was being titled "Reel" — a category, shared by every reel in
  the vault.

Verified against the real shapes:

```
Two Sum                              leetcode.com/problems/two-sum/
Why Caching is Hard                  reddit.com/r/programming/comments/1abc2d/why_caching_is_hard/
Bloom Filter                         en.wikipedia.org/wiki/Bloom_filter
www.instagram.com/reel/C8xYz1AbCdE   (falls back to the address)
www.youtube.com/watch?v=dQw4w9WgXcQ  (falls back to the address)
```

### Tags multiplying

Real output on one Instagram reel: `instagram`, `instagram-reel`, `kpop`, `kpop-idol`. Four tags
naming two things, and four sidebar entries that will only ever hold one link each.

**The cap dropped from five to three.** Five was chosen for how a card reads, which is the wrong
thing to optimise — a tag exists to gather links, and asking for five guarantees the list gets
padded to reach it.

**`normalizeTags` now drops a tag that only narrows one already kept**, matched on whole words so
`react` does not swallow `preact` and `ml` does not swallow `html`. It compares against tags kept so
far, so the broad one wins when the model writes it first, which it reliably does.

The known cost is written into the code: `react` arriving before `react-native` suppresses
`react-native`, and those are genuinely different things. A React Native page filed under `react` is
findable and not wrong; a vault where every subject exists at two granularities is neither.

The prompt asks for the same things — prefer the broad tag, never both granularities, and **do not
tag the platform**, since the domain is already stored and already filterable. As everywhere else in
`utils/tags.js`, the prompt is the request and the code is the guarantee.

---

## 2. Page capture before Phase 6 — the deviation, stated

`CLAUDE.md`'s Important Rule asks for four things before a major architectural change. The
deployment plan (§1) already deferred the extension until after Phase 6, on the grounds that its two
best features — omnibox search and better embedding input — both need semantic search to exist.
**Capture shipped anyway, ahead of Phase 6.** That needs the treatment.

**1. What problem it solves.** Bookmarks that cannot be read at all. Not "read poorly" — a `failed`
link with no title, no description and nothing for enrichment to summarise.

**2. Why the current architecture is insufficient.** The plan justified capture on paywalls, logins
and JavaScript-rendered pages. Production added a fourth and larger category that no amount of
server-side work touches: **sites that refuse this server because of where it is calling from.**
Measured last session — YouTube 429, LeetCode 403, both from Render, both while a residential IP got
200 and 403 respectively for the same URLs. LeetCode's refusal survived a real Chrome User-Agent, so
it is TLS fingerprint and IP reputation, not identity. There is no request `safeFetch` can make that
changes the answer.

**3. Alternatives considered.**

- *oEmbed for providers that publish one.* Real, cheap, and still worth doing — 868 bytes of JSON
  against 1.3MB of HTML for a YouTube video. But it covers a handful of providers, returns three
  fields, and its own availability from a datacenter IP is untested. It is a narrowing of the
  problem, not an answer to it.
- *Paid hosting with a dedicated egress IP.* Fly.io, named in the plan as the first upgrade to buy.
  It might fix YouTube. It does nothing for LeetCode's fingerprinting and nothing at all for a page
  behind a login, and it is the only option here that costs money every month.
- *Accept the failures and show the URL.* What shipped last session, and it is the right floor. It
  is not a ceiling: "Two Sum" derived from a path is the best that bookmark will ever show, and the
  product's promise is to find it from a description.
- *Wait for Phase 6.* The honest cost of waiting is that every link saved in the meantime from a
  blocked domain is permanently thin, and re-enriching them later needs content nothing will have.

**4. Why this one is appropriate.** It is the only option that reaches the pages, it costs nothing
to run, and it fits the existing pipeline in one branch. Critically, it is also *not* wasted Phase 6
work — `capture.text` is the cleaned page excerpt Phase 5 proved enrichment needs and Phase 6 will
embed, and keeping it means re-embedding the corpus after a model change does not mean asking every
user to revisit every page.

**What it does not change.** The branch is in `metadataWorker.runOne`, not in `saveLink`. Completing
a captured link synchronously was tempting — there is no I/O to wait for — but it would duplicate
`completeLink`, fork the state machine and break Principle 2. One completion path, one lease, one
retry policy; the capture case simply does not call the network.

**The trust boundary is the trap the plan warned about**, and it was handled by refusing to build a
second one. `captureParser.js` runs the same `cleanText` and `safeImageUrl` as `parseMetadata`, with
the same limits. A capture arrives with a valid credential attached, which is exactly what makes it
feel trusted; it is the DOM of a page that may be attacker-controlled.

**Re-saving became routine, as predicted.** A capture for a link whose extraction `failed` re-runs
it — the one client that can reach the page rescuing one the server could not. Scoped tightly: a
`ready` link is left completely alone.

---

## 3. What shipped

| Commit | |
| --- | --- |
| `82c14b1` | Stop naming bookmarks after their own domain |
| `0d97e8f` | Keep auto-tags few and non-overlapping |
| `9327fbf` | Bearer tokens for clients that cannot hold a cookie |
| `bce965b` | Accept a page capture from the extension |
| `9f56297` | The Chrome extension, and where its token comes from |

248 server tests pass. The client builds.

Three decisions inside the token work worth keeping:

- **SHA-256, not bcrypt, and this is the opposite of the password rule.** A password is low-entropy
  and chosen by a person, so the slow hash is what makes offline guessing impractical. This token is
  32 bytes from a CSPRNG — there is nothing to guess, the work factor buys no security, and an
  unindexable hash would mean bcrypt-comparing every row in the collection to authenticate one
  request. It is a single indexed equality match instead.
- **A token cannot mint another token.** `requireSession` narrows the three token-management routes
  to a real browser session, so a leaked token cannot quietly create its replacement and outlive the
  revocation of the one that leaked. It returns 403, not 401: the credential is valid and simply not
  allowed to do this.
- **A session JWT presented as a bearer credential is refused.** The web app's session lives in the
  httpOnly cookie and nowhere else; honouring it from a header would hand a working credential to
  anything that can read one.

And one on the body limit: `POST /api/links` gets a 512kb parser and everything else keeps 100kb.
The choice is made in `app.js` rather than inside `linkRouter` because **the body is parsed before
any router sees the request** — a per-route parser would never see a request the global one had
already rejected. A too-large body is now a 413 rather than a 500 claiming the server is broken.

---

## 4. Deploying the extension — the checklist

Nothing below can be done from this repository; all of it is dashboards and accounts.

### Step 0 — Deploy the API first, or nothing works

The extension talks to `https://linkvault-api-uenh.onrender.com/api`, and that service does not yet
have the token endpoints or the capture branch. **Push `main`; Render redeploys on push.** Then
redeploy the Vercel client too, so `/settings` exists to mint a token from.

Verify before touching Chrome:

```
curl -i https://linkvault-api-uenh.onrender.com/api/health
```

Allow ~50 seconds for the first request if the instance is cold — see the outstanding cron ping in
[the deploy note](./2026-09-03-deploy-v1-live.md) §5, which is *still* not set up and is still the
cheapest win on the list.

### Step 1 — Load it unpacked and use it

Before spending $5, confirm it works. `chrome://extensions` → **Developer mode** → **Load
unpacked** → the `extension/` folder. Mint a token at `/settings`, paste it into the extension's
Settings, and save a few pages.

**Save a LeetCode problem and an Instagram reel.** They are the two known-blocked shapes and they are
the entire argument for capture. If their titles now arrive, the feature works; if they do not,
that is a bug worth finding before review, not after.

### Step 2 — Register as a Chrome Web Store developer

<https://chrome.google.com/webstore/devconsole> — a **one-time $5 fee**, per account, not per
extension. Card required. Registration is usually instant.

### Step 3 — Prepare what the listing demands

The store will not accept an upload without these, and they are the part that takes real time.

| Item | Requirement | Note |
| --- | --- | --- |
| **Zip** | The *contents* of `extension/`, not the folder | `manifest.json` must be at the zip root |
| **Icon** | 128×128 PNG | Already in `icons/icon128.png` |
| **Screenshots** | 1–5, at 1280×800 or 640×400 | The popup on a real page is enough |
| **Description** | Up to 132 chars short, plus a full one | |
| **Category** | Productivity | |
| **Privacy policy** | A public URL | **Required**, because the extension handles user data |
| **Permission justifications** | One sentence per permission | See below |
| **Data use disclosures** | A form to fill | See below |

Zip it correctly — this is the most common first mistake:

```
cd extension && zip -r ../linkvault-extension-0.1.0.zip . -x '.*'
```

### Step 4 — Answer the permissions questions

Store review asks for a justification per permission. These are true and sufficient:

- **`activeTab`** — Reads the URL and title of the tab only when the user clicks the extension icon,
  in order to save that page as a bookmark.
- **`scripting`** — Reads the page's own title, description and text so the bookmark has useful
  content. Runs only in response to the user pressing Save, only in the active tab.
- **`storage`** — Stores the user's access token and the address of their LinkVault server.
- **Host permission** — The extension sends saved bookmarks to the user's own LinkVault API and
  nowhere else.

Reviewers reject broad permissions with thin justifications. This extension asks for `activeTab`
rather than `<all_urls>` precisely so that conversation is short.

### Step 5 — Fill in the data-use disclosures honestly

Tick **Website content** and **Authentication information**. Then the three certifications, all of
which are true of this code:

- Not sold to third parties. ✔
- Used only for the single purpose disclosed. ✔
- Not used to determine creditworthiness or for lending. ✔

The privacy policy needs to say, plainly: the extension sends the page's URL, title, description and
an excerpt of its text to the LinkVault server the user configured; it stores an access token
locally; it shares nothing with anyone else. A GitHub Pages file or a plain page on the Vercel
deployment both count as a public URL.

### Step 6 — Upload and wait

Review takes **anywhere from a few hours to two weeks**, and a first submission from a new developer
account is usually at the slow end. Publishing can be set to **Unlisted** — installable by link,
invisible in search, same review. For an extension whose users are currently one person, unlisted is
the sensible first choice.

### Step 7 — After it is published

`chrome.storage.local` survives an update, so a published user does not re-paste their token.

Bump `version` in `manifest.json` before every upload. The store refuses a version that is not
higher than the published one, and it is the single field with no undo.

---

## 5. Things worth knowing before step 1

**The API base cannot be freely typed.** `host_permissions` names two hosts, and a fetch to anything
else is blocked by Chrome with no useful error — it looks like the server being down. Changing where
the extension points means editing `manifest.json` and reloading.

**CORS is not involved and does not need configuring.** A request to a host in `host_permissions` is
made with the extension's own privileges rather than a web page's, so `CLIENT_ORIGIN` on the server
does not need to know the extension exists.

**A capture is an improvement, never a requirement.** A PDF viewer, a `chrome://` page, or a tab
that loaded before the extension was installed all capture nothing, and the save still happens — the
server falls back to fetching the URL, exactly as before.

**One save can now cost more than it did.** A capture skips the fetch, which is cheaper, but it also
means a page that used to fail now reaches enrichment and bills a model call. That is the intended
outcome and it is worth watching in the `DailyUsage` documents.

---

## 6. What the next session should pick up

1. **The cron ping on `/api/health`.** Third session running. It sits in front of every latency
   complaint.
2. **Verify capture against the real blocked domains in production**, not just locally. Everything
   in this project that broke, broke because the real dependency behaved differently from the test.
3. **The `enrichment` input still ignores `capture.text`.** The field is stored, `select: false`,
   and nothing reads it yet. `buildEnrichmentInput` is the one function that would change, and it is
   where the Phase 5 finding — three of four verification pages had no `og:description` and got no
   summary — finally gets its answer.
4. **Phase 6**, and with it the omnibox, which is the extension's other half and the reason the plan
   ordered things this way in the first place.

## 7. Housekeeping

- **`client/.env.example` has an uncommitted line in it that looks like a password.** It was not
  committed. If that string is a real credential — for Atlas, or anything else — it should be
  rotated, because `.env.example` is a tracked file and one `git add -A` away from being public.
- **The `OPENAI_API_KEY` exposed on 2026-09-03 is still of unknown rotation status.** Carried
  forward unchanged from the last note; treat it as unrotated until confirmed.
- **`MAX_LINKS_PER_USER` defaults to 100.** The extension makes saving cheap enough that this will
  be reached far sooner than it would have been.
