# LinkVault extension

One click saves the page you are on, and sends what your browser can see with it.

That second half is the reason this exists rather than a bookmarklet. `safeFetch` calls from a
datacenter, and production measured what that costs: YouTube answers **429** and LeetCode **403** to
the API specifically, whatever it sends, and nothing server-side reaches a page behind a login at
all. This runs in the tab you are already looking at, from your address and your session, so those
refusals stop applying.

## Layout

```
manifest.json      MV3. Permissions, and the only hosts a fetch may reach.
popup.html         The one button.
options.html       Where the access token is pasted.
styles.css         Both pages. Plain CSS, no build step.
src/capture.js     The only code that runs inside a page. Must stay self-contained.
src/api.js         Bearer-authenticated calls to the LinkVault API.
src/config.js      The two settings, in chrome.storage.local.
src/popup.js       Read the tab, capture, save, say what happened.
src/options.js     Paste a token, then prove it works against /auth/me.
```

There is **no build step**, deliberately. The zip uploaded to the store is these files exactly, so
what a reviewer reads is what Chrome runs.

## Running it locally

1. `chrome://extensions` → turn on **Developer mode**.
2. **Load unpacked** → choose this `extension/` folder.
3. In LinkVault (the web app), go to **Settings → Access tokens**, create one, and copy it.
4. Open the extension → **Settings** → paste the token → **Save and connect**.
   It answers with the account it connected as, or with what went wrong.

Pointing it at a local API: set the API address to `http://localhost:4000/api`. That host is already
in `host_permissions`; anything not listed there is blocked by Chrome with no useful error.

After editing any file, press **Reload** on the extension card. The popup picks up changes on its
next open; `manifest.json` changes always need the reload.

## Permissions, and why each one is here

| Permission | Why |
| --- | --- |
| `activeTab` | Read the current tab's URL and inject the capture — only after you click the icon, and only into that tab. |
| `scripting` | Run `readPage` in the tab. Nothing is injected until the save button is pressed. |
| `storage` | Keep the API address and the token. `local`, never `sync`: `sync` would push the credential to every browser on the Google account. |
| `host_permissions` | The API only. A fetch to a host outside this list is blocked, which is also what removes CORS from the picture. |

`<all_urls>` is deliberately **not** requested. `activeTab` grants what a click implies and nothing
standing, which is both the right posture and a much shorter conversation with store review.

## Publishing to the Chrome Web Store

The steps are in `docs/2026-09-04-extension.md`, along with what each one actually needs and what to
expect from review. In short: a one-time $5 developer registration, a zip of this folder, a privacy
policy URL, and screenshots.

Before zipping, bump `version` in `manifest.json`. The store refuses an upload whose version is not
higher than the one already published, and it is the one field with no undo.
