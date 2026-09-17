# The UI pass, and what a browser finally showed (2026-09-17)

The session opened with a status question and a proposal: *where are we functionally, do I start inviting
friends and family, and can the UI get drag-and-drop and better buttons.* It ended with the
four-session-old "never seen in a browser" item closed, and with two mobile bugs that had nothing to
do with anything built this session.

---

## 1. Where things actually stood

Measured, not read off the previous note:

| | |
| --- | --- |
| **Server tests** | 327 pass, 0 fail |
| **Production API** | 200 in **1.53s**, warm — the cron ping from Session A is working |
| **Working tree** | clean |

Functionally the product is complete through Phase 8 apart from hardening. What was missing for a
stranger was, in order of cost: the untuned search constants, `MAX_LINKS_PER_USER = 100`, no
analytics — and, as it turned out, a phone experience nobody had ever looked at.

## 2. "The UI is basic tailwindcss" — half right, and the wrong half

The premise deserved checking before acting on it. `index.css` is not basic: oklch tokens, two
themes, six accent presets deriving from shared lightness stops. That layer is good and was left
alone.

The problems were in how components *used* it, and they were more concrete than "make buttons nicer":

- **Card actions were invisible on touch.** `opacity-0 group-hover:opacity-100`, and Tailwind
  compiles `hover:` to `@media (hover: hover)`. On a phone that media query never matches, so edit
  and delete were not quiet — **they did not exist**. Same for collection rename/delete, and the tag
  rename affordance. Three places, one defect.
- **28px tap targets** (`p-1.5` around a `size-4` icon). Past the WCAG 2.2 floor of 24px, well under
  the 44px that is reliable under a thumb.
- **`lv-button` was genuinely flat** — one background, one hover, no pressed state.

### The fix, and why it lives where it does

`lv-row-action` is declared **unlayered** in `index.css`, which matters: `opacity-0` is a utility, and
Tailwind's `utilities` layer outranks `components` regardless of specificity. Styles in no layer at
all outrank both. The rule direction is also deliberate — the control is **visible by default** and
hidden only inside `@media (hover: hover)`, so any failure to match the query leaves the button
present rather than gone.

Tap targets grow under `@media (pointer: coarse)` only, so a desktop row does not get taller to pay
for a phone.

## 3. Drag and drop

### Why a dependency, given `CLAUDE.md` says not to add them without a reason

**The HTML5 drag-and-drop API has no touch support at all.** Not degraded — absent. Building on it
would have added a feature that excludes exactly the phone users whose edit and delete had just been
restored. `@dnd-kit/core` supplies pointer, touch and keyboard sensors. Atlassian's
pragmatic-drag-and-drop is smaller but is HTML5-based, which reintroduces the problem.

**The measured cost is +15KB gzipped** (91.35 → 106.50), which is more than the advertised "6KB core"
once utilities and the accessibility layer come with it. Recorded here rather than discovered later.

### Four decisions worth keeping

**Mouse and touch are separate sensors, not one pointer sensor.** They need opposite activation
rules. A mouse drag starts after 8px of travel, so clicks on the card's own link and buttons still
land. A touch drag starts after a 250ms hold, so a finger moving down the page scrolls it instead of
picking a bookmark up.

**Collision detection is `pointerWithin`, falling back to `rectIntersection`.** Not `closestCenter`,
which always returns something — it would file a bookmark into whichever collection happened to be
nearest when it was dropped on empty space. The fallback exists for the keyboard drag, which has no
pointer and asks whether the card's own rectangle overlaps a target.

**The pointer listeners are on the card; the key listener is on the grip alone.** Dragging from
anywhere on the row is what makes the gesture worth having, but a keyboard drag has to start from
something focusable, and making the row itself focusable would wrap `role="button"` around the title
link and five real buttons. Splitting them also avoids the duplicate that spreading `listeners` on
both would cause, since an event on the grip bubbles to the card.

**Drag is never the only path.** WCAG 2.2 requires a single-pointer alternative for any dragging
movement. The edit-icon route is untouched; drag is a second, faster door.

### The bin, and the confirmation

The bin stays mounted and hides itself rather than appearing on drag start, so dnd-kit always has it
registered — `pointer-events: none` does not affect collision detection, which is rect-based.

**The confirmation was the owner's call, against the recommendation.** The argument put was that
friction should match risk, and that a confirm dialog on every drop cancels the speed the gesture
buys — the alternative being a `deletedAt` field and an undo toast. The owner chose the dialog and no
schema change. Worth revisiting if the bin turns out to be used often; deletion here is genuinely
permanent, and that is what earns an interruption when the rest of the app confirms inline.

## 4. The browser session — carried since 2026-09-04, now closed

Docker was still not running, so the previous blocker was still in place. The way round it: an
**isolated stack** — `mongodb-memory-server` (already a devDependency, binary already cached by the
test suite), the API spawned against it with explicit env, and the Vite dev server in front. No
Atlas, no production data, no secrets, and the metadata worker deliberately off so nothing made real
network calls. Chromium via Playwright drove it. The harness was deleted afterwards.

**18 checks pass**, including: move updates the count and the card's meta line, bin drop opens the
dialog, Escape cancels without deleting, confirm actually deletes, the favourite toggle still clicks
through the drag listeners, and under `hover: none` / `pointer: coarse` edit and delete render at
opacity 1 at 44×44.

### Two bugs found this way, neither of them new

Both were pre-existing, and both affected **every phone visitor since the dashboard was built**:

1. **The page scrolled sideways on a phone.** A `grid` column is sized by its widest item's
   min-content, so one child that refused to shrink stretched the column — and with it the sidebar —
   to 483px inside a 390px screen. Fixed with `grid-cols-[minmax(0,1fr)]` on the single-column layout
   and `min-w-0` on both children.
2. **The header did not fit 390px.** Five controls, with "Sign out" wrapping to two lines. It is now
   hidden below `sm`; Settings is one tap away and signs out from its own header, so nothing became
   unreachable.

### One correction worth recording

**The first overflow check passed vacuously.** It compared `document.documentElement.scrollWidth`
against `window.innerWidth` — but when content overflows, Chrome's mobile emulation widens the layout
viewport to fit, so `innerWidth` grows to match `scrollWidth` and the comparison is always true. It
reported `484px of content in 484px` and called it a pass. Scanning for elements whose right edge is
past the **requested** 390px cannot be fooled that way, and it names the culprit.

A second false alarm went the other way: "Delete" looked clipped in the sidebar screenshot. The DOM
said otherwise — `scrollWidth === clientWidth === 50`, right edge inside the nav — and a 3× capture
confirmed it. It was a downscaled-render artifact. **Measure before fixing what a screenshot seems to
show.**

## 5. What is verified, and what is not

**Verified:** 327 server tests (no server code changed), the client builds and lints with only the two
pre-existing warnings, and all 18 browser checks against a real API in a real browser.

**Not verified:** none of this has been seen in *production*, and none of it has been seen by a person
rather than a script. The deploy is the next thing.

**Also not verified, and carried:** the drag gesture has never been tried with an actual finger. The
emulation reports `hover: none` and `pointer: coarse` correctly, but a 250ms hold-to-drag is a feel
judgement and emulation cannot make it.

## 6. On inviting people

The advice given, and the reasoning: **not until search has been measured.** A broken phone layout was
the embarrassing failure mode and it is now fixed, but what friends will actually judge is whether
describing a half-remembered thing finds it — and `MIN_SIMILARITY = 0.3` and `SEMANTIC_WEIGHT = 0.8`
have been guesses since the day they were written. Warm outreach is non-repeatable; each person gives
you one "try my thing".

The step before the step: save 20–30 real links on the deployed app and run ten searches whose right
answer you already know.

## 7. Carried forward

Unchanged from the [ready-for-users note](./2026-09-15-ready-for-users.md) except where marked.

- **`MIN_SIMILARITY` and `SEMANTIC_WEIGHT` are still guesses.** Still the most valuable thing left,
  and now the only thing standing between the product and being shown to people.
- **The cron hours still read `*/10 0-1,6-22`** and should be `0-1,6-23`. One character, still open,
  and 23:00–23:59 remains unpinged.
- **The extension is still deferred** on the $5 fee.
- **Capture has still never been verified against the real blocked domains in production.**
- **`MAX_LINKS_PER_USER` is 100.**
- **The `OPENAI_API_KEY` exposed on 2026-09-03 is still of unknown rotation status.** The repository
  was ruled out as the leak last session.
- **No analytics of any kind.**
- **Search result highlighting still does not exist.**
- **New: the dashboard has no bulk actions.** Drag moves one bookmark at a time, which is right for
  now and will stop being right the first time someone files thirty links.
- **New: `+15KB gzipped` of client bundle** now rides on every page load, including the landing page a
  stranger sees cold. Worth a route-level split if the landing page is ever measured as slow.

## 8. A second pass, the same day

Four follow-ups, after the first pass was deployed and looked at.

**Delete left the card.** It now lives in the edit panel behind the pencil, and it *requests* rather
than performs -- both it and the bin set the same `pendingDelete`, so there is one dialog, one code
path and one question. The argument for keeping a click route at all: drag-to-bin as the only way to
delete is fine for whoever discovered dragging, and invisible to a friend on a phone who did not.

**The drag affordance moved to the front of the row and stopped hiding.** A grip on the right at
`opacity-0` was, in practice, a gesture nobody could see. It is now the first thing in the card, in
the position a handle is looked for, always on screen, with `cursor: grab` over the card body and a
line under the Collections heading saying what to drag onto. It costs no width -- it left the cluster
on the right rather than being added to it.

**Search stopped looking like furniture.** `.lv-search`: 16px text in a 50px box with a magnifier in
the gutter and a four-pixel accent ring on focus. It is the one control the product exists for and it
was the same size as the sort dropdown.

**The extension became paste-first.** The popup opens with the cursor in a box; the `paste` event
*is* the command, with no Save button afterwards, because the second deliberate action is the thing
being removed. `Ctrl+Shift+L` opens it. Saving the current tab is still there, below a rule.

Three decisions in it worth keeping:

- **`urlFromText` lives in its own module** (`src/url.js`) with no browser dependency, so it can be
  read and tested directly. Pasted text is rarely only a URL -- it arrives with a trailing newline
  from a terminal, wrapped in punctuation from a chat message, or inside a sentence. **Nineteen cases
  pass**, including refusing `javascript:`, `file:` and `chrome://`, which matters because the popup
  would otherwise POST them.
- **Rejection happens locally.** A non-link never becomes a request, so the answer is instant instead
  of costing a cold start to hear.
- **The box is filled by hand, not by the browser.** Disabling the input in the same tick as the
  paste can pre-empt the browser's own insertion -- which leaves "Saved." above an empty box, saying
  that something was saved but not what. Found by looking at a screenshot, not by a failing assertion.

### Verified

**26 browser checks** on the client and **9 on the extension**, the latter driving the real
`popup.html` and `popup.js` against a real API and asserting the bookmark arrived in the vault. The
extension harness serves the folder over http with a stub for the three `chrome.*` APIs the popup
touches; everything else is the extension's own code unmodified.

Two harness traps worth remembering. A second Vite instance holding `[::1]:5174` made a test server
bound to `0.0.0.0` invisible to `localhost`, which resolves to `::1` first -- every request silently
reached Vite instead, returning the SPA shell with a 200. And because the harness serves the popup
over http rather than `chrome-extension://`, the browser applies CORS to a request a real extension
makes with its own privileges; the check runs its own API with `CLIENT_ORIGIN` pointed at the harness
rather than working around it in the code under test.

### Not verified

The Chrome-specific half: `chrome.storage.local`, `chrome.tabs.query`, the real clipboard, and
whether `Ctrl+Shift+L` is free on this machine. All of that needs the extension loaded unpacked --
which is free, needs no developer registration, and is documented in `extension/README.md`.

## 9. Next session

1. **Deploy this**, and open the production site on an actual phone. The emulation did its job but it
   is not a finger.
2. **Then Session B as already briefed** — build the vault, write the ten queries, log the similarity
   scores, move the two constants on evidence. The note from 2026-09-15 §7 has the method and it has
   not changed.

**What not to do:** still no Redis, still no `$vectorSearch`. Both arguments are unchanged and both
are recorded in the notes that made them.
