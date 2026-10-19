'use strict';
/**
 * 小球脆雷達 — 核心模組
 * ------------------------------------------------------------
 * 這個檔案「不綁定」執行環境：
 *   方案 A：run-once.js 由 GitHub Actions 每 15 分鐘呼叫一次 runScan()
 *   方案 B：之後新增 server.js，用 setInterval 呼叫同一個 runScan()，
 *          並用 Express 提供 /api/* 給 index.html 讀寫。
 * 換方案時只需換「入口檔」與「Store」，爬蟲 / 過濾 / 推播完全不用改。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const BASE_URL = 'https://www.threads.com';

const DEFAULT_CONFIG = {
  enabled: true,
  keywords: ['頂讓', '盤讓', '設備轉讓', '搬家出清'],   // 關鍵字池：輪流隨機搜尋
  mustKeywords: [],       // 必搜：每次掃描都搜（可留空）
  keywordsPerScan: 4,     // 每次從關鍵字池抽幾個（0 = 全部都搜）
  regions: [],
  excludeWords: [],
  excludeUsers: [],       // 排除帳號：這些帳號的貼文一律略過
  watchUsers: [],         // 關注帳號：每次掃描輪流去看他們的個人頁
  watchPerScan: 1,        // 每次掃描看幾個關注帳號（0＝不看個人頁，只做標記）
  regionRequired: false,
  strictKeyword: true,
  firstRunSilent: true,
  notifyErrors: true,
  notifyTelegram: true,   // false = 線索只存進控制台，不推播
  maxStoredRuns: 300,
  scanMinMinutes: 30,     // 每次掃描間隔：最短（分鐘）
  scanMaxMinutes: 90,     // 每次掃描間隔：最長（分鐘），中間亂數
  restHoursPerDay: 6,     // 每天休息幾小時（零散分布，每天不同）
  smartSchedule: true,    // 依發文時段：冷門時段休息、尖峰時段掃得密一點
  detailFetchMax: 6,      // 每次最多點進幾篇新線索看完整內容
  comboChance: 0.5,       // 每個關鍵字有多少機率搭配一個地區一起搜（0～1）
  timezone: 'Asia/Taipei',
  maxAgeHours: 72,
  scrollsPerKeyword: 3,
  maxNotifyPerRun: 15,
  maxStoredPosts: 300,
};

/* ---------------- 工具 ---------------- */
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
const norm = (s) => String(s || '').toLowerCase().replace(/臺/g, '台');
const normUser = (u) => String(u || '').trim().replace(/^https?:\/\/(www\.)?threads\.(com|net)\//i, '').replace(/^@/, '').replace(/[/?#].*$/, '').toLowerCase();
const cleanList = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter(Boolean))];

function loadConfig(file = path.join(ROOT, 'config.json')) {
  const cfg = { ...DEFAULT_CONFIG, ...readJson(file, {}) };
  cfg.keywords = cleanList(cfg.keywords);
  cfg.mustKeywords = cleanList(cfg.mustKeywords);
  cfg.allKeywords = cleanList([...cfg.mustKeywords, ...cfg.keywords]);
  cfg.regions = cleanList(cfg.regions);
  cfg.excludeWords = cleanList(cfg.excludeWords);
  cfg.excludeUsers = cleanList((cfg.excludeUsers || []).map(normUser));
  cfg.watchUsers = cleanList((cfg.watchUsers || []).map(normUser));
  return cfg;
}

/* ---------------- 儲存層（方案B可換成資料庫，介面不變） ---------------- */
class FileStore {
  constructor(dir = path.join(ROOT, 'data')) {
    this.postsFile = path.join(dir, 'posts.json');
    this.seenFile = path.join(dir, 'seen.json');
  }
  getSeen() { return new Set(readJson(this.seenFile, [])); }
  saveSeen(set, max = 5000) { writeJson(this.seenFile, [...set].slice(-max)); }
  getDoc() {
    return readJson(this.postsFile, { updatedAt: null, lastRun: null, runs: [], lastWarnAt: null, posts: [] });
  }
  saveDoc(doc) { doc.updatedAt = new Date().toISOString(); writeJson(this.postsFile, doc); }

  /* ---------- 資料庫：線索永久封存（依月份分檔）＋每日統計 ---------- */
  get dbDir() { return path.join(path.dirname(this.postsFile), 'db'); }
  archive(posts, tz = 'Asia/Taipei') {
    if (!posts || !posts.length) return 0;
    const idxFile = path.join(this.dbDir, 'index.json');
    const idx = readJson(idxFile, { months: [], counts: {} });
    const byMonth = {};
    for (const p of posts) {
      const m = monthIn(tz, new Date(Date.parse(p.foundAt || p.time) || Date.now()));
      (byMonth[m] = byMonth[m] || []).push(p);
    }
    let added = 0;
    for (const [m, list] of Object.entries(byMonth)) {
      const f = path.join(this.dbDir, `leads-${m}.json`);
      const cur = readJson(f, []);
      const have = new Set(cur.map((x) => x.url));
      for (const p of list) {
        if (have.has(p.url)) continue;
        const { url, user, authorUrl, text, time, foundAt, keywords, regions, foundBy, watched, full, code } = p;
        cur.push({ url, user, authorUrl, text, time, foundAt, keywords, regions, foundBy, watched, full, code });
        have.add(url); added++;
      }
      writeJson(f, cur);
      if (!idx.months.includes(m)) idx.months.push(m);
      idx.counts[m] = cur.length;
    }
    idx.months.sort();
    idx.updatedAt = new Date().toISOString();
    writeJson(idxFile, idx);
    return added;
  }
  addStats(run, newPosts, tz = 'Asia/Taipei') {
    const f = path.join(this.dbDir, 'stats.json');
    const st = readJson(f, { days: {} });
    const d = dateIn(tz, new Date());
    const day = st.days[d] || (st.days[d] = { scans: 0, scanned: 0, leads: 0, high: 0, buyers: 0, kw: {} });
    if (run.status === 'paused') return;
    day.scans++; day.scanned += run.scanned || 0; day.leads += (newPosts || []).length;
    for (const p of newPosts || []) {
      const a = require('./analyze').analyzePost(p);
      if (a.intent.level === '高') day.high++;
      if (a.role === '買方') day.buyers++;
      day.kw[p.foundBy] = (day.kw[p.foundBy] || 0) + 1;
    }
    writeJson(f, st);
  }
}
function monthIn(tz, d) { return dateIn(tz, d).slice(0, 7); }
function dateIn(tz, d) { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d); }

/* ---------------- 登入 Cookie 解析 ----------------
 * 支援兩種格式（放在 GitHub Secret: THREADS_COOKIES）：
 *  1. Cookie-Editor 匯出的 JSON 陣列
 *  2. 一行文字 "sessionid=xxx; csrftoken=yyy; ds_user_id=zzz"
 */
function parseCookies(raw) {
  if (!raw || !raw.trim()) return [];
  raw = raw.trim();
  if (raw.startsWith('[') || raw.startsWith('{')) {
    let arr = JSON.parse(raw);
    if (!Array.isArray(arr)) arr = arr.cookies || [arr];
    return arr.filter((c) => c && c.name).map((c) => {
      const o = {
        name: c.name, value: String(c.value ?? ''),
        domain: c.domain || '.threads.com', path: c.path || '/',
        httpOnly: !!c.httpOnly, secure: c.secure !== false,
      };
      const exp = c.expirationDate ?? c.expires;
      if (typeof exp === 'number' && exp > 0) o.expires = Math.floor(exp);
      const ss = String(c.sameSite || '').toLowerCase();
      if (ss === 'lax') o.sameSite = 'Lax';
      else if (ss === 'strict') o.sameSite = 'Strict';
      else if (ss === 'none' || ss === 'no_restriction') { o.sameSite = 'None'; o.secure = true; }
      return o;
    });
  }
  const out = [];
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    for (const domain of ['.threads.com', '.threads.net']) {
      out.push({ name, value, domain, path: '/', secure: true, httpOnly: false });
    }
  }
  return out;
}

/* ---------------- 頁面內擷取（在瀏覽器裡執行） ---------------- */
function extractInPage() {
  const RE = /\/@([^/?#]+)\/post\/([^/?#]+)/;
  const NOISE = /^(翻譯|翻譯年糕|查看翻譯|Translate|See translation|讚|回覆|轉發|分享|更多|Like|Reply|Repost|Share|More|作者|Author|·)$/i;
  const map = new Map();
  for (const a of document.querySelectorAll('a[href*="/post/"]')) {
    const m = (a.getAttribute('href') || '').match(RE);
    if (!m) continue;
    const user = decodeURIComponent(m[1]);
    const code = m[2];
    if (map.has(code)) continue;
    let box = a.closest('[data-pressable-container="true"]');
    if (!box) {
      let el = a;
      for (let i = 0; i < 10 && el.parentElement; i++) {
        el = el.parentElement;
        if ((el.innerText || '').length > 60) { box = el; break; }
      }
    }
    if (!box) box = a.parentElement || a;
    const timeEl = box.querySelector('time');
    const TIME = /^(\d+\s*(秒|分鐘|小時|天|週|周|個月|年|[smhdw])|剛剛|\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}\/\d{1,2}(\/\d{2,4})?)$/;
    const lines = (box.innerText || '').split('\n').map((s) => s.trim())
      .map((s) => (s.startsWith(user) ? s.slice(user.length).trim() : s)).filter(Boolean)
      .filter((s) => !NOISE.test(s) && !TIME.test(s) && !/^\d+([.,]\d+)?\s*[萬千kKmM]?$/.test(s) && !/^\d+\s*\/\s*\d+$/.test(s));
    const origin = location.origin && location.origin !== 'null' ? location.origin : 'https://www.threads.com';
    map.set(code, {
      code, user,
      url: `${origin}/@${user}/post/${code}`,
      authorUrl: `${origin}/@${user}`,
      text: lines.join('\n').slice(0, 1500),
      time: timeEl ? timeEl.getAttribute('datetime') : null,
    });
  }
  return [...map.values()];
}

async function scrapeKeyword(page, keyword, { scrolls = 3 } = {}) {
  const url = `${BASE_URL}/search?q=${encodeURIComponent(keyword)}&serp_type=default&filter=recent`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try { await page.waitForSelector('a[href*="/post/"]', { timeout: 15000 }); } catch { /* 可能沒結果或被擋 */ }
  const loginWall = /\/login/.test(page.url()) ||
    (await page.locator('input[autocomplete="username"], input[name="username"]').count()) > 0;
  for (let i = 0; i < scrolls; i++) {
    await page.mouse.wheel(0, 2400);
    await page.waitForTimeout(rand(1200, 2200));
  }
  const items = await page.evaluate(extractInPage);
  return { items, loginWall };
}

/* ---------------- 過濾 ---------------- */
function matchPost(post, cfg, foundBy) {
  const user = normUser(post.user);
  if ((cfg.excludeUsers || []).includes(user)) return null;
  const watched = (cfg.watchUsers || []).includes(user);
  const text = norm(`${post.text}\n${post.user}`);
  const keywords = (cfg.allKeywords || cfg.keywords).filter((k) => text.includes(norm(k)));
  if (cfg.strictKeyword && keywords.length === 0 && !watched) return null;
  if (cfg.excludeWords.some((w) => text.includes(norm(w)))) return null;
  const regions = cfg.regions.filter((r) => text.includes(norm(r)));
  if (cfg.regionRequired && cfg.regions.length && regions.length === 0) return null;
  if (cfg.maxAgeHours > 0 && post.time) {
    const t = Date.parse(post.time);
    if (!isNaN(t) && Date.now() - t > cfg.maxAgeHours * 3600e3) return null;
  }
  const out = { ...post, keywords: keywords.length ? keywords : [foundBy], regions, foundBy };
  if (watched) out.watched = true;
  return out;
}

/* ---------------- 推播 ---------------- */
const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const { analyzePost } = require('./analyze');
const LEVEL_ICON = { 高: '🔥', 中: '🌤', 低: '❄️' };
function formatPost(p) {
  const a = analyzePost(p);
  const tags = [...p.keywords, ...p.regions].join('・');
  const body = p.text.length > 300 ? p.text.slice(0, 300) + '…' : p.text;
  const i = a.info;
  const facts = [
    i.city || i.district ? `📍${[i.city, i.district].filter(Boolean).join(' ')}` : '',
    i.shop ? `🏪${i.shop}` : '',
    i.price ? `💰${i.price}` : '',
    i.area ? `📐${i.area}` : '',
    i.rent ? `🏠租金${i.rent}` : '',
    i.phone ? `📞${i.phone}` : '',
    i.line ? `💬LINE ${i.line}` : '',
    i.equip.length ? `🔧${i.equip.join('、')}` : '',
  ].filter(Boolean).join('　');
  const head = `${LEVEL_ICON[a.intent.level]}${a.intent.level}意向｜${a.role}｜${a.cat}`;
  return {
    html: `${head}\n🔔 <b>脆新線索｜${escHtml(tags)}</b>\n👤 <a href="${p.authorUrl}">@${escHtml(p.user)}</a>${facts ? `\n${escHtml(facts)}` : ''}\n\n${escHtml(body)}\n\n🔗 <a href="${p.url}">開啟貼文</a>`,
    plain: `${head}\n🔔 脆新線索｜${tags}\n👤 @${p.user}${facts ? `\n${facts}` : ''}\n\n${body}\n\n🔗 ${p.url}`,
  };
}

async function sendTelegram(html, env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const ids = String(env.TELEGRAM_CHAT_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!token || !ids.length) return false;
  let ok = false;
  for (const chat_id of ids) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    if (res.ok) ok = true; else console.warn('Telegram 失敗', res.status, await res.text());
  }
  return ok;
}

async function sendLine(plain, env) {
  const token = env.LINE_CHANNEL_TOKEN;
  const ids = String(env.LINE_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!token || !ids.length) return false;
  let ok = false;
  for (const to of ids) {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to, messages: [{ type: 'text', text: plain.slice(0, 4900) }] }),
    });
    if (res.ok) ok = true; else console.warn('LINE 失敗', res.status, await res.text());
  }
  return ok;
}

async function notify({ html, plain }, env) {
  const a = await sendTelegram(html, env).catch((e) => (console.warn(e.message), false));
  const b = await sendLine(plain || html.replace(/<[^>]+>/g, ''), env).catch((e) => (console.warn(e.message), false));
  return a || b;
}

/* ---------------- 關鍵字輪替：平均＋隨機 ----------------
 * 從「最久沒被搜過」的 2N 個裡面隨機抽 N 個 → 每個詞被搜的次數會很平均，順序又不固定。
 */
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function pickKeywords(cfg, doc) {
  const must = cfg.mustKeywords || [];
  const rest = (cfg.keywords || []).filter((k) => !must.includes(k));
  const n = Math.max(0, Math.round(Number(cfg.keywordsPerScan ?? 4)));
  if (n === 0 || n >= rest.length) return [...must, ...shuffle([...rest])];
  const stats = doc.kwStats || {};
  const ordered = shuffle([...rest]).sort((a, b) => ((stats[a] && stats[a].last) || 0) - ((stats[b] && stats[b].last) || 0));
  return [...must, ...shuffle(ordered.slice(0, Math.min(rest.length, n * 2))).slice(0, n)];
}

/* ---------------- 排程：亂數間隔＋尖峰時段（演算法在 analyze.js，與控制台共用） ---------------- */
const SCHED = require('./analyze');
const weightsOf = (doc, cfg) => SCHED.hourWeights((doc && doc.posts) || [], cfg.timezone);
const restHours = (cfg, d = new Date(), doc) => SCHED.restHours(cfg, d, doc ? weightsOf(doc, cfg) : null);
const inQuiet = (cfg, d = new Date(), doc) => SCHED.inQuiet(cfg, d, doc ? weightsOf(doc, cfg) : null);
const pickNext = (cfg, from = Date.now(), doc) => SCHED.pickNext(cfg, from, doc ? weightsOf(doc, cfg) : null);
function shouldScan(cfg, doc, now = new Date(), force = false) {
  if (force) return { due: true, reason: '手動執行' };
  if (!cfg.enabled) return { due: false, reason: '雷達已暫停' };
  if (inQuiet(cfg, now, doc)) return { due: false, reason: `今天的休息時段（${restHours(cfg, now, doc).join('、')} 點）` };
  const next = Date.parse(doc.nextScanAt || '');
  if (next && now.getTime() < next - 60e3) return { due: false, reason: `還沒到時間，預計 ${doc.nextScanAt}` };
  return { due: true, reason: '時間到了' };
}

/* ---------------- 主流程（方案 A / B 共用） ---------------- */
async function runScan({ chromium, cfg = loadConfig(), store = new FileStore(), env = process.env, log = console.log }) {
  const run = {
    startedAt: new Date().toISOString(), finishedAt: null, status: 'ok',
    scanned: 0, matched: 0, newCount: 0, notified: 0, perKeyword: {}, warnings: [],
  };
  const doc = store.getDoc();
  const finish = () => {
    run.finishedAt = new Date().toISOString();
    if (run.status !== 'paused') {
      const n = pickNext(cfg, Date.now(), doc);
      doc.nextScanAt = n.at; run.nextInMinutes = n.minutes;
      log(`下次掃描：約 ${n.minutes} 分鐘後${n.peak > 0.6 ? '（尖峰時段）' : ''}`);
    }
    try {
      if (!doc.archivedSeed) { store.archive(doc.posts || [], cfg.timezone); doc.archivedSeed = true; }
      store.archive(run._new || [], cfg.timezone);
      store.addStats(run, run._new || [], cfg.timezone);
    } catch (e) { log('資料庫寫入失敗：' + e.message); }
    delete run._new;
    doc.lastRun = run;
    doc.runs = [run, ...(doc.runs || [])].slice(0, cfg.maxStoredRuns || 300);
    store.saveDoc(doc);
    return run;
  };

  if (!cfg.enabled) { run.status = 'paused'; log('監控已暫停'); return finish(); }
  if (!cfg.allKeywords.length) { run.status = 'warn'; run.warnings.push('沒有設定關鍵字'); return finish(); }
  const thisRun = pickKeywords(cfg, doc);
  run.keywordsUsed = thisRun;
  doc.kwStats = doc.kwStats || {};
  log(`這次搜尋：${thisRun.join('、')}`);

  const seen = store.getSeen();
  const firstRun = seen.size === 0 && cfg.firstRunSilent;
  const scannedItems = [];
  let loginWall = false;

  const browser = await chromium.launch({ headless: true });
  const fresh = new Map();
  run.queries = [];
  try {
    const context = await browser.newContext({
      locale: 'zh-TW', timezoneId: 'Asia/Taipei', viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    });
    const cookies = parseCookies(env.THREADS_COOKIES);
    if (cookies.length) { await context.addCookies(cookies); run.loginMode = 'login'; }
    else run.loginMode = 'guest';   // 不登入模式（刻意選擇，不算警告）
    const page = await context.newPage();

    /* ① 搜尋：關鍵字（有機率加上一個地區一起搜） */
    const regions = cfg.regions || [];
    for (const kw of thisRun) {
      const st = doc.kwStats[kw] || (doc.kwStats[kw] = { count: 0, last: 0, scanned: 0, leads: 0 });
      st.count++; st.last = Date.now();
      const combo = regions.length && Math.random() < Number(cfg.comboChance ?? 0.5);
      const query = combo ? `${kw} ${regions[Math.floor(Math.random() * regions.length)]}` : kw;
      run.queries.push(query);
      try {
        const r = await scrapeKeyword(page, query, { scrolls: cfg.scrollsPerKeyword });
        run.perKeyword[kw] = (run.perKeyword[kw] > 0 ? run.perKeyword[kw] : 0) + r.items.length;
        st.scanned = (st.scanned || 0) + r.items.length;
        if (r.loginWall) loginWall = true;
        for (const it of r.items) scannedItems.push({ it, kw });
        log(`「${query}」抓到 ${r.items.length} 則`);
      } catch (e) {
        run.perKeyword[kw] = run.perKeyword[kw] > 0 ? run.perKeyword[kw] : -1;
        run.warnings.push(`「${query}」失敗：${e.message.split('\n')[0]}`);
      }
      await sleep(rand(3000, 6000));
    }

    /* ①-2 關注帳號：輪流看個人頁（最久沒看的優先） */
    const nWatch = Math.max(0, Math.round(Number(cfg.watchPerScan ?? 1)));
    if (nWatch && cfg.watchUsers.length) {
      doc.watchStats = doc.watchStats || {};
      const order = [...cfg.watchUsers].sort((a, b) => ((doc.watchStats[a] || {}).last || 0) - ((doc.watchStats[b] || {}).last || 0));
      for (const u of order.slice(0, nWatch)) {
        const ws = doc.watchStats[u] || (doc.watchStats[u] = { count: 0, last: 0, leads: 0 });
        ws.count++; ws.last = Date.now();
        try {
          await page.goto(`${BASE_URL}/@${encodeURIComponent(u)}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
          try { await page.waitForSelector('a[href*="/post/"]', { timeout: 15000 }); } catch { /* 可能沒貼文 */ }
          await page.mouse.wheel(0, 1800); await page.waitForTimeout(rand(1200, 2000));
          const items = (await page.evaluate(extractInPage)).filter((it) => normUser(it.user) === u);
          for (const it of items) scannedItems.push({ it, kw: '@' + u });
          run.perKeyword['@' + u] = items.length;
          log(`關注帳號 @${u} 抓到 ${items.length} 則`);
        } catch (e) { run.warnings.push(`關注帳號 @${u} 失敗：${e.message.split('\n')[0]}`); }
        await sleep(rand(3000, 6000));
      }
    }

    /* ② 過濾出新的線索 */
    for (const { it, kw } of scannedItems) {
      if (seen.has(it.url) || fresh.has(it.url)) continue;
      const m = matchPost(it, cfg, kw);
      if (m) fresh.set(it.url, { ...m, foundAt: new Date().toISOString() });
    }

    /* ③ 點進新線索看完整內容（搜尋頁常被截斷） */
    const maxDetail = Math.max(0, Number(cfg.detailFetchMax ?? 6));
    let fetched = 0;
    for (const p of [...fresh.values()].slice(0, maxDetail)) {
      try {
        await page.goto(p.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        try { await page.waitForSelector('a[href*="/post/"]', { timeout: 12000 }); } catch { /* 略過 */ }
        await page.waitForTimeout(rand(800, 1600));
        const items = await page.evaluate(extractInPage);
        const full = items.find((x) => x.code === p.code);
        if (full && full.text && full.text.length > (p.text || '').length) {
          const again = matchPost({ ...p, text: full.text, time: full.time || p.time }, cfg, p.foundBy);
          if (!again) { fresh.delete(p.url); log(`完整內容含排除字詞，略過：${p.url}`); }
          else fresh.set(p.url, { ...p, text: full.text, time: full.time || p.time, regions: again.regions, keywords: again.keywords, full: true });
        }
        fetched++;
      } catch (e) { log(`開啟貼文失敗：${e.message.split('\n')[0]}`); }
      await sleep(rand(2000, 4000));
    }
    run.detailFetched = fetched;
  } finally {
    await browser.close();
  }

  run.scanned = scannedItems.length;
  if (loginWall && run.loginMode === 'login') { run.status = 'warn'; run.warnings.push('Threads 要求登入，THREADS_COOKIES 可能已失效'); }

  scannedItems.forEach(({ it }) => seen.add(it.url));
  const newPosts = [...fresh.values()].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0));
  newPosts.forEach((p) => {
    const st = doc.kwStats[p.foundBy]; if (st) st.leads = (st.leads || 0) + 1;
    const ws = doc.watchStats && doc.watchStats[String(p.foundBy).replace(/^@/, '')]; if (ws) ws.leads = (ws.leads || 0) + 1;
  });
  run.matched = run.newCount = newPosts.length;
  run._new = newPosts;
  run.newUrls = newPosts.map((p) => p.url);

  run.pushMode = cfg.notifyTelegram === false ? 'off' : 'on';
  if (cfg.notifyTelegram === false) {
    log('推播已關閉：線索只存進控制台');
    if (firstRun) newPosts.forEach((p) => (p.initial = true));
  } else if (firstRun) {
    newPosts.forEach((p) => (p.initial = true));
    await notify({
      html: `✅ <b>小球脆雷達已啟動</b>\n已記錄目前 ${newPosts.length} 則符合的舊貼文（不逐則推播），之後的新貼文會即時通知你。`,
    }, env);
  } else {
    for (const p of newPosts.slice(0, cfg.maxNotifyPerRun)) {
      if (await notify(formatPost(p), env)) run.notified++;
      await sleep(1100);
    }
    const rest = newPosts.length - cfg.maxNotifyPerRun;
    if (rest > 0) await notify({ html: `📋 還有 <b>${rest}</b> 則新線索，請到控制台查看。` }, env);
  }

  if (run.status === 'warn' && cfg.notifyErrors) {
    const last = Date.parse(doc.lastWarnAt) || 0;
    if (Date.now() - last > 6 * 3600e3) {
      await notify({ html: `⚠️ <b>小球脆雷達警告</b>\n${escHtml(run.warnings.join('\n'))}` }, env);
      doc.lastWarnAt = new Date().toISOString();
    }
  }

  doc.posts = [...newPosts, ...(doc.posts || [])].slice(0, cfg.maxStoredPosts);
  store.saveSeen(seen);
  log(`完成：掃描 ${run.scanned}、新線索 ${run.newCount}、推播 ${run.notified}`);
  return finish();
}

async function sendTestNotification(env = process.env) {
  const ok = await notify({
    html: '🧪 <b>小球脆雷達測試通知</b>\n如果你看到這則訊息，代表推播設定成功！',
  }, env);
  if (!ok) throw new Error('推播失敗：請檢查 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID（或 LINE 設定）');
  return ok;
}

module.exports = {
  DEFAULT_CONFIG, loadConfig, normUser, FileStore, parseCookies, extractInPage, scrapeKeyword,
  matchPost, formatPost, notify, runScan, sendTestNotification, shouldScan, inQuiet, pickNext, restHours, pickKeywords,
};
