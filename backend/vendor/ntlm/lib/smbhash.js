/*
 * Samba LM / NT hash generation — clean-room reimplementation using
 * pure-JS MD4 and DES (no node:crypto / OpenSSL legacy provider).
 *
 * Copyright © 2026 Andrea Genovese
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

'use strict';

var $ = require('./common');
var md4 = require('./md4').md4;
var desEncryptBlock = require('./des').desEncryptBlock;

/*
 * Generate the LM Hash (16 bytes).
 */
function lmhashbuf(inputstr) {
  /* ASCII --> uppercase, truncate to 14 chars */
  var x = inputstr.substring(0, 14).toUpperCase();
  var xl = Buffer.byteLength(x, 'ascii');

  /* null pad to 14 bytes */
  var y = Buffer.alloc(14);
  y.write(x, 0, xl, 'ascii');

  /* insert odd parity bits in key */
  var halves = [
    $.oddpar($.expandkey(y.slice(0, 7))),
    $.oddpar($.expandkey(y.slice(7, 14))),
  ];

  /* DES encrypt magic number "KGS!@#$%" to two 8-byte ciphertexts (ECB) */
  var magic = Buffer.from('KGS!@#$%', 'binary');
  var buf = Buffer.alloc(16);
  var pos = 0;
  halves.forEach(function (z) {
    desEncryptBlock(z, magic).copy(buf, pos);
    pos += 8;
  });

  /* concat the two ciphertexts to form the 16-byte LM hash */
  return buf;
}

/*
 * Generate the NT Hash (16 bytes): MD4 of the UCS-2 (little-endian) password.
 */
function nthashbuf(str) {
  var ucs2 = Buffer.from(str, 'ucs2');
  return md4(ucs2);
}

function lmhash(is) {
  return $.bintohex(lmhashbuf(is));
}

function nthash(is) {
  return $.bintohex(nthashbuf(is));
}

module.exports.nthashbuf = nthashbuf;
module.exports.lmhashbuf = lmhashbuf;

module.exports.nthash = nthash;
module.exports.lmhash = lmhash;
