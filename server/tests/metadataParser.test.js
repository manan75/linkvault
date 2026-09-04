import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { decodeHtml, parseMetadata } from '../src/services/metadataParser.js';

const fixture = (name) =>
  fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8');

const parse = (name, finalUrl = 'https://example.com/blog/post') =>
  parseMetadata(fixture(name), { finalUrl });

describe('parseMetadata', () => {
  it('prefers Open Graph over the document title', () => {
    const result = parse('rich-og.html');

    assert.equal(result.title, 'Redis Caching Strategies');
    assert.equal(result.description, 'How to make an API faster without rewriting it.');
    assert.equal(result.author, 'Jane Roe');
    assert.equal(result.thumbnail, 'https://cdn.example.com/redis.png');
    assert.equal(result.favicon, 'https://cdn.example.com/favicon.svg');
  });

  it('falls back to <title>, collapsing the whitespace around it', () => {
    const result = parse('bare-title.html');

    assert.equal(result.title, 'A page with only a title');
    assert.equal(result.description, '');
    assert.equal(result.author, '');
    assert.equal(result.thumbnail, '');
  });

  it('guesses /favicon.ico when the page declares none', () => {
    assert.equal(parse('bare-title.html').favicon, 'https://example.com/favicon.ico');
  });

  it('leaves the title empty when the page declares none', () => {
    // Not the domain: the card already prints that on the line below, and a
    // domain stored here would permanently block the real title, because
    // `completeLink` only fills a field that is still empty. The client names
    // the link from its URL instead.
    const result = parseMetadata('<html><body>hi</body></html>', {
      finalUrl: 'https://example.com/',
    });

    assert.equal(result.title, '');
  });

  it('resolves relative asset paths against the URL the fetch ended at', () => {
    const result = parse('relative-assets.html', 'https://cdn.example.org/docs/page.html');

    assert.equal(result.thumbnail, 'https://cdn.example.org/images/hero.jpg');
    assert.equal(result.favicon, 'https://cdn.example.org/assets/icon.png');
  });

  it('reads an author out of JSON-LD when no meta tag carries one', () => {
    assert.equal(parse('relative-assets.html').author, 'Sam Okafor');
  });

  it('refuses image URLs that are not http(s)', () => {
    const result = parse('hostile.html');

    // Both of these end up in an <img src> in the client, so a javascript: or
    // data: URL surviving this far would be stored XSS.
    assert.equal(result.thumbnail, '');
    assert.equal(result.favicon, 'https://example.com/favicon.ico');
  });

  it('survives malformed markup and normalises what it finds', () => {
    const result = parse('hostile.html');

    assert.equal(result.title, 'Title with a tab and a newline');
    assert.equal(result.description, 'Trailing whitespace and & entities.');
  });

  it('caps a description at the schema limit', () => {
    const long = 'word '.repeat(1000);
    const result = parseMetadata(`<meta name="description" content="${long}">`, {
      finalUrl: 'https://example.com/',
    });

    assert.ok(result.description.length <= 2000);
  });
});

describe('decodeHtml', () => {
  it('uses the charset from the content type header', () => {
    const body = Buffer.from([0x63, 0x61, 0x66, 0xe9]); // "café" in latin1

    assert.equal(decodeHtml(body, 'text/html; charset=iso-8859-1'), 'café');
  });

  it('falls back to the charset declared in the document', () => {
    const body = Buffer.concat([
      Buffer.from('<meta charset="iso-8859-1">', 'latin1'),
      Buffer.from([0xe9]),
    ]);

    assert.ok(decodeHtml(body, 'text/html').endsWith('é'));
  });

  it('falls back to UTF-8 rather than throwing on an unknown charset', () => {
    assert.equal(decodeHtml(Buffer.from('ok', 'utf8'), 'text/html; charset=x-nonsense'), 'ok');
  });
});
