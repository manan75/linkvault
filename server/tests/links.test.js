import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import request from 'supertest';

import { clearTestDatabase, signUp, startTestDatabase, stopTestDatabase } from './helpers.js';

const { createApp } = await import('../src/app.js');
const { Link } = await import('../src/models/Link.js');

const app = createApp();

before(startTestDatabase);
after(stopTestDatabase);
afterEach(clearTestDatabase);

const save = (cookie, url, collectionId) =>
  request(app)
    .post('/api/links')
    .set('Cookie', cookie)
    .send(collectionId === undefined ? { url } : { url, collectionId });

const newCollection = async (cookie, name) => {
  const response = await request(app).post('/api/collections').set('Cookie', cookie).send({ name });
  return response.body.collection.id;
};

const list = (cookie, query = '') => request(app).get(`/api/links${query}`).set('Cookie', cookie);

async function savedLink(cookie, url, patch) {
  const response = await save(cookie, url);
  if (!patch) return response.body.link;

  const updated = await request(app)
    .patch(`/api/links/${response.body.link.id}`)
    .set('Cookie', cookie)
    .send(patch);

  return updated.body.link;
}

describe('POST /api/links', () => {
  it('saves a URL and returns the new bookmark', async () => {
    const { cookie } = await signUp(app);

    const response = await save(cookie, 'https://www.Example.com/redis-caching/?utm_source=hn');

    assert.equal(response.status, 201);
    assert.equal(response.body.created, true);
    assert.equal(response.body.link.url, 'https://www.Example.com/redis-caching/?utm_source=hn');
    assert.equal(response.body.link.canonicalUrl, 'https://example.com/redis-caching');
    assert.equal(response.body.link.domain, 'example.com');
  });

  it('starts a bookmark in the state later phases expect', async () => {
    const { cookie } = await signUp(app);

    const { body } = await save(cookie, 'https://example.com/a');

    assert.equal(body.link.processingStatus, 'pending');
    assert.equal(body.link.isFavorite, false);
    assert.equal(body.link.isRead, false);
    assert.equal(body.link.collectionId, null);
    assert.deepEqual(body.link.tags, []);
    assert.ok(body.link.savedAt);
  });

  it('rejects an unauthenticated save', async () => {
    const response = await request(app).post('/api/links').send({ url: 'https://example.com' });
    assert.equal(response.status, 401);
  });

  it('rejects input that is not a fetchable URL', async () => {
    const { cookie } = await signUp(app);

    for (const url of ['', 'not a url', 'javascript:alert(1)']) {
      const response = await save(cookie, url);
      assert.equal(response.status, 400, `expected ${url} to be rejected`);
    }
  });

  it('returns the existing bookmark instead of saving a URL twice', async () => {
    const { cookie } = await signUp(app);

    const first = await save(cookie, 'https://example.com/article');
    const second = await save(cookie, 'https://example.com/article');

    assert.equal(second.status, 200);
    assert.equal(second.body.created, false);
    assert.equal(second.body.link.id, first.body.link.id);
    assert.equal(await Link.countDocuments({}), 1);
  });

  it('recognises a cosmetically different URL as the same bookmark', async () => {
    const { cookie } = await signUp(app);

    const first = await save(cookie, 'https://example.com/article');
    const second = await save(cookie, 'https://www.example.com/article/?utm_source=twitter#intro');

    assert.equal(second.body.link.id, first.body.link.id);
    assert.equal(await Link.countDocuments({}), 1);
  });

  it('files the bookmark into a collection chosen at save time', async () => {
    const { cookie } = await signUp(app);
    const id = await newCollection(cookie, 'Backend');

    const response = await save(cookie, 'https://example.com/a', id);

    assert.equal(response.status, 201);
    assert.equal(response.body.link.collectionId, id);
  });

  it('moves an already-saved bookmark when a collection is chosen', async () => {
    const { cookie } = await signUp(app);
    const backend = await newCollection(cookie, 'Backend');
    const frontend = await newCollection(cookie, 'Frontend');

    const first = await save(cookie, 'https://example.com/a', frontend);
    const second = await save(cookie, 'https://example.com/a', backend);

    assert.equal(second.status, 200);
    assert.equal(second.body.created, false);
    assert.equal(second.body.moved, true);
    assert.equal(second.body.link.id, first.body.link.id);
    assert.equal(second.body.link.collectionId, backend);
  });

  it('leaves an already-saved bookmark filed where it is when no collection is chosen', async () => {
    const { cookie } = await signUp(app);
    const backend = await newCollection(cookie, 'Backend');

    await save(cookie, 'https://example.com/a', backend);
    const again = await save(cookie, 'https://example.com/a');

    assert.equal(again.body.moved, false);
    assert.equal(again.body.link.collectionId, backend);
  });

  it('refuses to save into another user collection', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);
    const id = await newCollection(alice.cookie, 'Private');

    const response = await save(bob.cookie, 'https://example.com/a', id);

    assert.equal(response.status, 404);
    assert.equal(await Link.countDocuments({}), 0, 'nothing should be saved when filing fails');
  });

  it('rejects a collectionId that is not an id', async () => {
    const { cookie } = await signUp(app);

    const response = await save(cookie, 'https://example.com/a', 'not-an-id');

    assert.equal(response.status, 400);
  });

  it('lets two users each save the same URL', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);

    const aliceLink = await save(alice.cookie, 'https://example.com/shared');
    const bobLink = await save(bob.cookie, 'https://example.com/shared');

    assert.equal(aliceLink.status, 201);
    assert.equal(bobLink.status, 201);
    assert.notEqual(aliceLink.body.link.id, bobLink.body.link.id);
  });
});

describe('GET /api/links', () => {
  it('returns only the requesting user own bookmarks', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);

    await save(alice.cookie, 'https://example.com/alice');
    await save(bob.cookie, 'https://example.com/bob');

    const response = await list(alice.cookie);

    assert.equal(response.status, 200);
    assert.equal(response.body.total, 1);
    assert.equal(response.body.links[0].canonicalUrl, 'https://example.com/alice');
  });

  it('returns the newest bookmark first', async () => {
    const { cookie } = await signUp(app);

    await save(cookie, 'https://example.com/first');
    await save(cookie, 'https://example.com/second');

    const { body } = await list(cookie);

    assert.deepEqual(
      body.links.map((link) => link.canonicalUrl),
      ['https://example.com/second', 'https://example.com/first'],
    );
  });

  it('filters by favorite and read state', async () => {
    const { cookie } = await signUp(app);

    await savedLink(cookie, 'https://example.com/fav', { isFavorite: true });
    await savedLink(cookie, 'https://example.com/read', { isRead: true });
    await save(cookie, 'https://example.com/plain');

    const favorites = await list(cookie, '?isFavorite=true');
    const unread = await list(cookie, '?isRead=false');

    assert.equal(favorites.body.total, 1);
    assert.equal(favorites.body.links[0].canonicalUrl, 'https://example.com/fav');
    assert.equal(unread.body.total, 2);
  });

  it('requires every requested tag to be present', async () => {
    const { cookie } = await signUp(app);

    await savedLink(cookie, 'https://example.com/both', { tags: ['react', 'testing'] });
    await savedLink(cookie, 'https://example.com/one', { tags: ['react'] });

    const both = await list(cookie, '?tag=react&tag=testing');
    const one = await list(cookie, '?tag=react');

    assert.equal(both.body.total, 1);
    assert.equal(both.body.links[0].canonicalUrl, 'https://example.com/both');
    assert.equal(one.body.total, 2);
  });

  it('filters by domain, ignoring a www prefix', async () => {
    const { cookie } = await signUp(app);

    await save(cookie, 'https://redis.io/docs');
    await save(cookie, 'https://example.com/a');

    const { body } = await list(cookie, '?domain=www.redis.io');

    assert.equal(body.total, 1);
    assert.equal(body.links[0].domain, 'redis.io');
  });

  it('filters by save date', async () => {
    const { cookie } = await signUp(app);
    await save(cookie, 'https://example.com/a');

    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();

    assert.equal((await list(cookie, `?savedAfter=${future}`)).body.total, 0);
    assert.equal((await list(cookie, `?savedAfter=${past}`)).body.total, 1);
  });

  it('finds bookmarks by keyword across titles and tags', async () => {
    const { cookie } = await signUp(app);

    await savedLink(cookie, 'https://example.com/a', { title: 'Redis Caching Strategies' });
    await savedLink(cookie, 'https://example.com/b', { title: 'Postgres Indexing' });
    await savedLink(cookie, 'https://example.com/c', { tags: ['caching'] });

    const { body } = await list(cookie, '?q=caching');

    assert.equal(body.total, 2);
    assert.ok(body.links.every((link) => link.canonicalUrl !== 'https://example.com/b'));
  });

  it('does not leak another user bookmarks through search', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);

    await savedLink(alice.cookie, 'https://example.com/secret', { title: 'Redis Caching' });

    const { body } = await list(bob.cookie, '?q=redis');

    assert.equal(body.total, 0);
  });

  it('pages through results', async () => {
    const { cookie } = await signUp(app);

    for (const n of [1, 2, 3]) await save(cookie, `https://example.com/${n}`);

    const firstPage = await list(cookie, '?limit=2&page=1');
    const secondPage = await list(cookie, '?limit=2&page=2');

    assert.equal(firstPage.body.links.length, 2);
    assert.equal(firstPage.body.hasMore, true);
    assert.equal(secondPage.body.links.length, 1);
    assert.equal(secondPage.body.hasMore, false);
    assert.equal(secondPage.body.total, 3);
  });

  it('rejects a nonsense filter rather than ignoring it', async () => {
    const { cookie } = await signUp(app);

    const response = await list(cookie, '?limit=500');

    assert.equal(response.status, 400);
  });
});

describe('GET /api/links/:id', () => {
  it('returns the bookmark to its owner', async () => {
    const { cookie } = await signUp(app);
    const link = await savedLink(cookie, 'https://example.com/a');

    const response = await request(app).get(`/api/links/${link.id}`).set('Cookie', cookie);

    assert.equal(response.status, 200);
    assert.equal(response.body.link.id, link.id);
  });

  it('gives another user a 404, not a 403, so the link is not confirmed to exist', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);
    const link = await savedLink(alice.cookie, 'https://example.com/private');

    const response = await request(app).get(`/api/links/${link.id}`).set('Cookie', bob.cookie);

    assert.equal(response.status, 404);
  });

  it('returns 404 for an id that is not an object id', async () => {
    const { cookie } = await signUp(app);

    const response = await request(app).get('/api/links/not-an-id').set('Cookie', cookie);

    assert.equal(response.status, 404);
  });
});

describe('PATCH /api/links/:id', () => {
  it('updates the fields a user may edit', async () => {
    const { cookie } = await signUp(app);
    const link = await savedLink(cookie, 'https://example.com/a');

    const response = await request(app)
      .patch(`/api/links/${link.id}`)
      .set('Cookie', cookie)
      .send({ title: 'Redis Caching', tags: ['Redis', 'redis', 'Caching'], isFavorite: true });

    assert.equal(response.status, 200);
    assert.equal(response.body.link.title, 'Redis Caching');
    assert.equal(response.body.link.isFavorite, true);
    // Tags are lowercased and de-duplicated so filters do not fragment.
    assert.deepEqual(response.body.link.tags, ['redis', 'caching']);
  });

  it('ignores fields the processing pipeline owns', async () => {
    const { cookie } = await signUp(app);
    const link = await savedLink(cookie, 'https://example.com/a');

    const response = await request(app)
      .patch(`/api/links/${link.id}`)
      .set('Cookie', cookie)
      .send({ title: 'Kept', processingStatus: 'ready', canonicalUrl: 'https://evil.test/' });

    assert.equal(response.body.link.title, 'Kept');
    assert.equal(response.body.link.processingStatus, 'pending');
    assert.equal(response.body.link.canonicalUrl, 'https://example.com/a');
  });

  it('rejects an empty patch', async () => {
    const { cookie } = await signUp(app);
    const link = await savedLink(cookie, 'https://example.com/a');

    const response = await request(app)
      .patch(`/api/links/${link.id}`)
      .set('Cookie', cookie)
      .send({});

    assert.equal(response.status, 400);
  });

  it('refuses to edit another user bookmark', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);
    const link = await savedLink(alice.cookie, 'https://example.com/private');

    const response = await request(app)
      .patch(`/api/links/${link.id}`)
      .set('Cookie', bob.cookie)
      .send({ title: 'Hijacked' });

    assert.equal(response.status, 404);

    const stored = await Link.findById(link.id);
    assert.equal(stored.title, '');
  });

  it('refuses to move a bookmark into another user collection', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);

    const collection = await request(app)
      .post('/api/collections')
      .set('Cookie', alice.cookie)
      .send({ name: 'Private' });

    const link = await savedLink(bob.cookie, 'https://example.com/a');

    const response = await request(app)
      .patch(`/api/links/${link.id}`)
      .set('Cookie', bob.cookie)
      .send({ collectionId: collection.body.collection.id });

    assert.equal(response.status, 404);
    assert.equal((await Link.findById(link.id)).collectionId, null);
  });

  it('clears the collection when collectionId is null', async () => {
    const { cookie } = await signUp(app);

    const collection = await request(app)
      .post('/api/collections')
      .set('Cookie', cookie)
      .send({ name: 'Reading' });

    const link = await savedLink(cookie, 'https://example.com/a', {
      collectionId: collection.body.collection.id,
    });
    assert.equal(link.collectionId, collection.body.collection.id);

    const cleared = await request(app)
      .patch(`/api/links/${link.id}`)
      .set('Cookie', cookie)
      .send({ collectionId: null });

    assert.equal(cleared.body.link.collectionId, null);
  });
});

describe('DELETE /api/links/:id', () => {
  it('permanently removes the owner bookmark', async () => {
    const { cookie } = await signUp(app);
    const link = await savedLink(cookie, 'https://example.com/a');

    const response = await request(app).delete(`/api/links/${link.id}`).set('Cookie', cookie);

    assert.equal(response.status, 204);
    assert.equal(await Link.countDocuments({}), 0);
  });

  it('lets the URL be saved again after deletion', async () => {
    const { cookie } = await signUp(app);
    const link = await savedLink(cookie, 'https://example.com/a');

    await request(app).delete(`/api/links/${link.id}`).set('Cookie', cookie);
    const again = await save(cookie, 'https://example.com/a');

    assert.equal(again.status, 201);
  });

  it('refuses to delete another user bookmark', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);
    const link = await savedLink(alice.cookie, 'https://example.com/private');

    const response = await request(app).delete(`/api/links/${link.id}`).set('Cookie', bob.cookie);

    assert.equal(response.status, 404);
    assert.equal(await Link.countDocuments({}), 1);
  });
});

describe('GET /api/links/tags', () => {
  it('returns the user own tags with counts, most used first', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);

    await savedLink(alice.cookie, 'https://example.com/a', { tags: ['react', 'testing'] });
    await savedLink(alice.cookie, 'https://example.com/b', { tags: ['react'] });
    await savedLink(bob.cookie, 'https://example.com/c', { tags: ['kafka'] });

    const { body } = await request(app).get('/api/links/tags').set('Cookie', alice.cookie);

    assert.deepEqual(body.tags, [
      { name: 'react', count: 2 },
      { name: 'testing', count: 1 },
    ]);
  });
});

describe('POST /api/links/:id/retry', () => {
  /** Puts a link in the state extraction leaves behind when it gives up. */
  async function failedLink(cookie) {
    const link = await savedLink(cookie, 'https://example.com/gone');

    await Link.updateOne(
      { _id: link.id },
      {
        processingStatus: 'failed',
        processingAttempts: 3,
        processingError: 'The site returned 404',
        processingStartedAt: new Date(),
      },
    );

    return link;
  }

  it('puts a failed link back in the queue with a clean slate', async () => {
    const { cookie } = await signUp(app);
    const link = await failedLink(cookie);

    const response = await request(app)
      .post(`/api/links/${link.id}/retry`)
      .set('Cookie', cookie);

    assert.equal(response.status, 200);
    assert.equal(response.body.link.processingStatus, 'pending');
    assert.equal(response.body.link.processingError, '');

    const stored = await Link.findById(link.id);
    // Reset rather than continued: the automatic ladder is already spent, and
    // this is a fresh decision by the user.
    assert.equal(stored.processingAttempts, 0);
  });

  it('refuses to reset a link that is mid-flight', async () => {
    const { cookie } = await signUp(app);
    const link = await savedLink(cookie, 'https://example.com/busy');
    await Link.updateOne({ _id: link.id }, { processingStatus: 'processing' });

    const response = await request(app)
      .post(`/api/links/${link.id}/retry`)
      .set('Cookie', cookie);

    // Claiming works by moving a link out of `pending`; resetting one that a
    // worker holds would let a second worker claim it alongside the first.
    assert.equal(response.status, 409);
  });

  it('will not retry someone else link', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);
    const link = await failedLink(alice.cookie);

    const response = await request(app)
      .post(`/api/links/${link.id}/retry`)
      .set('Cookie', bob.cookie);

    assert.equal(response.status, 404);
    assert.equal((await Link.findById(link.id)).processingStatus, 'failed');
  });

  it('requires a session', async () => {
    const { cookie } = await signUp(app);
    const link = await failedLink(cookie);

    assert.equal((await request(app).post(`/api/links/${link.id}/retry`)).status, 401);
  });
});
