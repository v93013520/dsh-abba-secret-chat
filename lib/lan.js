/**
 * LAN address enumeration for the AB-BA secret chat host half.
 *
 * Zero dependency: `node:os` only. IPv4 addresses of non-internal interfaces
 * are exactly what a partner on the same network can type into a browser.
 *
 * @module dsh-abba-secret-chat/lan
 */
import os from 'node:os';

/**
 * List this machine's non-internal IPv4 addresses.
 *
 * Order follows `os.networkInterfaces()` iteration order; duplicates (some
 * platforms report one address on several interfaces) are kept, matching the
 * original chat server's banner behavior.
 *
 * @returns {string[]} dotted-quad IPv4 addresses, for example `['192.168.1.10']`.
 */
export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni && ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

export default lanAddresses;
