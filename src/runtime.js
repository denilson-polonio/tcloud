'use strict';
const settings = require('./settings');
const tg = require('./telegram');
const bot = require('./bot');

let started = false;
let active = null;

async function startTelegram() {
  if (started) return;
  const cfg = settings.telegramConfig();
  if (!cfg.botToken) return;
  const b = tg.configure(cfg);
  b.catch((err) => { const e = err && err.error; console.error('Bot error:', (e && (e.description || e.message)) || (err && err.message) || String(err)); });
  bot.registerHandlers(b);
  started = true;
  active = b;
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
  await new Promise((r) => setTimeout(r, 400));
  await startTelegram();
}
module.exports = { startTelegram, stopTelegram, restartTelegram };
