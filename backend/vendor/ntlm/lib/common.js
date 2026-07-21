/*
 * NTLM helper primitives (key expansion / parity) — clean-room reimplementation.
 *
 * Copyright (C) 2026  Arkimede contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

'use strict';

function zeroextend(str, len) {
  while (str.length < len) str = '0' + str;
  return str;
}

/*
 * Fix (odd) parity bits in a 64-bit DES key.
 */
function oddpar(buf) {
  for (var j = 0; j < buf.length; j++) {
    var par = 1;
    for (var i = 1; i < 8; i++) {
      par = (par + ((buf[j] >> i) & 1)) % 2;
    }
    buf[j] |= par & 1;
  }
  return buf;
}

/*
 * Expand a 56-bit key buffer (7 bytes) to the full 64 bits (8 bytes) for DES.
 */
function expandkey(key56) {
  var key64 = Buffer.alloc(8);

  key64[0] = key56[0] & 0xfe;
  key64[1] = ((key56[0] << 7) & 0xff) | (key56[1] >> 1);
  key64[2] = ((key56[1] << 6) & 0xff) | (key56[2] >> 2);
  key64[3] = ((key56[2] << 5) & 0xff) | (key56[3] >> 3);
  key64[4] = ((key56[3] << 4) & 0xff) | (key56[4] >> 4);
  key64[5] = ((key56[4] << 3) & 0xff) | (key56[5] >> 5);
  key64[6] = ((key56[5] << 2) & 0xff) | (key56[6] >> 6);
  key64[7] = (key56[6] << 1) & 0xff;

  return key64;
}

/*
 * Convert a binary string to an upper-case, 32-char zero-padded hex string.
 */
function bintohex(bin) {
  var buf = Buffer.isBuffer(bin) ? bin : Buffer.from(bin, 'binary');
  var str = buf.toString('hex').toUpperCase();
  return zeroextend(str, 32);
}

module.exports.zeroextend = zeroextend;
module.exports.oddpar = oddpar;
module.exports.expandkey = expandkey;
module.exports.bintohex = bintohex;
