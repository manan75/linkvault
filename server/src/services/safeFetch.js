import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';

import { isBlockedAddress } from '../utils/privateAddress.js';

/**
 * The only way this codebase makes an HTTP request to a URL a user supplied.
 *
 * Nothing may bypass it. Everything dangerous about fetching a stranger's URL
 * is handled here, once:
 *
 *  - the hostname is resolved and *every* resolved address is checked, then the
 *    connection is made to the address that was checked, which closes the
 *    DNS-rebinding window between check and connect;
 *  - each redirect hop is re-checked, because a public URL is perfectly
 *    entitled to redirect to 169.254.169.254;
 *  - the response size cap is enforced while streaming, not after, so a
 *    multi-gigabyte body cannot exhaust memory before the check runs;
 *  - one deadline covers the whole exchange including redirects, so a chain of
 *    individually-fast hops cannot stall a worker indefinitely.
 */

const DEFAULTS = {
  timeoutMs: 8_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  // Honest about who is calling, and points at a page a site owner could block.
  userAgent: 'LinkVaultBot/0.1 (+https://github.com/manan75/linkvault)',
};

export class FetchError extends Error {
  /**
   * `retryable` is the transient/permanent split from the Phase 3 plan and is
   * decided here, where the cause is actually known. A blocked address or a 404
   * will fail identically on the next attempt; a timeout or a 503 may not.
   */
  constructor(kind, message, { retryable = false, status } = {}) {
    super(message);
    this.name = 'FetchError';
    this.kind = kind;
    this.retryable = retryable;
    this.status = status;
  }
}

/** Resolves a hostname and returns an address that is safe to connect to. */
async function resolveAllowedAddress(hostname, family, isBlocked) {
  let addresses;

  try {
    addresses = await dns.promises.lookup(hostname, { all: true, ...(family ? { family } : {}) });
  } catch (error) {
    // ENOTFOUND is a dead domain; EAI_AGAIN is the resolver being unwell.
    const retryable = error.code === 'EAI_AGAIN';
    throw new FetchError('dns', `Could not resolve ${hostname}`, { retryable });
  }

  if (addresses.length === 0) {
    throw new FetchError('dns', `Could not resolve ${hostname}`);
  }

  // Every answer is checked, not just the one that will be used: a name that
  // resolves to both a public and a private address is being used as a bypass.
  const blocked = addresses.find((entry) => isBlocked(entry.address));
  if (blocked) {
    throw new FetchError('blocked', 'That address is not publicly reachable');
  }

  return addresses[0];
}

/** Reads a response body, aborting the moment it grows past the cap. */
function readBody(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    response.on('data', (chunk) => {
      size += chunk.length;

      if (size > maxBytes) {
        response.destroy();
        reject(new FetchError('too-large', 'That page is too large to process'));
        return;
      }

      chunks.push(chunk);
    });

    response.on('end', () => resolve(Buffer.concat(chunks)));
    response.on('error', (error) =>
      reject(new FetchError('network', error.message, { retryable: true })),
    );
  });
}

/** Performs one hop, with no redirect following of its own. */
function requestOnce(url, { address, family, headers, timeoutMs, maxBytes }) {
  const transport = url.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers,
        // Connect to exactly the address that was vetted above. Node would
        // otherwise resolve the name again, and the answer could differ.
        lookup: (_hostname, options, callback) =>
          callback(null, options?.all ? [{ address, family }] : address, family),
      },
      (response) => {
        readBody(response, maxBytes).then(
          (body) => resolve({ response, body }),
          (error) => reject(error),
        );
      },
    );

    request.setTimeout(timeoutMs, () => {
      // Retryable, like the overall-deadline timeout below. A slow site is the
      // textbook transient failure; without this flag the socket timeout -- the
      // path a slow page actually takes -- was treated as permanent, so the
      // link failed on its first attempt and the backoff ladder never ran.
      request.destroy(
        new FetchError('timeout', 'That site took too long to respond', { retryable: true }),
      );
    });

    request.on('error', (error) => {
      if (error instanceof FetchError) reject(error);
      // Connection reset, refused, TLS failure: worth one more try later.
      else reject(new FetchError('network', error.message, { retryable: true }));
    });

    request.end();
  });
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Builds a fetch function.
 *
 * `isBlocked` is injectable for one reason: the transport (redirect handling,
 * size caps, timeouts) can only be tested against a server on loopback, which
 * the real guard correctly refuses. Tests narrow the predicate to allow their
 * own server and nothing else, so the redirect re-check is still exercised.
 * Production code uses the `safeFetch` export below and never overrides it.
 */
export function createSafeFetch({ isBlocked = isBlockedAddress, ...overrides } = {}) {
  const config = { ...DEFAULTS, ...overrides };

  return async function safeFetch(input, options = {}) {
    const timeoutMs = options.timeoutMs ?? config.timeoutMs;
    const maxBytes = options.maxBytes ?? config.maxBytes;
    const deadline = Date.now() + timeoutMs;

    let url = new URL(input);
    let hops = 0;

    while (true) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new FetchError('protocol', 'Only http and https URLs can be fetched');
      }

      // Credentials in a URL would be sent to whatever the redirect chain ends
      // at, and there is no reason for a bookmark to carry them.
      if (url.username || url.password) {
        throw new FetchError('protocol', 'URLs with embedded credentials are not fetched');
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new FetchError('timeout', 'That site took too long to respond', { retryable: true });
      }

      const resolved = await resolveAllowedAddress(url.hostname, options.family, isBlocked);

      const { response, body } = await requestOnce(url, {
        address: resolved.address,
        family: resolved.family,
        headers: {
          'User-Agent': config.userAgent,
          Accept: 'text/html,application/xhtml+xml',
          // No compression: the body is capped by size, and an encoded stream
          // would have to be inflated before the cap could mean anything.
          'Accept-Encoding': 'identity',
          Host: url.host,
        },
        timeoutMs: remaining,
        maxBytes,
      });

      if (REDIRECT_STATUSES.has(response.statusCode) && response.headers.location) {
        hops += 1;
        if (hops > config.maxRedirects) {
          throw new FetchError('redirect', 'That URL redirects too many times');
        }

        // Resolved against the current URL so a relative Location works, and
        // the loop re-checks the new host from the top.
        url = new URL(response.headers.location, url);
        continue;
      }

      if (response.statusCode >= 400) {
        // 429 and 5xx are the site being busy or broken; 4xx is the answer.
        const retryable = response.statusCode === 429 || response.statusCode >= 500;
        throw new FetchError('http', `The site returned ${response.statusCode}`, {
          retryable,
          status: response.statusCode,
        });
      }

      return {
        url: url.toString(),
        status: response.statusCode,
        contentType: response.headers['content-type'] ?? '',
        body,
      };
    }
  };
}

export const safeFetch = createSafeFetch();
