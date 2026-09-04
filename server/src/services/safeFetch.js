import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

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
 *  - the response size cap is enforced while streaming and *after* inflation,
 *    so neither a multi-gigabyte body nor a small archive that expands into one
 *    can exhaust memory before the check runs;
 *  - one deadline covers the whole exchange including redirects, so a chain of
 *    individually-fast hops cannot stall a worker indefinitely.
 */

const DEFAULTS = {
  timeoutMs: 8_000,
  maxBytes: 2 * 1024 * 1024,
  maxRedirects: 3,
  // Honest about who is calling, and points at a page a site owner could block.
  //
  // It stays honest. Sending `Discordbot` or a Chrome string would get past
  // some of what refuses us, and both are lies about identity told to bypass
  // access control. Neither would even work on the hard cases: sites that
  // privilege known crawlers verify them by reverse DNS on the source address,
  // and LeetCode's 403 was measured against a real Chrome User-Agent and
  // refused just the same, because it matches on TLS fingerprint.
  userAgent: 'LinkVaultBot/0.1 (+https://github.com/manan75/linkvault)',
  accept: 'text/html,application/xhtml+xml',
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

/**
 * Wraps the response in a decompressor when the server compressed it.
 *
 * The cap is applied to whatever comes *out* of this, never to what went in --
 * which is the whole reason the request used to ask for `identity`. A byte
 * limit measured on a compressed stream is not a limit: a few hundred kilobytes
 * of gzip can inflate into gigabytes, and a zip bomb is a perfectly ordinary
 * thing for a hostile URL to point at.
 *
 * Inflating in a stream rather than after the fact is what makes the guarantee
 * hold: `readBody` counts decompressed bytes as they arrive and destroys the
 * source the moment they exceed the cap, so the bomb is never assembled.
 *
 * Worth the machinery because the measurement is not marginal. Asking for
 * `identity` was costing 4x on YouTube (1325KB against 314KB), 5.7x on
 * Wikipedia and 6x on react.dev, against an 8-second deadline on an instance
 * with a tenth of a CPU.
 */
function decompress(response) {
  const encoding = String(response.headers['content-encoding'] ?? '').trim().toLowerCase();

  // `finishFlush: Z_SYNC_FLUSH` tolerates a truncated stream. Plenty of servers
  // close without the trailer, and a body that decoded fine up to that point is
  // worth keeping -- the metadata lives in the <head> either way.
  const options = { finishFlush: zlib.constants.Z_SYNC_FLUSH };

  if (encoding === 'gzip' || encoding === 'x-gzip') return response.pipe(zlib.createGunzip(options));
  if (encoding === 'deflate') return response.pipe(zlib.createInflate(options));
  if (encoding === 'br') return response.pipe(zlib.createBrotliDecompress());

  return response;
}

/** Reads a response body, aborting the moment it grows past the cap. */
function readBody(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const stream = decompress(response);
    const chunks = [];
    let size = 0;

    stream.on('data', (chunk) => {
      size += chunk.length;

      if (size > maxBytes) {
        // Both ends: the decompressor would otherwise keep inflating what the
        // socket has already delivered.
        response.destroy();
        stream.destroy();
        reject(new FetchError('too-large', 'That page is too large to process'));
        return;
      }

      chunks.push(chunk);
    });

    stream.on('end', () => resolve(Buffer.concat(chunks)));

    // A corrupt or truncated encoded body is the site's fault, not ours, and is
    // worth one more attempt -- the same reading as a reset connection.
    stream.on('error', (error) =>
      reject(new FetchError('network', error.message, { retryable: true })),
    );

    // Only reachable when `decompress` returned a wrapper; otherwise this is
    // the same emitter as above and the handler is simply redundant.
    if (stream !== response) {
      response.on('error', (error) =>
        reject(new FetchError('network', error.message, { retryable: true })),
      );
    }
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
    const accept = options.accept ?? config.accept;
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
          Accept: accept,
          // Safe because the cap in `readBody` counts decompressed bytes as
          // they arrive. Brotli is offered last: it decodes more slowly, which
          // matters on a tenth of a CPU, so it is a fallback rather than a
          // preference.
          'Accept-Encoding': 'gzip, deflate, br;q=0.5',
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
