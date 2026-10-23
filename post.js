/* =====================================================================
 * 小球脆雷達 — 📣 發文助手（半自動，預留全自動）
 *   data/outbox.json          貼文排程（控制台寫入）
 *   data/outbox-state.json    提醒／自動發文結果（雷達寫入，兩邊不會互相覆蓋）
 *   data/media/YYYY-MM/*.jpg  貼文圖片（壓縮後上傳）
 * 半自動：時間到 → Telegram 提醒 → 控制台按「📤 發文」→ 分享到 Threads App（圖＋文字）
 * 全自動（之後）：設好 Threads 官方授權後，模式選「自動發文」，雷達會用官方 API 發出去
 * ===================================================================== */
(function () {
'use strict';
const $$ = (s) => document.querySelector(s);
const OUT = 'data/outbox.json', OUTST = 'data/outbox-state.json';
const MAX_IMG = 10, MAX_TXT = 500;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const fmt = (t) => t ? new Date(t).toLocaleString('zh-TW', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

/* ---------------- GitHub 讀寫（圖片） ---------------- */
if (typeof GitHubAdapter !== 'undefined') {
  GitHubAdapter.prototype.putB64 = async function (p, b64, msg) {
    let sha; try { sha = (await this.req(`/contents/${p}?ref=${encodeURIComponent(this.c.branch || 'main')}`)).sha; } catch { /* 新檔案 */ }
    await this.req(`/contents/${p}`, { method: 'PUT', body: JSON.stringify({ message: msg || '上傳圖片', content: b64, sha, branch: this.c.branch || 'main' }) });
  };
  GitHubAdapter.prototype.getBlob = async function (p) {
    const r = await fetch(`${this.base}/contents/${p}?ref=${encodeURIComponent(this.c.branch || 'main')}`, { headers: { Accept: 'application/vnd.github.raw', Authorization: `Bearer ${this.c.token}`, 'X-GitHub-Api-Version': '2022-11-28' } });
    if (!r.ok) throw new Error(r.status); return r.blob();
  };
}

/* ---------------- 文案範本（每種都有好幾種說法，避免每次一模一樣） ---------------- */
const CATS = {
  施工實績: { icon: '🔨', topic: '餐飲創業', fields: ['地區', '店型', '項目', '細節'],
    open: ['💪 今天又完成一個案子！', '📍 今日施工紀錄', '✨ 完工分享', '🔨 又一間店順利交屋！'],
    body: ['{地區}{店型}的{項目}完成囉！{細節}', '這次幫{地區}的{店型}處理{項目}，{細節}', '{地區}{店型}｜{項目}\n{細節}'],
    close: ['有{項目}需求的老闆，歡迎私訊{名義}免費估價～{聯絡}', '想開店、要整修的老闆，都可以找{名義}聊聊😊{聯絡}', '從規劃到完工一次搞定，私訊{名義}就對了！{聯絡}'] },
  設備收購: { icon: '🔧', topic: '餐飲設備', fields: ['地區', '項目', '細節'],
    open: ['🔧 收購二手餐飲設備！', '💰 店要收了？設備交給我們！', '📢 長期收購餐飲設備'],
    body: ['{地區}收購：{項目}\n{細節}', '冰箱、製冰機、爐具、工作台…{項目}都收！{細節}', '服務範圍：{地區}\n收購項目：{項目}\n{細節}'],
    close: ['拍照私訊{名義}，快速估價、可到府搬運🚚{聯絡}', '收店、換設備都可以找{名義}，拆裝運一次處理！{聯絡}'] },
  二手設備出售: { icon: '🧊', topic: '二手餐飲設備', fields: ['項目', '價格', '地區', '細節'],
    open: ['🧊 二手設備出清！', '🔥 優質二手設備便宜賣', '📦 整理好的二手設備上架囉'],
    body: ['{項目}\n💰 {價格}\n📍 {地區}\n{細節}', '【{項目}】{價格}\n{細節}\n地點：{地區}', '{項目}，功能正常，{價格}帶走！\n{細節}'],
    close: ['要開店缺設備的老闆，私訊{名義}看實品～{聯絡}', '可協助運送安裝，詳情私訊{名義}！{聯絡}'] },
  頂讓物件: { icon: '🏪', topic: '店面頂讓', fields: ['地區', '店型', '價格', '細節'],
    open: ['🏪 店面頂讓資訊', '📢 好店頂讓，找有緣人！', '✨ 現成店面＋設備，接手就能做'],
    body: ['📍 {地區}\n🍽 {店型}\n💰 頂讓金：{價格}\n{細節}', '{地區}{店型}頂讓，{價格}\n{細節}', '【{地區}｜{店型}】\n頂讓金 {價格}\n{細節}'],
    close: ['有興趣的老闆私訊{名義}，可安排看店～{聯絡}', '想創業找店面，{名義}幫你一次評估！{聯絡}'] },
  清潔打掃: { icon: '🧹', topic: '清潔打掃', fields: ['地區', '項目', '細節'],
    open: ['🧹 清潔前後大公開！', '✨ 又清乾淨一間了', '🧽 退租／交屋清潔完成'],
    body: ['{地區}｜{項目}\n{細節}', '這次幫{地區}的客人做{項目}，{細節}', '{項目}完成✅ {細節}'],
    close: ['退租、交屋、油煙清潔都可以找{名義}～{聯絡}', '店面、廚房清潔交給{名義}，私訊估價！{聯絡}'] },
  拆除清運: { icon: '🚛', topic: '拆除清運', fields: ['地區', '項目', '細節'],
    open: ['🚛 拆除清運完工！', '📍 今日拆除紀錄', '🔨 店面復原交給我們'],
    body: ['{地區}｜{項目}\n{細節}', '幫{地區}的客人完成{項目}，{細節}', '{項目}一次處理好✅ {細節}'],
    close: ['退租復原、拆除清運，私訊{名義}免費估價～{聯絡}', '拆除＋清運＋清潔一條龍，找{名義}就對了！{聯絡}'] },
  招牌施工: { icon: '🪧', topic: '招牌', fields: ['地區', '店型', '項目', '細節'],
    open: ['🪧 新招牌上線！', '✨ 招牌完工分享', '💡 燈箱招牌亮起來了'],
    body: ['{地區}{店型}的{項目}完成！{細節}', '幫{地區}的{店型}做了{項目}，{細節}', '【{店型}｜{項目}】\n{細節}'],
    close: ['招牌製作、施工、維修都可以找{名義}～{聯絡}', '新店開幕需要招牌，私訊{名義}估價！{聯絡}'] },
  開店諮詢: { icon: '🍽', topic: '餐飲創業', fields: ['主題', '細節'],
    open: ['🍽 想開店的老闆看過來！', '💡 開店前一定要知道的事', '📝 餐飲創業小筆記'],
    body: ['{主題}\n{細節}', '今天聊聊：{主題}\n{細節}'],
    close: ['找點、設備、裝潢、招牌一次幫你處理，私訊{名義}～{聯絡}', '開店有任何問題，都歡迎問{名義}😊{聯絡}'] },
  自由發文: { icon: '✏️', topic: '', fields: [], open: [''], body: [''], close: [''] },
};
const CAT_NAMES = Object.keys(CATS);
function fill(t, v) {
  const r = (typeof replyCfg === 'function') ? replyCfg() : { name: '小球球', lineId: '' };
  return String(t || '').replace(/\{名義\}/g, r.name).replace(/\{聯絡\}/g, r.lineId ? `\nLINE：${r.lineId}` : '')
    .replace(/\{([^}]+)\}/g, (m, k) => (v[k] || '').trim()).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
// 挑「需要的欄位都有填」的說法；沒填的欄位不會留下奇怪的空白
function best(list, v) {
  const need = (t) => (String(t).match(/\{([^}]+)\}/g) || []).map((x) => x.slice(1, -1)).filter((k) => k !== '名義' && k !== '聯絡');
  const score = (t) => need(t).filter((k) => (v[k] || '').trim()).length - need(t).filter((k) => !(v[k] || '').trim()).length * 2;
  const top = Math.max(...list.map(score)); return pick(list.filter((t) => score(t) === top));
}
const tidy = (t) => t.split('\n').filter((l) => /[\p{L}\p{N}]/u.test(l.replace(/(地點|頂讓金|收購項目|服務範圍)[:：]?/g, ''))).join('\n')
  .replace(/(的|，|、)(?=[，。！\n]|$)/g, '').replace(/^[，、\s]+/gm, '');
function genText(cat, v) {
  const c = CATS[cat]; if (!c || cat === '自由發文') return '';
  if (!Object.values(v || {}).some((x) => String(x || '').trim())) return '';
  return [fill(pick(c.open), v), tidy(fill(best(c.body, v), v)), fill(best(c.close, v), v)].filter(Boolean).join('\n\n');
}
const fullText = (it) => (it.text || '').trim() + (it.topic ? `\n#${it.topic.replace(/^#/, '')}` : '');

/* ---------------- 狀態 ---------------- */
const P = window.POST = { data: { v: 1, items: [] }, st: { reminded: {}, published: {} }, sha: null, loaded: false, f: 'todo', blobs: new Map() };
const items = () => (P.data.items || []).filter((x) => !x.deleted);
const isDue = (x) => x.status === 'scheduled' && x.planAt && Date.parse(x.planAt) <= Date.now();
const statusOf = (x) => (P.st.published[x.id] ? 'posted' : x.status);

async function load(force) {
  const a = adapter();
  if (!a) { P.data = LS.get('outbox', { v: 1, items: [] }); P.loaded = true; return; }
  if (P.loaded && !force) return;
  const m = a.getMeta ? await a.getMeta(OUT) : null;
  P.data = (m && m.data) || { v: 1, items: [] }; P.sha = m && m.sha;
  try { P.st = (await a.getRaw(OUTST)) || { reminded: {}, published: {} }; } catch { /* 還沒有 */ }
  P.st.reminded = P.st.reminded || {}; P.st.published = P.st.published || {};
  P.loaded = true;
}
async function save(msg) {
  P.data.updatedAt = Date.now();
  const a = adapter();
  if (!a) { LS.set('outbox', P.data); return; }
  for (let i = 0; i < 3; i++) {
    try { P.sha = await a.putJson(OUT, P.data, P.sha, msg || '更新發文排程'); return; }
    catch (e) {
      if (!/409|422|does not match/.test(String(e.message)) || i === 2) throw e;
      const m = await a.getMeta(OUT); const remote = (m && m.data) || { items: [] }; P.sha = m && m.sha;
      const map = new Map((remote.items || []).map((x) => [x.id, x]));
      (P.data.items || []).forEach((x) => { const r = map.get(x.id); if (!r || (x.updatedAt || 0) >= (r.updatedAt || 0)) map.set(x.id, x); });
      P.data.items = [...map.values()];
    }
  }
}

/* ---------------- 圖片：壓縮＋上傳＋讀取 ---------------- */
function compress(file) {
  return new Promise((res, rej) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const max = 1440; let w = img.naturalWidth, h = img.naturalHeight; const k = Math.min(1, max / Math.max(w, h)); w = Math.round(w * k); h = Math.round(h * k);
      const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(img, 0, 0, w, h);
      URL.revokeObjectURL(url); c.toBlob((b) => b ? res({ blob: b, w, h }) : rej(new Error('壓縮失敗')), 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('讀不到這張圖')); };
    img.src = url;
  });
}
const blobToB64 = (b) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(b); });
async function blobOf(img) {
  if (img.local) return img.local;
  if (P.blobs.has(img.path)) return P.blobs.get(img.path);
  const a = adapter(); if (!a || !a.getBlob) throw new Error('沒有連線');
  const b = await a.getBlob(img.path); P.blobs.set(img.path, b); return b;
}
async function thumbURL(img) { try { return URL.createObjectURL(await blobOf(img)); } catch { return ''; } }
async function uploadNew(it) {
  const a = adapter(); if (!a || !a.putB64) return;
  const ym = new Date().toISOString().slice(0, 7);
  for (let i = 0; i < it.images.length; i++) {
    const im = it.images[i]; if (!im.local) continue;
    const path = `data/media/${ym}/${it.id}-${uid()}.jpg`;
    toast(`⏫ 上傳圖片 ${i + 1}/${it.images.length}…`);
    await a.putB64(path, await blobToB64(im.local), '上傳貼文圖片');
    P.blobs.set(path, im.local); it.images[i] = { path, w: im.w, h: im.h };
  }
}

/* ---------------- 發文（半自動：分享到 Threads App） ---------------- */
async function publishManual(it) {
  const text = fullText(it);
  try { await copyText(text); } catch { /* 略過 */ }
  let files = [];
  try { files = await Promise.all((it.images || []).map(async (im, i) => new File([await blobOf(im)], `小球-${i + 1}.jpg`, { type: 'image/jpeg' }))); } catch { files = []; }
  let shared = false;
  if (navigator.share && (!files.length || (navigator.canShare && navigator.canShare({ files })))) {
    try { await navigator.share(files.length ? { files, text } : { text }); shared = true; }
    catch (e) { if (e && e.name === 'AbortError') { toast('已取消分享'); return; } }
  }
  if (!shared) {
    window.open('https://www.threads.net/intent/post?text=' + encodeURIComponent(text), '_blank');
    if (files.length) toast('文字已複製。這台裝置不支援直接分享圖片，請用「⬇ 下載圖片」後在 Threads 手動加圖');
  } else toast('📋 文字也已經複製好了，Threads 沒帶到文字的話，長按貼上就好');
  setTimeout(() => askPosted(it), 1200);
}
function askPosted(it) {
  const m = document.createElement('div'); m.className = 'pmodal';
  m.innerHTML = `<div class="card"><h3 style="margin-top:0">發好了嗎？</h3><p class="hint">在 Threads 送出後，按「發好了」，這篇就會標記成已發布。也可以貼上貼文網址，之後方便追蹤成效。</p>
    <input class="search" id="pmUrl" placeholder="（可不填）貼上這篇的 Threads 網址" style="width:100%;margin:6px 0 12px">
    <div class="grid2"><button class="btn" data-pm="yes">✅ 發好了</button><button class="btn ghost" data-pm="no">還沒，等等再發</button></div>
    ${it.repeat && it.repeat !== 'none' ? `<p class="hint" style="margin:10px 0 0">🔁 這篇設定「${REPEAT[it.repeat]}」，發好後會自動排好下一次。</p>` : ''}</div>`;
  document.body.appendChild(m);
  m.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-pm]'); if (!b && e.target !== m) return;
    const yes = b && b.dataset.pm === 'yes'; const url = ($$('#pmUrl').value || '').trim(); m.remove();
    if (!yes) return;
    Object.assign(it, { status: 'posted', postedAt: Date.now(), postUrl: url || it.postUrl || '', updatedAt: Date.now() });
    const nx = spawnNext(it);
    try { await save('標記已發文'); toast(nx ? `✅ 已發布，下一次：${fmt(nx.planAt)}` : '✅ 已標記發布'); } catch (err) { toast('⚠️ 儲存失敗：' + err.message); }
    render();
  });
}
async function downloadImgs(it) {
  for (let i = 0; i < (it.images || []).length; i++) {
    const b = await blobOf(it.images[i]); const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `小球貼文-${i + 1}.jpg`; document.body.appendChild(a); a.click(); a.remove();
  }
}

/* ---------------- 重複排程（每天／每週／每月） ---------------- */
const REPEAT = { none: '不重複', daily: '每天', weekdays: '每週一～五', weekly: '每週', biweekly: '每兩週', monthly: '每月' };
function nextAt(iso, rep) {
  const d = new Date(iso || Date.now()); const now = Date.now();
  const step = () => { if (rep === 'daily') d.setDate(d.getDate() + 1); else if (rep === 'weekdays') { do d.setDate(d.getDate() + 1); while ([0, 6].includes(d.getDay())); }
    else if (rep === 'weekly') d.setDate(d.getDate() + 7); else if (rep === 'biweekly') d.setDate(d.getDate() + 14); else if (rep === 'monthly') d.setMonth(d.getMonth() + 1); };
  step(); let g = 0; while (d.getTime() < now && g++ < 400) step(); return d.toISOString();
}
// 這次發完／跳過 → 自動排下一次
function spawnNext(it) {
  if (!it.repeat || it.repeat === 'none' || it.nextId) return null;
  const n = { ...JSON.parse(JSON.stringify(it)), id: uid(), status: 'scheduled', planAt: nextAt(it.planAt, it.repeat), postedAt: 0, postUrl: '', replies: 0, nextId: '', createdAt: Date.now(), updatedAt: Date.now() };
  it.nextId = n.id; P.data.items.push(n); return n;
}
// 智能推薦時間：依「線索發文的熱門時段」（大家最常滑脆的時候）挑時間
function smartSlots() {
  const posts = (state.doc && state.doc.posts) || []; let w = null;
  try { w = window.RadarAnalyze && RadarAnalyze.hourWeights(posts, 'Asia/Taipei'); } catch { /* 略過 */ }
  const hours = w ? [...w.keys()].filter((h) => h >= 7 && h <= 23).sort((a, b) => w[b] - w[a]).slice(0, 3) : [12, 18, 21];
  const out = []; const base = new Date(); base.setMinutes(0, 0, 0);
  for (let day = 0; day < 3 && out.length < 6; day++) for (const h of hours.slice().sort((a, b) => a - b)) {
    const d = new Date(base); d.setDate(d.getDate() + day); d.setHours(h); if (d.getTime() > Date.now() + 15 * 60e3) out.push(d);
  }
  return { hours, slots: out.slice(0, 6) };
}

/* ---------------- 時間到：畫面圖示＋語音提醒 ---------------- */
function dueItems() { return items().filter((x) => statusOf(x) === 'scheduled' && isDue(x)); }
function badge() {
  const n = P.loaded ? dueItems().length : 0; const btn = document.querySelector('nav [data-tab=post]'); if (!btn) return;
  let b = btn.querySelector('.badge'); if (!b) { b = document.createElement('i'); b.className = 'badge'; btn.appendChild(b); }
  b.textContent = n; b.style.display = n ? 'block' : 'none'; btn.classList.toggle('ring', n > 0);
}
function alertDue() {
  if (!P.loaded) return; badge();
  const seen = new Set(LS.get('postAlerted', [])); const fresh = dueItems().filter((x) => !seen.has(x.id)); if (!fresh.length) return;
  fresh.forEach((x) => seen.add(x.id)); LS.set('postAlerted', [...seen].slice(-300));
  const x = fresh[0]; const msg = `⏰ 該發文了：${x.cat || '貼文'}${fresh.length > 1 ? `（還有 ${fresh.length - 1} 篇）` : ''}`;
  toast(msg + '，到「📣 發文」按「📤 發文」');
  try { if (window.speechSynthesis && !(typeof R !== 'undefined' && R.mode)) { const u = new SpeechSynthesisUtterance(`小球球，該發文了，${x.cat || ''}，${fresh.length}篇`); u.lang = 'zh-TW'; speechSynthesis.speak(u); } } catch { /* 略過 */ }
  try { if (navigator.vibrate) navigator.vibrate([300, 150, 300]); } catch { /* 略過 */ }
}
setInterval(() => { if (!document.hidden) alertDue(); }, 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) alertDue(); });

/* ---------------- 畫面 ---------------- */
function kpis() {
  const all = items(), wk = Date.now() - 7 * 864e5;
  const posted = all.filter((x) => statusOf(x) === 'posted');
  return [[posted.filter((x) => (x.postedAt || 0) > wk).length, '本週已發'], [all.filter((x) => statusOf(x) === 'scheduled').length, '排程中'],
    [all.filter((x) => statusOf(x) === 'draft').length, '草稿'], [posted.reduce((s, x) => s + (x.replies || 0), 0), '帶來私訊']];
}
async function render() {
  const root = $$('#postRoot'); if (!root) return;
  if (!P.loaded) { root.innerHTML = '<div class="empty">📣 讀取中…</div>'; try { await load(); } catch (e) { root.innerHTML = `<div class="empty">讀取失敗：${esc(e.message)}</div>`; return; } }
  let spawned = 0; items().forEach((x) => { if (P.st.published[x.id] && x.repeat && x.repeat !== 'none' && !x.nextId) { x.status = 'posted'; x.postedAt = x.postedAt || Date.parse(P.st.published[x.id].at); if (spawnNext(x)) spawned++; } });
  if (spawned) save('排下一次重複貼文').catch(() => {});
  badge();
  const all = items().sort((a, b) => (Date.parse(a.planAt || 0) || a.createdAt) - (Date.parse(b.planAt || 0) || b.createdAt));
  const due = all.filter((x) => statusOf(x) === 'scheduled' && isDue(x));
  const F = { todo: ['📅 待發', (x) => ['draft', 'scheduled'].includes(statusOf(x))], posted: ['✅ 已發布', (x) => statusOf(x) === 'posted'], all: ['全部', () => true] };
  const list = all.filter(F[P.f][1]); if (P.f === 'posted') list.reverse();
  const autoReady = !!(state.cfg && state.cfg.threadsAuto);
  root.innerHTML = `<div class="card"><div class="dbhead"><h3 style="margin:0">📣 發文助手</h3><button class="btn" data-po="new">＋ 新增貼文</button></div>
      <p class="hint">選範本、填幾個字、加照片，系統幫你寫好文案。時間到會用 Telegram 提醒你，按「📤 發文」就會把<b>照片＋文字</b>一起分享到 Threads App，再按送出就好。</p>
      <div class="kpis">${kpis().map(([v, l]) => `<div class="kpi"><b>${v}</b><small>${l}</small></div>`).join('')}</div>
      <p class="hint" style="margin:10px 0 0">🤖 全自動發文：${autoReady ? '<b style="color:#52d273">已啟用</b>' : '尚未設定（要先完成 Threads 官方授權，之後再一起設定）'}</p></div>
    ${due.length ? `<div class="card" style="border-color:#ff8a3d"><h3 style="margin-top:0">⏰ 該發文了（${due.length}）</h3>${due.map(card).join('')}</div>` : ''}
    <div class="chips" style="margin-bottom:12px">${Object.entries(F).map(([k, [l]]) => `<button class="chip ${P.f === k ? 'on' : ''}" data-pof="${k}">${l}</button>`).join('')}</div>
    <div>${list.filter((x) => !due.includes(x)).map(card).join('') || '<div class="empty">還沒有貼文，按「＋ 新增貼文」開始吧！</div>'}</div>`;
  root.querySelectorAll('img[data-path]').forEach(async (el) => { const it = all.find((x) => x.id === el.dataset.id); const im = it && it.images[+el.dataset.i]; if (im) el.src = await thumbURL(im); });
}
function card(x) {
  const s = statusOf(x), c = CATS[x.cat] || CATS['自由發文'];
  const pill = (s === 'posted' ? (x.skipped ? '<span class="tag">⏭ 已跳過</span>' : '<span class="rtag 賣方">✅ 已發布</span>') : s === 'scheduled' ? `<span class="rtag ${isDue(x) ? '同業' : '買方'}">${isDue(x) ? '⏰' : '📅'} ${esc(fmt(x.planAt))}${x.mode === 'auto' ? '・🤖自動' : ''}</span>` : '<span class="tag">草稿</span>') + (x.repeat && x.repeat !== 'none' ? `<span class="tag">🔁 ${REPEAT[x.repeat]}</span>` : '');
  return `<div class="card pcard" data-id="${x.id}"><div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span class="tag">${c.icon} ${esc(x.cat || '自由發文')}</span>${pill}${x.topic ? `<span class="viatag">#${esc(x.topic)}</span>` : ''}
      ${s === 'posted' ? `<span class="hint" style="margin:0">${esc(fmt(x.postedAt || (P.st.published[x.id] || {}).at))}・私訊 ${x.replies || 0}</span>` : ''}</div>
    ${(x.images || []).length ? `<div class="pthumbs">${x.images.map((im, i) => `<img data-path="${esc(im.path || '')}" data-id="${x.id}" data-i="${i}" alt="">`).join('')}</div>` : ''}
    <div class="ptext">${esc(x.text || '')}</div>
    <div class="acts" style="margin-top:8px">
      ${s !== 'posted' ? `<button class="btn sm" data-po="pub" data-id="${x.id}">📤 發文</button><button class="btn ghost sm" data-po="edit" data-id="${x.id}">✏️ 編輯</button>${x.repeat && x.repeat !== 'none' && s === 'scheduled' ? `<button class="btn ghost sm" data-po="skip" data-id="${x.id}">⏭ 跳過這次</button>` : ''}` : `<button class="btn ghost sm" data-po="rep" data-id="${x.id}">💬 ＋1 私訊</button>${x.postUrl ? `<a class="btn ghost sm" href="${esc(x.postUrl)}" target="_blank" rel="noopener">開啟貼文</a>` : ''}<button class="btn ghost sm" data-po="dup" data-id="${x.id}">🔁 再發一次</button>`}
      <button class="btn ghost sm" data-po="copy" data-id="${x.id}">📋 複製文字</button>
      ${(x.images || []).length ? `<button class="btn ghost sm" data-po="dl" data-id="${x.id}">⬇ 下載圖片</button>` : ''}
      <button class="btn ghost sm" data-po="del" data-id="${x.id}">🗑</button></div></div>`;
}

/* ---------------- 編輯視窗 ---------------- */
function localDT(t) { const d = t ? new Date(t) : new Date(Date.now() + 3600e3); d.setSeconds(0, 0); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16); }
function openEditor(src) {
  const it = src ? JSON.parse(JSON.stringify({ ...src, images: [] })) : { id: uid(), cat: '施工實績', text: '', topic: CATS['施工實績'].topic, images: [], status: 'draft', mode: 'manual', vals: {}, createdAt: Date.now() };
  if (src) it.images = (src.images || []).slice();
  it.vals = it.vals || {};
  const m = document.createElement('div'); m.className = 'pmodal'; m.id = 'postEd';
  const q = (sel) => m.querySelector(sel);
  const autoReady = !!(state.cfg && state.cfg.threadsAuto);
  const draw = () => {
    const c = CATS[it.cat];
    m.innerHTML = `<div class="card"><div class="dbhead"><h3 style="margin:0">${src ? '✏️ 編輯貼文' : '＋ 新增貼文'}</h3><button class="btn ghost sm" data-ed="close">✕</button></div>
      <div class="hint" style="margin-top:10px">① 選類型</div>
      <div class="chips" style="flex-wrap:wrap">${CAT_NAMES.map((k) => `<button class="chip ${it.cat === k ? 'on' : ''}" data-edcat="${k}">${CATS[k].icon} ${k}</button>`).join('')}</div>
      ${c.fields.length ? `<div class="hint" style="margin-top:12px">② 填幾個重點（不想填可留空）</div><div class="grid2">${c.fields.map((f) => `<div class="field" style="margin:0"><label>${f}</label><input data-edv="${f}" value="${esc(it.vals[f] || '')}" placeholder="${{ 地區: '例：台中北屯', 店型: '例：火鍋店', 項目: '例：招牌燈箱', 價格: '例：8000 元', 細節: '例：三天完工', 主題: '例：開店前要準備多少錢？' }[f] || ''}"></div>`).join('')}</div>
        <button class="btn" style="width:100%;margin-top:10px" data-ed="gen">✨ 產生文案（每按一次換一種說法）</button>` : ''}
      <div class="hint" style="margin-top:12px">${c.fields.length ? '③' : '②'} 文案（可以直接修改）<span id="edCount" style="float:right"></span></div>
      <textarea id="edText" rows="9" class="cmta" placeholder="先在上面填幾個重點，再按「✨ 產生文案」；也可以直接在這裡自己寫" style="width:100%;font-size:18px;line-height:1.6">${esc(it.text)}</textarea>
      <div class="field" style="margin-top:8px"><label>主題標籤（Threads 一篇只能有 1 個，會加在最後面）</label><input id="edTopic" value="${esc(it.topic || '')}" placeholder="例：餐飲設備"></div>
      <div class="hint">📷 照片（最多 ${MAX_IMG} 張，會自動壓縮）</div>
      <div class="pthumbs" id="edImgs">${it.images.map((im, i) => `<div class="pimg"><img data-edi="${i}" alt=""><button data-edrm="${i}">✕</button></div>`).join('')}
        ${it.images.length < MAX_IMG ? '<label class="padd">＋<input type="file" accept="image/*" multiple id="edFile" hidden></label>' : ''}</div>
      <div class="grid2" style="margin-top:12px"><div class="field" style="margin:0"><label>📅 預定發文時間</label><input type="datetime-local" id="edAt" value="${localDT(it.planAt)}"></div>
        <div class="field" style="margin:0"><label>發文方式</label><select id="edMode"><option value="manual">📱 時間到提醒我（半自動）</option><option value="auto" ${autoReady ? '' : 'disabled'}>🤖 時間到自動發${autoReady ? '' : '（尚未設定）'}</option></select></div></div>
      <div class="field" style="margin:12px 0 0"><label>🔁 重複</label><select id="edRep">${Object.entries(REPEAT).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
      <div class="hint" style="margin-top:10px">✨ 智能推薦時間（依你抓到的線索，大家最常滑脆的時段：${smartSlots().hours.map((h) => h + '點').join('、')}）</div>
      <div class="chips" style="flex-wrap:wrap">${smartSlots().slots.map((d) => `<button class="chip" data-edslot="${d.toISOString()}">${['今天', '明天', '後天'][Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5)] || ''} ${String(d.getHours()).padStart(2, '0')}:00</button>`).join('')}</div>
      <div class="grid2" style="margin-top:14px"><button class="btn" data-ed="sched">📅 排程</button><button class="btn" data-ed="now">📤 存好並馬上發</button></div>
      <button class="btn ghost" style="width:100%;margin-top:8px" data-ed="draft">💾 只存草稿</button></div>`;
    q('#edMode').value = it.mode === 'auto' && autoReady ? 'auto' : 'manual';
    q('#edRep').value = it.repeat || 'none';
    m.querySelectorAll('img[data-edi]').forEach(async (el) => { el.src = await thumbURL(it.images[+el.dataset.edi]); });
    count();
  };
  const sync = () => { const t = q('#edText'); if (t) it.text = t.value; const tp = q('#edTopic'); if (tp) it.topic = tp.value.replace(/^#/, '').trim(); m.querySelectorAll('[data-edv]').forEach((e) => { it.vals[e.dataset.edv] = e.value; }); const a = q('#edAt'); if (a) it.planAt = a.value ? new Date(a.value).toISOString() : ''; const md = q('#edMode'); if (md) it.mode = md.value; const rp = q('#edRep'); if (rp) it.repeat = rp.value; };
  const count = () => { const n = new TextEncoder().encode(fullText({ text: q('#edText').value, topic: q('#edTopic').value })).length; const ch = [...fullText({ text: q('#edText').value, topic: q('#edTopic').value })].length; const el = q('#edCount'); if (el) { el.textContent = `${ch} / ${MAX_TXT} 字`; el.style.color = ch > MAX_TXT ? '#ff6b6b' : ''; } };
  draw(); document.body.appendChild(m); document.body.style.overflow = 'hidden';
  if (!src) { it.text = genText(it.cat, it.vals); q('#edText').value = it.text; count(); }
  m.addEventListener('input', (e) => { if (e.target.id === 'edText' || e.target.id === 'edTopic') count(); });
  m.addEventListener('change', async (e) => {
    if (e.target.id !== 'edFile') return; sync();
    const files = [...e.target.files].slice(0, MAX_IMG - it.images.length);
    for (const f of files) { try { const r = await compress(f); it.images.push({ local: r.blob, w: r.w, h: r.h }); } catch (err) { toast('⚠️ ' + err.message); } }
    draw();
  });
  const close = () => { m.remove(); document.body.style.overflow = ''; };
  m.addEventListener('click', async (e) => {
    if (e.target === m) return;
    const sl = e.target.closest('[data-edslot]'); if (sl) { sync(); it.planAt = sl.dataset.edslot; q('#edAt').value = localDT(it.planAt); m.querySelectorAll('[data-edslot]').forEach((c) => c.classList.toggle('on', c === sl)); return; }
    const cb = e.target.closest('[data-edcat]'); if (cb) { sync(); it.cat = cb.dataset.edcat; it.topic = CATS[it.cat].topic || it.topic; it.text = genText(it.cat, it.vals) || it.text; draw(); return; }
    const rm = e.target.closest('[data-edrm]'); if (rm) { sync(); it.images.splice(+rm.dataset.edrm, 1); draw(); return; }
    const b = e.target.closest('[data-ed]'); if (!b) return; const act = b.dataset.ed;
    if (act === 'close') { if (confirm('離開不儲存？')) close(); return; }
    if (act === 'gen') { sync(); it.text = genText(it.cat, it.vals); q('#edText').value = it.text; count(); return; }
    sync();
    if (!it.text.trim() && !it.images.length) { toast('請先寫文案或加照片'); return; }
    if ([...fullText(it)].length > MAX_TXT) { toast(`文案超過 ${MAX_TXT} 字，Threads 會發不出去，請刪短一點`); return; }
    if (act === 'sched' && !it.planAt) { toast('請選預定發文時間'); return; }
    it.status = act === 'draft' ? 'draft' : 'scheduled'; if (act === 'now') it.planAt = new Date().toISOString();
    it.updatedAt = Date.now(); b.disabled = true;
    try {
      await uploadNew(it);
      const i = P.data.items.findIndex((x) => x.id === it.id); if (i >= 0) P.data.items[i] = it; else P.data.items.push(it);
      await save(act === 'draft' ? '儲存貼文草稿' : '排程貼文');
      close(); render(); toast(act === 'draft' ? '💾 已存草稿' : act === 'sched' ? `📅 已排程：${fmt(it.planAt)}，時間到會提醒你` : '✅ 已存好');
      if (act === 'now') publishManual(it);
    } catch (err) { b.disabled = false; toast('⚠️ 儲存失敗：' + err.message); }
  });
}

/* ---------------- 事件 ---------------- */
document.addEventListener('click', async (e) => {
  const f = e.target.closest('[data-pof]'); if (f) { P.f = f.dataset.pof; render(); return; }
  const b = e.target.closest('[data-po]'); if (!b) return;
  const act = b.dataset.po, it = items().find((x) => x.id === b.dataset.id);
  if (act === 'new') return openEditor(null);
  if (!it) return;
  if (act === 'edit') return openEditor(it);
  if (act === 'pub') return publishManual(it);
  if (act === 'copy') { copyText(fullText(it)).then(() => toast('📋 已複製文案')); return; }
  if (act === 'dl') { downloadImgs(it).catch((err) => toast('⚠️ ' + err.message)); return; }
  if (act === 'dup') { openEditor({ ...it, id: uid(), status: 'draft', planAt: '', postedAt: 0, postUrl: '', replies: 0, createdAt: Date.now() }); return; }
  try {
    if (act === 'skip') { const nx = spawnNext(it); it.status = 'posted'; it.skipped = true; it.updatedAt = Date.now(); await save('跳過這次'); toast(nx ? `⏭ 已跳過，下一次：${fmt(nx.planAt)}` : '已跳過'); }
    if (act === 'rep') { it.replies = (it.replies || 0) + 1; it.updatedAt = Date.now(); await save('記錄私訊'); toast('💬 已記錄 +1 私訊'); }
    if (act === 'del') { if (!confirm('刪除這篇？')) return; it.deleted = true; it.updatedAt = Date.now(); await save('刪除貼文'); toast('已刪除'); }
  } catch (err) { toast('⚠️ ' + err.message); }
  render();
});
P.boot = async function () { try { await load(true); alertDue(); } catch { /* 略過 */ } };
P.open = async function () { await render(); try { await load(true); } catch { /* 略過 */ } render(); };
P.render = render; P.genText = genText; P.CATS = CATS; P.fullText = fullText;
})();
