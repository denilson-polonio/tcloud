'use strict';
const config = require('../config');

/* ── Connectivity probe ──
   TCloud is fully decentralized: no central server, no licensing, no instance
   registration. The UI only needs "is the internet up?", which we answer by
   probing the Telegram API root (the one service TCloud actually depends on).
   We give it two chances with a generous timeout so a single slow or dropped
   request — common on a home connection / Raspberry Pi — never makes the whole
   app claim the internet is down. Cached briefly; never throws. */
function timedFetch(url, opts, ms) {
  if (typeof fetch !== 'function') return Promise.reject(new Error('no fetch'));
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms || 6000);
  return fetch(url, Object.assign({}, opts, { signal: ctrl.signal })).finally(() => clearTimeout(to));
}
async function probe(ms) {
  try { const r = await timedFetch(config.defaults.apiRoot, { method: 'GET' }, ms); return !!r; } catch (_) { return false; }
}
let cache = { net: null, at: 0 };
async function internetOk() {
  if (cache.net !== null && Date.now() - cache.at < 12000) return cache.net;
  let ok = await probe(6000);
  if (!ok) ok = await probe(6000); // second chance before declaring offline
  cache.net = ok; cache.at = Date.now();
  return ok;
}
module.exports = { internetOk };
