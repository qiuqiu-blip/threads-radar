/* 小球脆雷達｜官網跑馬燈管理（控制台用）
 * 資料存在 data/marquee.json，官網的 marquee.js 會每 5 分鐘讀一次。
 */
(function () {
  'use strict';
  // 兩個獨立的跑馬燈：官網（客人看）、後台（自己看），存不同檔案、內容互不影響
  var CH = {
    site: { path: 'data/marquee.json', name: '官網', icon: '📢', label: '📢 最新消息', attr: '', local: 'tr_marquee' },
    admin: { path: 'data/marquee-admin.json', name: '後台', icon: '🗂', label: '🗂 新線索', attr: ' data-feed="admin"', local: 'tr_marqueeAdmin' },
  };
  var M = window.MQ = { doc: null, sha: null, ch: 'site' };
  function C() { return CH[M.ch] || CH.site; }
  function ad() { try { return adapter(); } catch (e) { return null; } }
  function e(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function blank() { return { v: 1, label: C().label, speed: 80, items: [] }; }

  // 把別人的貼文整理成適合放官網的一句話：拿掉電話、帳號、網址、LINE ID
  M.clean = function (txt) {
    var s = String(txt || '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/@[\w.]+/g, '')
      .replace(/(line|LINE|賴)\s*(id|ID)?\s*[:：]?\s*[\w.@-]{3,}/g, '')
      .replace(/(?<!\d)(\+?886[-\s]?|0)9\d{2}[-\s]?\d{3}[-\s]?\d{3}/g, '')
      .replace(/(?<!\d)0\d{1,2}[-\s]?\d{3,4}[-\s]?\d{4}/g, '')
      .replace(/#\S+/g, '')
      .replace(/\s+/g, ' ').trim();
    return s.length > 120 ? s.slice(0, 118) + '…' : s;
  };
  M.embed = function () {
    var c = {}; try { c = JSON.parse(localStorage.getItem('tr_conn') || '{}'); } catch (x) { /* 略過 */ }
    var base = c.owner && c.repo ? 'https://' + c.owner.toLowerCase() + '.github.io/' + c.repo + '/' : location.href.replace(/[^/]*$/, '');
    return '<script src="' + base + 'marquee.js"' + C().attr + '></script>';
  };
  M.load = async function (ch) {
    if (ch) M.ch = ch;
    var a = ad(); if (!a) { M.doc = JSON.parse(localStorage.getItem(C().local) || 'null') || blank(); return M.doc; }
    var m = await a.getMeta(C().path); M.doc = (m && m.data) || blank(); M.sha = m && m.sha; return M.doc;
  };
  M.save = async function (msg) {
    M.doc.updatedAt = Date.now();
    var a = ad(); if (!a) { localStorage.setItem(C().local, JSON.stringify(M.doc)); return; }
    try { M.sha = await a.putJson(C().path, M.doc, M.sha, msg || '更新' + C().name + '跑馬燈'); }
    catch (x) { // 別台平板剛改過 → 合併後再存一次
      if (!/409|422|sha/i.test(String(x.message))) throw x;
      var mine = M.doc; await M.load(); var ids = {}; M.doc.items.forEach(function (i) { ids[i.id] = 1; });
      mine.items.forEach(function (i) { if (!ids[i.id]) M.doc.items.push(i); });
      M.doc.label = mine.label; M.doc.speed = mine.speed;
      M.sha = await a.putJson(C().path, M.doc, M.sha, msg || '更新' + C().name + '跑馬燈');
    }
  };
  function live(x) { return x.on !== false && (!x.until || x.until > Date.now()); }
  function left(x) { if (!x.until) return '一直播'; var d = Math.ceil((x.until - Date.now()) / 864e5); return d > 0 ? '剩 ' + d + ' 天' : '已到期'; }

  function overlay(html) {
    var o = document.getElementById('mqOv'); if (o) o.remove();
    o = document.createElement('div'); o.id = 'mqOv'; o.innerHTML = '<div class="card">' + html + '</div>';
    o.addEventListener('click', function (ev) { if (ev.target === o || ev.target.closest('[data-mqclose]')) o.remove(); });
    document.body.appendChild(o); return o;
  }
  function listHtml() {
    var it = (M.doc.items || []).slice().sort(function (a, b) { return b.at - a.at; });
    if (!it.length) return '<div class="hint">' + C().name + '上還沒有跑馬燈文字。</div>';
    return it.map(function (x) {
      return '<div class="mqrow ' + (live(x) ? '' : 'off') + '"><div class="mqtxt">' + e(x.text) + '<div class="hint" style="margin:4px 0 0">' + (live(x) ? '🟢 播放中' : '⚪ 沒在播') + '・' + left(x) + (x.link && x.link !== x.src ? '・🔗 點了開你的連結' : (!x.noLink && x.src ? '・🔗 點了開原貼文' : '')) + '</div></div>' +
        '<div class="mqbtn"><button class="btn ghost sm" data-mqtog="' + e(x.id) + '">' + (x.on === false ? '▶ 播放' : '⏸ 暫停') + '</button><button class="btn ghost sm" data-mqdel="' + e(x.id) + '">🗑</button></div></div>';
    }).join('');
  }
  function bindList(o) {
    o.addEventListener('click', async function (ev) {
      var t = ev.target.closest('[data-mqtog],[data-mqdel]'); if (!t) return;
      var id = t.dataset.mqtog || t.dataset.mqdel; var x = M.doc.items.find(function (i) { return i.id === id; }); if (!x) return;
      if (t.dataset.mqdel) M.doc.items = M.doc.items.filter(function (i) { return i.id !== id; }); else x.on = x.on === false;
      t.disabled = true;
      try { await M.save(t.dataset.mqdel ? '跑馬燈：刪除一則' : '跑馬燈：暫停／播放'); toast('✅ 已更新，' + C().name + '約 5 分鐘內跟著變'); } catch (er) { toast('存檔失敗：' + er.message); }
      var l = o.querySelector('#mqList'); if (l) l.innerHTML = listHtml();
    });
  }

  // 從線索卡片按「📢 上官網」或「🗂 上後台」
  M.openFromPost = async function (p, ch) {
    try { await M.load(ch || 'site'); } catch (x) { toast('讀取跑馬燈失敗：' + x.message); return; }
    var site = M.ch === 'site', c = C();
    var txt = site ? M.clean(p.text) : String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 150);
    var o = overlay(
      '<h3 style="margin:0 0 6px">' + c.icon + ' 放到' + c.name + '跑馬燈</h3>' +
      (site
        ? '<div class="hint">這是<b>客人看得到</b>的官網。已自動拿掉對方的帳號、電話、LINE、網址，<b>建議改寫成你自己的話</b>，例如「台中北屯 飲料店頂讓中，設備齊全，歡迎洽詢小球球」。</div>'
        : '<div class="hint">這是<b>只有你看得到</b>的官網後台。點跑馬燈文字會<b>直接開啟這則原貼文</b>，方便你隨時跟進。</div>') +
      '<label class="hint">跑馬燈文字<textarea id="mqText" rows="4" maxlength="200" style="width:100%;font-size:18px">' + e(txt) + '</textarea></label>' +
      '<div class="hint" style="text-align:right;margin:0" id="mqCnt"></div>' +
      '<label class="hint">播放多久<select id="mqDays" style="width:100%;font-size:17px"><option value="1">1 天</option><option value="3"' + (site ? '' : ' selected') + '>3 天</option><option value="7"' + (site ? ' selected' : '') + '>7 天</option><option value="14">14 天</option><option value="30">30 天</option><option value="0">一直播（自己刪才停）</option></select></label>' +
      (site
        ? '<label class="hint">點跑馬燈文字時<select id="mqOpen" style="width:100%;font-size:17px"><option value="none">不開任何東西</option><option value="link">開啟我填的連結</option><option value="src">開啟這則原貼文（Threads）</option></select></label>' +
          '<label class="hint" id="mqLinkRow" style="display:none">我的連結（例如 LINE 官方帳號網址）<input id="mqLink" placeholder="https://" style="width:100%;font-size:16px" value="' + e(localStorage.getItem('tr_mqLink') || '') + '"></label>'
        : '<div class="hint">🔗 點文字 → 開啟原貼文：<span style="word-break:break-all">' + e(p.url) + '</span></div>') +
      '<div class="acts" style="margin-top:12px"><button class="btn" id="mqGo">' + c.icon + ' 送到' + c.name + '</button><button class="btn ghost" data-mqclose>取消</button></div>' +
      '<h3 style="margin:18px 0 6px">目前' + c.name + '上的跑馬燈</h3><div id="mqList">' + listHtml() + '</div>');
    var ta = o.querySelector('#mqText'), cnt = o.querySelector('#mqCnt'), sel = o.querySelector('#mqOpen');
    if (sel) { var showLink = function () { o.querySelector('#mqLinkRow').style.display = sel.value === 'link' ? 'block' : 'none'; }; sel.onchange = showLink; showLink(); }
    var upd = function () { cnt.textContent = ta.value.length + ' / 200 字'; }; ta.oninput = upd; upd();
    bindList(o);
    o.querySelector('#mqGo').onclick = async function () {
      var text = ta.value.trim(); if (!text) { toast('請先寫跑馬燈文字'); return; }
      var days = Number(o.querySelector('#mqDays').value), how = sel ? sel.value : 'src', typed = sel ? o.querySelector('#mqLink').value.trim() : '';
      if (how === 'link' && !/^https?:\/\//.test(typed)) { toast('連結要用 https:// 開頭'); return; }
      var link = how === 'link' ? typed : how === 'src' ? p.url : '';
      try { if (how === 'link') localStorage.setItem('tr_mqLink', typed); } catch (x) { /* 略過 */ }
      M.doc.items = M.doc.items || [];
      M.doc.items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: text, link: link, noLink: how === 'none', at: Date.now(), until: days ? Date.now() + days * 864e5 : 0, on: true, src: p.url });
      M.doc.items = M.doc.items.filter(function (x) { return !x.until || x.until > Date.now() - 30 * 864e5; }).slice(-50);
      this.disabled = true; this.textContent = '傳送中…';
      try { await M.save('跑馬燈：新增一則'); toast(c.icon + ' 已送到' + c.name + '！約 5 分鐘內出現在最上方'); o.remove(); }
      catch (x) { toast('傳送失敗：' + x.message); this.disabled = false; this.textContent = c.icon + ' 送到' + c.name; }
    };
  };

  // 設定頁「管理」
  M.openManage = async function (ch) {
    try { await M.load(ch || 'site'); } catch (x) { toast('讀取跑馬燈失敗：' + x.message); return; }
    var o = overlay(
      '<div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">' + C().icon + ' ' + C().name + '跑馬燈管理</h3><button class="btn ghost sm" data-mqclose>✕ 關閉</button></div>' +
      '<label class="hint">左邊金色標籤的字<input id="mqLabel" value="' + e(M.doc.label || C().label) + '" style="width:100%;font-size:17px"></label>' +
      '<label class="hint">跑的速度<select id="mqSpeed" style="width:100%;font-size:17px">' + [[50, '慢'], [80, '普通'], [120, '快']].map(function (s) { return '<option value="' + s[0] + '"' + (Number(M.doc.speed || 80) === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') + '</select></label>' +
      '<div class="acts" style="margin-top:8px"><button class="btn sm" id="mqSaveSet">💾 儲存設定</button></div>' +
      '<h3 style="margin:18px 0 6px">目前的跑馬燈</h3><div id="mqList">' + listHtml() + '</div>' +
      '<h3 style="margin:18px 0 6px">接到' + C().name + '（已經幫你裝好了）</h3><div class="hint">' + C().name + '的 HTML 裡要有下面這一行（放在 &lt;body&gt; 後面）。</div>' +
      '<textarea id="mqEmbed" readonly rows="2" style="width:100%;font-size:15px">' + e(M.embed()) + '</textarea>' +
      '<div class="acts" style="margin-top:8px"><button class="btn sm" id="mqCopy">📋 複製這一行</button></div>');
    bindList(o);
    o.querySelector('#mqCopy').onclick = function () { copyText(o.querySelector('#mqEmbed').value).then(function () { toast('📋 已複製，貼到官網就好'); }); };
    o.querySelector('#mqSaveSet').onclick = async function () {
      M.doc.label = o.querySelector('#mqLabel').value.trim() || C().label; M.doc.speed = Number(o.querySelector('#mqSpeed').value) || 80;
      try { await M.save('跑馬燈：設定'); toast('✅ 已儲存'); } catch (x) { toast('存檔失敗：' + x.message); }
    };
  };
})();
