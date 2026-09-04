/**
 * Where the API lives.
 *
 * Unset -- which is every local run -- this stays `/api` and the Vite dev proxy
 * makes the call same-origin, so nothing about cookies needs thinking about.
 *
 * In production there is no proxy: the client is served from Vercel and the API
 * from Render, so this is set at build time to the full API base including the
 * `/api` prefix (`https://<service>.onrender.com/api`). That makes every request
 * cross-site, which is why the session cookie is `sameSite: 'none'` and why
 * `CLIENT_ORIGIN` on the server has to name this exact origin.
 *
 * Read through `import.meta.env`, so the value is baked into the bundle at build
 * time rather than read at runtime -- changing it means a redeploy of the client,
 * not a restart.
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/+$/, '');

/** Error carrying the status and field-level details returned by the API. */
export class ApiRequestError extends Error {
  constructor(message, { status, details } = {}) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.details = details ?? [];
  }
}

/**
 * Thin fetch wrapper: always sends the session cookie, always surfaces API
 * errors as ApiRequestError so callers have one failure shape to handle.
 */
async function request(path, { method = 'GET', body } = {}) {
  let response;

  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiRequestError('Could not reach the server. Is it running?');
  }

  if (response.status === 204) return null;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiRequestError(payload?.error?.message ?? 'Request failed', {
      status: response.status,
      details: payload?.error?.details,
    });
  }

  return payload;
}

/**
 * Builds a query string, skipping empty values and repeating array entries so
 * `tag: ['react', 'testing']` reaches the API as `?tag=react&tag=testing`.
 */
function toQuery(params = {}) {
  const search = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) value.forEach((entry) => search.append(key, entry));
    else search.append(key, String(value));
  }

  const query = search.toString();
  return query ? `?${query}` : '';
}

export const authApi = {
  register: (data) => request('/auth/register', { method: 'POST', body: data }),
  login: (data) => request('/auth/login', { method: 'POST', body: data }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),

  // Access tokens, for the browser extension and anything else that cannot hold
  // a cookie. `create` is the only call that ever returns the token itself.
  tokens: () => request('/auth/tokens'),
  createToken: (name) => request('/auth/tokens', { method: 'POST', body: { name } }),
  revokeToken: (id) => request(`/auth/tokens/${id}`, { method: 'DELETE' }),
};

export const linksApi = {
  list: (params) => request(`/links${toQuery(params)}`),
  save: (url, collectionId) =>
    request('/links', { method: 'POST', body: collectionId ? { url, collectionId } : { url } }),
  update: (id, patch) => request(`/links/${id}`, { method: 'PATCH', body: patch }),
  remove: (id) => request(`/links/${id}`, { method: 'DELETE' }),
  retry: (id) => request(`/links/${id}/retry`, { method: 'POST' }),
  tags: () => request('/links/tags'),
  // Renaming onto an existing tag merges the two; the API returns the refreshed
  // vocabulary so the sidebar does not need a second round trip.
  renameTag: (name, to) =>
    request(`/links/tags/${encodeURIComponent(name)}`, { method: 'PATCH', body: { name: to } }),
};

export const collectionsApi = {
  list: () => request('/collections'),
  create: (name) => request('/collections', { method: 'POST', body: { name } }),
  rename: (id, name) => request(`/collections/${id}`, { method: 'PATCH', body: { name } }),
  remove: (id) => request(`/collections/${id}`, { method: 'DELETE' }),
};
