/*
 * Pure-JavaScript MD4 (RFC 1320) implementation.
 *
 * Self-contained: does NOT depend on node:crypto or any OpenSSL legacy
 * provider (MD4 was moved to the legacy provider in OpenSSL 3).
 *
 * Copyright (C) 2026  Arkimede contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

'use strict';

function rotl(x, n) {
  return (x << n) | (x >>> (32 - n));
}

/*
 * Compute the MD4 digest of a Buffer.
 * Returns a 16-byte Buffer.
 */
function md4(input) {
  var msg = Buffer.isBuffer(input) ? input : Buffer.from(input, 'binary');
  var origLenBits = msg.length * 8;

  // Padding: 0x80, then zeros, until length % 64 === 56, then 8-byte LE length.
  var padLen = (msg.length % 64 < 56 ? 56 : 120) - (msg.length % 64);
  var total = msg.length + padLen + 8;
  var buf = Buffer.alloc(total);
  msg.copy(buf, 0);
  buf[msg.length] = 0x80;
  // 64-bit little-endian bit length (low 32 bits are enough for our sizes,
  // but write both words for correctness).
  buf.writeUInt32LE(origLenBits >>> 0, total - 8);
  buf.writeUInt32LE(Math.floor(origLenBits / 0x100000000) >>> 0, total - 4);

  var a = 0x67452301;
  var b = 0xefcdab89;
  var c = 0x98badcfe;
  var d = 0x10325476;

  var X = new Array(16);

  for (var off = 0; off < total; off += 64) {
    for (var i = 0; i < 16; i++) {
      X[i] = buf.readUInt32LE(off + i * 4);
    }

    var aa = a;
    var bb = b;
    var cc = c;
    var dd = d;

    // Round 1
    a = round1(a, b, c, d, X[0], 3);
    d = round1(d, a, b, c, X[1], 7);
    c = round1(c, d, a, b, X[2], 11);
    b = round1(b, c, d, a, X[3], 19);
    a = round1(a, b, c, d, X[4], 3);
    d = round1(d, a, b, c, X[5], 7);
    c = round1(c, d, a, b, X[6], 11);
    b = round1(b, c, d, a, X[7], 19);
    a = round1(a, b, c, d, X[8], 3);
    d = round1(d, a, b, c, X[9], 7);
    c = round1(c, d, a, b, X[10], 11);
    b = round1(b, c, d, a, X[11], 19);
    a = round1(a, b, c, d, X[12], 3);
    d = round1(d, a, b, c, X[13], 7);
    c = round1(c, d, a, b, X[14], 11);
    b = round1(b, c, d, a, X[15], 19);

    // Round 2
    a = round2(a, b, c, d, X[0], 3);
    d = round2(d, a, b, c, X[4], 5);
    c = round2(c, d, a, b, X[8], 9);
    b = round2(b, c, d, a, X[12], 13);
    a = round2(a, b, c, d, X[1], 3);
    d = round2(d, a, b, c, X[5], 5);
    c = round2(c, d, a, b, X[9], 9);
    b = round2(b, c, d, a, X[13], 13);
    a = round2(a, b, c, d, X[2], 3);
    d = round2(d, a, b, c, X[6], 5);
    c = round2(c, d, a, b, X[10], 9);
    b = round2(b, c, d, a, X[14], 13);
    a = round2(a, b, c, d, X[3], 3);
    d = round2(d, a, b, c, X[7], 5);
    c = round2(c, d, a, b, X[11], 9);
    b = round2(b, c, d, a, X[15], 13);

    // Round 3
    a = round3(a, b, c, d, X[0], 3);
    d = round3(d, a, b, c, X[8], 9);
    c = round3(c, d, a, b, X[4], 11);
    b = round3(b, c, d, a, X[12], 15);
    a = round3(a, b, c, d, X[2], 3);
    d = round3(d, a, b, c, X[10], 9);
    c = round3(c, d, a, b, X[6], 11);
    b = round3(b, c, d, a, X[14], 15);
    a = round3(a, b, c, d, X[1], 3);
    d = round3(d, a, b, c, X[9], 9);
    c = round3(c, d, a, b, X[5], 11);
    b = round3(b, c, d, a, X[13], 15);
    a = round3(a, b, c, d, X[3], 3);
    d = round3(d, a, b, c, X[11], 9);
    c = round3(c, d, a, b, X[7], 11);
    b = round3(b, c, d, a, X[15], 15);

    a = (a + aa) >>> 0;
    b = (b + bb) >>> 0;
    c = (c + cc) >>> 0;
    d = (d + dd) >>> 0;
  }

  var out = Buffer.alloc(16);
  out.writeUInt32LE(a >>> 0, 0);
  out.writeUInt32LE(b >>> 0, 4);
  out.writeUInt32LE(c >>> 0, 8);
  out.writeUInt32LE(d >>> 0, 12);
  return out;

  // -- helpers (hoisted) --
  function round1(w, x, y, z, m, s) {
    var t = (w + (((x & y) | (~x & z)) >>> 0) + m) >>> 0;
    return rotl(t, s) >>> 0;
  }
  function round2(w, x, y, z, m, s) {
    var t = (w + (((x & y) | (x & z) | (y & z)) >>> 0) + m + 0x5a827999) >>> 0;
    return rotl(t, s) >>> 0;
  }
  function round3(w, x, y, z, m, s) {
    var t = (w + ((x ^ y ^ z) >>> 0) + m + 0x6ed9eba1) >>> 0;
    return rotl(t, s) >>> 0;
  }
}

module.exports.md4 = md4;
