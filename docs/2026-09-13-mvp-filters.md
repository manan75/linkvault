# The last two MVP filters reach the UI (2026-09-13)

`CLAUDE.md` lists filtering by **domain** and by **date** under MVP search. Both have been
built and tested on the server since Phase 2 and unreachable from the browser ever since —
`listLinksSchema` validates `domain`, `savedAfter` and `savedBefore`, `buildLinkQuery`
applies them, and `links.test.js` covers both. The
[Phase 6 note](./2026-09-06-phase-6-search.md) carried this forward twice with the same
summary: *"the expensive half is done; `EMPTY_FILTERS` and `FilterBar` are what is
missing."* That turned out to be exactly right — **not one line of server code changed.**

---

## 1. Why the domain filter has no list of domains

The obvious design mirrors tags: a `/links/domains` endpoint aggregating the vault, and a
list in the sidebar to pick from. That was considered and not built.

A tag vocabulary is small, curated and worth browsing — it is how the user thinks about
their library, which is why it earns a sidebar. A domain list is neither. It is as long as
the vault is varied, nobody curates it, and it grows a row every time a new site is saved.
Browsing it is not the thing anyone wants; **filtering to the site of the link already on
screen is.**

So the domain on a link's meta line became the control. Clicking it filters, and the filter
bar grows a chip naming the active domain with an `✕`. That costs one endpoint, one
aggregation, one component and their tests less than the list would have, and it puts the
control where the intent forms.

The honest cost: a domain filter cannot be turned on for a site that has no link on screen.
Search first, then click — which is the same order the user would have arrived in anyway.
If the vault grows to where that stops being true, the endpoint is still there to write.

Clicking the domain **toggles**, matching how tag chips on the same card already behave.
The tooltip therefore says `Filter by redis.io` rather than "show only" — it is accurate in
both directions, and the `✕` on the chip is the obvious way out regardless.

## 2. The date filter, and the one detail that is easy to get wrong

Presets (past week / month / year) plus two `<input type="date">` boxes for an exact range,
in a popover on a chip.

**The chip's label is derived from the boundaries, never from the preset that set them.**
`Since 6 Sep`, `Until 6 Sep`, `6 Sep – 13 Sep`, or `Any time`. Remembering "Past week"
instead would start lying the moment a custom date is typed over it, and again at midnight.

**The detail worth recording: `<input type="date">` speaks local calendar days, and the API
filters on instants.** The obvious conversion back into the input is
`iso.toISOString().slice(0, 10)`, and it is wrong everywhere except UTC. Verified in the
project's own timezone (IST, UTC+5:30):

```
picked day 2026-09-13
  start boundary -> 2026-09-12T18:30:00.000Z
  naive UTC slice of that -> "2026-09-12"   ← the picker would reopen on the wrong day
  local date parts        -> "2026-09-13"   ← what the code does
```

So both directions convert through local date parts. And a picked day becomes the **start**
of that day when it opens a range and the **end** of it (`23:59:59.999`) when it closes one,
so choosing the same date in both boxes means that whole day rather than a single empty
instant at its start. A link saved at 09:00 and one saved at 23:59:59 both fall inside it;
the days either side do not.

A preset sets a floor and clears any ceiling. "Past week" means *since* then, and carrying a
stale ceiling over would silently hide everything saved since it was set.

## 3. One shared piece

`AppearanceMenu` already had the fifteen lines that close a popover on an outside click or
Escape, and the date panel wanted the same. They are now one hook,
`hooks/useDismissablePanel.js`, and `AppearanceMenu` uses it — the part that is easy to get
subtly wrong (only listening while open, and unsubscribing) is worth having in one place.

## 4. What is verified, and what is not

**Verified:**

- The 318 server tests still pass, and the client builds and lints clean (two pre-existing
  warnings, neither in changed code).
- The boundary arithmetic in §2, run in Node in the project's own timezone: single-day
  ranges are inclusive at both ends, adjacent days are excluded, and the round trip through
  the date input is stable.
- `toQuery` drops `null`, so an inactive domain or date filter sends no parameter at all —
  the request shape is unchanged when nothing is filtered.
- The server accepts what the client now sends: `savedAfter`/`savedBefore` are
  `z.coerce.date()`, which parses a full ISO instant.

**Not verified: none of this has been looked at in a browser.** Docker was not running, so
there was no local Mongo to serve a dashboard. The build passes and the logic is checked,
but the layout of the chip row with two more controls in it, and the popover's placement on
a narrow window, have not been seen. **That is the first thing to do next session** — it
needs nothing but `docker compose up -d mongo` and two dev servers.

## 5. Carried forward

Unchanged from the [Phase 6 note](./2026-09-06-phase-6-search.md) except where marked.

- **`MIN_SIMILARITY = 0.3` and `SEMANTIC_WEIGHT = 0.8` are still guesses.** Still the first
  thing worth tuning against a real vault, and still the way to do it is to log the
  similarity scores of a few searches whose right answer is known.
- **The extension is still not submitted.** $5, a zip, screenshots, a privacy policy URL.
- **The cron ping on `/api/health` is still not set up.** Sixth session.
- ~~Two MVP filters are built on the server and unreachable from the client.~~ **Done.**
- **`client/.env.example` still carries an uncommitted line that looks like a password.**
- **The `OPENAI_API_KEY` exposed on 2026-09-03 is still of unknown rotation status.**
- **`MAX_LINKS_PER_USER` is 100.**
- **Whether YouTube's oEmbed endpoint answers from Render's address is still unverified.**
- **Search result highlighting still does not exist.**
