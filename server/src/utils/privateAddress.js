import net from 'node:net';

/**
 * Decides whether an IP address is one the API is allowed to connect to.
 *
 * This is the guard behind the Phase 3 rule: extraction fetches URLs a stranger
 * chose, from inside the trust boundary. Without it, saving
 * `http://169.254.169.254/latest/meta-data/` turns the API into a reader for the
 * internal network -- and on a cloud host, for cloud credentials -- with the
 * result stored in a field the same user can read straight back.
 *
 * Checked against the *resolved address*, never the hostname: a name the
 * attacker controls can resolve to anything at all.
 */

/** [first byte, prefix length] pairs, written as CIDR for readability. */
const BLOCKED_IPV4 = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, including the cloud metadata endpoint
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
];

function ipv4ToBytes(address) {
  return address.split('.').map(Number);
}

function ipv6ToBytes(address) {
  // Expand "::" and any omitted leading zeros into 8 groups of 16 bits.
  const [head, tail = ''] = address.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];

  const missing = 8 - headGroups.length - tailGroups.length;
  const groups = address.includes('::')
    ? [...headGroups, ...Array(missing).fill('0'), ...tailGroups]
    : headGroups;

  return groups.flatMap((group) => {
    const value = parseInt(group || '0', 16);
    return [value >> 8, value & 0xff];
  });
}

function inRange(bytes, [network, prefix]) {
  const networkBytes = ipv4ToBytes(network);
  let remaining = prefix;

  for (let index = 0; remaining > 0; index += 1) {
    const bits = Math.min(8, remaining);
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((bytes[index] & mask) !== (networkBytes[index] & mask)) return false;
    remaining -= bits;
  }

  return true;
}

/**
 * True when the address must not be connected to.
 *
 * Unrecognised input is blocked rather than allowed: a guard that fails open is
 * not a guard.
 */
export function isBlockedAddress(address) {
  const version = net.isIP(address);

  if (version === 4) {
    return BLOCKED_IPV4.some((range) => inRange(ipv4ToBytes(address), range));
  }

  if (version !== 6) return true;

  const lower = address.toLowerCase();

  // IPv4-mapped (::ffff:10.0.0.1) and IPv4-compatible forms reach an IPv4
  // destination, so they are judged by the IPv4 rules.
  const mapped = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedAddress(mapped[1]);

  const bytes = ipv6ToBytes(lower);
  if (bytes.length !== 16) return true;

  const unspecified = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const uniqueLocal = (bytes[0] & 0xfe) === 0xfc; // fc00::/7
  const linkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80; // fe80::/10
  const multicast = bytes[0] === 0xff; // ff00::/8

  return unspecified || loopback || uniqueLocal || linkLocal || multicast;
}
