import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';

import request from 'supertest';

import { clearTestDatabase, signUp, startTestDatabase, stopTestDatabase } from './helpers.js';

const { createApp } = await import('../src/app.js');
const { Collection } = await import('../src/models/Collection.js');
const { Link } = await import('../src/models/Link.js');

const app = createApp();

before(startTestDatabase);
after(stopTestDatabase);
afterEach(clearTestDatabase);

const createCollection = (cookie, name) =>
  request(app).post('/api/collections').set('Cookie', cookie).send({ name });

async function collectionId(cookie, name) {
  const response = await createCollection(cookie, name);
  return response.body.collection.id;
}

async function saveInto(cookie, url, id) {
  const saved = await request(app).post('/api/links').set('Cookie', cookie).send({ url });

  await request(app)
    .patch(`/api/links/${saved.body.link.id}`)
    .set('Cookie', cookie)
    .send({ collectionId: id });

  return saved.body.link.id;
}

describe('POST /api/collections', () => {
  it('creates a collection for the signed-in user', async () => {
    const { cookie } = await signUp(app);

    const response = await createCollection(cookie, '  Reading list  ');

    assert.equal(response.status, 201);
    assert.equal(response.body.collection.name, 'Reading list');
    assert.ok(response.body.collection.id);
  });

  it('requires a session', async () => {
    const response = await request(app).post('/api/collections').send({ name: 'Reading' });
    assert.equal(response.status, 401);
  });

  it('rejects an empty name', async () => {
    const { cookie } = await signUp(app);

    const response = await createCollection(cookie, '   ');

    assert.equal(response.status, 400);
  });

  it('rejects a duplicate name regardless of case', async () => {
    const { cookie } = await signUp(app);

    await createCollection(cookie, 'Reading');
    const response = await createCollection(cookie, 'reading');

    assert.equal(response.status, 409);
    assert.equal(await Collection.countDocuments({}), 1);
  });

  it('lets two users each have a collection of the same name', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);

    await createCollection(alice.cookie, 'Reading');
    const response = await createCollection(bob.cookie, 'Reading');

    assert.equal(response.status, 201);
  });
});

describe('GET /api/collections', () => {
  it('returns only the user own collections, with link counts', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);

    const reading = await collectionId(alice.cookie, 'Reading');
    await collectionId(alice.cookie, 'Archive');
    await collectionId(bob.cookie, 'Bob only');

    await saveInto(alice.cookie, 'https://example.com/a', reading);
    await saveInto(alice.cookie, 'https://example.com/b', reading);
    await request(app)
      .post('/api/links')
      .set('Cookie', alice.cookie)
      .send({ url: 'https://example.com/loose' });

    const { body } = await request(app).get('/api/collections').set('Cookie', alice.cookie);

    assert.deepEqual(
      body.collections.map(({ name, linkCount }) => ({ name, linkCount })),
      [
        { name: 'Archive', linkCount: 0 },
        { name: 'Reading', linkCount: 2 },
      ],
    );
    assert.equal(body.uncategorisedCount, 1);
    assert.equal(body.totalCount, 3);
  });
});

describe('PATCH /api/collections/:id', () => {
  it('renames a collection', async () => {
    const { cookie } = await signUp(app);
    const id = await collectionId(cookie, 'Reading');

    const response = await request(app)
      .patch(`/api/collections/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'To read' });

    assert.equal(response.status, 200);
    assert.equal(response.body.collection.name, 'To read');
  });

  it('allows a rename that only changes case', async () => {
    const { cookie } = await signUp(app);
    const id = await collectionId(cookie, 'reading');

    const response = await request(app)
      .patch(`/api/collections/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'Reading' });

    assert.equal(response.status, 200);
    assert.equal(response.body.collection.name, 'Reading');
  });

  it('rejects a rename that collides with another collection', async () => {
    const { cookie } = await signUp(app);
    await collectionId(cookie, 'Reading');
    const archive = await collectionId(cookie, 'Archive');

    const response = await request(app)
      .patch(`/api/collections/${archive}`)
      .set('Cookie', cookie)
      .send({ name: 'reading' });

    assert.equal(response.status, 409);
  });

  it('refuses to rename another user collection', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);
    const id = await collectionId(alice.cookie, 'Private');

    const response = await request(app)
      .patch(`/api/collections/${id}`)
      .set('Cookie', bob.cookie)
      .send({ name: 'Hijacked' });

    assert.equal(response.status, 404);
    assert.equal((await Collection.findById(id)).name, 'Private');
  });
});

describe('DELETE /api/collections/:id', () => {
  it('deletes the collection and releases its links without deleting them', async () => {
    const { cookie } = await signUp(app);
    const id = await collectionId(cookie, 'Reading');
    const linkId = await saveInto(cookie, 'https://example.com/a', id);

    const response = await request(app).delete(`/api/collections/${id}`).set('Cookie', cookie);

    assert.equal(response.status, 200);
    assert.equal(response.body.releasedLinks, 1);
    assert.equal(await Collection.countDocuments({}), 0);

    const link = await Link.findById(linkId);
    assert.ok(link, 'the bookmark should survive its collection');
    assert.equal(link.collectionId, null);
  });

  it('leaves links in other collections alone', async () => {
    const { cookie } = await signUp(app);
    const reading = await collectionId(cookie, 'Reading');
    const archive = await collectionId(cookie, 'Archive');
    const kept = await saveInto(cookie, 'https://example.com/kept', archive);

    await request(app).delete(`/api/collections/${reading}`).set('Cookie', cookie);

    assert.equal((await Link.findById(kept)).collectionId.toString(), archive);
  });

  it('refuses to delete another user collection', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);
    const id = await collectionId(alice.cookie, 'Private');

    const response = await request(app).delete(`/api/collections/${id}`).set('Cookie', bob.cookie);

    assert.equal(response.status, 404);
    assert.equal(await Collection.countDocuments({}), 1);
  });

  it('returns 404 for an id that is not an object id', async () => {
    const { cookie } = await signUp(app);

    const response = await request(app).delete('/api/collections/nope').set('Cookie', cookie);

    assert.equal(response.status, 404);
  });
});
