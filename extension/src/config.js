/**
 * Where the extension keeps its two settings, and what they default to.
 *
 * `chrome.storage.local` rather than `sync`: the token is a credential, and
 * `sync` would push it to every browser signed into the same Google account,
 * including ones the user did not mean to authorise. A credential should live
 * exactly where it was installed.
 */

const DEFAULTS = {
  // Must match a `host_permissions` entry in the manifest, or the fetch is
  // blocked with no useful error. Both allowed values are listed there.
  apiBase: 'https://linkvault-api-uenh.onrender.com/api',
  token: '',
};

export async function loadSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

/** The base with any trailing slash removed, so paths concatenate predictably. */
export const normalizeApiBase = (value) => value.trim().replace(/\/+$/, '');
