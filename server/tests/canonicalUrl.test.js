import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { canonicalizeUrl } from '../src/utils/canonicalUrl.js';

const canonical = (input) => canonicalizeUrl(input).canonicalUrl;

describe('canonicalizeUrl', () => {
  it('keeps the URL the user pasted alongside the canonical form', () => {
    const result = canonicalizeUrl('https://WWW.Example.com/Article#notes');

    assert.equal(result.url, 'https://WWW.Example.com/Article#notes');
    assert.equal(result.canonicalUrl, 'https://example.com/Article');
  });

  it('lowercases the scheme and host but not the path', () => {
    assert.equal(canonical('HTTPS://Example.COM/Path/To/Page'), 'https://example.com/Path/To/Page');
  });

  it('strips a leading www.', () => {
    assert.equal(canonical('https://www.example.com/a'), 'https://example.com/a');
  });

  it('drops the fragment', () => {
    assert.equal(canonical('https://example.com/a#section-3'), 'https://example.com/a');
  });

  it('drops a trailing slash on a non-empty path but keeps the root slash', () => {
    assert.equal(canonical('https://example.com/blog/post/'), 'https://example.com/blog/post');
    assert.equal(canonical('https://example.com'), 'https://example.com/');
    assert.equal(canonical('https://example.com/'), 'https://example.com/');
  });

  it('strips known tracking parameters', () => {
    assert.equal(
      canonical('https://example.com/a?utm_source=x&utm_medium=y&fbclid=z&gclid=g&ref=r&mc_eid=m'),
      'https://example.com/a',
    );
  });

  it('preserves meaningful query parameters and their order', () => {
    assert.equal(
      canonical('https://www.youtube.com/watch?v=abc123&t=42'),
      'https://youtube.com/watch?v=abc123&t=42',
    );
  });

  it('keeps meaningful parameters while removing trackers around them', () => {
    assert.equal(
      canonical('https://example.com/doc?utm_source=news&id=7&fbclid=1'),
      'https://example.com/doc?id=7',
    );
  });

  it('treats two cosmetically different URLs for one page as the same bookmark', () => {
    assert.equal(
      canonical('http://example.com/post/'),
      canonical('http://WWW.Example.com/post#top'),
    );
  });

  it('does not merge distinct pages that differ only by query value', () => {
    assert.notEqual(canonical('https://example.com/w?v=a'), canonical('https://example.com/w?v=b'));
  });

  it('does not merge http and https, which are different origins', () => {
    assert.notEqual(canonical('http://example.com/a'), canonical('https://example.com/a'));
  });

  it('assumes https when the user omits the scheme', () => {
    const result = canonicalizeUrl('example.com/article');

    assert.equal(result.canonicalUrl, 'https://example.com/article');
    assert.equal(result.url, 'https://example.com/article');
  });

  it('reports the domain without www', () => {
    assert.equal(canonicalizeUrl('https://www.Example.com/a').domain, 'example.com');
  });

  it('rejects input that is not a URL', () => {
    for (const input of ['', '   ', 'not a url', 'http://', 'https://localhost/x']) {
      assert.throws(() => canonicalizeUrl(input), { statusCode: 400 }, `expected ${input} to fail`);
    }
  });

  it('rejects schemes that cannot be fetched or that can execute', () => {
    for (const input of ['javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'file:///etc/passwd']) {
      assert.throws(() => canonicalizeUrl(input), { statusCode: 400 }, `expected ${input} to fail`);
    }
  });
});
