const API_BASE = '/api';

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

export const authApi = {
  register: (data) => request('/auth/register', { method: 'POST', body: data }),
  login: (data) => request('/auth/login', { method: 'POST', body: data }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () => request('/auth/me'),
};
