import { ApiError, saveLink } from './api.js';
import { readPage } from './capture.js';
import { loadSettings } from './config.js';
import { urlFromText } from './url.js';

/**
 * Paste, and it is saved.
 *
 * The product promise is save, forget, describe, find -- and saving from the
 * web app costs four actions: copy the URL, switch tabs, find LinkVault, paste.
 * That friction lands at the exact moment of intent, which is why bookmark
 * tools die.
 *
 * So the popup opens with the cursor already in a box and the paste itself is
 * the command: there is no Save button to find afterwards, because a second
 * deliberate action is the thing being removed. Saving the current page still
 * exists underneath, which is what this extension used to be.
 */

const el = (id) => document.getElementById(id);

/** Pages the browser will not let a script into, and there is no point pretending. */
const UNREACHABLE = /^(chrome|chrome-extension|edge|about|devtools|view-source|file):/i;

/** How long a result stays on screen before the popup gets out of the way. */
const CLOSE_AFTER_MS = 1100;

function show(message, kind = '') {
  const status = el('status');
  status.textContent = message;
  status.className = `status ${kind}`;
}

/**
 * Reads the page, tolerating the cases where it cannot.
 *
 * A capture is an improvement, never a requirement: a PDF viewer, a page that
 * loaded before the extension was installed, or a host the user has not granted
 * all return nothing here, and the save still happens -- the server falls back
 * to fetching the URL itself, which is what it did before this existed.
 */
async function capturePage(tab) {
  if (UNREACHABLE.test(tab.url)) return null;

  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readPage,
    });

    return result?.result ?? null;
  } catch {
    return null;
  }
}

function describe({ created, recaptured, link }) {
  if (created) return ['Saved.', 'ok'];

  // The extension rescuing a page the server could not reach is the whole
  // argument for capture, so it is worth saying out loud rather than reporting
  // the same "already saved" as an ordinary duplicate.
  if (recaptured) return ['Already saved — sent the page this time, retrying.', 'ok'];

  if (link.processingStatus === 'failed') {
    return ['Already saved. This page could not be read.', 'warn'];
  }

  return ['Already saved.', 'ok'];
}

/** Shared by both routes in; `capture` is only ever present for the current tab. */
async function send({ url, capture, onFailure }) {
  show('Saving…');

  try {
    const result = await saveLink({ url, capture });
    const [message, kind] = describe(result);
    show(message, kind);

    // Long enough to read, short enough that saving stays one gesture.
    setTimeout(() => window.close(), CLOSE_AFTER_MS);
  } catch (error) {
    onFailure?.();

    if (error instanceof ApiError && error.status === 401) {
      show('Not connected. Open Settings and paste an access token.', 'error');
      return;
    }

    show(error.message, 'error');
  }
}

/**
 * Wires the paste box.
 *
 * The `paste` event rather than an input listener: it fires once, with the
 * clipboard's own text, before the field updates -- so a paste saves and a
 * keystroke does not.
 *
 * The address is written into the box by hand rather than left to the browser's
 * own insertion, because disabling the field in the same tick can pre-empt it --
 * which would leave "Saved." on screen above an empty box, saying that something
 * was saved but not what. It is also the cleaned URL rather than the raw
 * clipboard text, so a link pasted out of a sentence shows what was actually
 * sent.
 */
function wirePaste(input) {
  const attempt = (text) => {
    const url = urlFromText(text);

    if (!url) {
      show('That does not look like a link.', 'warn');
      return;
    }

    input.value = url;
    input.disabled = true;

    send({ url, onFailure: () => {
      input.disabled = false;
      input.focus();
      input.select();
    } });
  };

  input.addEventListener('paste', (event) => {
    attempt(event.clipboardData?.getData('text') ?? '');
  });

  // Typed, dropped, or pasted with the mouse into a field that then lost the
  // paste event: Enter is the fallback for every way text arrives that is not
  // Ctrl+V.
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    attempt(input.value);
  });

  input.focus();
}

/** The secondary route: whatever tab is in front, with its page content. */
function wireCurrentTab(tab) {
  const button = el('save');

  if (!tab?.url || UNREACHABLE.test(tab.url)) {
    // Not an error state any more. Pasting still works on a chrome:// page,
    // which is more than this extension could previously do at all.
    el('current').hidden = true;
    return;
  }

  el('page-title').textContent = tab.title ?? '';
  el('page-url').textContent = tab.url.replace(/^https?:\/\//i, '');

  button.addEventListener('click', async () => {
    button.disabled = true;
    const capture = await capturePage(tab);
    await send({
      url: tab.url,
      capture: capture ?? undefined,
      onFailure: () => {
        button.disabled = false;
      },
    });
  });
}

async function start() {
  el('open-options').addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const { token } = await loadSettings();

  if (!token) {
    el('paste').disabled = true;
    el('save').disabled = true;
    show('Open Settings and paste an access token to get started.', 'warn');
    return;
  }

  wirePaste(el('paste'));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  wireCurrentTab(tab);
}

start();
