import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { AppearanceMenu } from '../components/AppearanceMenu';
import { useAuth } from '../context/auth-context';
import { authApi } from '../lib/api';

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

/**
 * The token, shown once.
 *
 * Deliberately loud and deliberately not dismissable by accident: the server
 * stores only a hash, so this is genuinely the only moment it exists anywhere
 * the user can reach. A quiet row in the table below would be a promise the
 * system cannot keep.
 */
function NewToken({ token, onDone }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      // Clipboard access can be refused; the token is on screen either way.
      setCopied(false);
    }
  };

  return (
    <div className="rounded-xl border border-accent bg-accent-soft p-4">
      <p className="text-sm font-medium">Copy this now — it is not shown again.</p>

      <code className="mt-3 block overflow-x-auto rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs">
        {token}
      </code>

      <div className="mt-3 flex items-center gap-3">
        <button type="button" onClick={copy} className="lv-button">
          {copied ? 'Copied' : 'Copy token'}
        </button>
        <button type="button" onClick={onDone} className="lv-button-quiet">
          Done
        </button>
      </div>
    </div>
  );
}

function TokenRow({ token, onRevoke }) {
  const [isConfirming, setIsConfirming] = useState(false);

  return (
    <li className="flex flex-wrap items-center justify-between gap-3 border-b border-line py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="truncate font-medium">{token.name}</p>
        <p className="text-xs text-ink-faint">
          {`Created ${dateFormat.format(new Date(token.createdAt))}`}
          {token.lastUsedAt
            ? ` · last used ${dateFormat.format(new Date(token.lastUsedAt))}`
            : ' · never used'}
        </p>
      </div>

      {isConfirming ? (
        <div className="flex items-center gap-3 text-xs">
          <span className="text-ink-muted">Revoke immediately?</span>
          <button
            type="button"
            onClick={() => onRevoke(token.id)}
            className="font-medium text-danger underline underline-offset-2"
          >
            Revoke
          </button>
          <button type="button" onClick={() => setIsConfirming(false)} className="text-ink-muted">
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setIsConfirming(true)}
          className="lv-button-quiet shrink-0"
        >
          Revoke
        </button>
      )}
    </li>
  );
}

/**
 * Where the browser extension gets its credential.
 *
 * This page exists because the extension cannot sign in: its popup runs on
 * `chrome-extension://`, which is cross-site to the API, so the session cookie
 * is never attached. A token is the credential that works there -- and the
 * instructions sit beside the button that mints one, because a token with no
 * explanation of where to paste it is a dead end.
 */
export function SettingsPage() {
  const { user, logout } = useAuth();

  const [tokens, setTokens] = useState([]);
  const [name, setName] = useState('Chrome extension');
  const [issued, setIssued] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCreating, setIsCreating] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const { tokens: list } = await authApi.tokens();
      setTokens(list);
    } catch (cause) {
      setError(cause?.message ?? 'Could not load your access tokens.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = async (event) => {
    event.preventDefault();
    setError(null);
    setIsCreating(true);

    try {
      const { token } = await authApi.createToken(name.trim());
      setIssued(token);
      setName('Chrome extension');
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? 'Could not create that token.');
    } finally {
      setIsCreating(false);
    }
  };

  const revoke = async (id) => {
    setError(null);

    try {
      await authApi.revokeToken(id);
      await refresh();
    } catch (cause) {
      setError(cause?.message ?? 'Could not revoke that token.');
    }
  };

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-surface/85 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-3">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            LinkVault
          </Link>
          <div className="flex items-center gap-2">
            <span className="hidden px-2 text-sm text-ink-muted sm:inline">{user.email}</span>
            <AppearanceMenu />
            <button type="button" onClick={logout} className="lv-button-quiet">
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-8">
        <Link to="/" className="text-sm text-ink-muted underline underline-offset-4">
          ← Back to your vault
        </Link>

        <h1 className="mt-4 text-xl font-semibold tracking-tight">Access tokens</h1>
        <p className="mt-2 max-w-prose text-sm text-ink-muted">
          The browser extension signs in with a token rather than a password, so revoking it here
          disconnects that browser and nothing else. A token can read and change everything in your
          vault, so treat it like a password — and it can never create another token, which is why
          this page needs you signed in.
        </p>

        <section className="mt-8">
          {issued ? (
            <NewToken token={issued} onDone={() => setIssued(null)} />
          ) : (
            <form onSubmit={create} className="flex flex-wrap items-end gap-3">
              <div className="min-w-0 flex-1 space-y-1.5">
                <label htmlFor="token-name" className="block text-sm font-medium">
                  What is this token for?
                </label>
                <input
                  id="token-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={60}
                  required
                  placeholder="Chrome extension"
                  className="lv-field w-full"
                />
              </div>
              <button type="submit" disabled={isCreating} className="lv-button">
                {isCreating ? 'Creating…' : 'Create token'}
              </button>
            </form>
          )}

          {error ? (
            <p role="alert" className="mt-3 text-sm text-danger">
              {error}
            </p>
          ) : null}
        </section>

        <section className="mt-10">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            Your tokens
          </h2>

          {isLoading ? (
            <p className="mt-3 text-sm text-ink-faint">Loading…</p>
          ) : tokens.length === 0 ? (
            <p className="mt-3 text-sm text-ink-faint">You have no access tokens yet.</p>
          ) : (
            <ul className="mt-3">
              {tokens.map((token) => (
                <TokenRow key={token.id} token={token} onRevoke={revoke} />
              ))}
            </ul>
          )}
        </section>

        <section className="mt-12 rounded-xl border border-line bg-surface p-5">
          <h2 className="font-medium">Connecting the extension</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-ink-muted">
            <li>Create a token above and copy it.</li>
            <li>
              Open the LinkVault extension, choose <strong>Settings</strong>, and paste it in.
            </li>
            <li>It will tell you which account it connected as.</li>
          </ol>
          <p className="mt-3 max-w-prose text-sm text-ink-muted">
            The extension sends what your browser can see on the page. That is how it saves things
            this server cannot reach on its own — pages behind a login, and sites that refuse
            requests from a datacenter.
          </p>
        </section>
      </main>
    </div>
  );
}
