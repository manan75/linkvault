import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { mergeTags, normalizeTag, normalizeTags } = await import('../src/utils/tags.js');

/**
 * The deterministic half of tag consistency. These guards exist precisely
 * because the model cannot be relied on, so they are tested against the inputs
 * a model actually produces rather than tidy ones.
 */
describe('normalizeTag', () => {
  it('lowercases and hyphenates the shapes a model returns for one tag', () => {
    assert.equal(normalizeTag('Machine Learning'), 'machine-learning');
    assert.equal(normalizeTag('machine_learning'), 'machine-learning');
    assert.equal(normalizeTag('  React  '), 'react');
    assert.equal(normalizeTag('web--dev'), 'web-dev');
  });

  it('strips the punctuation a model leaves on, without eating real tags', () => {
    assert.equal(normalizeTag('#javascript'), 'javascript');
    assert.equal(normalizeTag('redis.'), 'redis');
    assert.equal(normalizeTag('c++'), 'c++');
    assert.equal(normalizeTag('c#'), 'c#');
  });

  it('rejects anything that is not usable as a label', () => {
    assert.equal(normalizeTag(''), null);
    assert.equal(normalizeTag('   '), null);
    assert.equal(normalizeTag('...'), null);
    assert.equal(normalizeTag(undefined), null);
    assert.equal(normalizeTag(42), null);
    // The schema's own limit: past it the write would fail anyway.
    assert.equal(normalizeTag('x'.repeat(41)), null);
    assert.equal(normalizeTag('x'.repeat(40)), 'x'.repeat(40));
  });

  it('does not singularise, because that breaks real tags', () => {
    assert.equal(normalizeTag('docs'), 'docs');
    assert.equal(normalizeTag('ops'), 'ops');
    assert.equal(normalizeTag('k8s'), 'k8s');
  });
});

describe('normalizeTags', () => {
  it('adopts the casing the vocabulary already uses', () => {
    // A legacy mixed-case tag is the only way drift can still appear, and it is
    // exactly the case where a second sidebar entry would be invisible.
    assert.deepEqual(normalizeTags(['React'], { vocabulary: ['ReactJS', 'React'] }), ['React']);
  });

  it('deduplicates case-insensitively', () => {
    assert.deepEqual(normalizeTags(['React', 'react', 'REACT']), ['react']);
  });

  it('caps the list and drops unusable entries without losing its place', () => {
    const tags = normalizeTags(['a', '', 'b', '...', 'c', 'd', 'e', 'f']);
    assert.deepEqual(tags, ['a', 'b', 'c', 'd', 'e']);
  });

  it('tolerates a model returning nothing at all', () => {
    assert.deepEqual(normalizeTags(undefined), []);
    assert.deepEqual(normalizeTags([]), []);
  });
});

describe('mergeTags', () => {
  it('appends without reordering or duplicating what is already there', () => {
    assert.deepEqual(mergeTags(['redis', 'caching'], ['React', 'redis']), [
      'redis',
      'caching',
      'React',
    ]);
  });

  it('leaves the existing set alone when there is nothing to add', () => {
    assert.deepEqual(mergeTags(['redis'], []), ['redis']);
  });
});
