'use strict';
/* ───────────────────────── state ───────────────────────── */
let token = localStorage.getItem('tcloud_token') || '';
let me = null, view = { type: 'folder', id: null }, treeData = [], tdropFolder = null;
let viewMode = localStorage.getItem('tcloud_viewmode') || 'grid';
const sel = new Set();
let installPrompt = null;
let rolesCache = [], permKeysCache = { content: [], admin: [] };
let orgMode = 'organization', orgName = '', support = 'https://t.me/tcloud_support', donation = 'https://ko-fi.com/denilson_polonio', appVersion = '', autoReload = true;
const $ = (s) => document.querySelector(s);
const PERM_LABELS = { upload: 'Upload', delete: 'Delete', createFolder: 'Create folders', share: 'Share', tdrop: 'TDrop access', manageUsers: 'Manage users', manageRoles: 'Manage roles', manageSettings: 'Manage settings', manageTelegram: 'Manage Telegram', manageBackups: 'Manage backups' };

/* ───────────────────────── i18n ───────────────────────── */
const LANGS = { en: 'English', it: 'Italiano' }; // extended at boot from /api/public/locales (public/i18n/*.json)
let LANG = localStorage.getItem('tcloud_lang') || (navigator.language || 'en').slice(0, 2).toLowerCase();
let DICT = {};
async function loadLocalesList() { try { const r = await (await fetch('/api/public/locales')).json(); for (const l of r.locales || []) if (l && l.code) LANGS[l.code] = l.name || l.code; } catch (_) {} }
async function loadI18n(lang) {
  LANG = lang || 'en';
  if (LANG === 'en') { DICT = {}; localStorage.setItem('tcloud_lang', 'en'); return; }
  try {
    const d = await (await fetch('/i18n/' + encodeURIComponent(LANG) + '.json')).json();
    if (!d || d.error) throw new Error('missing');
    DICT = d; localStorage.setItem('tcloud_lang', LANG);
  } catch (_) { LANG = 'en'; DICT = {}; localStorage.setItem('tcloud_lang', 'en'); }
}
function t(key, vars) { let s = (DICT && DICT[key] != null && DICT[key] !== '') ? DICT[key] : key; if (vars) for (const k in vars) s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]); return s; }
function applyI18nStatic(root) { (root || document).querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); }); (root || document).querySelectorAll('[data-i18n-ph]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); }); (root || document).querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); }); }

/* ───────────────────────── api & helpers ───────────────────────── */
async function api(path, opts = {}) {
  const headers = Object.assign({}, opts.headers);
  if (token) headers['X-Auth-Token'] = token;
  if (opts.json !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(opts.json); delete opts.json; }
  const res = await fetch('/api' + path, Object.assign({}, opts, { headers }));
  if (res.status === 401) { doLogout(); throw new Error('unauthorized'); }
  if (!res.ok) { const e = await res.json().catch(() => ({ error: res.statusText })); throw new Error(e.error || 'error'); }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res;
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Release notes arrive as Markdown (the GitHub release body). Strip the markup so
// the update dialog shows clean, readable text instead of raw **, ## and ` characters.
function cleanNotes(s) {
  return String(s == null ? '' : s)
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '\u2022 ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
function fmtSize(b) { if (b == null) return '—'; if (b < 1024) return b + ' B'; const u = ['KB', 'MB', 'GB', 'TB']; let i = -1; do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1); return b.toFixed(b < 10 ? 1 : 0) + ' ' + u[i]; }
function fmtDate(ts) { return new Date(ts).toLocaleString(LANG === 'it' ? 'it-IT' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
function fmtExpiry(ts) { if (!ts) return t('No expiry'); if (ts - Date.now() <= 0) return t('Expired'); return t('Expires {d}', { d: new Date(ts).toLocaleDateString(LANG === 'it' ? 'it-IT' : 'en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) }); }
function can(p) { return !!(me && me.perms && me.perms[p]); }
function hasAdminPerm() { return ['manageUsers', 'manageRoles', 'manageSettings', 'manageTelegram', 'manageBackups'].some(can); }
function shareLink(tk) { return location.origin + '/s/' + tk; }
async function copyText(tx) { try { await navigator.clipboard.writeText(tx); return true; } catch (_) { const a = document.createElement('textarea'); a.value = tx; document.body.appendChild(a); a.select(); let ok = false; try { ok = document.execCommand('copy'); } catch (_) {} a.remove(); return ok; } }

/* ───────────────────────── appearance ───────────────────────── */
function applyAppearance(a) {
  if (!a) return; const r = document.documentElement;
  r.classList.toggle('light', a.theme === 'light');
  if (a.accent) r.style.setProperty('--accent', a.accent);
  if (a.radius) r.style.setProperty('--radius', a.radius + 'px');
  // Background colors must respect the theme. The dark defaults must NOT override the
  // light theme (that caused dark text on a dark background). If a stored color is the
  // OTHER theme's default, fall back to this theme's default; truly custom colors persist.
  const _DBG = '#0a0c10', _DBG2 = '#11161f', _LBG = '#eef1f6', _LBG2 = '#e6ebf3';
  const _isLight = a.theme === 'light';
  const _norm = (c) => String(c || '').trim().toLowerCase();
  let _bg = a.bgColor, _bg2 = a.bgColor2;
  if (_isLight) { if (!_bg || _norm(_bg) === _DBG) _bg = _LBG; if (!_bg2 || _norm(_bg2) === _DBG2) _bg2 = _LBG2; }
  else { if (!_bg || _norm(_bg) === _LBG) _bg = _DBG; if (!_bg2 || _norm(_bg2) === _LBG2) _bg2 = _DBG2; }
  r.style.setProperty('--bg', _bg); r.style.setProperty('--bg2', _bg2);
  r.style.setProperty('--gap', a.density === 'compact' ? '10px' : '14px');
  document.body.classList.remove('bg-grid', 'bg-gradient', 'bg-image'); document.body.style.backgroundImage = '';
  if (a.bgStyle === 'grid') document.body.classList.add('bg-grid');
  else if (a.bgStyle === 'gradient') document.body.classList.add('bg-gradient');
  else if (a.bgStyle === 'image' && a.bgImage) { document.body.classList.add('bg-image'); document.body.style.backgroundImage = `url("${a.bgImage}")`; }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const brand = 'TCloud' + (a.brandSuffix ? ' | ' + a.brandSuffix : '');
  set('brand-name', brand); set('brand-mark', a.logo || '☁'); set('login-logo', a.logo || '☁'); set('login-title', brand); set('setup-logo', a.logo || '☁');
  if (a.mode !== undefined) document.title = brand;
  const m = document.querySelector('meta[name=theme-color]'); if (m) m.setAttribute('content', _bg || '#0a0c10');
}
async function loadAppearance() { try { applyAppearance(await (await fetch('/api/appearance')).json()); } catch (_) {} }

/* ───────────────────────── icons ───────────────────────── */
const ICO = {
  folder: '<svg viewBox="0 0 24 24" class="t-folder"><path fill="currentColor" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" opacity=".9"/></svg>',
  image: '<svg viewBox="0 0 24 24" class="t-image" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="1.6"/><path d="m4 17 5-4 4 3 3-2 4 4"/></svg>',
  video: '<svg viewBox="0 0 24 24" class="t-video" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z" fill="currentColor"/></svg>',
  audio: '<svg viewBox="0 0 24 24" class="t-audio" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5" fill="currentColor" stroke="none"/><circle cx="16.5" cy="16" r="2.5" fill="currentColor" stroke="none"/></svg>',
  archive: '<svg viewBox="0 0 24 24" class="t-archive" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M12 3v4m0 2v2m0 2v3"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" class="t-pdf" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M8 14h2m-2 3h6" stroke-width="1.4"/></svg>',
  doc: '<svg viewBox="0 0 24 24" class="t-doc" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M8 12h8M8 16h8M8 8h3"/></svg>',
  file: '<svg viewBox="0 0 24 24" class="t-file" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
};
function iconFile(name, mime) {
  const ext = (String(name).split('.').pop() || '').toLowerCase(); mime = mime || '';
  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'heic'].includes(ext)) return ICO.image;
  if (mime.startsWith('video/') || ['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v'].includes(ext)) return ICO.video;
  if (mime.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'].includes(ext)) return ICO.audio;
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return ICO.archive;
  if (ext === 'pdf') return ICO.pdf;
  if (['doc', 'docx', 'txt', 'md', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx'].includes(ext)) return ICO.doc;
  return ICO.file;
}
const I = {
  open: '<svg viewBox="0 0 24 24" class="ic"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  dl: '<svg viewBox="0 0 24 24" class="ic"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14"/></svg>',
  rn: '<svg viewBox="0 0 24 24" class="ic"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
  mv: '<svg viewBox="0 0 24 24" class="ic"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 11v4m-2-2h4"/></svg>',
  info: '<svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/></svg>',
  palette: '<svg viewBox="0 0 24 24" class="ic"><path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.5 0-.4-.2-.7-.4-1-.2-.2-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16a5 5 0 0 0 5-5c0-4.4-4-8-9-8z"/><circle cx="7.5" cy="10.5" r="1" fill="currentColor"/><circle cx="12" cy="7.5" r="1" fill="currentColor"/><circle cx="16.5" cy="10.5" r="1" fill="currentColor"/></svg>',
  del: '<svg viewBox="0 0 24 24" class="ic"><path d="M4 7h16M9 7V4h6v3m-7 0 1 13h6l1-13"/></svg>',
  share: '<svg viewBox="0 0 24 24" class="ic"><path d="M18 8a3 3 0 1 0-2.8-4M6 15a3 3 0 1 0 .1 0Zm12 4a3 3 0 1 0 .1 0ZM8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>',
  star: '<svg viewBox="0 0 24 24" class="ic"><path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 18.8 6.2 21.8l1.1-6.5L2.6 9.8l6.5-.9z"/></svg>',
  up: '<svg viewBox="0 0 24 24" class="ic"><path d="M12 16V4m0 0L7 9m5-5 5 5M5 20h14"/></svg>',
  upfolder: '<svg viewBox="0 0 24 24" class="ic"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v3M12 21v-7m-2.5 2.5L12 14l2.5 2.5"/></svg>',
  newfolder: '<svg viewBox="0 0 24 24" class="ic"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM12 11v4m-2-2h4"/></svg>',
  newfile: '<svg viewBox="0 0 24 24" class="ic"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M12 11v5m-2.5-2.5h5"/></svg>',
  logout: '<svg viewBox="0 0 24 24" class="ic"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>',
};

/* ───────────────────────── boot ───────────────────────── */
async function boot() {
  await loadLocalesList(); await loadI18n(LANG); applyI18nStatic(); await loadAppearance();
  if ('serviceWorker' in navigator) { try { await navigator.serviceWorker.register('/sw.js'); } catch (_) {} }
  try {
    const st = await (await fetch('/api/auth/status', { headers: token ? { 'X-Auth-Token': token } : {} })).json();
    orgMode = st.mode || 'organization'; orgName = st.orgName || ''; donation = st.donation || donation; support = st.support || support; appVersion = st.version || appVersion; if (typeof st.autoReload !== 'undefined') autoReload = st.autoReload;
    $('#boot').classList.add('hidden');
    if (!st.configured) return showSetup();
    if (st.authenticated) { me = st.user; return init(); }
    showLogin(st.allowRegistration);
  } catch (_) { $('#boot').classList.add('hidden'); showLogin(false); }
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (me) $('#btn-install').classList.remove('hidden'); });
window.addEventListener('appinstalled', () => { installPrompt = null; $('#btn-install').classList.add('hidden'); });

/* ───────────────────────── setup wizard (multi-step, language first) ───────────────────────── */
let wizStep = 0; const WIZ_MAX = 4; let botConnected = false;
function showSetup() { $('#setup').classList.remove('hidden'); initWizard(); }
function wizShow(n) {
  wizStep = Math.max(0, Math.min(WIZ_MAX, n));
  document.querySelectorAll('#setup .wiz-step').forEach((el) => el.classList.toggle('hidden', parseInt(el.dataset.step, 10) !== wizStep));
  const prog = $('#wiz-progress'); if (prog) prog.innerHTML = Array.from({ length: WIZ_MAX + 1 }, (_, i) => `<span class="wiz-dot ${i === wizStep ? 'active' : ''} ${i < wizStep ? 'done' : ''}"></span>`).join('');
  $('#wiz-back').classList.toggle('hidden', wizStep === 0);
  const last = wizStep === WIZ_MAX;
  $('#wiz-next').classList.toggle('hidden', last);
  $('#su-go').classList.toggle('hidden', !last);
  $('#su-error').textContent = '';
}
function initWizard() {
  const lg = $('#su-lang');
  if (lg && !lg.dataset.ready) {
    lg.dataset.ready = '1';
    const renderLangs = () => {
      lg.innerHTML = Object.entries(LANGS).map(([k, v]) => `<button type="button" class="lang-btn ${k === LANG ? 'sel' : ''}" data-l="${k}">${v}</button>`).join('');
      lg.querySelectorAll('.lang-btn').forEach((b) => b.onclick = async () => { await loadI18n(b.dataset.l); applyI18nStatic($('#setup')); renderLangs(); });
    };
    renderLangs();
  }
  wizShow(0);
}
async function connectBot() {
  const tok = $('#su-token').value.trim(); const st = $('#su-connect-status'); const btn = $('#su-connect');
  if (!tok) { st.textContent = t('Paste your bot token first.'); st.className = 'su-note err'; return false; }
  btn.disabled = true; const old = btn.textContent; btn.textContent = t('Connecting…');
  try {
    const r = await fetch('/api/setup/bot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ botToken: tok, apiRoot: $('#su-apiroot').value.trim() }) });
    const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Failed');
    botConnected = true; st.innerHTML = '✅ ' + t('Bot @{u} is live — now send it /id (or post /id inside your channel) to get the channel ID.', { u: esc(d.username) }); st.className = 'su-note ok';
    btn.textContent = t('Connected ✓'); btn.disabled = true; return true;
  } catch (e) { st.textContent = e.message; st.className = 'su-note err'; btn.disabled = false; btn.textContent = old; return false; }
}
if ($('#su-connect')) $('#su-connect').addEventListener('click', connectBot);
if ($('#su-token')) $('#su-token').addEventListener('input', () => { botConnected = false; const b = $('#su-connect'); if (b) { b.disabled = false; b.textContent = t('Connect bot'); } const st = $('#su-connect-status'); if (st) { st.textContent = ''; st.className = 'su-note'; } });
if ($('#wiz-back')) $('#wiz-back').addEventListener('click', () => wizShow(wizStep - 1));
if ($('#wiz-next')) $('#wiz-next').addEventListener('click', async () => {
  $('#su-error').textContent = '';
  if (wizStep === 1 && !botConnected) { const ok = await connectBot(); if (!ok) return; }
  if (wizStep === 2 && !$('#su-channel').value.trim()) { $('#su-error').textContent = t('Enter your storage channel ID.'); return; }
  if (wizStep === 3 && (!$('#su-user').value.trim() || $('#su-pass').value.length < 4)) { $('#su-error').textContent = t('Choose a username and a password (min 4 characters).'); return; }
  wizShow(wizStep + 1);
});
$('#su-go').addEventListener('click', async () => {
  $('#su-error').textContent = '';
  const body = { botToken: $('#su-token').value.trim(), storageChannel: $('#su-channel').value.trim(), apiRoot: $('#su-apiroot').value.trim(), chunkSizeMB: parseInt($('#su-chunk').value, 10) || undefined, adminUsername: $('#su-user').value.trim(), adminPassword: $('#su-pass').value, adminTelegramId: $('#su-tg').value.trim() };
  body.sessionDays = parseInt($('#su-session').value, 10); // 0 = until restart
  body.encrypt = $('#su-enc').checked;
  const ep = ($('#su-encpass') && $('#su-encpass').value) || ''; if (ep) body.encPassphrase = ep;
  body.stagingEnabled = !!($('#su-staging') && $('#su-staging').checked);
  const sp = ($('#su-staging-path') && $('#su-staging-path').value.trim()) || ''; if (sp) body.stagingPath = sp;
  const sgb = $('#su-staging-gb') && parseFloat($('#su-staging-gb').value); if (sgb > 0) body.stagingMaxGB = sgb;
  if (!body.storageChannel) { wizShow(2); $('#su-error').textContent = t('Enter your storage channel ID.'); return; }
  if (!body.adminUsername || body.adminPassword.length < 4) { wizShow(3); $('#su-error').textContent = t('Choose a username and a password (min 4 characters).'); return; }
  const btn = $('#su-go'); btn.disabled = true; btn.textContent = t('Checking Telegram…');
  try {
    const r = await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Setup failed');
    token = data.token; me = data.user; localStorage.setItem('tcloud_token', token);
    $('#setup').innerHTML = `<div class="auth-card"><div class="auth-logo">🎉</div><h1>${t('TCloud is ready!')}</h1><p class="auth-sub">${t('Your personal cloud is up and running. TCloud is free and made with love — if it is useful to you, consider supporting the project.')}</p><div class="modal-row" style="justify-content:center;margin-top:18px"><a class="modal-btn" href="${esc(donation)}" target="_blank" rel="noopener">♥ ${t('Support the project')}</a><button class="modal-btn primary" id="su-enter">${t('Enter TCloud')}</button></div></div>`;
    $('#su-enter').onclick = () => { $('#setup').classList.add('hidden'); init(); };
  } catch (e) { $('#su-error').textContent = e.message; btn.disabled = false; btn.textContent = t('Finish setup'); }
});

/* ───────────────────────── login / register ───────────────────────── */
function showLogin(allowReg) { $('#login').classList.remove('hidden'); $('#login-form').classList.remove('hidden'); $('#register-form').classList.add('hidden'); $('#to-register').classList.toggle('hidden', !allowReg); }
$('#to-register').addEventListener('click', () => { $('#login-form').classList.add('hidden'); $('#register-form').classList.remove('hidden'); });
$('#to-login').addEventListener('click', () => { $('#register-form').classList.add('hidden'); $('#login-form').classList.remove('hidden'); });
async function doLogout() { try { await fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Auth-Token': token } }); } catch (_) {} token = ''; me = null; localStorage.removeItem('tcloud_token'); location.reload(); }
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#login-error').textContent = '';
  try {
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#login-user').value.trim(), password: $('#login-pass').value, remember: $('#login-remember').checked }) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Invalid credentials');
    if (data.twoFactor) return show2faStep(data.pending, data.method);
    token = data.token; me = data.user; localStorage.setItem('tcloud_token', token); $('#login').classList.add('hidden'); init();
  } catch (err) { $('#login-error').textContent = err.message; }
});
$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault(); $('#reg-error').textContent = '';
  if ($('#reg-pass').value !== $('#reg-pass2').value) { $('#reg-error').textContent = t('Passwords do not match'); return; }
  try {
    const r = await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('#reg-user').value.trim(), password: $('#reg-pass').value, remember: $('#reg-remember').checked }) });
    const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Registration failed');
    token = data.token; me = data.user; localStorage.setItem('tcloud_token', token); $('#login').classList.add('hidden'); init();
  } catch (err) { $('#reg-error').textContent = err.message; }
});

function show2faStep(pending, method) {
  $('#login-form').classList.add('hidden'); $('#register-form').classList.add('hidden');
  let box = $('#twofa-form');
  if (!box) { box = document.createElement('form'); box.id = 'twofa-form'; box.className = 'auth-form'; $('#login-form').parentNode.appendChild(box); }
  box.classList.remove('hidden');
  box.innerHTML = `<p class="auth-sub" style="margin-top:0">${method === 'telegram' ? t('We sent a 6-digit code to your Telegram. Enter it to finish signing in.') : t('Enter the 6-digit code from your authenticator app.')}</p>
    <label>${t('Verification code')}</label><input type="text" id="tf-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456" />
    <button class="auth-btn" type="submit">${t('Verify')}</button>
    <button class="link-btn" type="button" id="tf-back">${t('← Back to login')}</button>
    <div class="login-error" id="tf-error"></div>`;
  $('#tf-code').focus();
  $('#tf-back').onclick = () => { box.classList.add('hidden'); $('#login-form').classList.remove('hidden'); };
  box.onsubmit = async (e) => {
    e.preventDefault(); $('#tf-error').textContent = '';
    try {
      const r = await fetch('/api/auth/2fa', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pending, code: $('#tf-code').value.trim() }) });
      const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Wrong code');
      token = data.token; me = data.user; localStorage.setItem('tcloud_token', token); $('#login').classList.add('hidden'); box.remove(); init();
    } catch (err) { $('#tf-error').textContent = err.message; }
  };
}

/* ───────────────────────── init / chrome ───────────────────────── */
async function init() {
  $('#app').classList.remove('hidden');
  $('#avatar').textContent = (me.username[0] || '?').toUpperCase();
  $('#chip-name').textContent = me.username;
  $('#chip-role').innerHTML = `<span class="badge${me.admin ? ' badge-admin' : ''}">${esc(me.role || 'user')}</span>`;
  $('#nav-admin').classList.toggle('hidden', !hasAdminPerm());
  $('#nav-tdrop').classList.toggle('hidden', !can('tdrop'));
  $('#btn-upload').classList.toggle('hidden', !can('upload'));
  $('#btn-newfolder').classList.toggle('hidden', !can('createFolder'));
  if (installPrompt || (isIOS() && !isStandalone())) $('#btn-install').classList.remove('hidden');
  setTimeout(() => { try { maybeCheckUpdate(); } catch (_) {} }, 1500);
  setViewMode(viewMode);
  await refreshTree(); openFolder(null);
}
function isIOS() { return /iphone|ipad|ipod/i.test(navigator.userAgent); }
function isStandalone() { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone; }
$('#btn-install').addEventListener('click', async () => {
  if (installPrompt) { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('#btn-install').classList.add('hidden'); }
  else if (isIOS()) { modal(`<h2>${t('Install app')}</h2><p style="color:var(--dim);line-height:1.6">${t('On iPhone/iPad: tap the Share button, then "Add to Home Screen".')}</p><div class="modal-row"><button class="modal-btn primary" id="ii-x">${t('Close')}</button></div>`); $('#ii-x').onclick = closeModal; }
});
$('#userchip').addEventListener('click', (e) => openMenu({ clientX: e.clientX, clientY: e.clientY }, [
  { label: t('Profile'), ic: I.info, fn: profileModal }, { sep: true }, { label: t('Sign out'), ic: I.logout, danger: true, fn: doLogout },
]));

async function refreshTree() {
  const r = await api('/tree'); treeData = r.tree; tdropFolder = r.tdropFolder; renderTree();
  let line = t('{files} files · {folders} folders', { files: '<b>' + r.stats.files + '</b>', folders: '<b>' + r.stats.folders + '</b>' }) + '<br>' + t('{size} stored', { size: fmtSize(r.stats.totalSize) });
  if (r.quota) { const pct = Math.min(100, Math.round((r.used / r.quota) * 100)); line += `<div class="quota"><div class="quota-bar"><div class="quota-fill" style="width:${pct}%"></div></div><span>${fmtSize(r.used)} / ${fmtSize(r.quota)}</span></div>`; }
  $('#stats').innerHTML = line;
  const badge = $('#tdrop-badge'); badge.textContent = r.tdropCount; badge.classList.toggle('hidden', !r.tdropCount || !can('tdrop'));
}
function renderTree() {
  const root = $('#tree'); root.innerHTML = '';
  const build = (nodes, container) => {
    for (const n of nodes) {
      const node = document.createElement('div'); node.className = 'tnode';
      const hasKids = n.children && n.children.length;
      const row = document.createElement('div'); row.className = 'trow' + (view.type === 'folder' && view.id === n.id ? ' active' : ''); row.dataset.folder = n.id;
      row.innerHTML = `<span class="tcaret ${hasKids ? '' : 'leaf'}"><svg viewBox="0 0 24 24" class="ic" style="width:12px;height:12px"><path d="m9 6 6 6-6 6"/></svg></span><svg viewBox="0 0 24 24" class="ic t-folder" style="width:15px;height:15px"><path fill="currentColor" stroke="none" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span class="tname">${esc(n.name)}</span>`;
      const kids = document.createElement('div'); kids.className = 'tchildren hidden'; if (hasKids) build(n.children, kids);
      const caret = row.querySelector('.tcaret');
      caret.addEventListener('click', (e) => { e.stopPropagation(); kids.classList.toggle('hidden'); caret.classList.toggle('open'); });
      row.addEventListener('click', () => openFolder(n.id));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); folderMenu(e, n); });
      makeDropTarget(row, n.id);
      node.appendChild(row); node.appendChild(kids); container.appendChild(node);
    }
  };
  build(treeData, root);
}

/* ───────────────────────── navigation ───────────────────────── */
$('#nav-root').addEventListener('click', () => openFolder(null));
$('#nav-starred').addEventListener('click', () => openStarred());
$('#nav-tdrop').addEventListener('click', () => openTDrop());
$('#nav-shares').addEventListener('click', () => openShares());
$('#nav-admin').addEventListener('click', () => openAdmin());

/* ── Mobile off-canvas sidebar (hamburger) ── */
const sidebarEl = $('#sidebar'), sidebarBackdrop = $('#sidebar-backdrop');
function closeSidebar() { sidebarEl.classList.remove('open'); sidebarBackdrop.classList.add('hidden'); }
function openSidebar() { sidebarEl.classList.add('open'); sidebarBackdrop.classList.remove('hidden'); }
$('#hamburger').addEventListener('click', () => (sidebarEl.classList.contains('open') ? closeSidebar() : openSidebar()));
sidebarBackdrop.addEventListener('click', closeSidebar);
sidebarEl.addEventListener('click', (e) => { if (window.matchMedia('(max-width: 820px)').matches && e.target.closest('.nav-item, .trow')) closeSidebar(); });
function setNav() { for (const [id, ty] of [['nav-root', 'folder'], ['nav-starred', 'starred'], ['nav-tdrop', 'tdrop'], ['nav-shares', 'shares'], ['nav-admin', 'admin']]) $('#' + id).classList.toggle('active', view.type === ty); const isAdmin = view.type === 'admin'; $('#view-toggle').classList.toggle('hidden', isAdmin); const _sb = document.querySelector('.search'); if (_sb) _sb.classList.toggle('hidden', isAdmin); }
function setViewMode(m) { viewMode = m === 'list' ? 'list' : 'grid'; localStorage.setItem('tcloud_viewmode', viewMode); $('#view-toggle').querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.v === viewMode)); }
$('#view-toggle').querySelectorAll('button').forEach((b) => b.onclick = () => { setViewMode(b.dataset.v); reload(); });
let searchTimer;
$('#search').addEventListener('input', (e) => { clearTimeout(searchTimer); const q = e.target.value.trim(); searchTimer = setTimeout(async () => { if (!q) return reload(); const r = await api('/search?q=' + encodeURIComponent(q)); $('#breadcrumb').innerHTML = `<span class="crumb current">${t('Results: "{q}"', { q: esc(q) })}</span>`; renderContent(r.folders, r.files); }, 250); });
function clearSel() { sel.clear(); updateBulkBar(); }
async function openFolder(id) { view = { type: 'folder', id }; setNav(); renderTree(); clearSel(); const data = await api('/list?folder=' + (id || '')); renderBreadcrumb(data.path); renderContent(data.folders, data.files); renderFolderNote(data.note, id); }
async function openStarred() { view = { type: 'starred', id: null }; setNav(); renderTree(); clearSel(); $('#breadcrumb').innerHTML = `<span class="crumb current">${t('Starred')}</span>`; const data = await api('/starred'); renderContent([], data.files); }
async function openTDrop() {
  view = { type: 'tdrop', id: tdropFolder }; setNav(); renderTree(); clearSel();
  $('#breadcrumb').innerHTML = `<span class="crumb current">${t('TDrop')}</span>`;
  const c = $('#content');
  c.innerHTML = `<div class="hintbar">${t('Files sent to the bot land here. Move them into your folders, or delete them.')}</div><div id="sub"></div>
    <div class="section-h" style="margin-top:28px">👥 ${t('Shared TDrop')}</div>
    <div class="hintbar">${t('A drop-box for the whole team: every member (and invited guests) can send files here via the bot. In the bot, use /settings to pick your default destination.')}</div>
    <div id="sub-shared"></div>`;
  const data = await api('/tdrop'); renderInto($('#sub'), [], data.files);
  try { const sh = await api('/tdrop/shared'); renderShared($('#sub-shared'), sh); }
  catch (_) { $('#sub-shared').innerHTML = `<div class="empty"><div class="empty-mark">◇</div>${t('Shared TDrop is not available for your account.')}</div>`; }
}
function gsSize(n) { if (!n && n !== 0) return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; }
function renderShared(box, sh) {
  if (!sh.files.length) { box.innerHTML = `<div class="empty"><div class="empty-mark">◇</div>${t('Nothing in the shared TDrop yet.')}</div>`; return; }
  box.innerHTML = '';
  for (const f of sh.files) {
    const canDel = sh.canModerate || f.uploaderId === me.id;
    const row = document.createElement('div'); row.className = 'gshare-row';
    row.innerHTML = `<div class="gs-main"><div class="gs-name">${esc(f.name)}</div><div class="gs-sub">${f.from ? esc(f.from) + ' · ' : ''}${gsSize(f.size)} · ${new Date(f.created_at).toLocaleDateString()}${f.guest ? ' · ' + t('guest') : ''}</div></div><div class="gs-actions"><button class="modal-btn" data-a="dl">⬇ ${t('Download')}</button>${canDel ? `<button class="modal-btn danger" data-a="del">🗑</button>` : ''}</div>`;
    row.querySelector('[data-a=dl]').onclick = async () => {
      try { const r = await fetch('/api/download/' + f.id, { headers: { 'X-Auth-Token': token } }); if (!r.ok) throw new Error(((await r.json()) || {}).error || 'Download failed'); const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = f.name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 8000); } catch (e) { alert(e.message); }
    };
    const del = row.querySelector('[data-a=del]');
    if (del) del.onclick = async () => { if (!confirm(t('Delete “{name}”?', { name: f.name }))) return; try { await api('/files/' + f.id, { method: 'DELETE' }); openTDrop(); } catch (e) { alert(e.message); } };
    box.appendChild(row);
  }
}
function renderBreadcrumb(path) {
  const bc = $('#breadcrumb'); bc.innerHTML = '';
  const home = document.createElement('span'); home.className = 'crumb' + (path.length ? '' : ' current'); home.textContent = t('All files'); home.onclick = () => openFolder(null); makeDropTarget(home, null); bc.appendChild(home);
  path.forEach((f, i) => { bc.insertAdjacentHTML('beforeend', '<span class="crumb-sep">/</span>'); const c = document.createElement('span'); c.className = 'crumb' + (i === path.length - 1 ? ' current' : ''); c.textContent = f.name; c.onclick = () => openFolder(f.id); makeDropTarget(c, f.id); bc.appendChild(c); });
}

async function adminTDrop(box) {
  box = box || $('#admin-body');
  const [gr, tr] = await Promise.all([api('/admin/tdrop/guests'), api('/tree')]);
  const flat = (nodes, pre) => nodes.flatMap((n) => [{ id: n.id, path: (pre ? pre + ' / ' : '') + n.name }].concat(flat(n.children, (pre ? pre + ' / ' : '') + n.name)));
  const folders = flat(tr.tree, '');
  box.innerHTML = `<div class="hintbar">${t('Invite people WITHOUT an account to send files to the bot — all you need is their Telegram @username. Note: Telegram bots cannot write first, so the guest has to open the bot and press Start (or just send a file).')}</div>
    <div class="modal-row" style="flex-wrap:wrap;gap:8px;margin:14px 0">
      <input id="g-user" placeholder="@username" style="flex:1;min-width:150px" />
      <select id="g-days"><option value="1">1 ${t('day')}</option><option value="7" selected>7 ${t('days')}</option><option value="30">30 ${t('days')}</option><option value="0">${t('No deadline')}</option></select>
      <select id="g-dest"><option value="shared">👥 ${t('Shared TDrop')}</option>${folders.map((f) => `<option value="${f.id}">📁 ${esc(f.path)}</option>`).join('')}</select>
      <button class="modal-btn primary" id="g-add">${t('Invite guest')}</button>
    </div><div id="g-err" class="login-error"></div><div id="g-list"></div>`;
  const list = gr.guests.length ? gr.guests.map((g) => `<div class="gshare-row"><div class="gs-main"><div class="gs-name">@${esc(g.username)}${g.active ? '' : ' · <span class="gs-expired">' + t('expired') + '</span>'}</div><div class="gs-sub">→ ${esc(g.dest)} · ${g.expires_at ? t('until {date}', { date: new Date(g.expires_at).toLocaleDateString() }) : t('no deadline')} · ${g.telegram_id ? t('linked ✓') : t('waiting for the guest to /start the bot')} · ${g.uploads} ${t('uploads')}</div></div><div class="gs-actions"><button class="modal-btn danger" data-id="${g.id}">${t('Remove')}</button></div></div>`).join('') : `<div class="empty"><div class="empty-mark">◇</div>${t('No guests invited yet.')}</div>`;
  $('#g-list').innerHTML = list;
  $('#g-list').querySelectorAll('button[data-id]').forEach((b) => { b.onclick = async () => { await api('/admin/tdrop/guests/' + b.dataset.id, { method: 'DELETE' }); adminTDrop(box); }; });
  $('#g-add').onclick = async () => { $('#g-err').textContent = ''; try { await api('/admin/tdrop/guests', { method: 'POST', json: { username: $('#g-user').value, days: parseInt($('#g-days').value, 10), dest: $('#g-dest').value } }); adminTDrop(box); } catch (e) { $('#g-err').textContent = e.message; } };
}

/* ───────────────────────── content (grid + list) ───────────────────────── */
function renderContent(folders, files) { renderInto($('#content'), folders, files); }
function renderInto(container, folders, files) {
  container.innerHTML = '';
  if (!folders.length && !files.length) { const msg = view.type === 'starred' ? t('No starred files yet.') : view.type === 'tdrop' ? t('No files received yet. Send one to the bot on Telegram.') : t('This folder is empty. Upload a file or create a folder.'); container.innerHTML = `<div class="empty"><div class="empty-mark">◇</div>${msg}</div>`; return; }
  if (viewMode === 'list') return renderList(container, folders, files);
  if (folders.length) { container.insertAdjacentHTML('beforeend', `<div class="section-h">${t('Folders')}</div>`); const g = document.createElement('div'); g.className = 'grid'; folders.forEach((f) => g.appendChild(folderCard(f))); container.appendChild(g); }
  if (files.length) { container.insertAdjacentHTML('beforeend', `<div class="section-h">${t('Files')}</div>`); const g = document.createElement('div'); g.className = 'grid'; files.forEach((f) => g.appendChild(fileCard(f))); container.appendChild(g); }
}
function selBox(id) { const b = document.createElement('div'); b.className = 'selbox' + (sel.has(id) ? ' on' : ''); b.innerHTML = '<svg viewBox="0 0 24 24" class="ic"><path d="m5 12 5 5L20 7"/></svg>'; b.onclick = (e) => { e.stopPropagation(); toggleSel(id); }; return b; }
function folderCard(f) {
  const el = document.createElement('div'); el.className = 'card folder'; el.draggable = true; el.dataset.folder = f.id;
  const fIco = f.icon ? `<span class="folder-emoji">${esc(f.icon)}</span>` : ICO.folder;
  if (f.color) { el.classList.add('has-color'); el.style.setProperty('--fc', f.color); }
  if (f.shadow) el.classList.add('fshadow');
  el.innerHTML = `<div class="card-tools"><div class="tool" data-act="menu"><svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/></svg></div></div><div class="card-ico">${fIco}</div><div class="card-name">${esc(f.name)}</div><div class="card-meta">${t('Folder')}</div>`;
  el.addEventListener('click', (e) => { if (e.target.closest('[data-act=menu]')) return folderMenu(e, f); openFolder(f.id); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); folderMenu(e, f); });
  el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-tcloud', JSON.stringify({ folders: [f.id], files: [] })); e.dataTransfer.effectAllowed = 'move'; });
  makeDropTarget(el, f.id);
  return el;
}
function fileCard(f) {
  const el = document.createElement('div'); el.className = 'card' + (sel.has(f.id) ? ' selected' : ''); el.draggable = true; el.dataset.file = f.id;
  el.appendChild(selBox(f.id));
  if (f.starred) { const d = document.createElement('div'); d.className = 'starred-dot'; d.innerHTML = I.star; el.appendChild(d); }
  el.insertAdjacentHTML('beforeend', `<div class="card-tools"><div class="tool" data-act="dl" title="${t('Download')}">${I.dl}</div><div class="tool" data-act="menu"><svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/></svg></div></div><div class="card-ico">${iconFile(f.name, f.mime)}</div><div class="card-name">${esc(f.name)}</div><div class="card-meta">${fmtSize(f.size)} · ${fmtDate(f.created_at).split(',')[0]}</div>`);
  el.addEventListener('click', (e) => { if (e.target.closest('.selbox')) return; if (e.target.closest('[data-act=dl]')) return download(f); if (e.target.closest('[data-act=menu]')) return fileMenu(e, f); fileInfo(f); });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); fileMenu(e, f); });
  el.addEventListener('dragstart', (e) => { const ids = sel.has(f.id) ? [...sel] : [f.id]; e.dataTransfer.setData('application/x-tcloud', JSON.stringify({ files: ids, folders: [] })); e.dataTransfer.effectAllowed = 'move'; });
  return el;
}
function renderList(container, folders, files) {
  const tbl = document.createElement('div'); tbl.className = 'ltable';
  tbl.innerHTML = `<div class="lrow lhead"><div class="lc-sel"></div><div class="lc-name">${t('Name')}</div><div class="lc-size">${t('Size')}</div><div class="lc-date">${t('Modified')}</div><div class="lc-act"></div></div>`;
  folders.forEach((f) => {
    const row = document.createElement('div'); row.className = 'lrow'; row.draggable = true; row.dataset.folder = f.id;
    const lIco = f.icon ? `<span class="folder-emoji">${esc(f.icon)}</span>` : ICO.folder;
    const lColor = f.color ? ` style="color:${esc(f.color)}"` : '';
    row.innerHTML = `<div class="lc-sel"></div><div class="lc-name"><span class="li"${lColor}>${lIco}</span>${esc(f.name)}</div><div class="lc-size">—</div><div class="lc-date">—</div><div class="lc-act"><button class="tool" data-act="menu"><svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/></svg></button></div>`;
    row.addEventListener('click', (e) => { if (e.target.closest('[data-act=menu]')) return folderMenu(e, f); openFolder(f.id); });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); folderMenu(e, f); });
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-tcloud', JSON.stringify({ folders: [f.id], files: [] })); });
    makeDropTarget(row, f.id); tbl.appendChild(row);
  });
  files.forEach((f) => {
    const row = document.createElement('div'); row.className = 'lrow' + (sel.has(f.id) ? ' selected' : ''); row.draggable = true; row.dataset.file = f.id;
    row.innerHTML = `<div class="lc-sel"><div class="selbox${sel.has(f.id) ? ' on' : ''}"><svg viewBox="0 0 24 24" class="ic"><path d="m5 12 5 5L20 7"/></svg></div></div><div class="lc-name"><span class="li">${iconFile(f.name, f.mime)}</span>${esc(f.name)} ${f.starred ? '<span class="star-mini">' + I.star + '</span>' : ''}</div><div class="lc-size">${fmtSize(f.size)}</div><div class="lc-date">${fmtDate(f.created_at)}</div><div class="lc-act"><button class="tool" data-act="dl">${I.dl}</button><button class="tool" data-act="menu"><svg viewBox="0 0 24 24" class="ic"><circle cx="12" cy="5" r="1.4" fill="currentColor"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="12" cy="19" r="1.4" fill="currentColor"/></svg></button></div>`;
    row.querySelector('.selbox').onclick = (e) => { e.stopPropagation(); toggleSel(f.id); };
    row.addEventListener('click', (e) => { if (e.target.closest('.selbox')) return; if (e.target.closest('[data-act=dl]')) return download(f); if (e.target.closest('[data-act=menu]')) return fileMenu(e, f); fileInfo(f); });
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); fileMenu(e, f); });
    row.addEventListener('dragstart', (e) => { const ids = sel.has(f.id) ? [...sel] : [f.id]; e.dataTransfer.setData('application/x-tcloud', JSON.stringify({ files: ids, folders: [] })); });
    tbl.appendChild(row);
  });
  container.appendChild(tbl);
}
function download(f) { window.location = '/api/download/' + f.id + (token ? '?token=' + encodeURIComponent(token) : ''); }

/* ───────────────────────── selection / bulk ───────────────────────── */
function toggleSel(id) { if (sel.has(id)) sel.delete(id); else sel.add(id); reapplySel(); updateBulkBar(); }
function reapplySel() { document.querySelectorAll('[data-file]').forEach((el) => { const on = sel.has(el.dataset.file); el.classList.toggle('selected', on); const sb = el.querySelector('.selbox'); if (sb) sb.classList.toggle('on', on); }); }
function updateBulkBar() {
  let bar = $('#bulkbar');
  if (!sel.size) { if (bar) bar.remove(); return; }
  if (!bar) { bar = document.createElement('div'); bar.id = 'bulkbar'; bar.className = 'bulkbar'; document.body.appendChild(bar); }
  bar.innerHTML = `<span class="bb-count">${t('{n} selected', { n: sel.size })}</span><button class="mini" data-a="dl">${t('Download')}</button><button class="mini" data-a="mv">${t('Move')}</button><button class="mini" data-a="star">${t('Star')}</button>${can('delete') ? `<button class="mini danger" data-a="del">${t('Delete')}</button>` : ''}<button class="mini" data-a="clear">${t('Clear')}</button>`;
  bar.querySelector('[data-a=clear]').onclick = () => { clearSel(); reapplySel(); };
  bar.querySelector('[data-a=dl]').onclick = async () => { for (const id of [...sel]) { const a = document.createElement('a'); a.href = '/api/download/' + id + '?token=' + encodeURIComponent(token); document.body.appendChild(a); a.click(); a.remove(); await new Promise((r) => setTimeout(r, 500)); } };
  bar.querySelector('[data-a=star]').onclick = async () => { for (const id of [...sel]) await api('/files/' + id, { method: 'PATCH', json: { star: true } }); clearSel(); reload(); };
  bar.querySelector('[data-a=mv]').onclick = () => bulkMove();
  const del = bar.querySelector('[data-a=del]'); if (del) del.onclick = async () => { if (!confirm(t('Delete {n} selected item(s)?', { n: sel.size }))) return; for (const id of [...sel]) await api('/files/' + id, { method: 'DELETE' }); clearSel(); await refreshTree(); reload(); };
}
function bulkMove() {
  const list = [{ id: '', name: t('All files (root)') }].concat(flatFolders(treeData, 0, []));
  modal(`<h2>${t('Move {n} item(s)', { n: sel.size })}</h2><div class="pick-list">` + list.map((o) => `<div class="pick" data-id="${esc(o.id)}">${ICO.folder.replace('class="t-folder"', 'class="ic t-folder" style="width:18px;height:18px"')}<span>${esc(o.name)}</span></div>`).join('') + `</div><div class="modal-row"><button class="modal-btn" id="mv-x">${t('Cancel')}</button></div>`);
  $('#mv-x').onclick = closeModal;
  $('#modal-box').querySelectorAll('.pick').forEach((p) => { p.onclick = async () => { closeModal(); for (const id of [...sel]) await api('/files/' + id, { method: 'PATCH', json: { folder: p.dataset.id || null } }); clearSel(); await refreshTree(); reload(); }; });
}

/* ───────────────────────── drag-to-move ───────────────────────── */
function makeDropTarget(el, folderId) {
  el.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('application/x-tcloud')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drag-over'); } });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', async (e) => {
    if (!e.dataTransfer.types.includes('application/x-tcloud')) return;
    e.preventDefault(); e.stopPropagation(); el.classList.remove('drag-over');
    let data; try { data = JSON.parse(e.dataTransfer.getData('application/x-tcloud')); } catch (_) { return; }
    const dest = folderId || null;
    try {
      for (const fid of (data.files || [])) await api('/files/' + fid, { method: 'PATCH', json: { folder: dest } });
      for (const fld of (data.folders || [])) { if (fld === dest) continue; await api('/folders/' + fld, { method: 'PATCH', json: { parent: dest } }); }
      clearSel(); await refreshTree(); reload();
    } catch (err) { alert(err.message); }
  });
}

/* ───────────────────────── context menus ───────────────────────── */
function openMenu(e, items) {
  const m = $('#menu'); m.innerHTML = '';
  items.forEach((it) => { if (it.sep) { m.insertAdjacentHTML('beforeend', '<div class="msep"></div>'); return; } const el = document.createElement('div'); el.className = 'mitem' + (it.danger ? ' danger' : ''); el.innerHTML = `${it.ic || ''}<span>${it.label}</span>`; el.onclick = () => { hideMenu(); it.fn(); }; m.appendChild(el); });
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect(); let x = e.clientX, y = e.clientY;
  if (x + r.width > innerWidth) x = innerWidth - r.width - 8;
  if (y + r.height > innerHeight) y = innerHeight - r.height - 8;
  m.style.left = Math.max(8, x) + 'px'; m.style.top = Math.max(8, y) + 'px';
  setTimeout(() => { const close = (ev) => { if (!ev.target.closest('#menu')) { hideMenu(); document.removeEventListener('mousedown', close); document.removeEventListener('contextmenu', onCtx); } }; const onCtx = (ev) => { if (!ev.target.closest('#menu')) { hideMenu(); document.removeEventListener('mousedown', close); document.removeEventListener('contextmenu', onCtx); } }; document.addEventListener('mousedown', close); }, 0);
}
function hideMenu() { $('#menu').classList.add('hidden'); }
/* ── Native folder notes: a text note pinned to the top of a folder ── */
function renderFolderNote(note, folderId) {
  const ex = document.getElementById('folder-note'); if (ex) ex.remove();
  if (!folderId) return; // only inside a real folder (not at the root)
  const div = document.createElement('div');
  div.id = 'folder-note';
  if (note) {
    div.className = 'folder-note';
    div.innerHTML = `<div class="fn-head"><svg viewBox="0 0 24 24" class="ic"><path d="M4 4h13l3 3v13H4z"/><path d="M8 4v5h8"/><path d="M8 14h8M8 17h5"/></svg><button class="tool fn-edit" title="${t('Edit note')}">${I.rn}</button></div><div class="fn-body"></div>`;
    div.querySelector('.fn-body').textContent = note;
    div.querySelector('.fn-edit').onclick = () => folderNoteModal({ id: folderId, note });
  } else {
    // No note yet — show a subtle, discoverable prompt (like Nextcloud's description).
    div.className = 'folder-note-add';
    div.innerHTML = `<button class="fn-add-btn"><svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14"/></svg>${t('Add a note for this folder')}</button>`;
    div.querySelector('.fn-add-btn').onclick = () => folderNoteModal({ id: folderId, note: '' });
  }
  $('#content').prepend(div);
}
function folderCustomizeModal(f) {
  const colors = ['', '#5cc8ff', '#7c5cff', '#54e09b', '#ff8a5c', '#ff5c8a', '#ffd25c', '#5cffd2', '#b15cff', '#ff5c5c'];
  const presets = ['📁', '📄', '🖼', '🎵', '🎬', '🚀', '💼', '⭐', '🔒', '💡', '📦', '🎨', '💻', '📸', '🎯', '🏠'];
  modal(`<h2>${t('Color & icon')}</h2><div class="setting-desc">${t('Give this folder its own color and icon to find it at a glance.')}</div>
    <label style="margin-top:12px">${t('Color')}</label>
    <div class="swatches" id="fc-colors">${colors.map((c) => `<div class="swatch ${(f.color || '') === c ? 'sel' : ''}" data-c="${c}" style="${c ? 'background:' + c : 'background:transparent;border:1px dashed var(--border);color:var(--faint)'}">${c ? '' : '∅'}</div>`).join('')}</div>
    <label style="margin-top:14px">${t('Icon (emoji)')}</label>
    <div class="emoji-grid" id="fc-presets">${presets.map((e) => `<button type="button" class="emoji-pick ${(f.icon || '') === e ? 'sel' : ''}" data-e="${e}">${e}</button>`).join('')}</div>
    <input type="text" id="fc-icon" maxlength="2" value="${esc(f.icon || '')}" placeholder="${t('or type one')}" style="width:120px;margin-top:8px" />
    <label style="margin-top:14px">${t('Shadow')}</label>
    <div class="seg" id="fc-shadow"><button type="button" data-v="0" class="${f.shadow ? '' : 'sel'}">${t('None')}</button><button type="button" data-v="1" class="${f.shadow ? 'sel' : ''}">${t('Colored glow')}</button></div>
    <div class="modal-row"><button class="modal-btn" id="fc-x">${t('Cancel')}</button><button class="modal-btn primary" id="fc-save">${t('Save')}</button></div><div id="fc-result"></div>`);
  let color = f.color || '';
  let shadow = f.shadow ? 1 : 0;
  $('#fc-colors').querySelectorAll('.swatch').forEach((sw) => sw.onclick = () => { color = sw.dataset.c; $('#fc-colors').querySelectorAll('.swatch').forEach((x) => x.classList.toggle('sel', x === sw)); });
  $('#fc-shadow').querySelectorAll('button').forEach((b) => b.onclick = () => { shadow = parseInt(b.dataset.v, 10); $('#fc-shadow').querySelectorAll('button').forEach((x) => x.classList.toggle('sel', x === b)); });
  $('#fc-presets').querySelectorAll('.emoji-pick').forEach((b) => b.onclick = () => { $('#fc-icon').value = b.dataset.e; $('#fc-presets').querySelectorAll('.emoji-pick').forEach((x) => x.classList.toggle('sel', x === b)); });
  $('#fc-x').onclick = closeModal;
  $('#fc-save').onclick = async () => { try { await api('/folders/' + f.id, { method: 'PATCH', json: { color: color || '', icon: $('#fc-icon').value || '', shadow: shadow } }); closeModal(); reload(); } catch (e) { $('#fc-result').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; } };
}
function folderNoteModal(f) {
  modal(`<h2>${t('Folder note')}</h2><div class="setting-desc">${t('Shown at the top of this folder — handy for context, reminders or instructions.')}</div><textarea id="fn-text" class="modal-input" rows="8" maxlength="20000" placeholder="${t('Write your note…')}"></textarea><div class="modal-actions"><button class="modal-btn" id="fn-cancel">${t('Cancel')}</button>${f.note ? `<button class="modal-btn danger" id="fn-del">${t('Remove note')}</button>` : ''}<button class="modal-btn primary" id="fn-save">${t('Save')}</button></div>`);
  $('#fn-text').value = f.note || '';
  $('#fn-cancel').onclick = closeModal;
  const del = document.getElementById('fn-del');
  if (del) del.onclick = async () => { try { await api('/folders/' + f.id, { method: 'PATCH', json: { note: '' } }); closeModal(); reload(); } catch (e) { alert(e.message); } };
  $('#fn-save').onclick = async () => { try { await api('/folders/' + f.id, { method: 'PATCH', json: { note: $('#fn-text').value } }); closeModal(); reload(); } catch (e) { alert(e.message); } };
}
function folderMenu(e, f) {
  const items = [{ label: t('Open'), ic: I.open, fn: () => openFolder(f.id) }, { label: t('Rename'), ic: I.rn, fn: () => renameFolder(f) }, { label: t('Color & icon'), ic: I.palette, fn: () => folderCustomizeModal(f) }, { label: f.note ? t('Edit note') : t('Folder note'), ic: I.info, fn: () => folderNoteModal(f) }];
  if (can('share')) items.push({ label: t('Share'), ic: I.share, fn: () => shareModal('folder', f) });
  if (can('delete')) items.push({ sep: true }, { label: t('Delete'), ic: I.del, danger: true, fn: () => removeFolder(f) });
  openMenu(e, items);
}
function fileMenu(e, f) {
  const items = [{ label: t('Download'), ic: I.dl, fn: () => download(f) }, { label: f.starred ? t('Unstar') : t('Star'), ic: I.star, fn: () => toggleStar(f) }, { label: t('Rename'), ic: I.rn, fn: () => renameFile(f) }, { label: t('Move to…'), ic: I.mv, fn: () => moveFileOne(f) }];
  if (can('share')) items.push({ label: t('Share'), ic: I.share, fn: () => shareModal('file', f) });
  items.push({ label: t('Info & metadata'), ic: I.info, fn: () => fileInfo(f) });
  if (can('delete')) items.push({ sep: true }, { label: t('Delete'), ic: I.del, danger: true, fn: () => removeFile(f) });
  openMenu(e, items);
}
async function toggleStar(f) { await api('/files/' + f.id, { method: 'PATCH', json: { star: !f.starred } }); reload(); }

/* empty-space right-click */
$('#content').addEventListener('contextmenu', (e) => {
  if (view.type !== 'folder') return;
  if (e.target.closest('.card') || e.target.closest('.lrow') || e.target.closest('[data-file]') || e.target.closest('[data-folder]')) return;
  e.preventDefault();
  const items = [];
  if (can('upload')) items.push({ label: t('Upload files'), ic: I.up, fn: () => $('#file-input').click() });
  if (can('upload')) items.push({ label: t('Upload folder'), ic: I.upfolder, fn: () => $('#folder-input').click() });
  if (can('createFolder')) items.push({ label: t('New folder'), ic: I.newfolder, fn: newFolder });
  if (can('upload')) items.push({ label: t('New text file'), ic: I.newfile, fn: newTextFile });
  if (items.length) openMenu(e, items);
});

/* ───────────────────────── modal primitives ───────────────────────── */
function modal(html, wide) { const box = $('#modal-box'); box.innerHTML = html; box.classList.toggle('wide', !!wide); $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') closeModal(); });
function promptModal(title, label, value = '') {
  return new Promise((resolve) => {
    modal(`<h2>${esc(title)}</h2><label>${esc(label)}</label><input type="text" id="pm-in" value="${esc(value)}" /><div class="modal-row"><button class="modal-btn" id="pm-x">${t('Cancel')}</button><button class="modal-btn primary" id="pm-ok">${t('Confirm')}</button></div>`);
    const inp = $('#pm-in'); inp.focus(); inp.select();
    const done = (v) => { closeModal(); resolve(v); };
    $('#pm-ok').onclick = () => done(inp.value.trim() || null); $('#pm-x').onclick = () => done(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); };
  });
}

/* ───────────────────────── folder & file ops ───────────────────────── */
$('#btn-newfolder').addEventListener('click', newFolder);
async function newFolder() { const name = await promptModal(t('New folder'), t('Folder name')); if (!name) return; const parent = view.type === 'folder' ? view.id : null; await api('/folders', { method: 'POST', json: { name, parent } }); await refreshTree(); if (view.type === 'folder') openFolder(view.id); }
async function newTextFile() { const name = await promptModal(t('New text file'), t('File name')); if (!name) return; const folder = view.type === 'folder' ? view.id : null; try { await api('/files/new', { method: 'POST', json: { name, folder, content: '' } }); await refreshTree(); reload(); } catch (e) { if (e.message) alert(e.message); } }
async function renameFolder(f) { const name = await promptModal(t('Rename folder'), t('New name'), f.name); if (!name) return; await api('/folders/' + f.id, { method: 'PATCH', json: { name } }); await refreshTree(); if (view.type === 'folder') openFolder(view.id); }
async function removeFolder(f) { if (!confirm(t('Delete folder "{name}" and all its contents? This cannot be undone.', { name: f.name }))) return; await api('/folders/' + f.id, { method: 'DELETE' }); await refreshTree(); openFolder(null); }
async function renameFile(f) { const name = await promptModal(t('Rename file'), t('New name'), f.name); if (!name) return; await api('/files/' + f.id, { method: 'PATCH', json: { name } }); reload(); }
async function removeFile(f) { if (!confirm(t('Delete "{name}"?', { name: f.name }))) return; await api('/files/' + f.id, { method: 'DELETE' }); await refreshTree(); reload(); }
function flatFolders(nodes, depth, out) { for (const n of nodes) { out.push({ id: n.id, name: '— '.repeat(depth) + n.name }); if (n.children) flatFolders(n.children, depth + 1, out); } return out; }
async function moveFileOne(f) {
  const list = [{ id: '', name: t('All files (root)') }].concat(flatFolders(treeData, 0, []));
  modal(`<h2>${t('Move "{name}"', { name: esc(f.name) })}</h2><div class="pick-list">` + list.map((o) => `<div class="pick" data-id="${esc(o.id)}">${ICO.folder.replace('class="t-folder"', 'class="ic t-folder" style="width:18px;height:18px"')}<span>${esc(o.name)}</span></div>`).join('') + `</div><div class="modal-row"><button class="modal-btn" id="mv-x">${t('Cancel')}</button></div>`);
  $('#mv-x').onclick = closeModal;
  $('#modal-box').querySelectorAll('.pick').forEach((p) => { p.onclick = async () => { closeModal(); await api('/files/' + f.id, { method: 'PATCH', json: { folder: p.dataset.id || null } }); await refreshTree(); reload(); }; });
}
function fileInfo(f) {
  let meta = {}; try { meta = JSON.parse(f.meta || '{}'); } catch (_) {}
  const rows = (k = '', v = '') => `<div class="meta-pair"><input type="text" placeholder="${t('key')}" value="${esc(k)}" data-mk><input type="text" placeholder="${t('value')}" value="${esc(v)}" data-mv><button class="meta-del">✕</button></div>`;
  const shareBtn = can('share') ? `<button class="modal-btn" id="fi-share">${t('Share')}</button>` : '';
  modal(`<h2>${esc(f.name)}</h2><div class="info-row"><span>${t('Size')}</span><b>${fmtSize(f.size)}</b></div><div class="info-row"><span>${t('Type')}</span><b>${esc(f.mime || '—')}</b></div><div class="info-row"><span>${t('Source')}</span><b>${f.source === 'tdrop' ? 'TDrop' : f.source === 'share' ? t('Share upload') : 'Web'}</b></div><div class="info-row"><span>${t('Uploaded')}</span><b>${fmtDate(f.created_at)}</b></div><label style="margin-top:18px">${t('Custom metadata')}</label><div class="meta-list" id="meta-list">${Object.entries(meta).map(([k, v]) => rows(k, v)).join('') || rows()}</div><button class="meta-add" id="meta-add">+ ${t('add field')}</button><div class="modal-row"><button class="modal-btn" id="fi-dl">${t('Download')}</button>${shareBtn}<button class="modal-btn primary" id="fi-save">${t('Save metadata')}</button></div>`);
  const list = $('#meta-list'); const bind = () => list.querySelectorAll('.meta-del').forEach((b) => (b.onclick = () => b.parentElement.remove())); bind();
  $('#meta-add').onclick = () => { list.insertAdjacentHTML('beforeend', rows()); bind(); };
  $('#fi-dl').onclick = () => download(f); if (shareBtn) $('#fi-share').onclick = () => shareModal('file', f);
  $('#fi-save').onclick = async () => { const obj = {}; list.querySelectorAll('.meta-pair').forEach((p) => { const k = p.querySelector('[data-mk]').value.trim(); const v = p.querySelector('[data-mv]').value.trim(); if (k) obj[k] = v; }); await api('/files/' + f.id, { method: 'PATCH', json: { meta: obj } }); closeModal(); reload(); };
}
function reload() { if (view.type === 'starred') openStarred(); else if (view.type === 'shares') openShares(); else if (view.type === 'admin') openAdmin(); else if (view.type === 'tdrop') openTDrop(); else openFolder(view.id); }

/* ───────────────────────── upload ───────────────────────── */
$('#btn-upload').addEventListener('click', () => $('#file-input').click());
$('#file-input').addEventListener('change', (e) => { const f = Array.from(e.target.files); e.target.value = ''; const dest = curFolder(); enqueueUpload(() => uploadFiles(f, dest)); });
$('#folder-input').addEventListener('change', (e) => { const f = Array.from(e.target.files); e.target.value = ''; const dest = curFolder(); enqueueUpload(() => uploadFolder(f, dest)); });
function curFolder() { return view.type === 'folder' ? (view.id || null) : null; }

/* ── Upload queue: run uploads one at a time. Starting a second upload while one
      was running used to clobber the shared progress toast and made it look like
      the first one had been cancelled — now they queue up instead. ── */
let _uploadChain = Promise.resolve();
function enqueueUpload(taskFn) { const run = _uploadChain.then(() => taskFn()); _uploadChain = run.catch(() => {}); return run; }

/* Split a file list into request-sized batches so a single heavy folder isn't
   sent as one giant request (which can time out or be rejected by the server). */
const UP_BATCH_FILES = 20;                  // max files per request
const UP_BATCH_BYTES = 200 * 1024 * 1024;   // ~200 MB per request
function makeBatches(files) {
  const out = []; let cur = [], bytes = 0;
  for (const f of files) {
    if (cur.length && (cur.length >= UP_BATCH_FILES || bytes + (f.size || 0) > UP_BATCH_BYTES)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(f); bytes += f.size || 0;
  }
  if (cur.length) out.push(cur);
  return out;
}

/* Upload one batch. Resolves to { ok, status, error } and crucially CHECKS the
   HTTP status — the old uploadGroup resolved even on errors, so failed batches
   (quota, 5xx, network) were silently dropped and files went missing. */
function postBatch(files, folderId, onProgress) {
  return new Promise((resolve) => {
    const fd = new FormData(); fd.append('folder', folderId || ''); files.forEach((f) => fd.append('files', f));
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/upload'); if (token) xhr.setRequestHeader('X-Auth-Token', token);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status === 401) { doLogout(); resolve({ ok: false, status: 401 }); return; }
      if (xhr.status >= 200 && xhr.status < 300) { resolve({ ok: true }); return; }
      let err = t('Error'); try { err = JSON.parse(xhr.responseText).error; } catch (_) {}
      resolve({ ok: false, status: xhr.status, error: err });
    };
    xhr.onerror = () => resolve({ ok: false, error: t('Network error') });
    xhr.send(fd);
  });
}

function finishToast(failed, total) {
  const toast = $('#toast');
  if (failed > 0) { $('#toast-title').textContent = '\u26a0\ufe0f ' + t('{f} of {n} file(s) failed to upload', { f: failed, n: total }); $('#toast-sub').textContent = ''; setTimeout(() => toast.classList.add('hidden'), 5000); }
  else { $('#toast-title').textContent = '\u2705 ' + t('Done'); $('#toast-fill').style.width = '100%'; setTimeout(() => toast.classList.add('hidden'), 1200); }
}

async function uploadFiles(files, folderId) {
  if (!files.length) return;
  if (view.type !== 'folder') openFolder(null);
  const toast = $('#toast'); toast.classList.remove('hidden'); $('#toast-fill').style.width = '0%';
  const batches = makeBatches(files); let failed = 0;
  for (let i = 0; i < batches.length; i++) {
    $('#toast-title').textContent = batches.length > 1 ? t('Uploading\u2026 {i}/{n}', { i: i + 1, n: batches.length }) : t('Uploading {n} file(s)\u2026', { n: files.length });
    $('#toast-sub').textContent = batches[i].map((f) => f.name).join(', ').slice(0, 60);
    $('#toast-fill').style.width = '0%';
    const r = await postBatch(batches[i], folderId, (p) => { $('#toast-fill').style.width = Math.round(p * 100) + '%'; if (p >= 1) { $('#toast-title').textContent = t('Sending to Telegram\u2026'); $('#toast-sub').textContent = t('Splitting into chunks'); } });
    if (!r.ok) { failed += batches[i].length; if (r.status === 401) return; }
  }
  finishToast(failed, files.length);
  await refreshTree(); reload();
}

async function uploadFolder(files, baseParent) {
  if (!files.length) return;
  if (view.type !== 'folder') openFolder(null);
  if (baseParent === undefined) baseParent = curFolder();
  const pathToId = { '': baseParent };
  const dirSet = new Set();
  files.forEach((f) => { const parts = (f.webkitRelativePath || f.name).split('/'); parts.pop(); let acc = ''; parts.forEach((p) => { acc = acc ? acc + '/' + p : p; dirSet.add(acc); }); });
  const dirs = [...dirSet].sort((a, b) => a.split('/').length - b.split('/').length);
  const toast = $('#toast'); toast.classList.remove('hidden'); $('#toast-title').textContent = t('Creating folders\u2026'); $('#toast-fill').style.width = '5%'; $('#toast-sub').textContent = '';
  try {
    for (const d of dirs) { const parts = d.split('/'); const parentPath = parts.slice(0, -1).join('/'); const parentId = pathToId[parentPath] != null ? pathToId[parentPath] : baseParent; const created = await api('/folders', { method: 'POST', json: { name: parts[parts.length - 1], parent: parentId } }); pathToId[d] = created.id; }
  } catch (e) { $('#toast-title').textContent = '\u274c ' + e.message; setTimeout(() => toast.classList.add('hidden'), 4000); return; }
  const groups = new Map();
  files.forEach((f) => { const parts = (f.webkitRelativePath || f.name).split('/'); parts.pop(); const dir = parts.join('/'); const fid = pathToId[dir] != null ? pathToId[dir] : baseParent; if (!groups.has(fid)) groups.set(fid, []); groups.get(fid).push(f); });
  // flatten (folder, batch) work-items so progress + failure count span the whole upload
  const work = [];
  for (const [fid, gfiles] of groups) for (const b of makeBatches(gfiles)) work.push([fid, b]);
  let failed = 0; const total = work.length;
  for (let i = 0; i < work.length; i++) {
    const [fid, b] = work[i];
    $('#toast-title').textContent = t('Uploading\u2026 {i}/{n}', { i: i + 1, n: total });
    $('#toast-sub').textContent = b.map((f) => f.name).join(', ').slice(0, 60);
    $('#toast-fill').style.width = '0%';
    const r = await postBatch(b, fid, (p) => { $('#toast-fill').style.width = Math.round(p * 100) + '%'; });
    if (!r.ok) { failed += b.length; if (r.status === 401) return; }
  }
  finishToast(failed, files.length);
  await refreshTree(); reload();
}

/* ── Drag & drop overlay. Fix: the overlay flickered because the counter was
      bumped on *dragover* (which fires continuously). Now dragenter counts up,
      dragleave counts down, dragover only keeps the drop target alive. ── */
let dragDepth = 0; const main = $('#main');
function isFileDrag(e) { return e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files'); }
main.addEventListener('dragenter', (e) => { if (!isFileDrag(e)) return; e.preventDefault(); if (!can('upload') || view.type !== 'folder') return; dragDepth++; $('#drop').classList.remove('hidden'); });
main.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
main.addEventListener('dragleave', (e) => { if (!isFileDrag(e)) return; dragDepth--; if (dragDepth <= 0) { dragDepth = 0; $('#drop').classList.add('hidden'); } });
main.addEventListener('drop', (e) => { dragDepth = 0; $('#drop').classList.add('hidden'); if (isFileDrag(e) && can('upload') && view.type === 'folder' && e.dataTransfer.files.length) { e.preventDefault(); const f = Array.from(e.dataTransfer.files); const dest = curFolder(); enqueueUpload(() => uploadFiles(f, dest)); } });

/* ───────────────────────── search ───────────────────────── */

/* ═════════════════════════ SHARING ═════════════════════════ */
const EXPIRY_OPTS = [{ label: 'No expiry', v: 0 }, { label: '1 hour', v: 3600 }, { label: '24 hours', v: 86400 }, { label: '7 days', v: 604800 }, { label: '30 days', v: 2592000 }];
function shareModal(type, res, existing) {
  const isFolder = type === 'folder', editing = !!existing;
  const fMode = !existing ? 'download' : (existing.upload_only ? 'drop' : (existing.allow_upload ? 'upload' : (existing.permission === 'view' ? 'view' : 'download')));
  const expirySel = (editing ? `<option value="-1" selected>${t('Leave unchanged')}</option>` : '') + EXPIRY_OPTS.map((o) => `<option value="${o.v}" ${!editing && o.v === 0 ? 'selected' : ''}>${t(o.label)}</option>`).join('');
  modal(`<h2>${editing ? t('Edit share') : t('Share')} "${esc(res.name)}"</h2><label>${t('Label (optional)')}</label><input type="text" id="sh-label" value="${esc((existing && existing.label) || '')}" />${isFolder
      ? `<label>${t('What people can do')}</label><select id="sh-faccess"><option value="view" ${fMode === 'view' ? 'selected' : ''}>${t('View only (no download)')}</option><option value="download" ${fMode === 'download' ? 'selected' : ''}>${t('View & download')}</option><option value="upload" ${fMode === 'upload' ? 'selected' : ''}>${t('View, download & upload')}</option><option value="drop" ${fMode === 'drop' ? 'selected' : ''}>${t('Upload only (a drop-box)')}</option></select><div class="setting-desc" id="sh-faccess-hint" style="margin-top:6px"></div>`
      : `<label>${t('Permission')}</label><select id="sh-perm"><option value="download" ${!existing || existing.permission === 'download' ? 'selected' : ''}>${t('View & download')}</option><option value="view" ${existing && existing.permission === 'view' ? 'selected' : ''}>${t('View only')}</option></select>`}` +
    `<div class="grid2"><div><label>${t('Expiry')}</label><select id="sh-exp">${expirySel}</select></div><div><label>${t('Download limit')}</label><input type="number" id="sh-max" min="0" placeholder="${t('unlimited')}" value="${existing && existing.max_downloads ? existing.max_downloads : ''}" /></div></div>` +
    (editing ? '' : `<label>${t('Custom link (optional)')}</label><div class="slug-row"><span class="slug-prefix">/s/</span><input type="text" id="sh-slug" placeholder="${t('random if empty')}" /></div>`) +
    `<label>${t('Password')} ${editing ? t('(leave empty to keep)') : t('(optional)')}</label><input type="text" id="sh-pass" placeholder="${editing && existing.has_password ? '•••••• ' + t('(set)') : t('no password')}" />` +
    (editing && existing.has_password ? `<label class="check"><input type="checkbox" id="sh-rmpass"/> ${t('Remove password')}</label>` : '') +
    `<div class="modal-row"><button class="modal-btn" id="sh-x">${t('Cancel')}</button><button class="modal-btn primary" id="sh-ok">${editing ? t('Save') : t('Create link')}</button></div><div id="sh-result"></div>`, true);
  $('#sh-x').onclick = closeModal;
  if (isFolder) {
    const hints = {
      view: t('Recipients can preview the files but cannot download or upload.'),
      download: t('Recipients can see and download everything inside, but cannot upload.'),
      upload: t('Recipients can see, download AND upload their own files.'),
      drop: t('A drop-box: recipients can only upload — they cannot see what is already inside.')
    };
    const sel = document.getElementById('sh-faccess'); const hint = document.getElementById('sh-faccess-hint');
    const refreshHint = () => { hint.textContent = hints[sel.value] || ''; };
    sel.onchange = refreshHint; refreshHint();
  }
  $('#sh-ok').onclick = async () => {
    const body = { label: $('#sh-label').value.trim() || null, maxDownloads: parseInt($('#sh-max').value, 10) || null };
    if (isFolder) { const mode = $('#sh-faccess').value; body.permission = mode === 'view' ? 'view' : 'download'; body.allowUpload = (mode === 'upload' || mode === 'drop'); body.uploadOnly = (mode === 'drop'); } else { body.permission = $('#sh-perm').value; }
    const expV = $('#sh-exp').value; if (expV !== '-1') body.expiresIn = parseInt(expV, 10);
    const pass = $('#sh-pass').value, rmpass = $('#sh-rmpass') && $('#sh-rmpass').checked;
    if (rmpass) body.password = ''; else if (pass) body.password = pass;
    if (!editing) { const slug = $('#sh-slug').value.trim(); if (slug) body.slug = slug; }
    try {
      let out;
      if (editing) out = await api('/shares/' + existing.id, { method: 'PATCH', json: body });
      else out = await api('/shares', { method: 'POST', json: Object.assign({ resourceType: type, resourceId: res.id }, body) });
      const url = out.url || shareLink(out.share.token || out.share.id);
      $('#sh-result').innerHTML = `<div class="share-link"><input type="text" readonly value="${esc(url)}" id="sh-url" /><button class="modal-btn primary" id="sh-copy">${t('Copy')}</button></div><div class="share-hint">${t('Anyone with this link can access it.')}</div>`;
      $('#sh-url').select();
      $('#sh-copy').onclick = async () => { const ok = await copyText(url); $('#sh-copy').textContent = ok ? t('Copied!') : t('Copy manually'); };
      if (editing) setTimeout(() => { closeModal(); openShares(); }, 600);
    } catch (e) { $('#sh-result').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; }
  };
}
async function openShares() {
  view = { type: 'shares', id: null }; setNav(); renderTree(); clearSel();
  $('#breadcrumb').innerHTML = `<span class="crumb current">${t('Shares')}</span>`;
  const { shares } = await api('/shares'); const c = $('#content');
  if (!shares.length) { c.innerHTML = `<div class="empty"><div class="empty-mark">◇</div>${t('No active shares. Use "Share" on a file or folder.')}</div>`; return; }
  c.innerHTML = `<div class="section-h">${t('Your shares')}</div><div class="shares" id="shares-list"></div>`;
  const list = $('#shares-list'); shares.forEach((s) => list.appendChild(shareRow(s)));
}
function shareStatus(s) { if (s.disabled) return { t: t('Disabled'), cls: 'off' }; if (s.expires_at && s.expires_at < Date.now()) return { t: t('Expired'), cls: 'off' }; if (s.max_downloads && s.downloads >= s.max_downloads) return { t: t('Limit reached'), cls: 'off' }; return { t: t('Active'), cls: 'on' }; }
function shareRow(s) {
  const el = document.createElement('div'); el.className = 'share-row'; const st = shareStatus(s), url = shareLink(s.token), tags = [];
  if (s.has_password) tags.push('<span class="tag">🔒 ' + t('password') + '</span>');
  if (s.allow_upload) tags.push('<span class="tag">⤓ ' + t('drop-box') + '</span>');
  if (s.upload_only) tags.push('<span class="tag">' + t('upload-only') + '</span>');
  tags.push(`<span class="tag">${s.permission === 'view' ? t('view only') : t('download')}</span>`);
  el.innerHTML = `<div class="share-main"><div class="share-ico">${s.resource_type === 'folder' ? ICO.folder : ICO.file}</div><div class="share-meta"><div class="share-name">${esc(s.resource_name || '(?)')} ${s.label ? '<span class="share-label">· ' + esc(s.label) + '</span>' : ''}</div><div class="share-sub">${tags.join(' ')} <span class="tag">${fmtExpiry(s.expires_at)}</span><span class="tag">${t('{n} downloads', { n: s.downloads })}${s.max_downloads ? ' / ' + s.max_downloads : ''}</span><span class="tag">/s/${esc(s.token)}</span></div></div><span class="status ${st.cls}">${st.t}</span></div><div class="share-actions"><button class="mini" data-a="copy">${t('Copy link')}</button><button class="mini" data-a="open">${t('Open')}</button><button class="mini" data-a="edit">${t('Edit')}</button><button class="mini" data-a="toggle">${s.disabled ? t('Enable') : t('Disable')}</button><button class="mini danger" data-a="del">${t('Delete')}</button></div>`;
  el.querySelector('[data-a=copy]').onclick = async (e) => { const ok = await copyText(url); e.target.textContent = ok ? t('Copied!') : url; setTimeout(() => (e.target.textContent = t('Copy link')), 1200); };
  el.querySelector('[data-a=open]').onclick = () => window.open(url, '_blank');
  el.querySelector('[data-a=edit]').onclick = () => shareModal(s.resource_type, { id: s.resource_id, name: s.resource_name }, s);
  el.querySelector('[data-a=toggle]').onclick = async () => { await api('/shares/' + s.id, { method: 'PATCH', json: { disabled: !s.disabled } }); openShares(); };
  el.querySelector('[data-a=del]').onclick = async () => { if (confirm(t('Delete this share link?'))) { await api('/shares/' + s.id, { method: 'DELETE' }); openShares(); } };
  return el;
}

/* ═════════════════════════ PROFILE ═════════════════════════ */
function profileModal() {
  const langOpts = Object.entries(LANGS).map(([k, v]) => `<option value="${k}" ${k === LANG ? 'selected' : ''}>${v}</option>`).join('');
  modal(`<h2>${t('Profile')}</h2><div class="info-row"><span>${t('User')}</span><b>${esc(me.username)}</b></div><div class="info-row"><span>${t('Role')}</span><b>${esc(me.role || '—')}</b></div><label style="margin-top:14px">${t('Language')}</label><select id="pf-lang">${langOpts}</select><label style="margin-top:14px">${t('Link Telegram (for TDrop)')}</label><input type="text" id="pf-tg" placeholder="${t('Your Telegram ID (send /id to the bot)')}" value="${esc(me.telegram_id || '')}" /><label style="margin-top:14px">${t('Change password')}</label><input type="password" id="pf-pass" placeholder="${t('New password (leave empty to keep)')}" autocomplete="new-password" />
    <label style="margin-top:16px">${t('Two-factor authentication (recommended)')}</label>
    <div id="pf-2fa">${me.two_factor_method
      ? `<div class="info-row"><span>${t('Status')}</span><b>✅ ${me.two_factor_method === 'telegram' ? t('Enabled via Telegram') : t('Enabled via authenticator app')}</b></div><div class="modal-row"><button type="button" class="modal-btn danger" id="tf-off">${t('Disable 2FA')}</button></div>`
      : `<div class="setting-desc">${t('Add a second step at login: a code from an authenticator app, or a code the bot sends you on Telegram.')}</div><div class="modal-row"><button type="button" class="modal-btn" id="tf-totp">${t('Use authenticator app')}</button><button type="button" class="modal-btn" id="tf-tg">${t('Use Telegram codes')}</button></div>`}
    <div id="tf-setup"></div></div><div class="modal-row"><button class="modal-btn" id="pf-x">${t('Close')}</button><button class="modal-btn primary" id="pf-save">${t('Save')}</button></div><div id="pf-result"></div>`);
  $('#pf-x').onclick = closeModal;
  $('#pf-lang').onchange = async (e) => { await loadI18n(e.target.value); applyI18nStatic(); closeModal(); reload(); };
  $('#pf-save').onclick = async () => { const body = { telegram_id: $('#pf-tg').value.trim() }; const pw = $('#pf-pass').value; if (pw) body.password = pw; try { const r = await api('/me', { method: 'PATCH', json: body }); me = r.user; $('#pf-result').innerHTML = `<div class="share-hint">✅ ${t('Saved.')}</div>`; setTimeout(closeModal, 700); } catch (e) { $('#pf-result').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; } };
  const tfBox = $('#tf-setup');
  const confirmUI = (intro) => {
    tfBox.insertAdjacentHTML('beforeend', `<label style="margin-top:10px">${t('Enter the 6-digit code to confirm')}</label><div class="modal-row" style="margin-top:6px"><input type="text" id="tf-c" inputmode="numeric" maxlength="6" placeholder="123456" style="flex:1" /><button type="button" class="modal-btn primary" id="tf-ok">${t('Confirm')}</button></div>`);
    $('#tf-ok').onclick = async () => { try { await api('/me/2fa/enable', { method: 'POST', json: { code: $('#tf-c').value.trim() } }); me = (await api('/me')).user; closeModal(); profileModal(); } catch (e) { $('#pf-result').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; } };
  };
  const bT = $('#tf-totp'); if (bT) bT.onclick = async () => { try { const r = await api('/me/2fa/setup', { method: 'POST', json: { method: 'totp' } }); tfBox.innerHTML = `<div class="setting-desc" style="margin-top:8px">${t('Scan this QR code with your authenticator app (Google Authenticator, Aegis, 1Password…), or add the secret by hand:')}</div>${r.qr ? `<div class="qr-box">${r.qr}</div>` : ''}<div class="code-box" style="user-select:all">${esc(r.secret)}</div><a href="${esc(r.otpauth)}" style="font-size:13px">${t('Open in authenticator app')}</a>`; confirmUI(); } catch (e) { $('#pf-result').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; } };
  const bG = $('#tf-tg'); if (bG) bG.onclick = async () => { try { await api('/me/2fa/setup', { method: 'POST', json: { method: 'telegram' } }); tfBox.innerHTML = `<div class="setting-desc" style="margin-top:8px">${t('We sent a code to your Telegram via the bot.')}</div>`; confirmUI(); } catch (e) { $('#pf-result').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; } };
  const bOff = $('#tf-off'); if (bOff) bOff.onclick = async () => { const pw = prompt(t('Confirm your password to disable 2FA:')); if (!pw) return; try { await api('/me/2fa/disable', { method: 'POST', json: { password: pw } }); me = (await api('/me')).user; closeModal(); profileModal(); } catch (e) { $('#pf-result').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; } };
}

/* ═════════════════════════ ADMIN ═════════════════════════ */
/* ───────────────────────── connectivity ───────────────────────── */
let _offlineEl = null;
let _offlineStrikes = 0;
// After an update the server restarts with new front-end files. Clear the service
// worker caches and reload so the browser actually loads the new version instead of
// the cached old one. Gated by the auto_reload setting.
async function hardReload() {
  try { if (window.caches && caches.keys) { const ks = await caches.keys(); await Promise.all(ks.map((k) => caches.delete(k))); } } catch (_) {}
  try { if (navigator.serviceWorker) { const rs = await navigator.serviceWorker.getRegistrations(); await Promise.all(rs.map((r) => r.unregister())); } } catch (_) {}
  location.reload();
}
function waitForServerThenReload() {
  let n = 0;
  const poll = setInterval(async () => {
    n++;
    try { const r = await (await fetch('/api/auth/status', { cache: 'no-store' })).json(); if (r && r.version) { clearInterval(poll); hardReload(); } }
    catch (_) { if (n > 90) clearInterval(poll); }
  }, 2000);
}
async function checkConnectivity() {
  // The browser itself knows when the device has no network — trust it instantly.
  if (navigator.onLine === false) { _offlineStrikes = 2; showOffline(); return; }
  let h, reached = true;
  try { h = await (await fetch('/api/health')).json(); } catch (_) { reached = false; h = null; }
  if (h && h.support) support = h.support;
  if (h && typeof h.autoReload !== 'undefined') autoReload = h.autoReload;
  // The server came back on a different version (e.g. it auto-updated) — reload to it.
  if (autoReload && appVersion && h && h.version && h.version !== appVersion) { hardReload(); return; }
  // Only the server's own probe to Telegram failing counts toward "offline", and
  // only after two strikes in a row — a single slow request shouldn't pop the modal.
  // If we couldn't even reach OUR server while the device is online, that's a
  // transient/server hiccup, not the user's internet, so we don't block on it.
  if (h && h.online === false) { _offlineStrikes++; if (_offlineStrikes >= 2) showOffline(); }
  else if (reached) { _offlineStrikes = 0; hideOffline(); }
}
function showOffline() {
  if (_offlineEl) return;
  _offlineEl = document.createElement('div'); _offlineEl.className = 'conn-blocker';
  _offlineEl.innerHTML = `<div class="conn-card"><div class="conn-ic">\uD83D\uDCE1</div><h2>${t('No internet connection')}</h2><p>${t('TCloud needs an internet connection to reach your Telegram storage. Please enable internet — without it TCloud cannot work.')}</p><button class="modal-btn primary" id="conn-retry">${t('Retry')}</button></div>`;
  document.body.appendChild(_offlineEl);
  const b = document.getElementById('conn-retry'); if (b) b.onclick = checkConnectivity;
}
function hideOffline() { if (_offlineEl) { _offlineEl.remove(); _offlineEl = null; } }
window.addEventListener('online', checkConnectivity);
window.addEventListener('offline', checkConnectivity);

/* ───────────────────────── update notice ───────────────────────── */
async function maybeCheckUpdate() {
  try {
    if (!me || !can('manageSettings')) return;
    const c = await api('/admin/update/check');
    if (!c || !c.available) return;
    if (localStorage.getItem('tc_upd_ignore') === c.latest) return;
    const sn = parseInt(localStorage.getItem('tc_upd_snooze') || '0', 10);
    if (sn && Date.now() < sn) return;
    updateModal(c);
  } catch (_) {}
}
let _updEl = null;
function closeUpdate() { if (_updEl) { _updEl.remove(); _updEl = null; } }
function updateModal(c) {
  closeUpdate();
  const schedBits = `<div class="upd-sched"><div class="setting-desc">${t('Schedule')}:</div><button class="modal-btn" id="upd-tonight">${t('Tonight 03:00')}</button><button class="modal-btn" id="upd-6h">${t('In 6 hours')}</button></div>`
    + `<label class="upd-auto"><input type="checkbox" id="upd-auto"${c.autoUpdate ? ' checked' : ''}/> ${t('Auto-update when idle')}</label>`;
  _updEl = document.createElement('div'); _updEl.className = 'conn-blocker';
  _updEl.innerHTML = `<div class="conn-card upd-card"><div class="conn-ic">\u2728</div><h2>${t('New version available')}</h2>`
    + `<p class="upd-intro">${t('Version {v} is ready to install.', { v: c.latest })}</p>`
    + (c.notes ? `<div class="upd-notes">${esc(cleanNotes(c.notes))}</div>` : '')
    + schedBits
    + `<div class="upd-actions"><button class="modal-btn primary" id="upd-now">${t('Update now')}</button>`
    + `<button class="modal-btn" id="upd-remind">${t('Remind me later')}</button>`
    + `<button class="modal-btn" id="upd-ignore">${t('Ignore this version')}</button></div>`
    + `<div id="upd-msg"></div></div>`;
  document.body.appendChild(_updEl);
  $('#upd-now').onclick = async () => { $('#upd-msg').innerHTML = t('Downloading and verifying…'); try { const r = await api('/admin/update/apply', { method: 'POST' }); if (r.ok) { $('#upd-msg').innerHTML = `<div class="share-hint">\u2705 ${t('Updated to {v}. Restarting…', { v: r.version })}</div>`; if (autoReload) waitForServerThenReload(); } } catch (e) { $('#upd-msg').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; } };
  $('#upd-remind').onclick = () => { localStorage.setItem('tc_upd_snooze', String(Date.now() + 24 * 3600 * 1000)); closeUpdate(); };
  $('#upd-ignore').onclick = () => { localStorage.setItem('tc_upd_ignore', c.latest); closeUpdate(); };
  const sched = async (at) => { try { await api('/admin/update/schedule', { method: 'POST', json: { at } }); $('#upd-msg').innerHTML = `<div class="share-hint">\u2705 ${t('Update scheduled.')}</div>`; setTimeout(closeUpdate, 1200); } catch (e) { $('#upd-msg').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; } };
  const ton = $('#upd-tonight'); if (ton) ton.onclick = () => { const d = new Date(); d.setHours(3, 0, 0, 0); if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); sched(d.getTime()); };
  const h6 = $('#upd-6h'); if (h6) h6.onclick = () => sched(Date.now() + 6 * 3600 * 1000);
  const au = $('#upd-auto'); if (au) au.onchange = async () => { try { await api('/admin/update/auto', { method: 'POST', json: { enabled: au.checked } }); } catch (_) {} };
}

async function openAdmin() {
  view = { type: 'admin', id: null }; setNav(); renderTree(); clearSel();
  $('#breadcrumb').innerHTML = `<span class="crumb current">${t('Admin')}</span>`;
  const tabs = [];
  if (can('manageSettings')) tabs.push(['general', t('General'), adminGeneral]);
  if (can('manageUsers')) tabs.push(['users', t('Users'), adminUsers]);
  if (can('manageUsers')) tabs.push(['tdrop', 'TDrop', adminTDrop]);
  if (can('manageRoles')) tabs.push(['roles', t('Roles'), adminRoles]);

  if (can('manageSettings')) tabs.push(['appearance', t('Appearance'), adminAppearance]);
  if (can('manageTelegram')) tabs.push(['telegram', t('Telegram'), adminTelegram]);
  if (can('manageBackups')) tabs.push(['backup', t('Backup'), adminBackup]);
  const c = $('#content');
  c.innerHTML = `<div class="tabs">${tabs.map((tb, i) => `<button class="tab ${i === 0 ? 'active' : ''}" data-t="${tb[0]}">${tb[1]}</button>`).join('')}</div><div id="admin-body"></div>`;
  c.querySelectorAll('.tab').forEach((el) => el.onclick = () => { c.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === el)); (tabs.find((tb) => tb[0] === el.dataset.t)[2])(); });
  if (tabs.length) tabs[0][2]();
}
async function loadRoles() { const r = await api('/admin/roles'); rolesCache = r.roles; permKeysCache = r.permKeys; return r; }

async function adminUsers() {
  const body = $('#admin-body'); body.innerHTML = `<div class="loading">${t('Loading…')}</div>`;
  await loadRoles().catch(() => {});
  const { users } = await api('/admin/users');
  const rows = users.map((u) => `<tr data-id="${u.id}"><td><b>${esc(u.username)}</b>${u.id === me.id ? ' <span class="tag">' + t('you') + '</span>' : ''}</td><td>${u.admin ? '<span class="badge badge-admin">' + esc(u.role || 'admin') + '</span>' : '<span class="badge">' + esc(u.role || 'user') + '</span>'}</td><td>${u.disabled ? '<span class="status off">' + t('disabled') + '</span>' : '<span class="status on">' + t('active') + '</span>'}</td><td>${fmtSize(u.used)} / ${u.quota ? fmtSize(u.quota) : '∞'}</td><td>${u.telegram_id ? '🔗 ' + esc(u.telegram_id) : '—'}</td><td class="row-actions"><button class="mini" data-a="edit">${t('Edit')}</button>${u.id === me.id ? '' : `<button class="mini" data-a="toggle">${u.disabled ? t('Enable') : t('Disable')}</button><button class="mini danger" data-a="del">${t('Delete')}</button>`}</td></tr>`).join('');
  body.innerHTML = `<div class="admin-head"><button class="modal-btn primary" id="new-user">+ ${t('New user')}</button></div><table class="utable"><thead><tr><th>${t('User')}</th><th>${t('Role')}</th><th>${t('Status')}</th><th>${t('Storage')}</th><th>${t('Telegram')}</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  $('#new-user').onclick = () => userModal();
  body.querySelectorAll('tr[data-id]').forEach((tr) => { const id = tr.dataset.id, u = users.find((x) => x.id === id); const ed = tr.querySelector('[data-a=edit]'); if (ed) ed.onclick = () => userModal(u); const tg = tr.querySelector('[data-a=toggle]'); if (tg) tg.onclick = async () => { try { await api('/admin/users/' + id, { method: 'PATCH', json: { disabled: !u.disabled } }); adminUsers(); } catch (e) { if (e.message) alert(e.message); } }; const dl = tr.querySelector('[data-a=del]'); if (dl) dl.onclick = async () => { if (confirm(t('Delete user "{u}" and all their files?', { u: u.username }))) { try { await api('/admin/users/' + id, { method: 'DELETE' }); adminUsers(); } catch (e) { if (e.message) alert(e.message); } } }; });
}
function overrideRow(key, ov) {
  const cur = (key in ov) ? (ov[key] ? 'allow' : 'deny') : 'inherit';
  return `<div class="ov-row"><span>${t(PERM_LABELS[key] || key)}</span><select data-ovk="${key}"><option value="inherit" ${cur === 'inherit' ? 'selected' : ''}>${t('Inherit')}</option><option value="allow" ${cur === 'allow' ? 'selected' : ''}>${t('Allow')}</option><option value="deny" ${cur === 'deny' ? 'selected' : ''}>${t('Deny')}</option></select></div>`;
}
function userModal(u) {
  const editing = !!u; const ov = (u && u.perms_override) || {};
  const roleOpts = rolesCache.map((r) => `<option value="${r.id}" ${u && u.role_id === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const allPerms = [...(permKeysCache.content || []), ...(permKeysCache.admin || [])];
  modal(`<h2>${editing ? t('Edit user') : t('New user')}</h2><label>${t('Username')}</label><input type="text" id="u-name" value="${esc(u ? u.username : '')}" /><label>${t('Password')} ${editing ? t('(leave empty to keep)') : ''}</label><input type="password" id="u-pass" autocomplete="new-password" /><div class="grid2"><div><label>${t('Role')}</label><select id="u-role">${roleOpts}</select></div><div><label>${t('Quota (MB, 0 = unlimited)')}</label><input type="number" id="u-quota" min="0" value="${u && u.quota ? Math.round(u.quota / 1048576) : 0}" /></div></div><label>${t('Telegram ID (optional)')}</label><input type="text" id="u-tg" value="${esc((u && u.telegram_id) || '')}" /><label style="margin-top:12px">${t('Permission overrides')} <span class="hint-inline">${t('(on top of the role)')}</span></label><div class="ov-grid" id="u-ov">${allPerms.map((k) => overrideRow(k, ov)).join('')}</div><div class="modal-row"><button class="modal-btn" id="u-x">${t('Cancel')}</button><button class="modal-btn primary" id="u-ok">${editing ? t('Save') : t('Create')}</button></div><div id="u-result"></div>`, true);
  $('#u-x').onclick = closeModal;
  $('#u-ok').onclick = async () => {
    const permsOverride = {};
    $('#u-ov').querySelectorAll('[data-ovk]').forEach((s) => { if (s.value === 'allow') permsOverride[s.dataset.ovk] = true; else if (s.value === 'deny') permsOverride[s.dataset.ovk] = false; });
    const body = { username: $('#u-name').value.trim(), roleId: $('#u-role').value, quotaMB: parseInt($('#u-quota').value, 10) || 0, telegramId: $('#u-tg').value.trim(), permsOverride };
    const pw = $('#u-pass').value; if (pw) body.password = pw;
    try { if (editing) await api('/admin/users/' + u.id, { method: 'PATCH', json: body }); else { if (!pw) throw new Error(t('Password is required for a new user')); await api('/admin/users', { method: 'POST', json: body }); } closeModal(); adminUsers(); }
    catch (e) { $('#u-result').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; }
  };
}

async function adminRoles() {
  const body = $('#admin-body'); body.innerHTML = `<div class="loading">${t('Loading…')}</div>`;
  await loadRoles();
  const rows = rolesCache.map((r) => { const grant = [...(permKeysCache.content || []), ...(permKeysCache.admin || [])].filter((k) => r.perms[k]).map((k) => t(PERM_LABELS[k] || k)); return `<tr data-id="${r.id}"><td><b>${esc(r.name)}</b> ${r.builtin ? '<span class="tag">' + t('built-in') + '</span>' : ''}</td><td>${r.admin ? '<span class="badge badge-admin">' + t('full access') + '</span>' : esc(grant.join(', ') || t('none'))}</td><td class="row-actions"><button class="mini" data-a="edit">${t('Edit')}</button>${r.builtin ? '' : `<button class="mini danger" data-a="del">${t('Delete')}</button>`}</td></tr>`; }).join('');
  body.innerHTML = `<div class="admin-head"><button class="modal-btn primary" id="new-role" ${can('manageRoles') ? '' : 'disabled'}>+ ${t('New role')}</button></div><table class="utable"><thead><tr><th>${t('Role')}</th><th>${t('Permissions')}</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  $('#new-role').onclick = () => roleModal();
  body.querySelectorAll('tr[data-id]').forEach((tr) => { const id = tr.dataset.id, r = rolesCache.find((x) => x.id === id); const ed = tr.querySelector('[data-a=edit]'); if (ed) ed.onclick = () => roleModal(r); const dl = tr.querySelector('[data-a=del]'); if (dl) dl.onclick = async () => { if (confirm(t('Delete role "{r}"?', { r: r.name }))) { try { await api('/admin/roles/' + id, { method: 'DELETE' }); adminRoles(); } catch (e) { if (e.message) alert(e.message); } } }; });
}
function roleModal(r) {
  const editing = !!r; const allPerms = [...(permKeysCache.content || []), ...(permKeysCache.admin || [])];
  const permChecks = allPerms.map((k) => `<label class="check"><input type="checkbox" data-pk="${k}" ${r && r.perms[k] ? 'checked' : ''}/> ${t(PERM_LABELS[k] || k)}</label>`).join('');
  modal(`<h2>${editing ? t('Edit role') : t('New role')}</h2><label>${t('Role name')}</label><input type="text" id="r-name" value="${esc(r ? r.name : '')}" ${r && r.builtin ? 'disabled' : ''} /><label class="check" style="margin-top:10px"><input type="checkbox" id="r-admin" ${r && r.admin ? 'checked' : ''} ${r && r.builtin ? 'disabled' : ''}/> ${t('Full administrator (all permissions)')}</label><label style="margin-top:12px">${t('Permissions')}</label><div class="perm-grid" id="r-perms">${permChecks}</div><div class="modal-row"><button class="modal-btn" id="r-x">${t('Cancel')}</button><button class="modal-btn primary" id="r-ok">${editing ? t('Save') : t('Create')}</button></div><div id="r-result"></div>`, true);
  const adminBox = $('#r-admin'); const syncAdmin = () => { $('#r-perms').querySelectorAll('input').forEach((c) => { c.disabled = adminBox.checked; }); }; adminBox.onchange = syncAdmin; syncAdmin();
  $('#r-x').onclick = closeModal;
  $('#r-ok').onclick = async () => {
    const perms = {}; $('#r-perms').querySelectorAll('[data-pk]').forEach((c) => perms[c.dataset.pk] = c.checked);
    const body = { name: $('#r-name').value.trim(), admin: adminBox.checked, perms };
    try { if (editing) await api('/admin/roles/' + r.id, { method: 'PATCH', json: body }); else await api('/admin/roles', { method: 'POST', json: body }); closeModal(); adminRoles(); }
    catch (e) { $('#r-result').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; }
  };
}

async function adminGeneral() {
  const body = $('#admin-body'); body.innerHTML = `<div class="loading">${t('Loading…')}</div>`;
  await loadRoles().catch(() => {});
  const s = await api('/admin/settings'); const st = await api('/admin/stats').catch(() => null);
  const isOrg = orgMode === 'organization';
  const roleOpts = rolesCache.filter((r) => !r.admin).map((r) => `<option value="${r.id}" ${s.defaultRoleId === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('');
  const orgRows = isOrg ? `<div class="setting-row"><div><div class="setting-title">${t('Allow new registrations')}</div><div class="setting-desc">${t('If enabled, anyone can create an account from the login page.')}</div></div><label class="switch"><input type="checkbox" id="set-reg" ${s.allowRegistration ? 'checked' : ''}/><span class="slider"></span></label></div><div class="setting-row"><div><div class="setting-title">${t('Default role for new users')}</div></div><select id="set-role" style="min-width:160px">${roleOpts}</select></div><div class="setting-row"><div><div class="setting-title">${t('Default quota (MB, 0 = unlimited)')}</div></div><input type="number" id="set-quota" min="0" value="${s.defaultQuotaMB}" style="width:120px" /></div>` : '';
  body.innerHTML = `<div class="setting-card"><div class="setting-row"><div><div class="setting-title">${t('Accept TDrop submissions')}</div><div class="setting-desc">${t('Master switch for files sent to the bot.')}</div></div><label class="switch"><input type="checkbox" id="set-drops" ${s.acceptDrops ? 'checked' : ''}/><span class="slider"></span></label></div>${orgRows}<div class="setting-row"><div><div class="setting-title">${t('Stay signed in for')}</div><div class="setting-desc">${t('How long login sessions last on this TCloud.')}</div></div><select id="set-sess" style="min-width:190px"><option value="1">1 ${t('day')}</option><option value="7">7 ${t('days')}</option><option value="30">30 ${t('days')}</option><option value="90">90 ${t('days')}</option><option value="365">365 ${t('days')}</option><option value="0">${t('Until the machine restarts')}</option></select></div><div class="setting-row"><div><div class="setting-title">${t('File encryption')}</div><div class="setting-desc">${s.encryption ? t('ON — files are encrypted (AES-256) on this machine before being sent to Telegram.') : t('OFF — chosen at setup. Files are stored on Telegram as-is.')}</div></div><b>${s.encryption ? '🔒' : '—'}</b></div><div class="setting-row"><div><div class="setting-title">${t('Buffer uploads locally first')}</div><div class="setting-desc">${t('Save uploads to a local folder and send them to Telegram in the background — faster uploads, gentler on Telegram.')}</div></div><label class="switch"><input type="checkbox" id="set-staging" ${s.stagingEnabled ? 'checked' : ''}/><span class="slider"></span></label></div><div class="setting-row"><div><div class="setting-title">${t('Staging folder')}</div><div class="setting-desc">${t('Leave empty to use data/staging.')}</div></div><input type="text" id="set-staging-path" value="${esc(s.stagingPath || '')}" placeholder="data/staging" style="min-width:200px" /></div><div class="setting-row"><div><div class="setting-title">${t('Max staging size (GB)')}</div></div><input type="number" id="set-staging-gb" min="1" value="${s.stagingMaxGB}" style="width:120px" /></div><div class="setting-row"><div><div class="setting-title">${t('Reload automatically after updates')}</div><div class="setting-desc">${t('When the server restarts for an update, reload the app automatically so you get the new version.')}</div></div><label class="switch"><input type="checkbox" id="set-autoreload" ${s.autoReload ? 'checked' : ''}/><span class="slider"></span></label></div><div class="modal-row"><button class="modal-btn primary" id="set-save">${t('Save settings')}</button></div><div id="set-result"></div></div>` +
    (st ? `<div class="setting-card"><div class="setting-title">${t('Instance statistics')}</div><div class="stat-grid"><div class="stat-cell"><b>${st.users}</b><span>${t('users')}</span></div><div class="stat-cell"><b>${st.files}</b><span>${t('files')}</span></div><div class="stat-cell"><b>${st.shares}</b><span>${t('shares')}</span></div><div class="stat-cell"><b>${fmtSize(st.totalSize)}</b><span>${t('total')}</span></div></div></div>` : '');
  const sSel = $('#set-sess'); if (sSel) sSel.value = s.sessionUntilRestart ? '0' : String(s.sessionDays || 30);
  $('#set-save').onclick = async () => { const j = { acceptDrops: $('#set-drops').checked }; const sv = parseInt($('#set-sess').value, 10); if (sv === 0) j.sessionUntilRestart = true; else { j.sessionUntilRestart = false; j.sessionDays = sv; } j.stagingEnabled = $('#set-staging').checked; const _sp = $('#set-staging-path'); if (_sp) j.stagingPath = _sp.value.trim(); const _sg = parseFloat($('#set-staging-gb').value); if (_sg > 0) j.stagingMaxGB = _sg; const _ar = $('#set-autoreload'); if (_ar) j.autoReload = _ar.checked; if (isOrg) { j.allowRegistration = $('#set-reg').checked; j.defaultRoleId = $('#set-role').value; j.defaultQuotaMB = parseInt($('#set-quota').value, 10) || 0; } const btn = $('#set-save'); const orig = btn.textContent; btn.disabled = true; btn.textContent = t('Saving…'); $('#set-result').innerHTML = ''; try { await api('/admin/settings', { method: 'PATCH', json: j }); btn.classList.add('saved-ok'); btn.textContent = '✅ ' + t('Saved'); $('#set-result').innerHTML = `<div class="share-hint">\u2705 ${t('Settings saved.')}</div>`; setTimeout(() => { btn.classList.remove('saved-ok'); btn.textContent = orig; btn.disabled = false; $('#set-result').innerHTML = ''; }, 1800); } catch (e) { btn.disabled = false; btn.textContent = orig; $('#set-result').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; } };
  // Updates panel
  body.insertAdjacentHTML('beforeend', `<div class="setting-card"><div class="setting-title">${t('Updates')}</div><div id="upd-body" class="setting-desc">${t('Checking…')}</div><div id="upd-actions" class="modal-row" style="margin-top:10px"></div><div id="upd-result"></div></div>`);
  (async () => {
    let c; try { c = await api('/admin/update/check'); } catch (e) { c = { serverDown: true }; }
    const b = $('#upd-body'), act = $('#upd-actions'); if (!b) return;
    if (!c || c.serverDown) { b.innerHTML = t('Update server unreachable. Your TCloud keeps working.'); return; }
    if (c.available) {
      b.innerHTML = t('Update available: {a} → {b}', { a: c.current, b: c.latest }) + (c.notes ? `<div class="upd-notes">${esc(cleanNotes(c.notes))}</div>` : '');
      act.innerHTML = `<button class="modal-btn primary" id="upd-go">${t('Update now')}</button>`;
      $('#upd-go').onclick = async () => { if (!confirm(t('Install version {v} now? TCloud will restart.', { v: c.latest }))) return; $('#upd-go').disabled = true; $('#upd-result').innerHTML = t('Downloading and verifying…'); try { const r = await api('/admin/update/apply', { method: 'POST' }); if (r.ok) { $('#upd-result').innerHTML = `<div class="share-hint">\u2705 ${t('Updated to {v}. Restarting…', { v: r.version })}</div>`; if (autoReload) waitForServerThenReload(); } } catch (e) { $('#upd-result').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; $('#upd-go').disabled = false; } };
    } else { b.innerHTML = t('You are up to date (v{v}).', { v: c.current }); }
    if (act) act.insertAdjacentHTML('afterend', `<div class="setting-desc" style="margin-top:10px">TCloud v${esc(c.current || appVersion)} · ${t('Need help?')} <a href="${esc(support)}" target="_blank" rel="noopener">${t('Support')}</a> · <a href="${esc(donation)}" target="_blank" rel="noopener" class="donate-link">♥ ${t('Support the project')}</a></div>`);
  })();
}

// (The Personal/Organization choice was removed — every TCloud supports multiple
// users out of the box; just create them in Admin → Users when you want them.)

const ACCENTS = ['#5cc8ff', '#7c5cff', '#54e09b', '#ff8a5c', '#ff5c8a', '#ffd25c', '#5cffd2', '#b15cff'];
async function adminAppearance() {
  const body = $('#admin-body'); const a = await (await fetch('/api/appearance')).json(); const draft = Object.assign({}, a);
  const render = () => {
    body.innerHTML = `<div class="setting-card"><div class="setting-title">${t('Branding')}</div><label>${t('Your name after "TCloud" (optional)')}</label><input type="text" id="ap-suffix" maxlength="40" value="${esc(draft.brandSuffix || '')}" /></div><div class="setting-card"><div class="setting-title">${t('Theme')}</div><div class="seg" id="ap-theme"><button data-v="dark" class="${draft.theme === 'dark' ? 'sel' : ''}">${t('Dark')}</button><button data-v="light" class="${draft.theme === 'light' ? 'sel' : ''}">${t('Light')}</button></div><label style="margin-top:14px">${t('Accent')}</label><div class="swatches" id="ap-acc">${ACCENTS.map((c) => `<div class="swatch ${draft.accent === c ? 'sel' : ''}" data-c="${c}" style="background:${c}"></div>`).join('')}</div><label style="margin-top:10px">${t('Custom accent')}</label><input type="color" id="ap-acccustom" value="${draft.accent || '#5cc8ff'}" /><label style="margin-top:14px">${t('Density')}</label><div class="seg" id="ap-density"><button data-v="comfortable" class="${draft.density !== 'compact' ? 'sel' : ''}">${t('Comfortable')}</button><button data-v="compact" class="${draft.density === 'compact' ? 'sel' : ''}">${t('Compact')}</button></div><label style="margin-top:14px">${t('Corner radius')} (${draft.radius || 16}px)</label><input type="range" id="ap-radius" min="0" max="28" value="${draft.radius || 16}" style="width:100%" /></div><div class="setting-card"><div class="setting-title">${t('Background')}</div><div class="seg" id="ap-bg"><button data-v="grid" class="${draft.bgStyle === 'grid' ? 'sel' : ''}">${t('Grid')}</button><button data-v="solid" class="${draft.bgStyle === 'solid' ? 'sel' : ''}">${t('Solid')}</button><button data-v="gradient" class="${draft.bgStyle === 'gradient' ? 'sel' : ''}">${t('Gradient')}</button><button data-v="image" class="${draft.bgStyle === 'image' ? 'sel' : ''}">${t('Image')}</button></div><div class="grid2" style="margin-top:12px"><div><label>${t('Background color')}</label><input type="color" id="ap-bgc" value="${draft.bgColor || '#0a0c10'}" /></div><div><label>${t('Secondary color')}</label><input type="color" id="ap-bgc2" value="${draft.bgColor2 || '#11161f'}" /></div></div><label style="margin-top:12px">${t('Background image')}</label><div class="bg-upload-row"><input type="text" id="ap-bgimg" placeholder="${t('paste a URL, or upload')}" value="${esc(draft.bgImage || '')}" /><label class="modal-btn bg-upload-btn">${t('Upload image')}<input type="file" id="ap-bgfile" accept="image/*" hidden /></label></div><div class="setting-desc" id="ap-bg-status">${t('Uploaded images stay on this machine — never sent to Telegram.')}</div></div><div class="modal-row"><button class="modal-btn" id="ap-reset">${t('Reset preview')}</button><button class="modal-btn primary" id="ap-save">${t('Save appearance')}</button></div><div id="ap-result"></div>`;
    const collect = () => ({ logo: (draft.logo || '☁'), brandSuffix: ($('#ap-suffix') ? $('#ap-suffix').value : (draft.brandSuffix || '')), accent: draft.accent, theme: draft.theme, density: draft.density, radius: parseInt($('#ap-radius').value, 10), bgStyle: draft.bgStyle, bgColor: $('#ap-bgc').value, bgColor2: $('#ap-bgc2').value, bgImage: $('#ap-bgimg').value });
    const upd = () => { Object.assign(draft, collect()); applyAppearance(draft); };
    ['ap-suffix', 'ap-radius', 'ap-bgc', 'ap-bgc2', 'ap-bgimg'].forEach((id) => { const el = $('#' + id); if (el) el.oninput = upd; });
    const bgf = $('#ap-bgfile'); if (bgf) bgf.onchange = async () => {
      const file = bgf.files[0]; if (!file) return; const st = $('#ap-bg-status');
      if (!/^image\//.test(file.type || '')) { st.textContent = t('Only image files are allowed'); return; }
      if (file.size > 8 * 1024 * 1024) { st.textContent = t('Image too large (max 8 MB)'); return; }
      st.textContent = t('Uploading…');
      try { const fd = new FormData(); fd.append('file', file); const r = await fetch('/api/admin/appearance/bg-image', { method: 'POST', headers: { 'X-Auth-Token': token }, body: fd }); const d = await r.json(); if (!r.ok) throw new Error(d.error || 'upload failed'); draft.bgImage = d.url; draft.bgStyle = 'image'; Object.assign(draft, collect(), { bgImage: d.url, bgStyle: 'image' }); render(); applyAppearance(draft); $('#ap-bg-status').textContent = t('Uploaded ✓ — click Save appearance to keep it.'); } catch (e) { st.textContent = e.message; }
    };
    $('#ap-theme').querySelectorAll('button').forEach((b) => b.onclick = () => { draft.theme = b.dataset.v; Object.assign(draft, collect()); render(); applyAppearance(draft); });
    $('#ap-density').querySelectorAll('button').forEach((b) => b.onclick = () => { draft.density = b.dataset.v; Object.assign(draft, collect()); render(); applyAppearance(draft); });
    $('#ap-bg').querySelectorAll('button').forEach((b) => b.onclick = () => { draft.bgStyle = b.dataset.v; Object.assign(draft, collect()); render(); applyAppearance(draft); });
    $('#ap-acc').querySelectorAll('.swatch').forEach((sw) => sw.onclick = () => { draft.accent = sw.dataset.c; Object.assign(draft, collect()); render(); applyAppearance(draft); });
    $('#ap-acccustom').oninput = (e) => { draft.accent = e.target.value; applyAppearance(draft); $('#ap-acc').querySelectorAll('.swatch').forEach((x) => x.classList.remove('sel')); };
    $('#ap-reset').onclick = () => loadAppearance();
    $('#ap-save').onclick = async () => { try { Object.assign(draft, collect()); const saved = await api('/admin/appearance', { method: 'PATCH', json: draft }); applyAppearance(saved); $('#ap-result').innerHTML = `<div class="share-hint">✅ ${t('Appearance saved for everyone.')}</div>`; } catch (e) { $('#ap-result').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; } };
  };
  render();
}

async function adminTelegram() {
  const body = $('#admin-body'); body.innerHTML = `<div class="loading">${t('Loading…')}</div>`;
  const s = await api('/admin/settings');
  body.innerHTML = `<div class="setting-card"><div class="setting-title">${t('Telegram backend')}</div><div class="setting-desc" style="margin-bottom:10px">${t('Changing these re-validates the bot and restarts the connection. The token is never shown back.')}</div><label>${t('Storage channel ID')}</label><input type="text" id="tg-channel" value="${esc(s.storageChannel || '')}" /><label>${t('Bot API endpoint')}</label><input type="text" id="tg-apiroot" value="${esc(s.apiRoot || 'https://api.telegram.org')}" /><label>${t('Chunk size (MB)')}</label><input type="number" id="tg-chunk" min="1" value="${s.chunkSizeMB}" /><label>${t('Bot token')} <span class="hint-inline">${t('(leave empty to keep)')}</span></label><input type="text" id="tg-token" placeholder="${t('leave empty to keep')}" autocomplete="off" /><div class="modal-row"><button class="modal-btn primary" id="tg-save">${t('Validate & save')}</button></div><div id="tg-result"></div></div>`;
  $('#tg-save').onclick = async () => { const b = { storageChannel: $('#tg-channel').value.trim(), apiRoot: $('#tg-apiroot').value.trim(), chunkSizeMB: parseInt($('#tg-chunk').value, 10) || 18 }; const tok = $('#tg-token').value.trim(); if (tok) b.botToken = tok; $('#tg-result').innerHTML = `<div class="loading" style="padding:10px">${t('Checking…')}</div>`; try { await api('/admin/telegram', { method: 'PATCH', json: b }); $('#tg-result').innerHTML = `<div class="share-hint">✅ ${t('Saved and reconnected.')}</div>`; } catch (e) { $('#tg-result').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; } };
}

async function adminBackup() {
  const body = $('#admin-body'); body.innerHTML = `<div class="loading">${t('Loading…')}</div>`;
  const info = await api('/admin/backup/info'); const last = info.lastBackupAt ? fmtDate(info.lastBackupAt) : t('never');
  body.innerHTML = `<div class="setting-card"><div class="setting-title">${t('Download backup')}</div><div class="setting-desc">${t('Exports the full database (settings, roles, users, file index, shares). Optionally encrypt it with a passphrase (AES-256).')}</div><label>${t('Passphrase (optional)')}</label><input type="text" id="bk-pass" autocomplete="off" /><div class="modal-row"><button class="modal-btn primary" id="bk-dl">${t('Download .tcb')}</button></div></div><div class="setting-card"><div class="setting-title">${t('Restore from file')}</div><div class="setting-desc">${t('Replaces all current data. Telegram connection settings on this instance are kept.')}</div><input type="file" id="bk-file" accept=".tcb" /><label>${t('Passphrase (if encrypted)')}</label><input type="text" id="bk-rpass" autocomplete="off" /><div class="modal-row"><button class="modal-btn" id="bk-restore">${t('Restore')}</button></div><div id="bk-result"></div></div><div class="setting-card"><div class="setting-title">${t('Channel snapshots (disaster recovery)')}</div><div class="setting-desc">${t('Push an encrypted snapshot into the storage channel and pin it. "Restore from channel" rebuilds from the latest pinned snapshot.')}<br>${t('Last backup:')} <b>${last}</b></div><label>${t('Passphrase (recommended)')}</label><input type="text" id="bk-cpass" autocomplete="off" /><div class="modal-row"><button class="modal-btn" id="bk-push">${t('Backup to channel')}</button><button class="modal-btn" id="bk-pull">${t('Restore from channel')}</button></div><div id="bk-cresult"></div></div><div class="setting-card danger-zone"><div class="setting-title">${t('Danger zone')}</div><div class="setting-desc">${t('Completely remove TCloud from this machine. Your files stay safe in your Telegram channel.')}</div><div class="modal-row"><button class="modal-btn danger" id="bk-uninstall">${t('Uninstall TCloud')}</button></div></div>`;
  $('#bk-dl').onclick = () => { const p = $('#bk-pass').value.trim(); window.location = '/api/admin/backup/export?token=' + encodeURIComponent(token) + (p ? '&pass=' + encodeURIComponent(p) : ''); };
  $('#bk-restore').onclick = async () => { const f = $('#bk-file').files[0]; if (!f) { $('#bk-result').innerHTML = `<div class="login-error">${t('Choose a file first.')}</div>`; return; } if (!confirm(t('This will REPLACE all current data. Continue?'))) return; const fd = new FormData(); fd.append('file', f); fd.append('pass', $('#bk-rpass').value.trim()); $('#bk-result').innerHTML = `<div class="loading" style="padding:10px">${t('Restoring…')}</div>`; try { const r = await fetch('/api/admin/backup/restore', { method: 'POST', headers: { 'X-Auth-Token': token }, body: fd }); const data = await r.json(); if (!r.ok) throw new Error(data.error || 'Restore failed'); $('#bk-result').innerHTML = `<div class="share-hint">✅ ${t('Restored. Reloading…')}</div>`; setTimeout(() => location.reload(), 1200); } catch (e) { $('#bk-result').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; } };
  $('#bk-push').onclick = async () => { $('#bk-cresult').innerHTML = `<div class="loading" style="padding:10px">${t('Uploading…')}</div>`; try { const r = await api('/admin/backup/channel/push', { method: 'POST', json: { pass: $('#bk-cpass').value.trim() } }); $('#bk-cresult').innerHTML = `<div class="share-hint">✅ ${t('Snapshot pinned')} (${fmtSize(r.size)}${r.encrypted ? ', ' + t('encrypted') : ''}).</div>`; adminBackup(); } catch (e) { $('#bk-cresult').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; } };
  // Danger zone is owner-only (the server enforces it too).
  if (!(me && me.is_owner)) { const ub = $('#bk-uninstall'); if (ub) { const c = ub.closest('.setting-card'); if (c) c.remove(); } }
  else $('#bk-uninstall').onclick = () => {
    modal(`<h2>${t('Uninstall TCloud')}</h2><div class="setting-desc">${t('This stops the service and removes TCloud and its local data from this machine. Your files stay safe in your Telegram channel. This cannot be undone.')}</div><label style="margin-top:10px">${t('Confirm your password')}</label><input type="password" id="un-pass" autocomplete="off" /><div id="un-out"></div><div class="modal-row"><button class="modal-btn" id="un-cancel">${t('Cancel')}</button><button class="modal-btn danger" id="un-go">${t('Uninstall now')}</button></div>`);
    $('#un-cancel').onclick = closeModal;
    $('#un-go').onclick = async () => {
      const pass = $('#un-pass').value; if (!pass) { $('#un-out').innerHTML = `<div class="login-error">${t('Enter your password.')}</div>`; return; }
      const b = $('#un-go'); b.disabled = true; b.textContent = t('Uninstalling…');
      try {
        const r = await api('/admin/uninstall', { method: 'POST', json: { password: pass } });
        const cmd = r.command || 'sudo bash /opt/tcloud/uninstall.sh';
        $('#un-out').innerHTML = `<div class="share-hint" style="margin-top:12px">✅ ${t('TCloud is shutting down and removing itself. Your files stay in your Telegram channel.')}</div><div class="setting-desc">${t('If a step needed root we could not get, finish it on the server with:')}</div><div class="code-box"><code>${esc(cmd)}</code></div><div class="modal-row"><button class="modal-btn" id="un-copy">${t('Copy command')}</button></div><div class="setting-desc">${t('To remove your files too, delete the Telegram channel; to retire the bot, message @BotFather → /deletebot.')}</div>`;
        $('#un-copy').onclick = () => { try { navigator.clipboard.writeText(cmd); $('#un-copy').textContent = t('Copied ✓'); } catch (_) {} };
      } catch (e) { $('#un-out').innerHTML = `<div class="login-error">${esc(e.message === 'Invalid password' ? t('Wrong password.') : e.message)}</div>`; b.disabled = false; b.textContent = t('Uninstall now'); }
    };
  };
  $('#bk-pull').onclick = async () => { if (!confirm(t('Rebuild the database from the latest pinned channel snapshot? Current data will be replaced.'))) return; $('#bk-cresult').innerHTML = `<div class="loading" style="padding:10px">${t('Restoring…')}</div>`; try { await api('/admin/backup/channel/restore', { method: 'POST', json: { pass: $('#bk-cpass').value.trim() } }); $('#bk-cresult').innerHTML = `<div class="share-hint">✅ ${t('Restored. Reloading…')}</div>`; setTimeout(() => location.reload(), 1200); } catch (e) { $('#bk-cresult').innerHTML = `<div class="login-error">${esc(e.message)}</div>`; } };
}

/* ── Marquee (rubber-band) multi-select: click empty space and drag a box to
      select files, like Windows Explorer / Google Drive. Hold Ctrl/Cmd/Shift to
      add to the current selection. Files only (folders aren't selectable). ── */
(function setupMarquee() {
  const content = $('#content');
  const INTERACTIVE = '.card, .lrow, [data-folder], [data-file], button, a, input, select, textarea, .tool, .selbox, .menu, .modal-wrap';
  let box = null, sx = 0, sy = 0, active = false, baseSel = null;

  content.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;                              // left button only
    if (e.target.closest(INTERACTIVE)) return;              // started on a real item
    if (!document.querySelector('[data-file]')) return;     // nothing selectable
    e.preventDefault();                                     // avoid native text selection
    sx = e.clientX; sy = e.clientY; active = false;
    baseSel = (e.ctrlKey || e.metaKey || e.shiftKey) ? new Set(sel) : new Set();

    const onMove = (ev) => {
      const dx = Math.abs(ev.clientX - sx), dy = Math.abs(ev.clientY - sy);
      if (!active) { if (dx < 5 && dy < 5) return; active = true; box = document.createElement('div'); box.className = 'marquee'; document.body.appendChild(box); document.body.classList.add('marquee-on'); }
      const l = Math.min(sx, ev.clientX), tp = Math.min(sy, ev.clientY), w = Math.abs(ev.clientX - sx), h = Math.abs(ev.clientY - sy);
      box.style.left = l + 'px'; box.style.top = tp + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px';
      const m = box.getBoundingClientRect();
      sel.clear(); baseSel.forEach((id) => sel.add(id));
      document.querySelectorAll('[data-file]').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (!(r.right < m.left || r.left > m.right || r.bottom < m.top || r.top > m.bottom)) sel.add(el.dataset.file);
      });
      reapplySel();
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('marquee-on');
      if (box) { box.remove(); box = null; }
      if (active) updateBulkBar();
      active = false; baseSel = null;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
})();

boot();

/* start connectivity monitoring */
try { checkConnectivity(); setInterval(checkConnectivity, 30000); } catch (_) {}
