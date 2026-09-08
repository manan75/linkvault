import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import request from 'supertest';

import { clearTestDatabase, signUp, startTestDatabase, stopTestDatabase } from './helpers.js';

const { createApp } = await import('../src/app.js');
const { Link } = await import('../src/models/Link.js');
const { reindexKeywords } = await import('../src/services/searchIndex.js');
const { tokenize, buildSearchTokens, matchPrefix, queryTerms } = await import(
  '../src/services/searchTokens.js',
);

const app = createApp();

before(startTestDatabase);
after(stopTestDatabase);
afterEach(clearTestDatabase);

const list = (cookie, query = '') => request(app).get(`/api/links${query}`).set('Cookie', cookie);

let seedCounter = 0;

/**
 * Writes a bookmark directly.
 *
 * The API route deliberately will not let a caller set a title or a summary --
 * those belong to the pipeline -- and reaching each field through `PATCH` would
 * put three requests of setup in front of every assertion here. The
 * `pre('save')` hook is part of what is under test, and `Link.create` runs it.
 */
async function seed(userId, fields) {
  seedCounter += 1;
  const url = fields.url ?? `https://example.com/${seedCounter}`;

  return Link.create({
    domain: 'example.com',
    ...fields,
    userId,
    url,
    canonicalUrl: url,
  });
}

const titles = (body) => body.links.map((link) => link.title);

describe('the search tokenizer', () => {
  it('splits a compound word at its camel-case boundary as well as keeping it whole', () => {
    assert.deepEqual(tokenize('PostgreSQL'), ['postgresql', 'postgre', 'sql']);
  });

  it('keeps single-character query terms, which the document side drops', () => {
    assert.deepEqual(queryTerms('r'), ['r']);
    assert.deepEqual(tokenize('a react app'), ['react', 'app']);
  });

  it('indexes the fields a bookmark is remembered by, and not the scheme', () => {
    const tokens = buildSearchTokens({
      title: 'Redis Caching',
      tags: ['backend'],
      url: 'https://www.redis.io/docs',
      domain: 'redis.io',
    });

    assert.ok(tokens.includes('redis'));
    assert.ok(tokens.includes('backend'));
    assert.ok(tokens.includes('docs'));
    assert.ok(!tokens.includes('https'));
    assert.ok(!tokens.includes('www'));
  });
  it('reduces a typed inflection to the stem it is matched by', () => {
    assert.equal(matchPrefix('listings'), 'listing');
    assert.equal(matchPrefix('caching'), 'cach');
    assert.equal(matchPrefix('libraries'), 'librar');
    assert.equal(matchPrefix('watches'), 'watch');
  });

  it('leaves a term alone when the stem would be too short to mean anything', () => {
    // "car" would otherwise match "careers", and "tag" would match "target".
    assert.equal(matchPrefix('cars'), 'cars');
    assert.equal(matchPrefix('tags'), 'tags');
    assert.equal(matchPrefix('react'), 'react');
  });
});

describe('keyword search', () => {
  /**
   * The defect that prompted this work. `$text` matched whole stemmed words, so
   * every prefix below returned nothing until its final character landed.
   */
  it('matches a prefix, from the first keystroke onwards', async () => {
    const { cookie, user } = await signUp(app);

    await seed(user.id, { title: 'React Server Components' });
    await seed(user.id, { title: 'Kafka Exactly-Once Semantics' });

    for (const prefix of ['re', 'rea', 'reac', 'react']) {
      const { body } = await list(cookie, `?q=${prefix}`);
      assert.deepEqual(titles(body), ['React Server Components'], `prefix "${prefix}"`);
    }

    for (const prefix of ['ka', 'kafk', 'kafka']) {
      const { body } = await list(cookie, `?q=${prefix}`);
      assert.deepEqual(titles(body), ['Kafka Exactly-Once Semantics'], `prefix "${prefix}"`);
    }
  });


  /**
   * Prefix matching only runs one way, so typing more than the page says used
   * to find nothing: a bookmark summarised "Listing of open roles" was invisible
   * to "listings". Found against a real vault, not a fixture.
   */
  it('finds a singular when a plural is typed, and the other way round', async () => {
    const { cookie, user } = await signUp(app);

    await seed(user.id, { title: 'Stripe Careers', summary: 'Listing of open roles.' });
    await seed(user.id, { title: 'Redis Caches', summary: 'How the cache is filled.' });

    for (const q of ['listing', 'listings']) {
      assert.deepEqual(titles((await list(cookie, `?q=${q}`)).body), ['Stripe Careers'], q);
    }

    for (const q of ['cache', 'caches', 'caching']) {
      assert.deepEqual(titles((await list(cookie, `?q=${q}`)).body), ['Redis Caches'], q);
    }
  });
  /**
   * The other half of the same defect: `$text` ORs its terms, so adding a word
   * made the result set larger. This is the "search does not filter" complaint.
   */
  it('narrows as words are added, rather than widening', async () => {
    const { cookie, user } = await signUp(app);

    await seed(user.id, { title: 'React Server Components' });
    await seed(user.id, { title: 'React Router Basics' });

    assert.equal((await list(cookie, '?q=react')).body.total, 2);
    assert.equal((await list(cookie, '?q=react%20server')).body.total, 1);
    assert.equal((await list(cookie, '?q=react%20server%20components')).body.total, 1);
  });

  it('finds a word buried inside a compound one', async () => {
    const { cookie, user } = await signUp(app);

    await seed(user.id, { title: 'PostgreSQL Indexing Deep Dive' });

    assert.equal((await list(cookie, '?q=sql')).body.total, 1);
    assert.equal((await list(cookie, '?q=postgres')).body.total, 1);
  });

  it('searches summaries and tags, not only titles', async () => {
    const { cookie, user } = await signUp(app);

    await seed(user.id, { title: 'Untitled', summary: 'How to speed up an API with a cache.' });
    await seed(user.id, { title: 'Also untitled', tags: ['kubernetes'] });

    assert.equal((await list(cookie, '?q=cache')).body.total, 1);
    assert.equal((await list(cookie, '?q=kuber')).body.total, 1);
  });

  it('ranks a title match above a description match', async () => {
    const { cookie, user } = await signUp(app);

    await seed(user.id, { title: 'Unrelated', description: 'Mentions redis once, in passing.' });
    await seed(user.id, { title: 'Redis Caching Strategies' });

    const { body } = await list(cookie, '?q=redis');

    assert.equal(body.total, 2);
    assert.equal(body.links[0].title, 'Redis Caching Strategies');
  });

  /**
   * A sentence typed into the box shares no single document with all its words.
   * Returning nothing is a worse answer than returning the closest few -- but
   * the client has to be able to say that is what happened.
   */
  it('falls back to matching some terms, and says so, when no link matches all', async () => {
    const { cookie, user } = await signUp(app);

    await seed(user.id, { title: 'Redis Caching Strategies', tags: ['backend'] });
    await seed(user.id, { title: 'React Server Components' });

    const strict = await list(cookie, '?q=redis%20caching');
    assert.equal(strict.body.total, 1);
    assert.equal(strict.body.search.relaxed, false);

    const relaxed = await list(cookie, '?q=make%20my%20backend%20snappier');
    assert.equal(relaxed.body.total, 1);
    assert.equal(relaxed.body.search.relaxed, true);
    assert.deepEqual(titles(relaxed.body), ['Redis Caching Strategies']);
  });

  it('returns nothing, unrelaxed, when a single term matches nothing', async () => {
    const { cookie, user } = await signUp(app);

    await seed(user.id, { title: 'React Server Components' });

    const { body } = await list(cookie, '?q=zzzz');

    assert.equal(body.total, 0);
    assert.equal(body.search.relaxed, false);
  });

  it('applies the structural filters to a search as well as to a listing', async () => {
    const { cookie, user } = await signUp(app);

    await seed(user.id, { title: 'Redis Caching', isFavorite: true, tags: ['db'] });
    await seed(user.id, { title: 'Redis Streams', isFavorite: false, tags: ['db'] });

    assert.equal((await list(cookie, '?q=redis')).body.total, 2);
    assert.equal((await list(cookie, '?q=redis&isFavorite=true')).body.total, 1);
    assert.equal((await list(cookie, '?q=redis&tag=db')).body.total, 2);
    assert.equal((await list(cookie, '?q=redis&tag=missing')).body.total, 0);
  });

  it('honours an explicit sort during a search instead of ranking', async () => {
    const { cookie, user } = await signUp(app);

    const older = await seed(user.id, { title: 'Redis Caching Strategies' });
    await seed(user.id, { title: 'Redis' });

    // `Redis` ranks first: an exact whole-token title match beats a prefix one.
    assert.deepEqual(titles((await list(cookie, '?q=redis')).body), [
      'Redis',
      'Redis Caching Strategies',
    ]);

    const { body } = await list(cookie, '?q=redis&sort=oldest');
    assert.equal(body.links[0].id, older.id.toString());
  });

  it('pages a ranked result set', async () => {
    const { cookie, user } = await signUp(app);

    for (const n of [1, 2, 3]) await seed(user.id, { title: `Redis note ${n}` });

    const first = await list(cookie, '?q=redis&limit=2&page=1');
    const second = await list(cookie, '?q=redis&limit=2&page=2');

    assert.equal(first.body.links.length, 2);
    assert.equal(first.body.hasMore, true);
    assert.equal(second.body.links.length, 1);
    assert.equal(second.body.hasMore, false);
    assert.equal(second.body.total, 3);
  });

  it('never returns another user bookmarks', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);

    await seed(alice.user.id, { title: 'Redis Caching' });

    assert.equal((await list(bob.cookie, '?q=redis')).body.total, 0);
    assert.equal((await list(bob.cookie, '?q=re')).body.total, 0);
  });
});

describe('keeping the keyword index in step with the document', () => {
  it('reindexes when a user edits the title', async () => {
    const { cookie, user } = await signUp(app);

    const link = await seed(user.id, { title: 'Kafka Exactly-Once' });

    await request(app)
      .patch(`/api/links/${link.id}`)
      .set('Cookie', cookie)
      .send({ title: 'Redis Caching Strategies' });

    assert.equal((await list(cookie, '?q=kafka')).body.total, 0);
    assert.equal((await list(cookie, '?q=redis')).body.total, 1);
  });

  /**
   * `renameTag` rewrites arrays with an aggregation pipeline, which never loads
   * a document and so cannot fire the `pre('save')` hook. Without the explicit
   * reindex it calls, a renamed tag stays findable under its old name and is
   * invisible under its new one.
   */
  it('reindexes after a tag rename, which bypasses the save hook', async () => {
    const { cookie, user } = await signUp(app);

    await seed(user.id, { title: 'Untitled', tags: ['kafka'] });

    await request(app)
      .patch('/api/links/tags/kafka')
      .set('Cookie', cookie)
      .send({ name: 'streaming' });

    assert.equal((await list(cookie, '?q=streaming')).body.total, 1);
    assert.equal((await list(cookie, '?q=kafka')).body.total, 0);
  });

  it('backfills links written before the field existed', async () => {
    const { cookie, user } = await signUp(app);

    const link = await seed(user.id, { title: 'Redis Caching Strategies' });
    await Link.collection.updateOne({ _id: link._id }, { $unset: { searchTokens: '' } });

    assert.equal((await list(cookie, '?q=redis')).body.total, 0, 'unfindable before the backfill');

    const { updated } = await reindexKeywords({ userId: user.id });

    assert.equal(updated, 1);
    assert.equal((await list(cookie, '?q=redis')).body.total, 1);
  });
});
