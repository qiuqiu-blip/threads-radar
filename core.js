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
  keywords: ['頂讓', '盤讓', '設備轉讓', '搬家出清'],
  regions: [],
  excludeWords: [],
  regionRequired: false,
  strictKeyword: true,
  firstRunSilent: true,
  notifyErrors: true,
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
const cleanList = (arr) => [...new Set((Array.isArray(arr) ? arr : []).map((s) => String(s).trim()).filter(Boolean))];

function loadConfig(file = path.join(ROOT, 'config.json')) {
  const cfg = { ...DEFAULT_CONFIG, ...readJson(file, {}) };
  cfg.keywords = cleanList(cfg.keywords);
  cfg.regions = cleanList(cfg.regions);
  cfg.excludeWords = cleanList(cfg.excludeWords);
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
}

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
  const text = norm(`${post.text}\n${post.user}`);
  const keywords = cfg.keywords.filter((k) => text.includes(norm(k)));
  if (cfg.strictKeyword && keywords.length === 0) return null;
  if (cfg.excludeWords.some((w) => text.includes(norm(w)))) return null;
  const regions = cfg.regions.filter((r) => text.includes(norm(r)));
  if (cfg.regionRequired && cfg.regions.length && regions.length === 0) return null;
  if (cfg.maxAgeHours > 0 && post.time) {
    const t = Date.parse(post.time);
    if (!isNaN(t) && Date.now() - t > cfg.maxAgeHours * 3600e3) return null;
  }
  return { ...post, keywords: keywords.length ? keywords : [foundBy], regions, foundBy };
}

/* ---------------- 推播 ---------------- */
const escHtml = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function formatPost(p) {
  const tags = [...p.keywords, ...p.regions].join('・');
  const body = p.text.length > 350 ? p.text.slice(0, 350) + '…' : p.text;
  return {
    html: `🔔 <b>脆新線索｜${escHtml(tags)}</b>\n👤 <a href="${p.authorUrl}">@${escHtml(p.user)}</a>\n\n${escHtml(body)}\n\n🔗 <a href="${p.url}">開啟貼文</a>`,
    plain: `🔔 脆新線索｜${tags}\n👤 @${p.user}\n${p.authorUrl}\n\n${body}\n\n🔗 ${p.url}`,
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

/* ---------------- 主流程（方案 A / B 共用） ---------------- */
async function runScan({ chromium, cfg = loadConfig(), store = new FileStore(), env = process.env, log = console.log }) {
  const run = {
    startedAt: new Date().toISOString(), finishedAt: null, status: 'ok',
    scanned: 0, matched: 0, newCount: 0, notified: 0, perKeyword: {}, warnings: [],
  };
  const doc = store.getDoc();
  const finish = () => {
    run.finishedAt = new Date().toISOString();
    doc.lastRun = run;
    doc.runs = [run, ...(doc.runs || [])].slice(0, 30);
    store.saveDoc(doc);
    return run;
  };

  if (!cfg.enabled) { run.status = 'paused'; log('監控已暫停'); return finish(); }
  if (!cfg.keywords.length) { run.status = 'warn'; run.warnings.push('沒有設定關鍵字'); return finish(); }

  const seen = store.getSeen();
  const firstRun = seen.size === 0 && cfg.firstRunSilent;
  const scannedItems = [];
  let loginWall = false;

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      locale: 'zh-TW', timezoneId: 'Asia/Taipei', viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    });
    const cookies = parseCookies(env.THREADS_COOKIES);
    if (cookies.length) await context.addCookies(cookies);
    else run.warnings.push('未設定 THREADS_COOKIES，以未登入狀態搜尋（結果可能很少）');
    const page = await context.newPage();

    for (const kw of cfg.keywords) {
      try {
        const r = await scrapeKeyword(page, kw, { scrolls: cfg.scrollsPerKeyword });
        run.perKeyword[kw] = r.items.length;
        if (r.loginWall) loginWall = true;
        for (const it of r.items) scannedItems.push({ it, kw });
        log(`「${kw}」抓到 ${r.items.length} 則`);
      } catch (e) {
        run.perKeyword[kw] = -1;
        run.warnings.push(`「${kw}」失敗：${e.message.split('\n')[0]}`);
      }
      await sleep(rand(3000, 6000));
    }
  } finally {
    await browser.close();
  }

  run.scanned = scannedItems.length;
  if (loginWall) { run.status = 'warn'; run.warnings.push('Threads 要求登入，THREADS_COOKIES 可能已失效'); }

  const fresh = new Map();
  for (const { it, kw } of scannedItems) {
    if (seen.has(it.url) || fresh.has(it.url)) continue;
    const m = matchPost(it, cfg, kw);
    if (m) fresh.set(it.url, { ...m, foundAt: new Date().toISOString() });
  }
  scannedItems.forEach(({ it }) => seen.add(it.url));
  const newPosts = [...fresh.values()].sort((a, b) => (Date.parse(b.time) || 0) - (Date.parse(a.time) || 0));
  run.matched = run.newCount = newPosts.length;

  if (firstRun) {
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
  DEFAULT_CONFIG, loadConfig, FileStore, parseCookies, extractInPage, scrapeKeyword,
  matchPost, formatPost, notify, runScan, sendTestNotification,
};
