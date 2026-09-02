import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';

import { createSafeFetch, FetchError, safeFetch } from '../src/services/safeFetch.js';
import { isBlockedAddress } from '../src/utils/privateAddress.js';

/**
 * The transport tests need a server, and a server can only listen on loopback --
 * which the real guard rightly refuses. So they narrow the guard to allow this
 * one address and nothing else. Every other address, including the one the
 * redirect test bounces to, is still judged by the production rules.
 */
const allowingOnlyLoopback = (address) => address !== '127.0.0.1' && isBlockedAddress(address);

let server;
let origin;

/** Set per test to decide how the next request is answered. */
let handler = () => {};

before(async () => {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const fetchLocal = createSafeFetch({ isBlocked: allowingOnlyLoopback, timeoutMs: 2000 });

/** Asserts the call rejects with a FetchError of the expected kind. */
async function failsWith(promise, kind) {
  const error = await promise.then(
    () => null,
    (cause) => cause,
  );

  assert.ok(error instanceof FetchError, `expected a FetchError, got ${error}`);
  assert.equal(error.kind, kind);
  return error;
}

describe('safeFetch address guard', () => {
  it('refuses a private address', async () => {
    await failsWith(safeFetch('http://127.0.0.1:9/'), 'blocked');
    await failsWith(safeFetch('http://10.0.0.5/'), 'blocked');
  });

  it('refuses the cloud metadata endpoint', async () => {
    await failsWith(safeFetch('http://169.254.169.254/latest/meta-data/'), 'blocked');
  });

  it('refuses a public URL that redirects to a private address', async () => {
    // The case a hostname check alone would miss entirely.
    handler = (req, res) => {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    };

    await failsWith(fetchLocal(`${origin}/redirect-to-metadata`), 'blocked');
  });

  it('refuses non-http protocols and embedded credentials', async () => {
    await failsWith(safeFetch('file:///etc/passwd'), 'protocol');
    await failsWith(safeFetch('http://user:secret@example.com/'), 'protocol');
  });
});

describe('safeFetch transport', () => {
  it('returns the body, status and content type', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<title>Hello</title>');
    };

    const result = await fetchLocal(`${origin}/page`);

    assert.equal(result.status, 200);
    assert.match(result.contentType, /text\/html/);
    assert.equal(result.body.toString(), '<title>Hello</title>');
  });

  it('sends no compressed encoding, so the size cap means something', async () => {
    let seen;
    handler = (req, res) => {
      seen = req.headers['accept-encoding'];
      res.end('ok');
    };

    await fetchLocal(`${origin}/headers`);

    assert.equal(seen, 'identity');
  });

  it('follows a redirect and reports the final URL', async () => {
    handler = (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/end' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<title>Arrived</title>');
    };

    const result = await fetchLocal(`${origin}/start`);

    assert.equal(result.url, `${origin}/end`);
    assert.equal(result.body.toString(), '<title>Arrived</title>');
  });

  it('gives up on a redirect loop', async () => {
    handler = (req, res) => {
      res.writeHead(302, { Location: '/again' });
      res.end();
    };

    await failsWith(fetchLocal(`${origin}/loop`), 'redirect');
  });

  it('stops reading a body that exceeds the cap', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      // Written in chunks, so the cap has to be enforced mid-stream rather
      // than by trusting a Content-Length header.
      for (let index = 0; index < 20; index += 1) res.write('x'.repeat(1024));
      res.end();
    };

    await failsWith(fetchLocal(`${origin}/huge`, { maxBytes: 4096 }), 'too-large');
  });

  it('gives up on a site that never answers, but calls it worth retrying', async () => {
    handler = () => {}; // deliberately leaves the request hanging

    const error = await failsWith(fetchLocal(`${origin}/slow`, { timeoutMs: 150 }), 'timeout');

    // A slow site is transient by definition. Marked permanent, a link would
    // fail on its first attempt and never use its remaining two.
    assert.equal(error.retryable, true);
  });

  it('treats 404 as permanent and 503 as worth retrying', async () => {
    handler = (req, res) => {
      res.writeHead(req.url === '/missing' ? 404 : 503);
      res.end();
    };

    const missing = await failsWith(fetchLocal(`${origin}/missing`), 'http');
    assert.equal(missing.retryable, false);

    const unavailable = await failsWith(fetchLocal(`${origin}/unavailable`), 'http');
    assert.equal(unavailable.retryable, true);
  });
});
