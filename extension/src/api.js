import { loadSettings, normalizeApiBase } from './config.js';

/**
 * The extension's half of the API contract.
 *
 * Every request carries `Authorization: Bearer`, never a cookie -- the popup
 * runs on `chrome-extension://`, which is cross-site, so no cookie would be
 * attached even if one existed here.
 *
 * CORS never enters into it: a request to a host listed in the manifest's
 * `host_permissions` is made with the extension's own privileges rather than a
 * web page's. That is also why the API base cannot be freely typed -- a host the
 * manifest does not name is blocked with no error worth reading.
 */

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function call(path, { method = 'GET', body } = {}) {
  const { apiBase, token } = await loadSettings();

  if (!token) {
    throw new ApiError('Not connected. Open the options page and paste an access token.', 401);
  }

  let response;

  try {
    response = await fetch(`${normalizeApiBase(apiBase)}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // A free Render instance takes about fifty seconds to wake from idle, and
    // this is what that looks like from here. Saying so beats "failed to fetch".
    throw new ApiError('Could not reach LinkVault. It may still be waking up.', 0);
  }

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(payload?.error?.message ?? `Request failed (${response.status})`, response.status);
  }

  return payload;
}

/**
 * Saves a URL with what the page said about itself.
 *
 * The response distinguishes three outcomes the popup shows differently:
 * `created` for a new bookmark, `recaptured` for one that had failed and has
 * just been handed content the server could not reach, and neither for a URL
 * already saved and already fine.
 */
export function saveLink({ url, capture }) {
  return call('/links', { method: 'POST', body: { url, capture } });
}

/** Used only to tell the user which account a token belongs to. */
export function whoAmI() {
  return call('/auth/me');
}
