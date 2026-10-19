/* =====================================================================
 * 小球脆雷達 — 數據資料庫
 * ① 線索庫（永久封存，公開資料）      data/db/leads-YYYY-MM.json（雷達寫入）
 * ② 客戶名冊  ③ 聯絡紀錄（AES 加密）   data/db/crm.enc.json（控制台寫入）
 * ④ 物件庫＋買賣配對（由①即時計算）
 * ⑤ 長期統計                          data/db/stats.json（雷達寫入）＋②③
 * ===================================================================== */
(function () {
'use strict';

/* ---------------- GitHub／自架伺服器 讀寫 ---------------- */
GitHubAdapter.prototype.getRaw = async function (p) {
  const r = await fetch(`${this.base}/contents/${p}?ref=${encodeURIComponent(this.c.branch || 'main')}&_=${Date.now()}`, {
    cache: 'no-store', headers: { Accept: 'application/vnd.github.raw+json', Authorization: `Bearer ${this.c.token}`, 'X-GitHub-Api-Version': '2022-11-28' } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(r.status);
  return r.json();
};
GitHubAdapter.prototype.getMeta = async function (p) {
  try { const j = await this.req(`/contents/${p}?ref=${encodeURIComponent(this.c.branch || 'main')}&_=${Date.now()}`);
    return { sha: j.sha, data: j.content ? JSON.parse(b64dec(j.content)) : await this.getRaw(p) }; }
  catch (e) { if (String(e.message).startsWith('404')) return null; throw e; }
};
GitHubAdapter.prototype.putJson = async function (p, obj, sha, msg) {
  const j = await this.req(`/contents/${p}`, { method: 'PUT', body: JSON.stringify({ message: msg || '更新資料庫', content: b64enc(JSON.stringify(obj)), sha: sha || undefined, branch: this.c.branch || 'main' }) });
  return j.content.sha;
};
ApiAdapter.prototype.getRaw = function (p) { return this.req('/api/file?path=' + encodeURIComponent(p)).catch((e) => { if (String(e.message) === '404') return null; throw e; }); };
ApiAdapter.prototype.getMeta = async function (p) { const d = await this.getRaw(p); return d ? { sha: null, data: d } : null; };
ApiAdapter.prototype.putJson = async function (p, obj) { await this.req('/api/file?path=' + encodeURIComponent(p), { method: 'PUT', body: JSON.stringify(obj) }); return null; };

/* ---------------- 加密（PBKDF2 → AES-GCM 256） ---------------- */
const enc = new TextEncoder(), dec = new TextDecoder();
const toB64 = (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function deriveKey(pw, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function sealData(key, salt, iter, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct), updatedAt: new Date().toISOString() };
}
async function openData(key, file) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(file.iv) }, key, fromB64(file.ct));
  return JSON.parse(dec.decode(pt));
}

/* ---------------- 狀態 ---------------- */
const CRM_PATH = 'data/db/crm.enc.json';
const DB = window.DB = {
  leads: [], months: [], stats: { days: {} }, loaded: false, loading: null,
  key: null, salt: null, iter: 200000, sha: null, data: null, unlocked: false, exists: null,
  dirty: false, saving: false, saveT: null, sync: '', sub: 'leads', page: { leads: 50, cust: 50, logs: 80, match: 30 },
};
const emptyData = () => ({ v: 1, customers: {}, logs: [], postCrm: {}, updatedAt: Date.now() });
const STATUS_RANK = { 未聯絡: 0, 不需聯絡: 0, 已私訊: 1, 已回覆: 2, 成交: 3 };
const LOG_TYPES = ['私訊', '回覆', '電話', '看店', '報價', '成交', '備註'];
const SERVICES = ['尋點頂讓', '創業諮詢', '設備收購', '拆除清運', '清潔打掃', '整場規劃', '木作裝潢', '水電裝配', '招牌施工', '南北貨運', '資訊通勤', '加盟推薦', '維修服務'];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const fmtT = (x) => { const t = typeof x === 'number' ? x : Date.parse(x); return t ? new Date(t).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : ''; };
const fmtFull = (x) => { const t = typeof x === 'number' ? x : Date.parse(x); return t ? new Date(t).toLocaleString('zh-TW', { hour12: false }) : ''; };
const monthOf = (x) => { const t = typeof x === 'number' ? x : Date.parse(x); return t ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit' }).format(new Date(t)).slice(0, 7) : ''; };

/* ---------------- 合併（多台裝置同時修改） ---------------- */
function merge(a, b) {
  a = a || emptyData(); b = b || emptyData();
  const out = emptyData();
  for (const src of [a, b]) {
    for (const [u, c] of Object.entries(src.customers || {})) { const cur = out.customers[u]; if (!cur || (c.updatedAt || 0) > (cur.updatedAt || 0)) out.customers[u] = c; }
    for (const [u, c] of Object.entries(src.postCrm || {})) { const cur = out.postCrm[u]; if (!cur || (c.at || 0) > (cur.at || 0)) out.postCrm[u] = c; }
  }
  const seen = new Map(); [...(a.logs || []), ...(b.logs || [])].forEach((l) => { const cur = seen.get(l.id); if (!cur || (l.edited || 0) > (cur.edited || 0)) seen.set(l.id, l); });
  out.logs = [...seen.values()].filter((l) => !l.deleted || Date.now() - l.edited < 30 * 864e5).sort((x, y) => y.at - x.at);
  for (const src of [a, b]) for (const u of Object.keys(src.customers || {})) if (src.customers[u] && src.customers[u].deleted && out.customers[u] && out.customers[u].updatedAt <= src.customers[u].updatedAt) out.customers[u] = src.customers[u];
  out.updatedAt = Math.max(a.updatedAt || 0, b.updatedAt || 0);
  return out;
}

/* ---------------- 解鎖／建立／儲存 ---------------- */
async function fetchCrm() { const a = adapter(); if (!a) throw new Error('請先到「連線」設定'); return a.getMeta(CRM_PATH); }
DB.checkExists = async function () { try { const m = await fetchCrm(); DB.exists = !!m; DB._meta = m; } catch (e) { DB.exists = null; } return DB.exists; };
DB.create = async function (pw) {
  if (!pw || pw.length < 6) throw new Error('密碼至少 6 個字');
  const m = await fetchCrm(); if (m) throw new Error('雲端已經有資料庫了，請直接輸入密碼解鎖');
  DB.salt = crypto.getRandomValues(new Uint8Array(16)); DB.key = await deriveKey(pw, DB.salt, DB.iter);
  DB.data = merge(emptyData(), { postCrm: state.crm || {} }); DB.sha = null; DB.unlocked = true; DB.exists = true;
  await DB.save(true);
};
DB.unlock = async function (pw, remember) {
  const m = DB._meta && DB._meta.data ? DB._meta : await fetchCrm();
  if (!m) throw new Error('雲端還沒有資料庫，請先建立密碼');
  const f = m.data; const salt = fromB64(f.salt); const key = await deriveKey(pw, salt, f.iter || 200000);
  let data; try { data = await openData(key, f); } catch { throw new Error('密碼錯誤'); }
  DB.key = key; DB.salt = salt; DB.iter = f.iter || 200000; DB.sha = m.sha; DB.unlocked = true; DB._meta = null;
  DB.data = merge(data, { postCrm: state.crm || {} });
  state.crm = { ...(state.crm || {}), ...DB.data.postCrm }; LS.set('crm', state.crm);
  if (remember) LS.set('dbPw', btoa(unescape(encodeURIComponent(pw)))); else LS.set('dbPw', null);
  renderList(); renderSummary();
  if (JSON.stringify(Object.keys(data.postCrm || {}).length) !== JSON.stringify(Object.keys(DB.data.postCrm).length)) DB.markDirty();
};
DB.lock = function () { DB.key = null; DB.data = null; DB.unlocked = false; LS.set('dbPw', null); DB.render(); };
DB.markDirty = function () { if (!DB.unlocked) return; DB.dirty = true; DB.data.updatedAt = Date.now(); DB.sync = '⏳ 等待同步…'; DB.renderSync(); clearTimeout(DB.saveT); DB.saveT = setTimeout(() => DB.save(), 2000); };
DB.save = async function (force) {
  if (!DB.unlocked || (!DB.dirty && !force)) return; if (DB.saving) { clearTimeout(DB.saveT); DB.saveT = setTimeout(() => DB.save(force), 1500); return; }
  const a = adapter(); if (!a) return; DB.saving = true; DB.sync = '☁️ 同步中…'; DB.renderSync();
  try {
    for (let tries = 0; tries < 3; tries++) {
      try {
        const file = await sealData(DB.key, DB.salt, DB.iter, DB.data);
        DB.sha = await a.putJson(CRM_PATH, file, DB.sha, '更新客戶資料（加密）');
        DB.dirty = false; DB.sync = '✅ 已同步 ' + fmtT(Date.now()); break;
      } catch (e) {
        if (!/409|422|does not match/.test(String(e.message)) || tries === 2) throw e;
        const m = await fetchCrm(); if (m) { const other = await openData(DB.key, m.data); DB.data = merge(other, DB.data); DB.sha = m.sha; }
      }
    }
  } catch (e) { DB.sync = '⚠️ 同步失敗，稍後重試（' + e.message + '）'; clearTimeout(DB.saveT); DB.saveT = setTimeout(() => DB.save(), 15000); }
  finally { DB.saving = false; DB.renderSync(); }
};
DB.pull = async function () { // 從雲端拉最新的（換裝置修改後）
  if (!DB.unlocked || DB.dirty || DB.saving) return;
  try { const m = await fetchCrm(); if (m && m.sha !== DB.sha) { const other = await openData(DB.key, m.data); DB.data = merge(DB.data, other); DB.sha = m.sha; state.crm = { ...state.crm, ...DB.data.postCrm }; LS.set('crm', state.crm); renderList(); DB.render(); } } catch { /* 略過 */ }
};
DB.changePassword = async function (oldPw, newPw) {
  if (!DB.unlocked) throw new Error('請先解鎖'); if (!newPw || newPw.length < 6) throw new Error('新密碼至少 6 個字');
  const f = await fetchCrm(); try { await openData(await deriveKey(oldPw, fromB64(f.data.salt), f.data.iter || 200000), f.data); } catch { throw new Error('舊密碼錯誤'); }
  DB.salt = crypto.getRandomValues(new Uint8Array(16)); DB.key = await deriveKey(newPw, DB.salt, DB.iter); DB.sha = f.sha;
  if (LS.get('dbPw', null)) LS.set('dbPw', btoa(unescape(encodeURIComponent(newPw))));
  await DB.save(true);
};

/* ---------------- 讀取線索庫＋統計 ---------------- */
DB.load = async function (force) {
  if (DB.loading) return DB.loading; if (DB.loaded && !force) return;
  DB.loading = (async () => {
    const a = adapter(); const map = new Map();
    const cur = (state.doc && (state.doc._all || state.doc.posts)) || [];
    if (a) {
      try {
        const idx = await a.getRaw('data/db/index.json'); DB.months = (idx && idx.months) || [];
        const files = await Promise.all(DB.months.map((m) => a.getRaw(`data/db/leads-${m}.json`).catch(() => [])));
        files.forEach((list) => (list || []).forEach((p) => map.set(p.url, p)));
        DB.stats = (await a.getRaw('data/db/stats.json')) || { days: {} };
      } catch (e) { toast('讀取資料庫失敗：' + e.message); }
    }
    cur.forEach((p) => { if (!map.has(p.url)) map.set(p.url, p); else map.set(p.url, { ...map.get(p.url), ...p }); });
    DB.leads = [...map.values()].sort((x, y) => (Date.parse(y.foundAt || y.time) || 0) - (Date.parse(x.foundAt || x.time) || 0));
    DB.loaded = true; DB.loading = null;
  })();
  return DB.loading;
};

/* ---------------- 客戶／紀錄 操作 ---------------- */
const postsOf = (u) => DB.leads.filter((p) => normUser(p.user) === u);
function ensureCustomer(u) {
  const c = DB.data.customers[u];
  if (c && !c.deleted) return c;
  const ps = postsOf(u); const info = {}; ps.forEach((p) => { const i = an(p).info; info.phone = info.phone || i.phone; info.line = info.line || i.line; info.city = info.city || [i.city, i.district].filter(Boolean).join(' '); info.shop = info.shop || i.shop; });
  return (DB.data.customers[u] = { user: u, name: '', phone: info.phone || '', line: info.line || '', area: info.city || '', shop: info.shop || '', note: '', next: '', status: '未聯絡', temp: '', dealAmount: '', dealService: '', dealAt: '', createdAt: Date.now(), updatedAt: Date.now() });
}
function addLog(u, type, note, url) { DB.data.logs.unshift({ id: uid(), user: u, url: url || '', at: Date.now(), type, note: note || '' }); }
// 線索卡片上的狀態／冷溫熱 → 同步進客戶資料
const _setCrm = setCrm;
setCrm = function (u, patch) {
  const before = crm(u).s; _setCrm(u, patch);
  if (!DB.unlocked) return;
  DB.data.postCrm[u] = state.crm[u];
  const p = (DB.leads.length ? DB.leads : (state.doc && state.doc._all) || []).find((x) => x.url === u) || ((state.doc && state.doc.posts) || []).find((x) => x.url === u);
  if (p) {
    const user = normUser(p.user); const c = ensureCustomer(user);
    if (patch.s && patch.s !== before) {
      if ((STATUS_RANK[patch.s] || 0) >= (STATUS_RANK[c.status] || 0) || patch.s === '不需聯絡') c.status = patch.s;
      if (patch.s === '成交' && !c.dealAt) c.dealAt = Date.now();
      addLog(user, patch.s === '成交' ? '成交' : patch.s === '已回覆' ? '回覆' : patch.s === '已私訊' ? '私訊' : '備註', `狀態：${before} → ${patch.s}`, u);
    }
    if ('t' in patch) c.temp = patch.t || '';
    c.updatedAt = Date.now();
  }
  DB.markDirty();
};

/* ---------------- 物件配對 ---------------- */
function wan(s) {
  if (!s) return null; s = String(s).replace(/,/g, '');
  let m = s.match(/(\d+(?:\.\d+)?)\s*萬/); if (m) return +m[1];
  m = s.match(/(\d+(?:\.\d+)?)\s*[kK]/); if (m) return +m[1] / 10;
  m = s.match(/(\d{4,})/); if (m) return +m[1] / 10000;
  return null;
}
function listingOf(p) { const a = an(p); const i = a.info; return { p, a, city: i.city, district: i.district, shop: i.shop, price: wan(i.price), priceText: i.price, area: i.area, rent: i.rent }; }
function matchScore(b, l) {
  let s = 0; const why = [];
  if (b.city && l.city) { if (b.city === l.city) { s += 3; why.push('同縣市'); } else return null; }
  if (b.district && l.district && b.district === l.district) { s += 2; why.push('同區'); }
  if (b.shop && l.shop && b.shop === l.shop) { s += 2; why.push('同店型'); }
  if (b.price && l.price) { if (l.price <= b.price * 1.15) { s += 3; why.push('在預算內'); } else if (l.price <= b.price * 1.4) { s += 1; why.push('略超預算'); } else s -= 2; }
  return s >= 3 ? { s, why } : null;
}
DB.matches = function () {
  const buyers = [], listings = [];
  for (const p of DB.leads) { const a = an(p); if (a.role === '買方') buyers.push(listingOf(p)); else if (a.role === '賣方' && (a.cat === '頂讓' || a.cat === '收店' || (a.info.shop && a.cat !== '設備'))) listings.push(listingOf(p)); }
  const pairs = [];
  for (const b of buyers) for (const l of listings) { if (normUser(b.p.user) === normUser(l.p.user)) continue; const m = matchScore(b, l); if (m) pairs.push({ b, l, ...m }); }
  pairs.sort((x, y) => y.s - x.s);
  return { buyers, listings, pairs };
};

/* ---------------- 匯出 ---------------- */
function dl(name, head, rows) {
  const cell = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""').replace(/\s+/g, ' ') + '"';
  const csv = '﻿' + [head, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `脆雷達_${name}_${today().replace(/-/g, '')}.csv`; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000); toast(`📥 已匯出「${name}」${rows.length} 筆`);
}
function dlJson(name, obj) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  a.download = `脆雷達_${name}_${today().replace(/-/g, '')}.json`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const leadRow = (p) => { const a = an(p), i = a.info, c = crm(p.url); return [fmtFull(p.foundAt), fmtFull(p.time), '@' + p.user, a.intent.level, a.intent.reasons.join('、'), a.role, a.cat, c.s, c.t || '', (p.keywords || []).join('、'), [i.city, i.district].filter(Boolean).join(' '), i.shop, i.price, i.area, i.rent, i.phone, i.line, (i.equip || []).join('、'), p.text, p.url, p.authorUrl]; };
const LEAD_HEAD = ['發現時間', '發文時間', '帳號', '意向', '意向理由', '角色', '類型', '聯絡狀態', '冷溫熱', '關鍵字', '地區', '店型', '價格', '坪數', '租金', '電話', 'LINE', '設備', '內容', '貼文連結', '發文者主頁'];
DB.exportLeads = (list) => dl('線索庫', LEAD_HEAD, (list || DB.leads).map(leadRow));
DB.exportCustomers = () => dl('客戶名冊', ['帳號', '稱呼', '狀態', '冷溫熱', '電話', 'LINE', '地區', '店型', '下次跟進', '成交金額(萬)', '成交服務', '成交日', '貼文數', '紀錄數', '備註', '建立', '更新'],
  custList().map((c) => [c.user, c.name, c.status, c.temp, c.phone, c.line, c.area, c.shop, c.next, c.dealAmount, c.dealService, c.dealAt ? fmtFull(c.dealAt) : '', postsOf(c.user).length, DB.data.logs.filter((l) => l.user === c.user && !l.deleted).length, c.note, fmtFull(c.createdAt), fmtFull(c.updatedAt)]));
DB.exportLogs = () => dl('聯絡紀錄', ['時間', '帳號', '類型', '內容', '貼文連結'], DB.data.logs.filter((l) => !l.deleted).map((l) => [fmtFull(l.at), l.user, l.type, l.note, l.url]));
DB.exportListings = () => { const { listings } = DB.matches(); dl('物件庫', ['發現時間', '帳號', '類型', '地區', '店型', '價格', '價格(萬)', '坪數', '租金', '電話', 'LINE', '內容', '連結'], listings.map((l) => [fmtFull(l.p.foundAt), '@' + l.p.user, l.a.cat, [l.city, l.district].filter(Boolean).join(' '), l.shop, l.priceText, l.price ?? '', l.area, l.rent, l.a.info.phone, l.a.info.line, l.p.text, l.p.url])); };
DB.exportMatches = () => { const { pairs } = DB.matches(); dl('買賣配對', ['配對分數', '原因', '買方帳號', '買方需求', '買方預算(萬)', '物件帳號', '物件地區', '物件店型', '物件價格(萬)', '物件內容', '買方連結', '物件連結'], pairs.map((x) => [x.s, x.why.join('、'), '@' + x.b.p.user, x.b.p.text, x.b.price ?? '', '@' + x.l.p.user, [x.l.city, x.l.district].filter(Boolean).join(' '), x.l.shop, x.l.price ?? '', x.l.p.text, x.b.p.url, x.l.p.url])); };
DB.exportDaily = () => dl('每日統計', ['日期', '掃描次數', '掃到貼文', '新線索', '高意向', '買方'], Object.entries(DB.stats.days || {}).sort().map(([d, v]) => [d, v.scans, v.scanned, v.leads, v.high, v.buyers]));
DB.exportMonthly = () => dl('每月統計', ['月份', '線索', '高意向', '買方', '已聯絡', '成交', '成交金額(萬)', '掃描次數'], monthly().map((m) => [m.m, m.leads, m.high, m.buyers, m.contacted, m.deals, m.amount, m.scans]));
DB.exportBackup = () => dlJson('完整備份', { app: 'threads-radar', exportedAt: new Date().toISOString(), config: state.cfg, leads: DB.leads, stats: DB.stats, crm: DB.unlocked ? DB.data : null });

/* ---------------- 統計 ---------------- */
function custList() { return Object.values((DB.data && DB.data.customers) || {}).filter((c) => !c.deleted).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); }
function monthly() {
  const M = {}; const g = (m) => (M[m] = M[m] || { m, leads: 0, high: 0, buyers: 0, contacted: 0, deals: 0, amount: 0, scans: 0 });
  DB.leads.forEach((p) => { const m = monthOf(p.foundAt || p.time); if (!m) return; const a = an(p); const x = g(m); x.leads++; if (a.intent.level === '高') x.high++; if (a.role === '買方') x.buyers++; });
  Object.entries(state.crm || {}).forEach(([, c]) => { if (['已私訊', '已回覆', '成交'].includes(c.s) && c.at) g(monthOf(c.at)).contacted++; });
  custList().forEach((c) => { if (c.status === '成交' && c.dealAt) { const x = g(monthOf(c.dealAt)); x.deals++; x.amount += +c.dealAmount || 0; } });
  Object.entries(DB.stats.days || {}).forEach(([d, v]) => { g(d.slice(0, 7)).scans += v.scans || 0; });
  return Object.values(M).sort((a, b) => b.m.localeCompare(a.m));
}

/* ---------------- 畫面 ---------------- */
const $$ = (sel) => document.querySelector(sel);
DB.renderSync = function () { const el = $$('#dbSync'); if (el) el.textContent = DB.unlocked ? DB.sync || '✅ 已解鎖' : ''; };
function lockPane() {
  if (DB.unlocked) return `<div class="dbbar"><span>🔓 客戶資料已解鎖</span><span id="dbSync" class="hint" style="margin:0">${esc(DB.sync || '✅ 已同步')}</span><button class="btn ghost sm" data-db="lock">🔒 上鎖</button></div>`;
  if (DB.exists === false) return `<div class="card"><h3>🔐 建立客戶資料庫密碼</h3>
    <p class="hint">客戶名冊和聯絡紀錄會用這組密碼<b>加密</b>後存到 GitHub，別人只會看到亂碼。換手機或平板時，輸入同一組密碼就能看到。<br><b style="color:var(--warn)">⚠️ 密碼忘記就無法救回資料，請記在安全的地方。</b></p>
    <div class="grid2"><div class="field"><label>設定密碼（至少 6 個字）</label><input type="password" id="dbPw1" autocomplete="new-password"></div>
    <div class="field"><label>再輸入一次</label><input type="password" id="dbPw2" autocomplete="new-password"></div></div>
    <label class="switch"><span>在這台裝置記住密碼（下次自動解鎖）</span><input type="checkbox" class="tg" id="dbRemember" checked></label>
    <button class="btn" style="width:100%;margin-top:10px" data-db="create">建立並加密</button></div>`;
  return `<div class="card"><h3>🔒 輸入密碼解鎖客戶資料</h3>
    <p class="hint">「線索庫、物件配對、統計」不用密碼就能看；「客戶名冊、聯絡紀錄」需要解鎖。</p>
    <div class="field"><label>資料庫密碼</label><input type="password" id="dbPw" autocomplete="current-password"></div>
    <label class="switch"><span>在這台裝置記住密碼（下次自動解鎖）</span><input type="checkbox" class="tg" id="dbRemember" checked></label>
    <button class="btn" style="width:100%;margin-top:10px" data-db="unlock">解鎖</button>
    ${DB.exists === null ? '<p class="hint">（正在確認雲端資料庫…）</p>' : ''}</div>`;
}
const SUBS = [['leads', '📚 線索庫'], ['cust', '👥 客戶'], ['logs', '🗒 聯絡紀錄'], ['match', '🤝 物件配對'], ['stats', '📈 統計'], ['backup', '💾 備份']];
DB.render = function () {
  const root = $$('#dbRoot'); if (!root) return;
  const due = DB.unlocked ? custList().filter((c) => c.next && c.next <= today() && c.status !== '成交' && c.status !== '不需聯絡') : [];
  root.innerHTML = `${lockPane()}
    ${due.length ? `<div class="card" style="border-color:var(--warn)"><h3>⏰ 今日待跟進（${due.length}）</h3>${due.slice(0, 8).map((c) => `<div class="dbrow" data-cust="${esc(c.user)}"><b>@${esc(c.user)}</b> <span class="tag">${esc(c.status)}</span> <span class="hint" style="margin:0">${esc(c.next)}${c.note ? '・' + esc(c.note.slice(0, 30)) : ''}</span></div>`).join('')}</div>` : ''}
    <div class="chips" style="margin-bottom:12px">${SUBS.map(([k, l]) => `<button class="chip ${DB.sub === k ? 'on' : ''}" data-dbsub="${k}">${l}</button>`).join('')}</div>
    <div id="dbPane"></div>`;
  renderPane();
};
function needUnlock() { return `<div class="empty">🔒 這部分是加密的客戶資料，請先在上方輸入密碼解鎖</div>`; }
function renderPane() {
  const el = $$('#dbPane'); if (!el) return;
  if (!DB.loaded) { el.innerHTML = `<div class="empty">📚 讀取資料庫中…</div>`; DB.load().then(renderPane); return; }
  const q = (DB.q || '').toLowerCase();
  if (DB.sub === 'leads') {
    const months = [...new Set(DB.leads.map((p) => monthOf(p.foundAt || p.time)))].filter(Boolean).sort().reverse();
    const list = DB.leads.filter((p) => { const a = an(p); if (DB.fm && monthOf(p.foundAt || p.time) !== DB.fm) return false; if (DB.fr && a.role !== DB.fr) return false; if (DB.fi && a.intent.level !== DB.fi) return false; return !q || `${p.text} ${p.user}`.toLowerCase().includes(q); });
    el.innerHTML = `<div class="card"><div class="dbhead"><h3 style="margin:0">📚 線索庫（${list.length} / 共 ${DB.leads.length} 則）</h3><button class="btn sm" data-db="xleads">📥 匯出</button></div>
      <input class="search" id="dbQ" placeholder="搜尋內容、帳號、電話…" value="${esc(DB.q || '')}" style="width:100%;margin:10px 0">
      <div class="filters" style="grid-template-columns:repeat(3,1fr)"><select id="dbFm"><option value="">全部月份</option>${months.map((m) => `<option ${DB.fm === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
      <select id="dbFr"><option value="">全部角色</option>${['賣方', '買方', '同業'].map((r) => `<option ${DB.fr === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
      <select id="dbFi"><option value="">全部意向</option>${['高', '中', '低'].map((r) => `<option ${DB.fi === r ? 'selected' : ''} value="${r}">${r}意向</option>`).join('')}</select></div>
      ${list.slice(0, DB.page.leads).map((p) => { const a = an(p), i = a.info; return `<div class="dbrow" data-cust="${esc(normUser(p.user))}">
        <div><span class="hint" style="margin:0">${fmtT(p.foundAt || p.time)}</span> <span class="ipill ${a.intent.level}">${a.intent.level}</span> <span class="rtag ${a.role}">${a.role}</span> <b>@${esc(p.user)}</b> <span class="tag">${esc(crm(p.url).s)}</span></div>
        <div class="hint" style="margin:4px 0 0">${esc([[i.city, i.district].filter(Boolean).join(''), i.shop, i.price, i.area, i.phone].filter(Boolean).join('・'))}</div>
        <div class="dbtxt">${esc((p.text || '').slice(0, 90))}</div></div>`; }).join('') || '<div class="empty">沒有資料</div>'}
      ${list.length > DB.page.leads ? `<button class="btn ghost sm" style="width:100%" data-db="more" data-k="leads">顯示更多（還有 ${list.length - DB.page.leads} 則）</button>` : ''}</div>`;
    DB._leadList = list; bindFilters(); return;
  }
  if (DB.sub === 'match') {
    const { buyers, listings, pairs } = DB.matches();
    el.innerHTML = `<div class="card"><div class="dbhead"><h3 style="margin:0">🤝 買賣配對（${pairs.length} 組）</h3><span><button class="btn sm" data-db="xmatch">📥 匯出配對</button> <button class="btn ghost sm" data-db="xlist">📥 匯出物件庫</button></span></div>
      <p class="hint">物件 ${listings.length} 筆（賣方頂讓／收店）・買方 ${buyers.length} 位（找店的人）。配對依據：同縣市、同區、同店型、價格在預算內。</p>
      ${pairs.slice(0, DB.page.match).map((x) => `<div class="dbrow match">
        <div><span class="ipill 高">${x.s} 分</span> <span class="hint" style="margin:0">${esc(x.why.join('、'))}</span></div>
        <div class="mrow"><span class="rtag 買方">買方</span> <b data-cust="${esc(normUser(x.b.p.user))}">@${esc(x.b.p.user)}</b> <span class="dbtxt">${esc(x.b.p.text.slice(0, 60))}</span></div>
        <div class="mrow"><span class="rtag 賣方">物件</span> <b data-cust="${esc(normUser(x.l.p.user))}">@${esc(x.l.p.user)}</b> <span class="dbtxt">${esc([[x.l.city, x.l.district].filter(Boolean).join(''), x.l.shop, x.l.priceText, x.l.area].filter(Boolean).join('・'))}</span></div>
        <div class="acts" style="margin-top:6px"><a class="btn ghost sm" href="${esc(x.b.p.url)}" target="_blank">開啟買方貼文</a><a class="btn ghost sm" href="${esc(x.l.p.url)}" target="_blank">開啟物件貼文</a></div></div>`).join('') || '<div class="empty">目前還沒有配對成功的組合。線索累積越多，配對越多。</div>'}
      ${pairs.length > DB.page.match ? `<button class="btn ghost sm" style="width:100%" data-db="more" data-k="match">顯示更多</button>` : ''}</div>`;
    return;
  }
  if (DB.sub === 'stats') {
    const ms = monthly(); const cl = DB.unlocked ? custList() : [];
    const deals = cl.filter((c) => c.status === '成交'); const amt = deals.reduce((s, c) => s + (+c.dealAmount || 0), 0);
    const contacted = Object.values(state.crm || {}).filter((c) => ['已私訊', '已回覆', '成交'].includes(c.s)).length;
    const days = []; const vals = []; for (let i = 29; i >= 0; i--) { const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - i * 864e5)); days.push(+d.slice(8)); vals.push((DB.stats.days[d] || {}).leads || DB.leads.filter((p) => (p.foundAt || '').startsWith(d)).length); }
    el.innerHTML = `<div class="card"><h3>📈 長期統計</h3><div class="kpis">
      ${[[DB.leads.length, '累計線索'], [ms.length, '涵蓋月份'], [DB.leads.filter((p) => an(p).intent.level === '高').length, '累計高意向'], [DB.leads.filter((p) => an(p).role === '買方').length, '累計買方'],
         [contacted, '已聯絡'], [DB.unlocked ? cl.length : '🔒', '客戶數'], [DB.unlocked ? deals.length : '🔒', '成交數'], [DB.unlocked ? amt.toLocaleString() : '🔒', '成交金額（萬）']].map(([v, l]) => `<div class="kpi"><b>${v}</b><small>${l}</small></div>`).join('')}</div></div>
      <div class="card"><div class="dbhead"><h3 style="margin:0">近 30 天新線索</h3><button class="btn sm" data-db="xdaily">📥 匯出每日</button></div><div class="chartbox" style="margin-top:10px"><div id="dbDaily" class="svgc"></div></div></div>
      <div class="card"><div class="dbhead"><h3 style="margin:0">每月統計</h3><button class="btn sm" data-db="xmonthly">📥 匯出每月</button></div><div class="mwrap" style="margin-top:10px"><table class="matrix"><tr><th>月份</th><th>線索</th><th>高意向</th><th>買方</th><th>已聯絡</th><th>成交</th><th>金額(萬)</th><th>掃描</th></tr>
      ${ms.map((m) => `<tr><th>${m.m}</th><td>${m.leads}</td><td>${m.high}</td><td>${m.buyers}</td><td>${m.contacted}</td><td>${DB.unlocked ? m.deals : '🔒'}</td><td>${DB.unlocked ? m.amount : '🔒'}</td><td>${m.scans}</td></tr>`).join('') || '<tr><td>尚無資料</td></tr>'}</table></div></div>`;
    svgBar('dbDaily', days.map(String), vals, { highlight: (i) => i === 29, every: 3 }); return;
  }
  if (DB.sub === 'backup') {
    el.innerHTML = `<div class="card"><h3>💾 備份與還原</h3>
      <button class="btn" style="width:100%" data-db="xbackup">📦 下載完整備份（線索＋統計＋設定${DB.unlocked ? '＋客戶資料' : ''}）</button>
      <p class="hint">${DB.unlocked ? '⚠️ 完整備份裡的客戶資料是<b>未加密</b>的，請妥善保管。' : '🔒 解鎖後下載，備份才會包含客戶資料。'}</p>
      <div class="field" style="margin-top:12px"><label>從備份還原客戶資料（會與現有資料合併，不會覆蓋）</label><input type="file" id="dbRestore" accept=".json,application/json"></div>
      <p class="hint">所有匯出的 CSV 檔都可以用 Excel、Google 試算表打開。</p></div>
      ${DB.unlocked ? `<div class="card"><h3>🔑 變更資料庫密碼</h3><div class="grid2"><div class="field"><label>舊密碼</label><input type="password" id="dbOld"></div><div class="field"><label>新密碼（至少 6 個字）</label><input type="password" id="dbNew"></div></div><button class="btn ghost" style="width:100%" data-db="chpw">變更密碼</button></div>` : ''}`;
    const f = $$('#dbRestore'); if (f) f.onchange = restoreFile; return;
  }
  if (!DB.unlocked) { el.innerHTML = needUnlock(); return; }
  if (DB.sub === 'cust') {
    const list = custList().filter((c) => !q || `${c.user} ${c.name} ${c.phone} ${c.line} ${c.note} ${c.area} ${c.shop}`.toLowerCase().includes(q));
    el.innerHTML = `<div class="card"><div class="dbhead"><h3 style="margin:0">👥 客戶名冊（${list.length}）</h3><span><button class="btn ghost sm" data-db="newcust">＋ 新增</button> <button class="btn sm" data-db="xcust">📥 匯出</button></span></div>
      <input class="search" id="dbQ" placeholder="搜尋帳號、稱呼、電話、備註…" value="${esc(DB.q || '')}" style="width:100%;margin:10px 0">
      ${list.slice(0, DB.page.cust).map((c) => `<div class="dbrow" data-cust="${esc(c.user)}">
        <div><b>@${esc(c.user)}</b>${c.name ? ' ' + esc(c.name) : ''} <span class="tag">${esc(c.status)}</span>${c.temp ? ` <span class="tag">${c.temp === '熱' ? '🔥' : c.temp === '溫' ? '🌤' : '❄️'} ${c.temp}</span>` : ''}${c.next ? ` <span class="tag" style="${c.next <= today() ? 'color:var(--warn);border-color:var(--warn)' : ''}">⏰ ${esc(c.next)}</span>` : ''}</div>
        <div class="hint" style="margin:4px 0 0">${esc([c.phone, c.line && 'LINE ' + c.line, c.area, c.shop, c.status === '成交' && c.dealAmount ? `成交 ${c.dealAmount} 萬` : ''].filter(Boolean).join('・'))}・貼文 ${postsOf(c.user).length}・更新 ${fmtT(c.updatedAt)}</div>
        ${c.note ? `<div class="dbtxt">📝 ${esc(c.note.slice(0, 80))}</div>` : ''}</div>`).join('') || '<div class="empty">還沒有客戶。在線索卡片上改聯絡狀態，或按「📇 客戶」就會自動建立。</div>'}
      ${list.length > DB.page.cust ? `<button class="btn ghost sm" style="width:100%" data-db="more" data-k="cust">顯示更多</button>` : ''}</div>`;
    bindFilters(); return;
  }
  if (DB.sub === 'logs') {
    const list = DB.data.logs.filter((l) => !l.deleted && (!DB.lt || l.type === DB.lt) && (!q || `${l.user} ${l.note} ${l.type}`.toLowerCase().includes(q)));
    el.innerHTML = `<div class="card"><div class="dbhead"><h3 style="margin:0">🗒 聯絡紀錄（${list.length}）</h3><button class="btn sm" data-db="xlogs">📥 匯出</button></div>
      <div class="filters" style="grid-template-columns:2fr 1fr;margin-top:10px"><input class="search" id="dbQ" placeholder="搜尋帳號、內容…" value="${esc(DB.q || '')}">
      <select id="dbLt"><option value="">全部類型</option>${LOG_TYPES.map((t) => `<option ${DB.lt === t ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      ${list.slice(0, DB.page.logs).map((l) => `<div class="dbrow" data-cust="${esc(l.user)}"><div><span class="hint" style="margin:0">${fmtT(l.at)}</span> <span class="tag">${esc(l.type)}</span> <b>@${esc(l.user)}</b></div>${l.note ? `<div class="dbtxt">${esc(l.note)}</div>` : ''}</div>`).join('') || '<div class="empty">還沒有聯絡紀錄</div>'}
      ${list.length > DB.page.logs ? `<button class="btn ghost sm" style="width:100%" data-db="more" data-k="logs">顯示更多</button>` : ''}</div>`;
    bindFilters();
  }
}
function bindFilters() {
  const qi = $$('#dbQ'); if (qi) { qi.oninput = () => { DB.q = qi.value; clearTimeout(DB.qT); DB.qT = setTimeout(() => { const pos = qi.selectionStart; renderPane(); const n = $$('#dbQ'); if (n) { n.focus(); n.setSelectionRange(pos, pos); } }, 300); }; }
  [['#dbFm', 'fm'], ['#dbFr', 'fr'], ['#dbFi', 'fi'], ['#dbLt', 'lt']].forEach(([s, k]) => { const e = $$(s); if (e) e.onchange = () => { DB[k] = e.value; renderPane(); }; });
}
async function restoreFile(e) {
  const f = e.target.files[0]; if (!f) return;
  try { const j = JSON.parse(await f.text()); const c = j.crm || (j.customers ? j : null); if (!c) throw new Error('檔案裡沒有客戶資料');
    if (!DB.unlocked) throw new Error('請先解鎖'); DB.data = merge(DB.data, c); state.crm = { ...state.crm, ...DB.data.postCrm }; LS.set('crm', state.crm); DB.markDirty(); DB.render(); toast('✅ 已合併還原客戶資料'); }
  catch (err) { toast('還原失敗：' + err.message); }
}

/* ---------------- 客戶詳細視窗 ---------------- */
DB.openCustomer = async function (u) {
  u = normUser(u); if (!u) return;
  if (!DB.unlocked) { showTab('db'); DB.open(); toast('🔒 請先解鎖客戶資料'); return; }
  await DB.load(); const c = ensureCustomer(u);
  const ps = postsOf(u); const logs = DB.data.logs.filter((l) => l.user === u && !l.deleted);
  const m = document.createElement('div'); m.id = 'custModal';
  m.innerHTML = `<div class="card cm">
    <div class="dbhead"><h3 style="margin:0">📇 @${esc(u)}</h3><button class="btn ghost sm" data-cm="close">✕</button></div>
    <div class="grid2" style="margin-top:10px">
      <div class="field"><label>稱呼</label><input id="cmName" value="${esc(c.name)}" placeholder="例：陳小姐"></div>
      <div class="field"><label>狀態</label><select id="cmStatus">${['未聯絡', '已私訊', '已回覆', '成交', '不需聯絡'].map((s) => `<option ${c.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="field"><label>電話</label><input id="cmPhone" value="${esc(c.phone)}" inputmode="tel"></div>
      <div class="field"><label>LINE</label><input id="cmLine" value="${esc(c.line)}" autocapitalize="off"></div>
      <div class="field"><label>地區</label><input id="cmArea" value="${esc(c.area)}"></div>
      <div class="field"><label>店型</label><input id="cmShop" value="${esc(c.shop)}"></div>
      <div class="field"><label>冷溫熱</label><select id="cmTemp"><option value="">未設定</option>${['冷', '溫', '熱'].map((s) => `<option ${c.temp === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div class="field"><label>⏰ 下次跟進日期</label><input type="date" id="cmNext" value="${esc(c.next)}"></div>
      <div class="field"><label>成交金額（萬）</label><input type="number" id="cmAmt" value="${esc(c.dealAmount)}"></div>
      <div class="field"><label>成交服務</label><select id="cmSvc"><option value="">—</option>${SERVICES.map((s) => `<option ${c.dealService === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label>📝 備註</label><textarea id="cmNote" rows="3" class="cmta">${esc(c.note)}</textarea></div>
    <div class="grid2"><button class="btn" data-cm="save">💾 儲存</button><button class="btn ghost" data-cm="del">🗑 刪除客戶</button></div>
    <h3 style="margin-top:18px">➕ 新增聯絡紀錄</h3>
    <div class="filters" style="grid-template-columns:1fr 3fr"><select id="cmLt">${LOG_TYPES.map((t) => `<option>${t}</option>`).join('')}</select><input class="search" id="cmLn" placeholder="例：約週五下午看店"></div>
    <button class="btn ghost sm" style="width:100%" data-cm="addlog">新增紀錄</button>
    <h3 style="margin-top:18px">🗒 聯絡紀錄（${logs.length}）</h3>
    ${logs.map((l) => `<div class="dbrow"><span class="hint" style="margin:0">${fmtT(l.at)}</span> <span class="tag">${esc(l.type)}</span> ${esc(l.note)} <button class="btn ghost sm" style="float:right;padding:2px 8px" data-cm="dellog" data-id="${l.id}">✕</button></div>`).join('') || '<p class="hint">還沒有紀錄</p>'}
    <h3 style="margin-top:18px">📄 這個帳號的貼文（${ps.length}）</h3>
    ${ps.map((p) => `<div class="dbrow"><span class="hint" style="margin:0">${fmtT(p.foundAt || p.time)}</span> <span class="tag">${esc(crm(p.url).s)}</span><div class="dbtxt">${esc((p.text || '').slice(0, 120))}</div><div class="acts" style="margin-top:6px"><a class="btn ghost sm" href="${esc(p.url)}" target="_blank">開啟貼文</a><button class="btn ghost sm" data-reply="${esc(p.url)}">✍️ 產生回覆</button></div></div>`).join('') || '<p class="hint">資料庫裡沒有這個帳號的貼文</p>'}
  </div>`;
  document.body.appendChild(m); document.body.style.overflow = 'hidden';
  m.addEventListener('click', (e) => {
    if (e.target === m) return closeCm();
    const b = e.target.closest('[data-cm]'); if (!b) return; const act = b.dataset.cm;
    if (act === 'close') return closeCm();
    if (act === 'save') {
      const prev = c.status;
      Object.assign(c, { name: $$('#cmName').value.trim(), status: $$('#cmStatus').value, phone: $$('#cmPhone').value.trim(), line: $$('#cmLine').value.trim(), area: $$('#cmArea').value.trim(), shop: $$('#cmShop').value.trim(),
        temp: $$('#cmTemp').value, next: $$('#cmNext').value, dealAmount: $$('#cmAmt').value, dealService: $$('#cmSvc').value, note: $$('#cmNote').value, updatedAt: Date.now() });
      if (c.status === '成交' && !c.dealAt) c.dealAt = Date.now();
      if (prev !== c.status) addLog(u, c.status === '成交' ? '成交' : '備註', `狀態：${prev} → ${c.status}`);
      DB.markDirty(); toast('💾 已儲存（加密同步中）'); closeCm(); DB.render(); return;
    }
    if (act === 'del') { if (!confirm(`刪除客戶 @${u}？（聯絡紀錄也會一起隱藏）`)) return; DB.data.customers[u] = { user: u, deleted: true, updatedAt: Date.now() };
      DB.data.logs.forEach((l) => { if (l.user === u) { l.deleted = true; l.edited = Date.now(); } }); DB.markDirty(); closeCm(); DB.render(); toast('已刪除客戶'); return; }
    if (act === 'addlog') { const note = $$('#cmLn').value.trim(); addLog(u, $$('#cmLt').value, note); c.updatedAt = Date.now(); DB.markDirty(); closeCm(); DB.openCustomer(u); toast('已新增紀錄'); return; }
    if (act === 'dellog') { const l = DB.data.logs.find((x) => x.id === b.dataset.id); if (l) { l.deleted = true; l.edited = Date.now(); DB.markDirty(); closeCm(); DB.openCustomer(u); } }
  });
};
function closeCm() { const m = $$('#custModal'); if (m) m.remove(); document.body.style.overflow = ''; }

/* ---------------- 事件 ---------------- */
DB.open = async function () {
  DB.render();
  if (DB.exists === null || DB.exists === undefined) { await DB.checkExists(); DB.render(); }
  if (!DB.loaded) { await DB.load(); DB.render(); }
};
document.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-db],[data-dbsub],[data-cust]'); if (!t) return;
  if (t.closest('#custModal') && !t.dataset.cust) return;
  if (t.dataset.dbsub) { DB.sub = t.dataset.dbsub; DB.q = ''; DB.render(); return; }
  if (t.dataset.cust !== undefined && !t.dataset.db) { if (t.closest('#custModal')) return; DB.openCustomer(t.dataset.cust); return; }
  const act = t.dataset.db;
  try {
    if (act === 'create') { const a = $$('#dbPw1').value, b = $$('#dbPw2').value; if (a !== b) throw new Error('兩次密碼不一樣'); t.disabled = true; await DB.create(a); if ($$('#dbRemember').checked) LS.set('dbPw', btoa(unescape(encodeURIComponent(a)))); toast('🔐 已建立加密資料庫'); DB.render(); }
    if (act === 'unlock') { t.disabled = true; await DB.unlock($$('#dbPw').value, $$('#dbRemember').checked); toast('🔓 已解鎖'); DB.render(); }
    if (act === 'lock') { DB.lock(); toast('🔒 已上鎖'); }
    if (act === 'chpw') { await DB.changePassword($$('#dbOld').value, $$('#dbNew').value); toast('🔑 密碼已變更'); DB.render(); }
    if (act === 'more') { DB.page[t.dataset.k] += 100; renderPane(); }
    if (act === 'newcust') { const u = normUser(prompt('輸入客戶的 Threads 帳號（或自訂一個代號）') || ''); if (u) { ensureCustomer(u); DB.markDirty(); DB.openCustomer(u); } }
    if (act === 'xleads') DB.exportLeads(DB._leadList);
    if (act === 'xcust') DB.exportCustomers();
    if (act === 'xlogs') DB.exportLogs();
    if (act === 'xlist') DB.exportListings();
    if (act === 'xmatch') DB.exportMatches();
    if (act === 'xdaily') DB.exportDaily();
    if (act === 'xmonthly') DB.exportMonthly();
    if (act === 'xbackup') DB.exportBackup();
  } catch (err) { toast('⚠️ ' + err.message); t.disabled = false; }
});

/* 啟動：記住密碼的裝置自動解鎖；每 2 分鐘拉一次別台裝置的修改 */
(async function boot() {
  const saved = LS.get('dbPw', null); if (!saved || !adapter()) return;
  try { await DB.load(); await DB.unlock(decodeURIComponent(escape(atob(saved))), true); DB.sync = '✅ 已自動解鎖'; DB.render(); } catch (e) { if (/密碼錯誤/.test(e.message)) LS.set('dbPw', null); }
})();
setInterval(() => { if (!document.hidden) DB.pull(); }, 120000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) DB.pull(); else if (DB.dirty) DB.save(); });
window.addEventListener('pagehide', () => { if (DB.dirty) DB.save(); });
})();
