'use strict';
const crypto = require('crypto');


const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}
function b32decode(str) {
  str = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, val = 0; const out = [];
  for (const c of str) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

function genSecret() { return b32encode(crypto.randomBytes(20)); }

function hotp(secretB32, counter) {
  const key = b32decode(secretB32);
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(msg).digest();
  const o = h[h.length - 1] & 0xf;
  const code = (((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) >>> 0;
  return String(code % 1e6).padStart(6, '0');
}

function verify(secretB32, code, windowSteps = 1, t = Date.now()) {
  try {
    code = String(code || '').replace(/\D/g, '');
    if (code.length !== 6 || !secretB32) return false;
    const step = Math.floor(t / 1000 / 30);
    for (let w = -windowSteps; w <= windowSteps; w++) {
      if (crypto.timingSafeEqual(Buffer.from(hotp(secretB32, step + w)), Buffer.from(code))) return true;
    }
    return false;
  } catch (_) { return false; }
}

function otpauthURL(label, issuer, secret) {
  return 'otpauth://totp/' + encodeURIComponent(issuer) + ':' + encodeURIComponent(label) +
    '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer) + '&digits=6&period=30';
}

function numericCode() { return String(crypto.randomInt(0, 1e6)).padStart(6, '0'); }

module.exports = { genSecret, hotp, verify, otpauthURL, numericCode, b32encode, b32decode };
