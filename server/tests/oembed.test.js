import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { endpointFor, fetchOembed, fieldsFromOembed, PROVIDERS } = await import(
  '../src/services/oembed.js'
);

/** A provider reply in the shape YouTube actually returns. */
const YOUTUBE_REPLY = {
  title: 'Rick Astley - Never Gonna Give You Up (Official Video)',
  author_name: 'Rick Astley',
  thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
  provider_name: 'YouTube',
  type: 'video',
  html: '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
};

const reply = (payload) => async () => ({ body: Buffer.from(JSON.stringify(payload)) });

describe('endpointFor', () => {
  it('recognises the providers it covers, including subdomains and short forms', () => {
    const cases = [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://vimeo.com/76979871',
      'https://soundcloud.com/forss/flickermood',
      'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
      'https://www.reddit.com/r/programming/comments/1abc2d/x/',
    ];

    for (const url of cases) {
      assert.ok(endpointFor(url), `expected a provider for ${url}`);
    }
  });

  it('percent-encodes the URL into the endpoint', () => {
    const endpoint = endpointFor('https://www.youtube.com/watch?v=dQw4w9WgXcQ');

    assert.ok(endpoint.startsWith('https://www.youtube.com/oembed?format=json&url='));
    // Unencoded, the `&v=` would become a parameter of the *endpoint* rather
    // than part of the URL being asked about.
    assert.ok(endpoint.includes('%3Fv%3DdQw4w9WgXcQ'));
  });

  it('returns null for anything it does not cover', () => {
    assert.equal(endpointFor('https://example.com/page'), null);
    assert.equal(endpointFor('not a url'), null);
  });

  it('matches on the host, not on the URL containing a provider name', () => {
    // The trap a regex over the whole URL would fall into. Asking YouTube about
    // an attacker's page is pointless at best; matching this way is how a
    // lookup gets steered.
    assert.equal(endpointFor('https://evil.example.com/youtube.com/watch?v=x'), null);
    assert.equal(endpointFor('https://notyoutube.com/watch?v=x'), null);
    assert.equal(endpointFor('https://youtube.com.evil.example/watch?v=x'), null);
  });
});

describe('fieldsFromOembed', () => {
  const pageUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  it('maps a reply onto the fields a bookmark stores', () => {
    const fields = fieldsFromOembed(YOUTUBE_REPLY, { pageUrl });

    assert.equal(fields.title, 'Rick Astley - Never Gonna Give You Up (Official Video)');
    assert.equal(fields.author, 'Rick Astley');
    assert.equal(fields.thumbnail, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
    assert.equal(fields.favicon, 'https://www.youtube.com/favicon.ico');
    // oEmbed has no description field. Empty is the honest answer, and it is
    // what lets enrichment tag the link without inventing a summary.
    assert.equal(fields.description, '');
  });

  it('never stores an image reference that is not http(s)', () => {
    const fields = fieldsFromOembed(
      { ...YOUTUBE_REPLY, thumbnail_url: 'javascript:alert(1)' },
      { pageUrl },
    );

    // A provider is likelier to behave than an arbitrary page. That is not a
    // reason to trust it: this value ends up in an <img src> either way.
    assert.equal(fields.thumbnail, '');
  });

  it('returns null when the reply names nothing', () => {
    assert.equal(fieldsFromOembed(null, { pageUrl }), null);
    assert.equal(fieldsFromOembed({}, { pageUrl }), null);
    assert.equal(fieldsFromOembed({ title: '   ' }, { pageUrl }), null);
  });
});

describe('fetchOembed', () => {
  const url = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

  it('asks for JSON, briefly, and with a cap sized for a kilobyte reply', async () => {
    let seen;
    await fetchOembed(url, {
      fetchJson: async (endpoint, options) => {
        seen = { endpoint, options };
        return { body: Buffer.from(JSON.stringify(YOUTUBE_REPLY)) };
      },
    });

    assert.equal(seen.options.accept, 'application/json');
    assert.ok(seen.options.timeoutMs <= 5_000);
    assert.ok(seen.options.maxBytes <= 64 * 1024);
  });

  it('returns the fields when the provider answers', async () => {
    const fields = await fetchOembed(url, { fetchJson: reply(YOUTUBE_REPLY) });

    assert.equal(fields.title, YOUTUBE_REPLY.title);
  });

  it('never asks about a URL no provider covers', async () => {
    let asked = false;
    const fields = await fetchOembed('https://example.com/page', {
      fetchJson: async () => {
        asked = true;
        return { body: Buffer.from('{}') };
      },
    });

    assert.equal(asked, false);
    assert.equal(fields, null);
  });

  /**
   * The property the whole design rests on: this route is an optimisation, so
   * every way it can go wrong has to mean "nothing to say" and let the ordinary
   * page fetch run. A throw here would fail a bookmark that was about to work.
   */
  it('returns null rather than throwing, for every failure a provider can produce', async () => {
    const failures = {
      'a 404 for something that does not exist': async () => {
        throw new Error('The site returned 404');
      },
      'a timeout': async () => {
        throw new Error('That site took too long to respond');
      },
      'a body that is not JSON': async () => ({ body: Buffer.from('<!DOCTYPE html>') }),
      'JSON that is not an object': async () => ({ body: Buffer.from('"nope"') }),
      'an empty body': async () => ({ body: Buffer.from('') }),
    };

    for (const [name, fetchJson] of Object.entries(failures)) {
      assert.equal(await fetchOembed(url, { fetchJson }), null, `should be null for ${name}`);
    }
  });
});

describe('the provider table', () => {
  it('points every endpoint at https and leaves it ready for a URL', () => {
    for (const { hosts, endpoint } of PROVIDERS) {
      assert.ok(endpoint.startsWith('https://'), `${hosts[0]} must be https`);
      assert.ok(/[?&]url=$/.test(endpoint), `${hosts[0]} must end at the url parameter`);
    }
  });
});
