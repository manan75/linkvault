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

async function savedLink(cookie, url, patch) {
  const response = await request(app).post('/api/links').set('Cookie', cookie).send({ url });
  if (!patch) return response.body.link;

  const updated = await request(app)
    .patch(`/api/links/${response.body.link.id}`)
    .set('Cookie', cookie)
    .send(patch);

  return updated.body.link;
}

const rename = (cookie, from, to) =>
  request(app)
    .patch(`/api/links/tags/${encodeURIComponent(from)}`)
    .set('Cookie', cookie)
    .send({ name: to });

describe('PATCH /api/links/:id — tag provenance', () => {
  it('marks tags as user-edited so enrichment stops writing them', async () => {
    const { cookie } = await signUp(app);
    const link = await savedLink(cookie, 'https://example.com/a');

    assert.equal(link.tagsEditedByUser, false);

    const edited = await savedLink(cookie, 'https://example.com/b', { tags: ['react'] });
    assert.equal(edited.tagsEditedByUser, true);
  });

  it('does not set the flag for an edit that leaves tags alone', async () => {
    const { cookie } = await signUp(app);
    const link = await savedLink(cookie, 'https://example.com/a', { title: 'Renamed' });

    assert.equal(link.tagsEditedByUser, false);
  });

  it('does not set the flag when the submitted tags are unchanged', async () => {
    // Re-submitting an unchanged edit form must not quietly opt the link out of
    // future auto-tagging.
    const { cookie } = await signUp(app);
    const link = await savedLink(cookie, 'https://example.com/a');

    await Link.updateOne({ _id: link.id }, { $set: { tags: ['react'] } });

    const resubmitted = await request(app)
      .patch(`/api/links/${link.id}`)
      .set('Cookie', cookie)
      .send({ tags: ['react'] });

    assert.equal(resubmitted.body.link.tagsEditedByUser, false);
  });
});

describe('PATCH /api/links/tags/:name', () => {
  it('renames a tag across every link that carries it', async () => {
    const { cookie } = await signUp(app);
    await savedLink(cookie, 'https://example.com/a', { tags: ['js', 'testing'] });
    await savedLink(cookie, 'https://example.com/b', { tags: ['js'] });
    await savedLink(cookie, 'https://example.com/c', { tags: ['kafka'] });

    const response = await rename(cookie, 'js', 'javascript');

    assert.equal(response.status, 200);
    assert.equal(response.body.modified, 2);
    assert.equal(response.body.merged, false);

    // The refreshed vocabulary comes back so the sidebar needs no second call.
    assert.deepEqual(
      response.body.tags.map((tag) => tag.name).sort(),
      ['javascript', 'kafka', 'testing'],
    );
  });

  it('merges when the target already exists, without duplicating it', async () => {
    const { cookie } = await signUp(app);
    await savedLink(cookie, 'https://example.com/a', { tags: ['js', 'javascript'] });
    await savedLink(cookie, 'https://example.com/b', { tags: ['js'] });

    const response = await rename(cookie, 'js', 'javascript');

    assert.equal(response.body.merged, true);

    const links = await Link.find({}).sort({ url: 1 });
    assert.deepEqual(links[0].tags, ['javascript']);
    assert.deepEqual(links[1].tags, ['javascript']);
  });

  it('preserves the order of the tags it did not touch', async () => {
    // `$setUnion` would have been shorter and would have sorted these.
    const { cookie } = await signUp(app);
    await savedLink(cookie, 'https://example.com/a', { tags: ['zebra', 'js', 'apple'] });

    await rename(cookie, 'js', 'javascript');

    assert.deepEqual((await Link.findOne({})).tags, ['zebra', 'javascript', 'apple']);
  });

  it('renames auto-tags alongside tags so provenance stays accurate', async () => {
    const { cookie } = await signUp(app);
    const link = await savedLink(cookie, 'https://example.com/a');
    await Link.updateOne({ _id: link.id }, { $set: { tags: ['js'], autoTags: ['js'] } });

    await rename(cookie, 'js', 'javascript');

    const stored = await Link.findById(link.id);
    assert.deepEqual(stored.tags, ['javascript']);
    assert.deepEqual(stored.autoTags, ['javascript']);
  });

  it('normalises the incoming name rather than creating a second spelling', async () => {
    const { cookie } = await signUp(app);
    await savedLink(cookie, 'https://example.com/a', { tags: ['ml'] });

    await rename(cookie, 'ml', '  Machine Learning ');

    assert.deepEqual((await Link.findOne({})).tags, ['machine-learning']);
  });

  it('does not touch another user’s tags', async () => {
    const alice = await signUp(app);
    const bob = await signUp(app);
    await savedLink(alice.cookie, 'https://example.com/a', { tags: ['js'] });
    await savedLink(bob.cookie, 'https://example.com/b', { tags: ['js'] });

    await rename(alice.cookie, 'js', 'javascript');

    const bobsLink = await Link.findOne({ url: 'https://example.com/b' });
    assert.deepEqual(bobsLink.tags, ['js']);
  });

  it('404s for a tag the user does not have', async () => {
    const { cookie } = await signUp(app);
    await savedLink(cookie, 'https://example.com/a', { tags: ['js'] });

    assert.equal((await rename(cookie, 'nope', 'javascript')).status, 404);
  });

  it('rejects a name that normalises to nothing', async () => {
    const { cookie } = await signUp(app);
    await savedLink(cookie, 'https://example.com/a', { tags: ['js'] });

    assert.equal((await rename(cookie, 'js', '...')).status, 400);
  });

  it('requires a session', async () => {
    const response = await request(app).patch('/api/links/tags/js').send({ name: 'javascript' });
    assert.equal(response.status, 401);
  });
});
