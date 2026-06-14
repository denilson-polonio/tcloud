'use strict';
const settings = require('./settings');
const tg = require('./telegram');
const bot = require('./bot');

// The bot is used BOTH as a storage backend (API calls that post/fetch/delete
// channel messages) AND as a long-polling receiver for TDrop (files users send
// to it). So we must register handlers and start polling.
let started = false;
let active = null;

async function startTelegram() {
  if (started) return;
  const cfg = settings.telegramConfig();
  // The bot starts as soon as a TOKEN exists — even before the storage channel
  // is set — so that during setup you can send /id to it (or inside the channel)
  // to discover the channel ID. Storage calls just need the channel set later.
  if (!cfg.botToken) return;
  const b = tg.configure(cfg);
  // A global error handler so a single bad update (e.g. an odd channel post) can
  // never stop long-polling. Without this, grammy stops the bot on any throw.
  b.catch((err) => { const e = err && err.error; console.error('Bot error:', (e && (e.description || e.message)) || (err && err.message) || String(err)); });
  bot.registerHandlers(b);
  started = true;
  active = b;
  // bot.start() resolves only when the bot stops, so we must NOT await it.
  b.start({
    drop_pending_updates: true,
    onStart: (info) => console.log(`  Telegram bot @${info.username} ready` + (cfg.storageChannel ? ' — TDrop active.' : ' — send /id in your channel to get its ID.') + '\n'),
  }).catch((e) => { console.error('Telegram polling stopped:', e.message || e); started = false; active = null; });
}
async function stopTelegram() {
  if (active) { try { await active.stop(); } catch (_) {} active = null; }
  started = false;
}
async function restartTelegram() {
  await stopTelegram();
  await new Promise((r) => setTimeout(r, 400)); // let Telegram release the previous getUpdates poller
  await startTelegram();
}
module.exports = { startTelegram, stopTelegram, restartTelegram };
