import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isBlockedAddress } from '../src/utils/privateAddress.js';

describe('isBlockedAddress', () => {
  it('blocks loopback', () => {
    assert.equal(isBlockedAddress('127.0.0.1'), true);
    assert.equal(isBlockedAddress('127.1.2.3'), true);
    assert.equal(isBlockedAddress('::1'), true);
  });

  it('blocks the cloud metadata endpoint', () => {
    // The one that turns an SSRF into leaked cloud credentials.
    assert.equal(isBlockedAddress('169.254.169.254'), true);
  });

  it('blocks the private IPv4 ranges', () => {
    assert.equal(isBlockedAddress('10.0.0.5'), true);
    assert.equal(isBlockedAddress('172.16.0.1'), true);
    assert.equal(isBlockedAddress('172.31.255.254'), true);
    assert.equal(isBlockedAddress('192.168.1.1'), true);
  });

  it('allows public addresses either side of a private range', () => {
    // 172.16/12 covers 172.16-172.31 only; the neighbours must stay reachable.
    assert.equal(isBlockedAddress('172.15.0.1'), false);
    assert.equal(isBlockedAddress('172.32.0.1'), false);
    assert.equal(isBlockedAddress('11.0.0.1'), false);
    assert.equal(isBlockedAddress('93.184.216.34'), false);
  });

  it('blocks CGNAT, unspecified, multicast and reserved space', () => {
    assert.equal(isBlockedAddress('100.64.0.1'), true);
    assert.equal(isBlockedAddress('0.0.0.0'), true);
    assert.equal(isBlockedAddress('224.0.0.1'), true);
    assert.equal(isBlockedAddress('255.255.255.255'), true);
  });

  it('blocks IPv6 unique-local, link-local and multicast', () => {
    assert.equal(isBlockedAddress('fc00::1'), true);
    assert.equal(isBlockedAddress('fd12:3456::1'), true);
    assert.equal(isBlockedAddress('fe80::1'), true);
    assert.equal(isBlockedAddress('ff02::1'), true);
    assert.equal(isBlockedAddress('::'), true);
  });

  it('allows public IPv6', () => {
    assert.equal(isBlockedAddress('2606:2800:220:1:248:1893:25c8:1946'), false);
  });

  it('judges IPv4-mapped IPv6 by the IPv4 rules', () => {
    // ::ffff:127.0.0.1 reaches loopback, so writing it that way must not help.
    assert.equal(isBlockedAddress('::ffff:127.0.0.1'), true);
    assert.equal(isBlockedAddress('::ffff:169.254.169.254'), true);
    assert.equal(isBlockedAddress('::ffff:93.184.216.34'), false);
  });

  it('blocks anything it cannot parse rather than failing open', () => {
    assert.equal(isBlockedAddress('not-an-address'), true);
    assert.equal(isBlockedAddress(''), true);
  });
});
