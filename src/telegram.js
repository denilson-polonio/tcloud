'use strict';
const { Bot, InputFile, GrammyError, HttpError } = require('grammy');

// Lazily-configured Telegram layer. The bot is created only once a token and
// channel are available (from settings or the setup wizard).
const state = { bot: null, token: '', channel: '', apiRoot: 'https://api.telegram.org', CHUNK: 18 * 1024 * 1024 };

function isReady() { return !!state.bot; }
function chunkSize() { return state.CHUNK; }

function configure({ botToken, storageChannel, apiRoot, chunkSizeMB }) {
  state.token = botToken;
  state.channel = storageChannel;
  state.apiRoot = (apiRoot || 'https://api.telegram.org').replace(/\/+$/, '');
  state.CHUNK = Math.max(1, chunkSizeMB || 18) * 1024 * 1024;
  state.bot = new Bot(botToken, { client: { apiRoot: state.apiRoot } });
  return state.bot;
}

function ensure() { if (!state.bot) throw new Error('Telegram not configured'); }

async function withRetry(fn, tries = 6) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      const is429 = e instanceof GrammyError && e.error_code === 429;
      const is5xx = e instanceof GrammyError && e.error_code >= 500;
      const isNet = (typeof HttpError !== 'undefined' && e instanceof HttpError)
        || /network|timeout|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|socket/i.test(String(e && e.message));
      if ((is429 || is5xx || isNet) && attempt < tries) {
        const wait = is429 ? (((e.parameters && e.parameters.retry_after) || 1) + 1) : Math.min(2 ** attempt, 8);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      throw e;
    }
  }
}

async function uploadChunk(buffer, name) {
  ensure();
  const msg = await withRetry(() =>
    state.bot.api.sendDocument(state.channel, new InputFile(buffer, name), { disable_notification: true })
  );
  return {
    file_id: msg.document.file_id,
    message_id: msg.message_id,
    size: msg.document.file_size != null ? msg.document.file_size : buffer.length,
  };
}

async function copyToChannel(fileId) {
  ensure();
  const msg = await withRetry(() => state.bot.api.sendDocument(state.channel, fileId, { disable_notification: true }));
  // Telegram may echo the file back as a document, photo, video, audio, voice or
  // animation depending on the original file_id — read whichever the response
  // actually carries instead of assuming `msg.document` (which crashed TDrop on
  // photos/videos and showed a random "save failed").
  const media = msg.document
    || (Array.isArray(msg.photo) && msg.photo.length ? msg.photo[msg.photo.length - 1] : null)
    || msg.video || msg.audio || msg.voice || msg.animation;
  if (!media || !media.file_id) throw new Error('Telegram did not return a stored file');
  return {
    file_id: media.file_id,
    message_id: msg.message_id,
    size: media.file_size != null ? media.file_size : 0,
  };
}

async function downloadChunk(fileId) {
  ensure();
  const file = await withRetry(() => state.bot.api.getFile(fileId));
  const url = `${state.apiRoot}/file/bot${state.token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Telegram download failed (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

async function deleteMessage(messageId) {
  if (!messageId || !state.bot) return;
  try { await state.bot.api.deleteMessage(state.channel, messageId); } catch (_) {}
}

/* ── Backup helpers: push a snapshot to the channel and pin it ── */
async function sendBackup(buffer, name, caption) {
  ensure();
  const msg = await withRetry(() =>
    state.bot.api.sendDocument(state.channel, new InputFile(buffer, name), { caption: caption || '', disable_notification: true })
  );
  return { file_id: msg.document.file_id, message_id: msg.message_id };
}
async function pinMessage(messageId) {
  ensure();
  try { await state.bot.api.pinChatMessage(state.channel, messageId, { disable_notification: true }); return true; }
  catch (_) { return false; }
}
async function getPinnedBackup() {
  ensure();
  const chat = await withRetry(() => state.bot.api.getChat(state.channel));
  const pin = chat.pinned_message;
  if (!pin || !pin.document) return null;
  return { file_id: pin.document.file_id, message_id: pin.message_id, name: pin.document.file_name };
}

// Validate a token/channel pair without keeping it: returns the bot username.
async function sendMessage(chatId, text) {
  ensure();
  return withRetry(() => state.bot.api.sendMessage(chatId, text));
}
// Validate just a bot TOKEN (no channel needed) — used by the setup wizard to
// start the bot early so the user can send /id to discover the channel ID.
async function probeToken({ botToken, apiRoot }) {
  const b = new Bot(botToken, { client: { apiRoot: (apiRoot || 'https://api.telegram.org').replace(/\/+$/, '') } });
  const me = await b.api.getMe();
  return { username: me.username, name: me.first_name };
}
async function probe({ botToken, storageChannel, apiRoot }) {
  const probeBot = new Bot(botToken, { client: { apiRoot: (apiRoot || 'https://api.telegram.org').replace(/\/+$/, '') } });
  const me = await probeBot.api.getMe();
  // Try to read the channel; bot must be a member/admin.
  const chat = await probeBot.api.getChat(storageChannel);
  return { username: me.username, chatTitle: chat.title || String(storageChannel) };
}

module.exports = {
  sendMessage,
  isReady, chunkSize, configure,
  uploadChunk, copyToChannel, downloadChunk, deleteMessage,
  sendBackup, pinMessage, getPinnedBackup, probe, probeToken,
};
