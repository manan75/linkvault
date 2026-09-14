# The privacy policy, and what the store submission still needs (2026-09-14)

Short note. The session was one question -- *are we ready to publish the extension?* -- and the
answer was yes on engineering, no on paperwork. This records the one gap that got closed and the
checklist for closing the rest.

---

## 1. The extension was already built

Worth stating because it was not obvious from outside: `extension/` has been complete since
2026-09-04 (`9f56297`, `bce965b`, `9327fbf`). Manifest, popup, options, capture, bearer-token API
client, no build step. The server half is live -- `/api/auth/me` answers 401 on Render, so the
token path is deployed.

**Nothing about the extension needs writing. What was missing was a privacy policy**, which the
Chrome Web Store requires as a public URL before it will accept an upload from an extension that
handles user data.

## 2. What shipped

| Commit | |
| --- | --- |
| `a632ff1` | The privacy policy page, at `/privacy` |
| `4cf931e` | Dropped a stray line from `client/.env.example` |

Live at **`https://linkvault-livid-two.vercel.app/privacy`**. That is the URL the store listing
wants.

Three decisions in it:

- **Routed outside both auth gates.** A reviewer reads it without an account, and `PublicOnlyRoute`
  would bounce a signed-in user away from their own policy.
- **Linked from the auth layout and the extension's options page.** The options link is absolute,
  because a relative link from `chrome-extension://` resolves inside the extension and 404s.
- **Written by reading the code, not from a template.** A policy that drifts from what the server
  does is a public false statement about someone's data. When `embedding.js`, `enrichment.js`,
  `oembed.js` or the models change what leaves this server, that page changes with them.

## 3. What reading the code for it turned up

Not new behaviour -- new *visibility* of behaviour that was always there, and all three are now
disclosed:

- **Every search query reaches OpenAI.** `embedQuery` has to put the query in the same vector space
  as the documents. Inherent to Phase 6, not incidental, and the strongest reason the store's data
  form needs *Website content* ticked.
- **Enrichment and embedding send different things.** `buildEnrichmentInput` sends title,
  description and domain only. The captured page excerpt goes to the embedding call and not the
  tagging one.
- **The oEmbed providers are a third party.** Saving a YouTube, Vimeo, SoundCloud, Spotify, Flickr
  or Reddit link tells that site the URL was looked up.

## 4. The submission checklist

In order. Steps 3 onward are all dashboards and are described in full in
[the extension note](./2026-09-04-extension.md), section 4 -- this is the sequence, not a
replacement for it.

1. **Set `CONTACT_EMAIL`** at the top of `client/src/pages/PrivacyPage.jsx`. It is deliberately
   empty: the store requires a working contact, but publishing an address is the owner's decision.
   Right now the Contact section says it is missing rather than rendering a dead `mailto:`. **This
   is a hard blocker.**
2. **Verify capture against the real blocked domains in production.** Load `extension/` unpacked,
   mint a token at `/settings`, and save a LeetCode problem and an Instagram reel. If the titles
   arrive, capture works. **Carried forward since 2026-09-04 and still not done** -- it is the
   entire argument for the feature, and half an hour, not a session.
3. **Register as a Chrome Web Store developer.** $5, one-time, per account.
4. **Prepare the listing.** Zip the *contents* of `extension/` with `manifest.json` at the root;
   1-5 screenshots at 1280x800; a short description under 132 chars; category Productivity; the
   privacy URL from section 2.
5. **Answer permissions and data disclosures.** The per-permission justifications in the extension
   note are accurate and unchanged. Tick *Website content* and *Authentication information*; all
   three certifications are true of this code.
6. **Publish Unlisted.** Same review, installable by link, invisible in search. Right choice while
   the user count is one.

Bump `version` in `manifest.json` before every upload. The store refuses a version that is not
higher than the published one, and it is the one field with no undo.

## 5. Why the privacy posture holds up

Recorded so it does not have to be re-derived when review asks:

- **`activeTab`, not `<all_urls>`.** No standing permission to read anything. This is the single
  biggest thing reviewers push back on.
- **Two hosts in `host_permissions`**, the browser blocks the rest. No analytics, no third-party
  code, no remotely hosted code, no build step -- what a reviewer reads is what Chrome runs.
- **Token in `chrome.storage.local`, never `sync`.** It does not propagate to every browser on the
  Google account.
- **A token cannot mint another token** (403 from `requireSession`), and a session JWT presented as
  a bearer credential is refused.
- **Captured DOM is untrusted on arrival** -- `captureParser.js` runs the same sanitisers as the
  server-side parser.

## 6. Carried forward

Unchanged from the [MVP filters note](./2026-09-13-mvp-filters.md) except where marked.

- **`MIN_SIMILARITY = 0.3` and `SEMANTIC_WEIGHT = 0.8` are still guesses.**
- **The extension is still not submitted.** Now blocked only on a contact address and a $5 fee.
- **The cron ping on `/api/health` is still not set up.** Seventh session. Measured at **32 seconds
  cold** while probing the API this session, which is what it costs every time.
- ~~`client/.env.example` carries a line that looks like a password.~~ **Closed.** It was
  committed in `9f56297` rather than uncommitted as three notes had it, and the repo is public --
  but the user confirms it was a random string, not a credential. Line removed.
- **The `OPENAI_API_KEY` exposed on 2026-09-03 is still of unknown rotation status.**
- **`MAX_LINKS_PER_USER` is 100.**
- **Whether YouTube's oEmbed endpoint answers from Render's address is still unverified.**
- **Search result highlighting still does not exist.**
- **The privacy page is a claim about code.** If what leaves the server changes, it changes too.
