import { ApiError, saveLink } from './api.js';
import { readPage } from './capture.js';
import { loadSettings } from './config.js';

/**
 * One button, and the four things it has to get right.
 *
 * The product promise is save, forget, describe, find -- and saving from the
 * web app costs four actions: copy the URL, switch tabs, find LinkVault, paste.
 * That friction lands at the exact moment of intent, which is why bookmark
 * tools die. This is meant to be one click and no thought.
 */

const el = (id) => document.getElementById(id);

/** Pages the browser will not let a script into, and there is no point pretending. */
const UNREACHABLE = /^(chrome|chrome-extension|edge|about|devtools|view-source|file):/i;

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

async function save(tab) {
  const button = el('save');

  button.disabled = true;
  show('Saving…');

  try {
    const capture = await capturePage(tab);
    const result = await saveLink({ url: tab.url, capture: capture ?? undefined });

    const [message, kind] = describe(result);
    show(message, kind);

    // Long enough to read, short enough that saving stays one gesture.
    setTimeout(() => window.close(), 1200);
  } catch (error) {
    button.disabled = false;

    if (error instanceof ApiError && error.status === 401) {
      show('Not connected. Open Settings and paste an access token.', 'error');
      return;
    }

    show(error.message, 'error');
  }
}

async function start() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  el('page-title').textContent = tab?.title ?? '';
  el('page-url').textContent = (tab?.url ?? '').replace(/^https?:\/\//i, '');

  el('open-options').addEventListener('click', (event) => {
    event.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const { token } = await loadSettings();

  if (!token) {
    el('save').disabled = true;
    show('Open Settings and paste an access token to get started.', 'warn');
    return;
  }

  if (!tab?.url || UNREACHABLE.test(tab.url)) {
    el('save').disabled = true;
    show('There is nothing to save on this page.', 'warn');
    return;
  }

  el('save').addEventListener('click', () => save(tab));
}

start();
