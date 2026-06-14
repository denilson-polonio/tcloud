'use strict';
const TOKEN = decodeURIComponent((location.pathname.match(/\/s\/([^/?#]+)/) || [])[1] || '');
let pw = sessionStorage.getItem('tc_pw_' + TOKEN) || null;
let appName = 'TCloud', logoChar = '☁';
const $ = (s) => document.querySelector(s);
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtSize(b) { if (b == null) return '—'; if (b < 1024) return b + ' B'; const u = ['KB', 'MB', 'GB', 'TB']; let i = -1; do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1); return b.toFixed(b < 10 ? 1 : 0) + ' ' + u[i]; }

/* self-contained i18n for the public page (visitor sees the instance default language) */
const S = {
  it: {
    'Shared content': 'Contenuto condiviso', 'This link is not available.': 'Questo link non è disponibile.',
    'Password required': 'Password richiesta', 'This shared link is protected.': 'Questo link condiviso è protetto.',
    'Enter password': 'Inserisci la password', 'Unlock': 'Sblocca', 'Wrong password.': 'Password errata.',
    'Download': 'Scarica', 'Open': 'Apri', 'Upload to this folder': 'Carica in questa cartella',
    'The owner has enabled a drop-box here.': 'Il proprietario ha abilitato un drop-box qui.', 'Upload files': 'Carica file',
    'This folder is empty.': 'Questa cartella è vuota.', 'Folders': 'Cartelle', 'Files': 'File', 'Folder': 'Cartella',
    'Uploading {n} file(s)…': 'Caricamento di {n} file…', 'Sending to Telegram…': 'Invio a Telegram…', 'Uploaded': 'Caricato',
    'Error': 'Errore', 'Network error': 'Errore di rete', 'Invalid link.': 'Link non valido.',
  },
};
let LANG = 'en';
function t(key, vars) { let s = (S[LANG] && S[LANG][key]) || key; if (vars) for (const k in vars) s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), vars[k]); return s; }

const ICO = {
  folder: '<svg viewBox="0 0 24 24" class="t-folder"><path fill="currentColor" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  image: '<svg viewBox="0 0 24 24" class="t-image" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9" r="1.6"/><path d="m4 17 5-4 4 3 3-2 4 4"/></svg>',
  video: '<svg viewBox="0 0 24 24" class="t-video" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m10 9 5 3-5 3z" fill="currentColor"/></svg>',
  pdf: '<svg viewBox="0 0 24 24" class="t-pdf" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
  file: '<svg viewBox="0 0 24 24" class="t-file" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/></svg>',
};
function icon(name, mime) {
  const ext = (String(name).split('.').pop() || '').toLowerCase(); mime = mime || '';
  if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return ICO.image;
  if (mime.startsWith('video/') || ['mp4', 'mkv', 'mov', 'webm'].includes(ext)) return ICO.video;
  if (ext === 'pdf') return ICO.pdf;
  return ICO.file;
}
function applyAppearance(a) {
  if (!a) return;
  const r = document.documentElement;
  r.classList.toggle('light', a.theme === 'light');
  if (a.accent) r.style.setProperty('--accent', a.accent);
  if (a.bgColor) r.style.setProperty('--bg', a.bgColor);
  if (a.bgColor2) r.style.setProperty('--bg2', a.bgColor2);
  document.body.classList.remove('bg-grid', 'bg-gradient', 'bg-image');
  if (a.bgStyle === 'gradient') document.body.classList.add('bg-gradient');
  else if (a.bgStyle === 'image' && a.bgImage) { document.body.classList.add('bg-image'); document.body.style.backgroundImage = `url("${a.bgImage}")`; }
  else document.body.classList.add('bg-grid');
  appName = a.appName || 'TCloud'; logoChar = a.logo || '☁';
  const want = (a.language || (navigator.language || 'en').slice(0, 2)).toLowerCase();
  if (S[want]) LANG = want;
  document.documentElement.lang = LANG;
  document.title = 'TCloud | ' + (a.mode === 'organization' && a.orgName ? a.orgName : 'Personal');
}

function pwQuery() { return pw ? '?pw=' + encodeURIComponent(pw) : ''; }
function dlUrl(fileId) { return `/api/public/${TOKEN}/download/${fileId}${pwQuery()}`; }
function viewUrl(fileId) { return `/api/public/${TOKEN}/view/${fileId}${pwQuery()}`; }

async function apiGet(folderId) {
  const headers = pw ? { 'X-Share-Password': pw } : {};
  const url = `/api/public/${TOKEN}` + (folderId ? '?folder=' + encodeURIComponent(folderId) : '');
  const res = await fetch(url, { headers });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}
function header() { return `<div class="share-head"><div class="logo">${esc(logoChar)}</div><div><h1>${esc(appName)}</h1><div class="sub">${t('Shared content')}</div></div></div>`; }

async function load(folderId) {
  const root = $('#root');
  const r = await apiGet(folderId);
  $('#boot').classList.add('hidden'); root.classList.remove('hidden');
  if (!r.ok) { if (r.data.needsPassword) return showGate(r.data.error); root.innerHTML = header() + `<div class="msg-box">${esc(r.data.error || t('This link is not available.'))}</div>`; return; }
  const d = r.data; if (d.type === 'file') return renderFile(d); renderFolder(d);
}
function showGate(msg) {
  $('#root').innerHTML = header() + `<div class="gate"><div class="file-hero" style="margin:0"><div class="big">${ICO.file}</div><h2>${t('Password required')}</h2><p class="sub" style="margin:6px 0 0">${t('This shared link is protected.')}</p><input type="password" id="g-pass" placeholder="${t('Enter password')}" /><div class="login-error" id="g-err">${esc(msg && msg !== 'Password required.' ? msg : '')}</div><button class="auth-btn" id="g-go" style="width:100%">${t('Unlock')}</button></div></div>`;
  const go = async () => {
    const val = $('#g-pass').value;
    const res = await fetch(`/api/public/${TOKEN}/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: val }) });
    const data = await res.json();
    if (res.ok && data.ok) { pw = val; sessionStorage.setItem('tc_pw_' + TOKEN, pw); load(); } else $('#g-err').textContent = data.error || t('Wrong password.');
  };
  $('#g-go').onclick = go; $('#g-pass').onkeydown = (e) => { if (e.key === 'Enter') go(); }; $('#g-pass').focus();
}
function renderFile(d) {
  const f = d.file, canDl = d.permission !== 'view';
  $('#root').innerHTML = header() + `<div class="file-hero"><div class="big">${icon(f.name, f.mime)}</div><h2>${esc(f.name)}</h2><div class="meta">${fmtSize(f.size)} · ${esc(f.mime || 'file')}</div>${canDl ? `<a class="auth-btn" style="display:inline-block;text-decoration:none" href="${dlUrl(f.id)}">${t('Download')}</a>` : `<a class="auth-btn" style="display:inline-block;text-decoration:none" href="${viewUrl(f.id)}" target="_blank">${t('Open')}</a>`}</div>`;
}
function renderFolder(d) {
  const canDl = d.permission !== 'view';
  const crumbs = d.path.map((p, i) => `<span class="crumb ${i === d.path.length - 1 ? 'current' : ''}" data-id="${esc(p.id)}">${esc(p.name)}</span>`).join('<span class="crumb-sep">/</span>');
  let html = header() + `<div class="breadcrumb" style="margin-bottom:18px">${crumbs}</div>`;
  if (d.allow_upload) html += `<div class="setting-card" style="display:flex;align-items:center;justify-content:space-between;gap:16px"><div><div class="setting-title">${t('Upload to this folder')}</div><div class="setting-desc">${t('The owner has enabled a drop-box here.')}</div></div><button class="modal-btn primary" id="up-btn">${t('Upload files')}</button></div>`;
  if (!d.folders.length && !d.files.length && !d.upload_only) html += `<div class="msg-box">${t('This folder is empty.')}</div>`;
  if (d.folders.length) { html += `<div class="section-h">${t('Folders')}</div><div class="grid">` + d.folders.map((f) => `<div class="card folder" data-fid="${esc(f.id)}"><div class="card-ico">${ICO.folder}</div><div class="card-name">${esc(f.name)}</div><div class="card-meta">${t('Folder')}</div></div>`).join('') + `</div>`; }
  if (d.files.length) { html += `<div class="section-h">${t('Files')}</div><div class="grid">` + d.files.map((f) => `<div class="card"><div class="card-tools"><a class="tool" title="${canDl ? t('Download') : t('Open')}" href="${canDl ? dlUrl(f.id) : viewUrl(f.id)}" ${canDl ? '' : 'target="_blank"'}><svg viewBox="0 0 24 24" class="ic"><path d="M12 4v10m0 0 4-4m-4 4-4-4M5 19h14"/></svg></a></div><div class="card-ico">${icon(f.name, f.mime)}</div><div class="card-name">${esc(f.name)}</div><div class="card-meta">${fmtSize(f.size)}</div></div>`).join('') + `</div>`; }
  $('#root').innerHTML = html;
  $('#root').querySelectorAll('[data-fid]').forEach((el) => el.onclick = () => load(el.dataset.fid));
  $('#root').querySelectorAll('.breadcrumb .crumb').forEach((el) => el.onclick = () => load(el.dataset.id));
  if (d.allow_upload) { const cur = d.current.id; $('#up-btn').onclick = () => { const fi = $('#file-input'); fi.onchange = () => { uploadTo(cur, fi.files); fi.value = ''; }; fi.click(); }; }
}
function uploadTo(folderId, fileList) {
  const files = Array.from(fileList); if (!files.length) return;
  const fd = new FormData(); files.forEach((f) => fd.append('files', f));
  const toast = $('#toast'); toast.classList.remove('hidden');
  $('#toast-title').textContent = t('Uploading {n} file(s)…', { n: files.length }); $('#toast-sub').textContent = ''; $('#toast-fill').style.width = '0%';
  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/public/${TOKEN}/upload?folder=${encodeURIComponent(folderId)}${pw ? '&pw=' + encodeURIComponent(pw) : ''}`);
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const p = Math.round((e.loaded / e.total) * 100); $('#toast-fill').style.width = p + '%'; if (p >= 100) $('#toast-title').textContent = t('Sending to Telegram…'); } };
  xhr.onload = () => { if (xhr.status >= 200 && xhr.status < 300) { $('#toast-title').textContent = '✅ ' + t('Uploaded'); $('#toast-fill').style.width = '100%'; setTimeout(() => { toast.classList.add('hidden'); load(folderId); }, 1200); } else { let m = t('Error'); try { m = JSON.parse(xhr.responseText).error; } catch (_) {} $('#toast-title').textContent = '❌ ' + m; setTimeout(() => toast.classList.add('hidden'), 4000); } };
  xhr.onerror = () => { $('#toast-title').textContent = '❌ ' + t('Network error'); setTimeout(() => toast.classList.add('hidden'), 4000); };
  xhr.send(fd);
}
(async function () {
  try { applyAppearance(await (await fetch('/api/appearance')).json()); } catch (_) {}
  if (!TOKEN) { $('#boot').classList.add('hidden'); $('#root').classList.remove('hidden'); $('#root').innerHTML = `<div class="msg-box">${t('Invalid link.')}</div>`; return; }
  load();
})();
