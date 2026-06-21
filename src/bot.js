'use strict';
const { InlineKeyboard } = require('grammy');
const tg = require('./telegram');
const auth = require('./auth');
const storage = require('./storage');
const settings = require('./settings');
const config = require('../config');
const db = require('./db');
const guests = require('./guests');
const shares = require('./shares');
const crypto = require('crypto');

const DICT = {
  it: {
    share_btn: '🔗 Condividi',
    share_choose: 'Che tipo di link vuoi creare?',
    share_public: '🌐 Pubblico',
    share_private: '🔒 Privato',
    share_public_made: '🌐 Link pubblico (chiunque con il link puo aprirlo):\n<code>{url}</code>',
    share_private_made: '🔒 Link privato:\n<code>{url}</code>\nPassword: <code>{pass}</code>',
    share_no_perm: '⛔ Non hai il permesso di condividere.',
    share_no_url: '🔗 Link creato. Imposta un "URL pubblico dei link" nelle impostazioni per avere il link completo. Token: <code>{token}</code>',
    share_failed: '⚠️ Impossibile creare il link: {err}',
    file_gone: 'file non trovato',
    no_links: 'Non hai link attivi. Invia un file e tocca 🔗 Condividi.',
    revoke_btn: '🗑 Revoca',
    link_revoked: '🗑 Link revocato.',
    start_linked: '👋 Ciao {name}! TCloud è collegato.\n\nInviami qualsiasi file (foto, video, documento, audio…) e finirà subito nella tua cartella TDrop personale. Da lì puoi organizzarlo nelle tue cartelle — qui o nell\'app web.\n\n💡 Dopo che invii un file ti propongo io di spostarlo in una cartella.',
    start_unlinked: '👋 Benvenuto su TCloud!\n\nTCloud è un cloud self-hosted che trasforma Telegram in spazio di archiviazione illimitato per i tuoi file — il tuo Google Drive privato, alle tue condizioni. 🚀\n\nQuesto bot è la casella TDrop: invii un file e compare nel tuo TCloud, pronto da organizzare e condividere.\n\nPer iniziare a salvare i file qui, collega questo account Telegram al tuo profilo TCloud:\n1. Apri TCloud → Profilo\n2. Incolla il tuo ID Telegram: {id}\n\n{site}',
    id_msg: '🆔 Il tuo ID Telegram è:\n<code>{id}</code>\n\nAggiungilo in TCloud → Profilo per collegare questo account.',
    help_msg: '📖 <b>Comandi</b>\n/start — informazioni e collegamento\n/id — mostra il tuo ID Telegram\n/settings — scegli dove salvare i file (tuo TDrop, condiviso, o chiedi ogni volta)\n/cancel — annulla l\'operazione in corso\n/links — i tuoi link condivisi (con revoca)\n\nInvia un file per salvarlo, poi usa i pulsanti. 📂',
    saving: '⏳ Salvataggio di “{name}”…',
    saved: '✅ “{name}” salvato nel tuo TDrop. 📥',
    not_linked_file: '📥 Ho ricevuto “{name}”, ma non posso salvarlo: questo account Telegram non è ancora collegato a un utente TCloud.\n\nTCloud trasforma Telegram nel tuo cloud privato illimitato. Collega il tuo account per conservare file come questo:\n• Apri TCloud → Profilo\n• Incolla il tuo ID Telegram: {id}\n\n{site}',
    disabled_drops: '⛔ Il TDrop è attualmente disattivato dall\'amministratore.',
    account_disabled: '⛔ Il tuo account TCloud è disabilitato.',
    no_tdrop: '🔒 Il tuo account non ha accesso al TDrop. Chiedi a un amministratore di abilitare il permesso “tdrop”.',
    quota_full: '❌ Spazio insufficiente — la tua quota di archiviazione TCloud è piena.',
    save_failed: '❌ Impossibile salvare il file: {err}',
    choose_folder: '📁 Dove va “{name}”?',
    root_option: '🏠 Home (nessuna cartella)',
    new_folder_btn: '➕ Nuova cartella',
    cancel_btn: '✖️ Annulla',
    moved: '✅ Spostato “{name}” → {folder} 📂',
    ask_folder_name: '✏️ Inviami il nome della nuova cartella (la creo e ci sposto dentro il tuo file). Invia /cancel per annullare.',
    folder_created_moved: '✅ Creata “{folder}” e spostato “{name}” al suo interno. 📂',
    cancelled: '👍 Ok, lascio tutto com\'è.',
    confirm_delete: '🗑 Eliminare “{name}”? Verrà rimosso dal tuo TCloud.',
    yes_del: '✅ Sì, elimina',
    keep_btn: '✖️ Mantieni',
    deleted: '🗑 “{name}” eliminato.',
    gone: '⚠️ Quel file non è più disponibile.',
    settings_msg: '⚙️ <b>Impostazioni TDrop</b>\nDove devo salvare i file che mi invii?\n\nDestinazione attuale: <b>{dest}</b>',
    dest_mine: '📥 Il mio TDrop',
    dest_shared: '👥 TDrop condiviso',
    dest_ask: '❓ Chiedimelo ogni volta',
    settings_saved: '✅ Fatto! I prossimi file andranno in: <b>{dest}</b>',
    where_save: '📥 “{name}” — dove lo salvo?',
    saved_shared: '✅ “{name}” salvato nel TDrop CONDIVISO. 👥',
    guest_welcome: '👋 Ciao @{u}! Sei ospite di questo TCloud: inviami pure i file e li consegno io.\n\n📂 Destinazione: <b>{dest}</b>\n⏳ Validità: <b>{exp}</b>',
    guest_saved: '✅ “{name}” ricevuto e consegnato. Grazie! {exp}',
    guest_expired: '⌛ Il tuo invito ospite è scaduto. Chiedi all\'amministratore di TCloud un nuovo invito.',
    exp_never: 'nessuna scadenza',
    exp_until: 'fino al {date}',
    move_btn: '📁 Sposta in una cartella',
    del_btn: '🗑 Elimina',
    site_have: '🌐 Il tuo TCloud: {url}',
    site_none: 'Non hai ancora TCloud? Chiedi al tuo amministratore.',
  },
};
function lang() { return (settings.appearance().language || 'en').toLowerCase().startsWith('it') ? 'it' : 'en'; }
function B(key, vars) {
  let s = (DICT[lang()] && DICT[lang()][key]) || DICT.en[key] || key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}
DICT.en = {
  share_btn: '🔗 Share',
  share_choose: 'What kind of link?',
  share_public: '🌐 Public',
  share_private: '🔒 Private',
  share_public_made: '🌐 Public link (anyone with the link can open it):\n<code>{url}</code>',
  share_private_made: '🔒 Private link:\n<code>{url}</code>\nPassword: <code>{pass}</code>',
  share_no_perm: '⛔ You do not have permission to share.',
  share_no_url: '🔗 Link created. Set a "Public share URL" in settings to get the full link. Token: <code>{token}</code>',
  share_failed: '⚠️ Could not create the link: {err}',
  file_gone: 'file not found',
  no_links: 'You have no active links. Send a file and tap 🔗 Share.',
  revoke_btn: '🗑 Revoke',
  link_revoked: '🗑 Link revoked.',
  start_linked: '👋 Hi {name}! TCloud is connected.\n\nSend me any file (photo, video, document, audio…) and it lands straight in your personal TDrop folder. From there you can organize it into your folders — here or in the web app.\n\n💡 After you send a file I\'ll offer to move it into a folder.',
  start_unlinked: '👋 Welcome to TCloud!\n\nTCloud is a self-hosted cloud that turns Telegram into unlimited storage for your files — your own private cloud, on your terms. 🚀\n\nThis bot is the TDrop inbox: send a file and it appears in your TCloud, ready to organize and share.\n\nTo start saving files here, link this Telegram account to your TCloud profile:\n1. Open TCloud → Profile\n2. Paste your Telegram ID: {id}\n\n{site}',
  id_msg: '🆔 Your Telegram ID is:\n<code>{id}</code>\n\nAdd it in TCloud → Profile to link this account.',
  help_msg: '📖 <b>Commands</b>\n/start — info & linking\n/id — show your Telegram ID\n/settings — choose where files go (your TDrop, shared, or ask every time)\n/cancel — cancel the current action\n/links — your shared links (with revoke)\n\nSend a file to save it, then use the buttons. 📂',
  saving: '⏳ Saving “{name}”…',
  saved: '✅ Saved “{name}” to your TDrop. 📥',
  not_linked_file: '📥 I received “{name}”, but I couldn\'t save it — this Telegram account isn\'t linked to a TCloud user yet.\n\nTCloud turns Telegram into your own unlimited private cloud. Link your account to keep files like this:\n• Open TCloud → Profile\n• Paste your Telegram ID: {id}\n\n{site}',
  disabled_drops: '⛔ TDrop is currently turned off by the administrator.',
  account_disabled: '⛔ Your TCloud account is disabled.',
  no_tdrop: '🔒 Your account doesn\'t have TDrop access. Ask an administrator to enable the “tdrop” permission.',
  quota_full: '❌ Not enough space — your TCloud storage quota is full.',
  save_failed: '❌ Couldn\'t save the file: {err}',
  choose_folder: '📁 Where should “{name}” go?',
  root_option: '🏠 Home (no folder)',
  new_folder_btn: '➕ New folder',
  cancel_btn: '✖️ Cancel',
  moved: '✅ Moved “{name}” → {folder} 📂',
  ask_folder_name: '✏️ Send me the name for the new folder (I\'ll create it and move your file inside). Send /cancel to abort.',
  folder_created_moved: '✅ Created “{folder}” and moved “{name}” inside. 📂',
  cancelled: '👍 Okay, left things as they were.',
  confirm_delete: '🗑 Delete “{name}”? This removes it from your TCloud.',
  yes_del: '✅ Yes, delete',
  keep_btn: '✖️ Keep',
  deleted: '🗑 Deleted “{name}”.',
  gone: '⚠️ That file is no longer available.',
  settings_msg: '⚙️ <b>TDrop settings</b>\nWhere should I save the files you send me?\n\nCurrent destination: <b>{dest}</b>',
  dest_mine: '📥 My TDrop',
  dest_shared: '👥 Shared TDrop',
  dest_ask: '❓ Ask me every time',
  settings_saved: '✅ Done! New files will go to: <b>{dest}</b>',
  where_save: '📥 “{name}” — where should I save it?',
  saved_shared: '✅ Saved “{name}” to the SHARED TDrop. 👥',
  guest_welcome: '👋 Hi @{u}! You are a guest of this TCloud: send me files and I will deliver them.\n\n📂 Destination: <b>{dest}</b>\n⏳ Valid: <b>{exp}</b>',
  guest_saved: '✅ “{name}” received and delivered. Thanks! {exp}',
  guest_expired: '⌛ Your guest invite has expired. Ask the TCloud admin for a new one.',
  exp_never: 'no deadline',
  exp_until: 'until {date}',
  move_btn: '📁 Move to folder',
  del_btn: '🗑 Delete',
  site_have: '🌐 Your TCloud: {url}',
  site_none: 'Don\'t have TCloud yet? Ask your admin.',
};

function siteLine() { return config.publicUrl ? B('site_have', { url: config.publicUrl }) : B('site_none'); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function botShareUrl(token) {
  const b = (settings.getRaw('share_public_url') || config.shareUrl || config.publicUrl || '').replace(/\/+$/, '');
  return b ? b + '/s/' + token : null;
}
async function makeShare(ctx, user, fileId, isPrivate) {
  if (!auth.can(user, 'share')) return ctx.reply(B('share_no_perm'));
  let password = null;
  if (isPrivate) { password = crypto.randomBytes(6).toString('base64').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8); if (password.length < 4) password = 'tc' + Math.floor(1000 + Math.random() * 9000); }
  try {
    const s = shares.createShare({ ownerId: user.id, resourceType: 'file', resourceId: fileId, password, permission: 'download' });
    const url = botShareUrl(s.token);
    if (!url) return ctx.reply(B('share_no_url', { token: s.token }), { parse_mode: 'HTML' });
    if (isPrivate) return ctx.reply(B('share_private_made', { url: esc(url), pass: esc(password) }), { parse_mode: 'HTML', disable_web_page_preview: true });
    return ctx.reply(B('share_public_made', { url: esc(url) }), { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (e) { return ctx.reply(B('share_failed', { err: e.message || String(e) })); }
}

function getPrefs(user) { try { return JSON.parse(user.prefs || '{}'); } catch (_) { return {}; } }
function setPref(userId, key, val) {
  const row = db.prepare('SELECT prefs FROM users WHERE id = ?').get(userId);
  let p = {}; try { p = JSON.parse((row && row.prefs) || '{}'); } catch (_) {}
  p[key] = val;
  db.prepare('UPDATE users SET prefs = ? WHERE id = ?').run(JSON.stringify(p), userId);
}
function destLabel(d) { return d === 's' ? B('dest_shared') : d === 'a' ? B('dest_ask') : B('dest_mine'); }
function ownerRow() { return db.prepare('SELECT * FROM users WHERE is_owner = 1 LIMIT 1').get(); }
function canBotDelete(user, file) {
  if (file.owner_id === user.id) return true;
  try {
    const sid = storage.getSharedTDropFolderId(false);
    const m = JSON.parse(file.meta || '{}');
    return !!sid && file.folder_id === sid && m.uploaderId === user.id;
  } catch (_) { return false; }
}
function flatten(tree, prefix) {
  let out = [];
  for (const n of tree) { const path = (prefix ? prefix + ' / ' : '') + n.name; out.push({ id: n.id, path }); out = out.concat(flatten(n.children, path)); }
  return out;
}
const PER = 6;
function moveMenu(user, name) {
  return (page) => {
    const folders = flatten(storage.folderTree(user.id), '');
    const pages = Math.max(1, Math.ceil(folders.length / PER)); page = Math.min(Math.max(0, page || 0), pages - 1);
    const kb = new InlineKeyboard().text(B('root_option'), 'mf:__root__').row();
    for (const f of folders.slice(page * PER, page * PER + PER)) kb.text('📁 ' + f.path, 'mf:' + f.id).row();
    if (pages > 1) { if (page > 0) kb.text('◀️', 'mp:' + (page - 1)); kb.text(`${page + 1}/${pages}`, 'noop'); if (page < pages - 1) kb.text('▶️', 'mp:' + (page + 1)); kb.row(); }
    kb.text(B('new_folder_btn'), 'nf').text(B('cancel_btn'), 'x');
    return { text: B('choose_folder', { name }), reply_markup: kb };
  };
}

function registerHandlers(bot) {
  const pending = new Map();
  const pendingDrops = new Map();

  bot.command('start', (ctx) => {
    if (!ctx.from) return;
    const u = auth.getUserByTelegram(ctx.from.id);
    if (u && !u.disabled) return ctx.reply(B('start_linked', { name: u.username }), { reply_markup: new InlineKeyboard().text('🆔 ' + 'ID', 'showid') });
    const g = guests.match(ctx.from.id, ctx.from.username);
    if (g && guests.isActive(g)) {
      const dest = g.folder_id ? ((storage.getFolder(g.folder_id) || {}).name || 'folder') : B('dest_shared');
      const exp = g.expires_at ? B('exp_until', { date: new Date(g.expires_at).toLocaleDateString() }) : B('exp_never');
      return ctx.reply(B('guest_welcome', { u: g.username, dest, exp }), { parse_mode: 'HTML' });
    }
    if (g) return ctx.reply(B('guest_expired'));
    return ctx.reply(B('start_unlinked', { id: ctx.from.id, site: siteLine() }), { disable_web_page_preview: true });
  });
  bot.command('settings', (ctx) => {
    if (!ctx.from) return;
    const u = auth.getUserByTelegram(ctx.from.id);
    if (!u || u.disabled) return ctx.reply(B('start_unlinked', { id: ctx.from.id, site: siteLine() }), { disable_web_page_preview: true });
    const d = getPrefs(u).tdropDest || 'm';
    const kb = new InlineKeyboard()
      .text((d === 'm' ? '✓ ' : '') + B('dest_mine'), 'set:m').row()
      .text((d === 's' ? '✓ ' : '') + B('dest_shared'), 'set:s').row()
      .text((d === 'a' ? '✓ ' : '') + B('dest_ask'), 'set:a');
    return ctx.reply(B('settings_msg', { dest: destLabel(d) }), { parse_mode: 'HTML', reply_markup: kb });
  });
  bot.command('id', (ctx) => ctx.reply(B('id_msg', { id: ctx.chat.id }), { parse_mode: 'HTML' }));
  bot.command('help', (ctx) => ctx.reply(B('help_msg'), { parse_mode: 'HTML' }));
  bot.command('links', async (ctx) => {
    if (!ctx.from) return;
    const u = auth.getUserByTelegram(ctx.from.id);
    if (!u || u.disabled) return ctx.reply(B('start_unlinked', { id: ctx.from.id, site: siteLine() }), { disable_web_page_preview: true });
    const list = shares.listByOwner(u.id).filter((x) => !x.disabled);
    if (!list.length) return ctx.reply(B('no_links'));
    for (const sh of list.slice(0, 20)) {
      const url = botShareUrl(sh.token) || ('/s/' + sh.token);
      const lock = sh.has_password ? '\u{1F512}' : '\u{1F310}';
      const kb = new InlineKeyboard().text(B('revoke_btn'), 'lr:' + sh.token);
      await ctx.reply(lock + ' <b>' + esc(sh.resource_name || sh.token) + '</b>\n<code>' + esc(url) + '</code>', { parse_mode: 'HTML', reply_markup: kb, disable_web_page_preview: true });
    }
  });
  bot.command('cancel', (ctx) => { const p = pending.get(ctx.chat.id); pending.delete(ctx.chat.id); ctx.reply(B('cancelled')); });

  async function deliverUserFile(ctx, user, doc, name, dest, editMsgId, kind) {
    let folderId, ownerId = user.id, meta = {}, savedKey = 'saved';
    if (dest === 's') {
      folderId = storage.getSharedTDropFolderId(true);
      const ow = ownerRow(); ownerId = ow ? ow.id : user.id;
      meta = { from: user.username, uploaderId: user.id };
      savedKey = 'saved_shared';
    } else folderId = storage.getTDropFolderId(user.id);
    const quotaUser = ownerId === user.id ? user : auth.getUserById(ownerId);
    try { storage.assertQuota(quotaUser, doc.file_size || 0); } catch (_) { return ctx.reply(B('quota_full')); }
    try {
      let msgId = editMsgId;
      if (msgId) await ctx.api.editMessageText(ctx.chat.id, msgId, B('saving', { name })).catch(() => {});
      else { const notice = await ctx.reply(B('saving', { name })); msgId = notice.message_id; }
      const posted = await tg.copyToChannel(doc.file_id, kind);
      const file = storage.registerSingleChunkFile({
        name, mime: doc.mime_type, size: doc.file_size || posted.size || 0,
        ownerId, folderId, source: 'tdrop', tgFileId: posted.file_id, messageId: posted.message_id, meta,
      });
      const kb = dest === 's'
        ? new InlineKeyboard().text(B('share_btn'), 'sh:' + file.id).text(B('del_btn'), 'del:' + file.id)
        : new InlineKeyboard().text(B('move_btn'), 'mv:' + file.id).text(B('del_btn'), 'del:' + file.id).row().text(B('share_btn'), 'sh:' + file.id);
      await ctx.api.editMessageText(ctx.chat.id, msgId, B(savedKey, { name }), { reply_markup: kb });
    } catch (e) { console.error('TDrop error:', e); ctx.reply(B('save_failed', { err: e.message || String(e) })); }
  }

  async function handleIncoming(ctx, doc, fallbackName, kind) {
    if (ctx.chat.type !== 'private') return;
    const name = (doc && doc.file_name) || fallbackName || `file_${Date.now()}`;
    const user = auth.getUserByTelegram(ctx.from.id);
    if (!user) {
      const g = guests.match(ctx.from.id, ctx.from.username);
      if (g) {
        if (!guests.isActive(g)) return ctx.reply(B('guest_expired'));
        if (settings.getRaw('accept_drops') === 'false') return ctx.reply(B('disabled_drops'));
        const folderId = g.folder_id || storage.getSharedTDropFolderId(true);
        const fRow = folderId ? storage.getFolder(folderId) : null;
        if (!fRow) return ctx.reply(B('save_failed', { err: 'destination folder is gone' }));
        const destOwner = auth.getUserById(fRow.owner_id);
        try { storage.assertQuota(destOwner, doc.file_size || 0); } catch (_) { return ctx.reply(B('quota_full')); }
        try {
          const notice = await ctx.reply(B('saving', { name }));
          const posted = await tg.copyToChannel(doc.file_id, kind);
          storage.registerSingleChunkFile({
            name, mime: doc.mime_type, size: doc.file_size || posted.size || 0,
            ownerId: fRow.owner_id, folderId, source: 'tdrop',
            tgFileId: posted.file_id, messageId: posted.message_id,
            meta: { from: '@' + g.username, guest: true },
          });
          guests.bumpUploads(g.id);
          const exp = g.expires_at ? '(' + B('exp_until', { date: new Date(g.expires_at).toLocaleDateString() }) + ')' : '';
          await ctx.api.editMessageText(ctx.chat.id, notice.message_id, B('guest_saved', { name, exp }));
        } catch (e) { console.error('TDrop guest error:', e); ctx.reply(B('save_failed', { err: e.message || String(e) })); }
        return;
      }
      return ctx.reply(B('not_linked_file', { name, id: ctx.from.id, site: siteLine() }), { disable_web_page_preview: true });
    }
    if (user.disabled) return ctx.reply(B('account_disabled'));
    if (settings.getRaw('accept_drops') === 'false') return ctx.reply(B('disabled_drops'));
    if (!auth.can(user, 'tdrop')) return ctx.reply(B('no_tdrop'));
    const dest = getPrefs(user).tdropDest || 'm';
    if (dest === 'a') {
      const pid = crypto.randomBytes(4).toString('hex');
      pendingDrops.set(pid, { doc: { file_id: doc.file_id, mime_type: doc.mime_type, file_size: doc.file_size }, name, userId: user.id, exp: Date.now() + 10 * 60000, kind });
      const kb = new InlineKeyboard().text(B('dest_mine'), 'sd:m:' + pid).text(B('dest_shared'), 'sd:s:' + pid).row().text(B('cancel_btn'), 'sx:' + pid);
      return ctx.reply(B('where_save', { name }), { reply_markup: kb });
    }
    return deliverUserFile(ctx, user, doc, name, dest, undefined, kind);
  }

  bot.on('message:document', (ctx) => handleIncoming(ctx, ctx.message.document, undefined, 'document'));
  bot.on('message:video', (ctx) => handleIncoming(ctx, ctx.message.video, `video_${Date.now()}.mp4`, 'video'));
  bot.on('message:audio', (ctx) => handleIncoming(ctx, ctx.message.audio, undefined, 'audio'));
  bot.on('message:voice', (ctx) => handleIncoming(ctx, ctx.message.voice, `voice_${Date.now()}.ogg`, 'voice'));
  bot.on('message:photo', (ctx) => { const p = ctx.message.photo[ctx.message.photo.length - 1]; handleIncoming(ctx, { file_id: p.file_id, file_size: p.file_size, mime_type: 'image/jpeg' }, `photo_${Date.now()}.jpg`, 'photo'); });

  bot.on('message:text', async (ctx) => {
    const txt = ctx.message.text || '';
    if (txt.startsWith('/')) return;
    const p = pending.get(ctx.chat.id);
    if (!p || !p.awaitingName) return;
    const user = auth.getUserByTelegram(ctx.from.id);
    if (!user) { pending.delete(ctx.chat.id); return; }
    const file = storage.getFile(p.fileId);
    if (!file || file.owner_id !== user.id) { pending.delete(ctx.chat.id); return ctx.reply(B('gone')); }
    const fname = txt.trim().slice(0, 80) || 'New folder';
    const folder = storage.createFolder(fname, null, user.id);
    storage.moveFile(file.id, folder.id);
    pending.delete(ctx.chat.id);
    ctx.reply(B('folder_created_moved', { folder: fname, name: file.name }));
  });

  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data || '';
    const user = auth.getUserByTelegram(ctx.from.id);
    const ack = (t) => ctx.answerCallbackQuery(t ? { text: t } : undefined).catch(() => {});
    if (data === 'noop') return ack();
    if (data === 'showid') { await ack(); return ctx.reply(B('id_msg', { id: ctx.from.id }), { parse_mode: 'HTML' }); }
    if (!user || user.disabled) { return ack(); }

    if (data === 'x') { const p = pending.get(ctx.chat.id); pending.delete(ctx.chat.id); await ack(); return ctx.editMessageText(B('cancelled')).catch(() => {}); }
    if (data.startsWith('sh:')) { const fid = data.slice(3); await ack(); if (!auth.can(user, 'share')) return ctx.reply(B('share_no_perm')); if (!storage.ownsFile(user.id, fid)) return ctx.reply(B('share_failed', { err: B('file_gone') })); return ctx.reply(B('share_choose'), { reply_markup: new InlineKeyboard().text(B('share_public'), 'shp:' + fid).text(B('share_private'), 'shv:' + fid) }); }
    if (data.startsWith('shp:')) { await ack(); return makeShare(ctx, user, data.slice(4), false); }
    if (data.startsWith('shv:')) { await ack(); return makeShare(ctx, user, data.slice(4), true); }
    if (data.startsWith('lr:')) { const tk = data.slice(3); await ack(); try { shares.updateShare(tk, user.id, { disabled: true }); } catch (_) {} return ctx.editMessageText(B('link_revoked')).catch(() => {}); }

    if (data.startsWith('set:')) {
      const d = data.slice(4);
      if (!['m', 's', 'a'].includes(d)) return ack();
      setPref(user.id, 'tdropDest', d); await ack();
      return ctx.editMessageText(B('settings_saved', { dest: destLabel(d) }), { parse_mode: 'HTML' }).catch(() => {});
    }
    if (data.startsWith('sx:')) { pendingDrops.delete(data.slice(3)); await ack(); return ctx.editMessageText(B('cancelled')).catch(() => {}); }
    if (data.startsWith('sd:')) {
      const [, d, pid] = data.split(':');
      const p = pendingDrops.get(pid);
      if (!p || p.exp < Date.now() || p.userId !== user.id) { await ack(); return ctx.editMessageText(B('gone')).catch(() => {}); }
      pendingDrops.delete(pid); await ack();
      return deliverUserFile(ctx, user, p.doc, p.name, d === 's' ? 's' : 'm', ctx.callbackQuery.message && ctx.callbackQuery.message.message_id, p.kind);
    }

    if (data.startsWith('mv:')) {
      const fileId = data.slice(3); const file = storage.getFile(fileId);
      if (!file || file.owner_id !== user.id) { await ack(); return ctx.editMessageText(B('gone')).catch(() => {}); }
      pending.set(ctx.chat.id, { fileId, name: file.name });
      const m = moveMenu(user, file.name)(0); await ack();
      return ctx.editMessageText(m.text, { reply_markup: m.reply_markup }).catch(() => {});
    }
    if (data.startsWith('mp:')) {
      const p = pending.get(ctx.chat.id); if (!p) { await ack(); return ctx.editMessageText(B('gone')).catch(() => {}); }
      const m = moveMenu(user, p.name)(parseInt(data.slice(3), 10) || 0); await ack();
      return ctx.editMessageReplyMarkup({ reply_markup: m.reply_markup }).catch(() => {});
    }
    if (data === 'nf') {
      const p = pending.get(ctx.chat.id); if (!p) { await ack(); return ctx.editMessageText(B('gone')).catch(() => {}); }
      p.awaitingName = true; pending.set(ctx.chat.id, p); await ack();
      return ctx.editMessageText(B('ask_folder_name')).catch(() => {});
    }
    if (data.startsWith('mf:')) {
      const p = pending.get(ctx.chat.id); if (!p) { await ack(); return ctx.editMessageText(B('gone')).catch(() => {}); }
      const file = storage.getFile(p.fileId);
      if (!file || file.owner_id !== user.id) { pending.delete(ctx.chat.id); await ack(); return ctx.editMessageText(B('gone')).catch(() => {}); }
      const dest = data.slice(3);
      let label;
      if (dest === '__root__') { storage.moveFile(file.id, null); label = B('root_option'); }
      else { const folder = storage.getFolder(dest); if (!folder || folder.owner_id !== user.id) { await ack(); return; } storage.moveFile(file.id, dest); label = storage.folderPath(dest).filter((x) => !x.system).map((x) => x.name).join(' / '); }
      pending.delete(ctx.chat.id); await ack();
      return ctx.editMessageText(B('moved', { name: file.name, folder: label })).catch(() => {});
    }
    if (data.startsWith('del:')) {
      const fileId = data.slice(4); const file = storage.getFile(fileId);
      if (!file || !canBotDelete(user, file)) { await ack(); return ctx.editMessageText(B('gone')).catch(() => {}); }
      const kb = new InlineKeyboard().text(B('yes_del'), 'dy:' + fileId).text(B('keep_btn'), 'x'); await ack();
      return ctx.editMessageText(B('confirm_delete', { name: file.name }), { reply_markup: kb }).catch(() => {});
    }
    if (data.startsWith('dy:')) {
      const fileId = data.slice(3); const file = storage.getFile(fileId);
      if (!file || !canBotDelete(user, file)) { await ack(); return ctx.editMessageText(B('gone')).catch(() => {}); }
      const nm = file.name; await storage.deleteFile(fileId); await ack();
      return ctx.editMessageText(B('deleted', { name: nm })).catch(() => {});
    }
    return ack();
  });
}
module.exports = { registerHandlers };
