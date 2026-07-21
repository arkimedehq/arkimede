/*
 * NTLM authentication message encoding (Type1 / Type2 / Type3) —
 * clean-room reimplementation with a drop-in public API compatible with
 * ntlm@0.1.3, but using pure-JS MD4/DES primitives (no OpenSSL provider
 * dependency).
 *
 * Copyright © 2026 Andrea Genovese
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

'use strict';

var $ = require('./common');
var smbhash = require('./smbhash');
var lmhashbuf = smbhash.lmhashbuf;
var nthashbuf = smbhash.nthashbuf;
var desEncryptBlock = require('./des').desEncryptBlock;

function encodeType1(hostname, ntdomain) {
  hostname = hostname.toUpperCase();
  ntdomain = ntdomain.toUpperCase();
  var hostnamelen = Buffer.byteLength(hostname, 'ascii');
  var ntdomainlen = Buffer.byteLength(ntdomain, 'ascii');

  var pos = 0;
  var buf = Buffer.alloc(32 + hostnamelen + ntdomainlen);

  buf.write('NTLMSSP', pos, 7, 'ascii'); // byte protocol[8];
  pos += 7;
  buf.writeUInt8(0, pos);
  pos++;

  buf.writeUInt8(0x01, pos); // byte type;
  pos++;

  buf.fill(0x00, pos, pos + 3); // byte zero[3];
  pos += 3;

  buf.writeUInt16LE(0xb203, pos); // short flags;
  pos += 2;

  buf.fill(0x00, pos, pos + 2); // byte zero[2];
  pos += 2;

  buf.writeUInt16LE(ntdomainlen, pos); // short dom_len;
  pos += 2;
  buf.writeUInt16LE(ntdomainlen, pos); // short dom_len;
  pos += 2;

  var ntdomainoff = 0x20 + hostnamelen;
  buf.writeUInt16LE(ntdomainoff, pos); // short dom_off;
  pos += 2;

  buf.fill(0x00, pos, pos + 2); // byte zero[2];
  pos += 2;

  buf.writeUInt16LE(hostnamelen, pos); // short host_len;
  pos += 2;
  buf.writeUInt16LE(hostnamelen, pos); // short host_len;
  pos += 2;

  buf.writeUInt16LE(0x20, pos); // short host_off;
  pos += 2;

  buf.fill(0x00, pos, pos + 2); // byte zero[2];
  pos += 2;

  buf.write(hostname, 0x20, hostnamelen, 'ascii');
  buf.write(ntdomain, ntdomainoff, ntdomainlen, 'ascii');

  return buf;
}

function decodeType2(buf) {
  var proto = buf.toString('ascii', 0, 7);
  if (buf[7] !== 0x00 || proto !== 'NTLMSSP')
    throw new Error('magic was not NTLMSSP');

  var type = buf.readUInt8(8);
  if (type !== 0x02) throw new Error('message was not NTLMSSP type 0x02');

  var nonce = buf.slice(24, 32);
  return nonce;
}

function encodeType3(username, hostname, ntdomain, nonce, password) {
  hostname = hostname.toUpperCase();
  ntdomain = ntdomain.toUpperCase();

  var lmh = Buffer.alloc(21);
  lmhashbuf(password).copy(lmh);
  var nth = Buffer.alloc(21);
  nthashbuf(password).copy(nth);

  var lmr = makeResponse(lmh, nonce);
  var ntr = makeResponse(nth, nonce);

  var usernamelen = Buffer.byteLength(username, 'ucs2');
  var hostnamelen = Buffer.byteLength(hostname, 'ucs2');
  var ntdomainlen = Buffer.byteLength(ntdomain, 'ucs2');
  var lmrlen = 0x18;
  var ntrlen = 0x18;

  var ntdomainoff = 0x40;
  var usernameoff = ntdomainoff + ntdomainlen;
  var hostnameoff = usernameoff + usernamelen;
  var lmroff = hostnameoff + hostnamelen;
  var ntroff = lmroff + lmrlen;

  var pos = 0;
  var msg_len = 64 + ntdomainlen + usernamelen + hostnamelen + lmrlen + ntrlen;
  var buf = Buffer.alloc(msg_len);

  buf.write('NTLMSSP', pos, 7, 'ascii'); // byte protocol[8];
  pos += 7;
  buf.writeUInt8(0, pos);
  pos++;

  buf.writeUInt8(0x03, pos); // byte type;
  pos++;

  buf.fill(0x00, pos, pos + 3); // byte zero[3];
  pos += 3;

  buf.writeUInt16LE(lmrlen, pos); // short lm_resp_len;
  pos += 2;
  buf.writeUInt16LE(lmrlen, pos); // short lm_resp_len;
  pos += 2;
  buf.writeUInt16LE(lmroff, pos); // short lm_resp_off;
  pos += 2;
  buf.fill(0x00, pos, pos + 2); // byte zero[2];
  pos += 2;

  buf.writeUInt16LE(ntrlen, pos); // short nt_resp_len;
  pos += 2;
  buf.writeUInt16LE(ntrlen, pos); // short nt_resp_len;
  pos += 2;
  buf.writeUInt16LE(ntroff, pos); // short nt_resp_off;
  pos += 2;
  buf.fill(0x00, pos, pos + 2); // byte zero[2];
  pos += 2;

  buf.writeUInt16LE(ntdomainlen, pos); // short dom_len;
  pos += 2;
  buf.writeUInt16LE(ntdomainlen, pos); // short dom_len;
  pos += 2;
  buf.writeUInt16LE(ntdomainoff, pos); // short dom_off;
  pos += 2;
  buf.fill(0x00, pos, pos + 2); // byte zero[2];
  pos += 2;

  buf.writeUInt16LE(usernamelen, pos); // short user_len;
  pos += 2;
  buf.writeUInt16LE(usernamelen, pos); // short user_len;
  pos += 2;
  buf.writeUInt16LE(usernameoff, pos); // short user_off;
  pos += 2;
  buf.fill(0x00, pos, pos + 2); // byte zero[2];
  pos += 2;

  buf.writeUInt16LE(hostnamelen, pos); // short host_len;
  pos += 2;
  buf.writeUInt16LE(hostnamelen, pos); // short host_len;
  pos += 2;
  buf.writeUInt16LE(hostnameoff, pos); // short host_off;
  pos += 2;
  buf.fill(0x00, pos, pos + 6); // byte zero[6];
  pos += 6;

  buf.writeUInt16LE(msg_len, pos); // short msg_len;
  pos += 2;
  buf.fill(0x00, pos, pos + 2); // byte zero[2];
  pos += 2;

  buf.writeUInt16LE(0x8201, pos); // short flags;
  pos += 2;
  buf.fill(0x00, pos, pos + 2); // byte zero[2];
  pos += 2;

  buf.write(ntdomain, ntdomainoff, ntdomainlen, 'ucs2');
  buf.write(username, usernameoff, usernamelen, 'ucs2');
  buf.write(hostname, hostnameoff, hostnamelen, 'ucs2');
  lmr.copy(buf, lmroff, 0, lmrlen);
  ntr.copy(buf, ntroff, 0, ntrlen);

  return buf;
}

/*
 * Produce the 24-byte LM/NT response: split the 21-byte hash into three
 * 7-byte DES keys and encrypt the 8-byte server nonce with each.
 */
function makeResponse(hash, nonce) {
  var out = Buffer.alloc(24);
  for (var i = 0; i < 3; i++) {
    var keybuf = $.oddpar($.expandkey(hash.slice(i * 7, i * 7 + 7)));
    var block = desEncryptBlock(keybuf, nonce);
    block.copy(out, i * 8);
  }
  return out;
}

exports.encodeType1 = encodeType1;
exports.decodeType2 = decodeType2;
exports.encodeType3 = encodeType3;

// Convenience methods.

exports.challengeHeader = function (hostname, domain) {
  return 'NTLM ' + exports.encodeType1(hostname, domain).toString('base64');
};

exports.responseHeader = function (res, url, domain, username, password) {
  var serverNonce = Buffer.from(
    (res.headers['www-authenticate'].match(/^NTLM\s+(.+?)(,|\s+|$)/) || [])[1],
    'base64'
  );
  var hostname = require('url').parse(url).hostname;
  return (
    'NTLM ' +
    exports
      .encodeType3(username, hostname, domain, exports.decodeType2(serverNonce), password)
      .toString('base64')
  );
};

// Import smbhash module.

exports.smbhash = require('./smbhash');
