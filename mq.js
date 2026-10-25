/* 小球脆雷達｜官網跑馬燈管理（控制台用）
 * 資料存在 data/marquee.json，官網的 marquee.js 會每 5 分鐘讀一次。
 */
(function () {
  'use strict';
  var PATH = 'data/marquee.json';
  var M = window.MQ = { doc: null, sha: null };
  function ad() { try { return adapter(); } catch (e) { return null; } }
  function e(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function blank() { return { v: 1, label: '📢 最新消息', speed: 80, items: [] }; }

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
    return '<script src="' + base + 'marquee.js"></script>';
  };
  M.load = async function () {
    var a = ad(); if (!a) { M.doc = JSON.parse(localStorage.getItem('tr_marquee') || 'null') || blank(); return M.doc; }
    var m = await a.getMeta(PATH); M.doc = (m && m.data) || blank(); M.sha = m && m.sha; return M.doc;
  };
  M.save = async function (msg) {
    M.doc.updatedAt = Date.now();
    var a = ad(); if (!a) { localStorage.setItem('tr_marquee', JSON.stringify(M.doc)); return; }
    try { M.sha = await a.putJson(PATH, M.doc, M.sha, msg || '更新官網跑馬燈'); }
    catch (x) { // 別台平板剛改過 → 合併後再存一次
      if (!/409|422|sha/i.test(String(x.message))) throw x;
      var mine = M.doc; await M.load(); var ids = {}; M.doc.items.forEach(function (i) { ids[i.id] = 1; });
      mine.items.forEach(function (i) { if (!ids[i.id]) M.doc.items.push(i); });
      M.doc.label = mine.label; M.doc.speed = mine.speed;
      M.sha = await a.putJson(PATH, M.doc, M.sha, msg || '更新官網跑馬燈');
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
    if (!it.length) return '<div class="hint">官網上還沒有跑馬燈文字。</div>';
    return it.map(function (x) {
      return '<div class="mqrow ' + (live(x) ? '' : 'off') + '"><div class="mqtxt">' + e(x.text) + '<div class="hint" style="margin:4px 0 0">' + (live(x) ? '🟢 播放中' : '⚪ 沒在播') + '・' + left(x) + (x.link ? '・🔗 有連結' : '') + '</div></div>' +
        '<div class="mqbtn"><button class="btn ghost sm" data-mqtog="' + e(x.id) + '">' + (x.on === false ? '▶ 播放' : '⏸ 暫停') + '</button><button class="btn ghost sm" data-mqdel="' + e(x.id) + '">🗑</button></div></div>';
    }).join('');
  }
  function bindList(o) {
    o.addEventListener('click', async function (ev) {
      var t = ev.target.closest('[data-mqtog],[data-mqdel]'); if (!t) return;
      var id = t.dataset.mqtog || t.dataset.mqdel; var x = M.doc.items.find(function (i) { return i.id === id; }); if (!x) return;
      if (t.dataset.mqdel) M.doc.items = M.doc.items.filter(function (i) { return i.id !== id; }); else x.on = x.on === false;
      t.disabled = true;
      try { await M.save(t.dataset.mqdel ? '跑馬燈：刪除一則' : '跑馬燈：暫停／播放'); toast('✅ 已更新，官網約 5 分鐘內跟著變'); } catch (er) { toast('存檔失敗：' + er.message); }
      var l = o.querySelector('#mqList'); if (l) l.innerHTML = listHtml();
    });
  }

  // 從線索卡片按「📢 上官網」
  M.openFromPost = async function (p) {
    try { await M.load(); } catch (x) { toast('讀取跑馬燈失敗：' + x.message); return; }
    var o = overlay(
      '<h3 style="margin:0 0 6px">📢 放到官網跑馬燈</h3>' +
      '<div class="hint">已自動拿掉對方的帳號、電話、LINE、網址。<b>建議改寫成你自己的話</b>，例如「台中北屯 飲料店頂讓中，設備齊全，歡迎洽詢小球球」。</div>' +
      '<label class="hint">跑馬燈文字<textarea id="mqText" rows="4" maxlength="200" style="width:100%;font-size:18px">' + e(M.clean(p.text)) + '</textarea></label>' +
      '<div class="hint" style="text-align:right;margin:0" id="mqCnt"></div>' +
      '<label class="hint">播放多久<select id="mqDays" style="width:100%;font-size:17px"><option value="1">1 天</option><option value="3">3 天</option><option value="7" selected>7 天</option><option value="14">14 天</option><option value="30">30 天</option><option value="0">一直播（自己刪才停）</option></select></label>' +
      '<label class="hint">點文字要連去哪裡（可不填，例如你的 LINE 官方帳號網址）<input id="mqLink" placeholder="https://" style="width:100%;font-size:16px" value="' + e(localStorage.getItem('tr_mqLink') || '') + '"></label>' +
      '<div class="acts" style="margin-top:12px"><button class="btn" id="mqGo">📢 送到官網</button><button class="btn ghost" data-mqclose>取消</button></div>' +
      '<h3 style="margin:18px 0 6px">目前官網上的跑馬燈</h3><div id="mqList">' + listHtml() + '</div>');
    var ta = o.querySelector('#mqText'), cnt = o.querySelector('#mqCnt');
    var upd = function () { cnt.textContent = ta.value.length + ' / 200 字'; }; ta.oninput = upd; upd();
    bindList(o);
    o.querySelector('#mqGo').onclick = async function () {
      var text = ta.value.trim(); if (!text) { toast('請先寫跑馬燈文字'); return; }
      var days = Number(o.querySelector('#mqDays').value), link = o.querySelector('#mqLink').value.trim();
      if (link && !/^https?:\/\//.test(link)) { toast('連結要用 https:// 開頭'); return; }
      try { localStorage.setItem('tr_mqLink', link); } catch (x) { /* 略過 */ }
      M.doc.items = M.doc.items || [];
      M.doc.items.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: text, link: link, at: Date.now(), until: days ? Date.now() + days * 864e5 : 0, on: true, src: p.url });
      M.doc.items = M.doc.items.filter(function (x) { return !x.until || x.until > Date.now() - 30 * 864e5; }).slice(-50);
      this.disabled = true; this.textContent = '傳送中…';
      try { await M.save('跑馬燈：新增一則'); toast('📢 已送到官網！約 5 分鐘內出現在官網最上方'); o.remove(); }
      catch (x) { toast('傳送失敗：' + x.message); this.disabled = false; this.textContent = '📢 送到官網'; }
    };
  };

  // 設定頁「管理」
  M.openManage = async function () {
    try { await M.load(); } catch (x) { toast('讀取跑馬燈失敗：' + x.message); return; }
    var o = overlay(
      '<div style="display:flex;justify-content:space-between;align-items:center"><h3 style="margin:0">📢 官網跑馬燈管理</h3><button class="btn ghost sm" data-mqclose>✕ 關閉</button></div>' +
      '<label class="hint">左邊金色標籤的字<input id="mqLabel" value="' + e(M.doc.label || '📢 最新消息') + '" style="width:100%;font-size:17px"></label>' +
      '<label class="hint">跑的速度<select id="mqSpeed" style="width:100%;font-size:17px">' + [[50, '慢'], [80, '普通'], [120, '快']].map(function (s) { return '<option value="' + s[0] + '"' + (Number(M.doc.speed || 80) === s[0] ? ' selected' : '') + '>' + s[1] + '</option>'; }).join('') + '</select></label>' +
      '<div class="acts" style="margin-top:8px"><button class="btn sm" id="mqSaveSet">💾 儲存設定</button></div>' +
      '<h3 style="margin:18px 0 6px">目前的跑馬燈</h3><div id="mqList">' + listHtml() + '</div>' +
      '<h3 style="margin:18px 0 6px">接到官網（只要做一次）</h3><div class="hint">把下面這一行貼到官網的 HTML 裡（放在 &lt;body&gt; 後面），官網最上方就會出現跑馬燈。</div>' +
      '<textarea id="mqEmbed" readonly rows="2" style="width:100%;font-size:15px">' + e(M.embed()) + '</textarea>' +
      '<div class="acts" style="margin-top:8px"><button class="btn sm" id="mqCopy">📋 複製這一行</button></div>');
    bindList(o);
    o.querySelector('#mqCopy').onclick = function () { copyText(o.querySelector('#mqEmbed').value).then(function () { toast('📋 已複製，貼到官網就好'); }); };
    o.querySelector('#mqSaveSet').onclick = async function () {
      M.doc.label = o.querySelector('#mqLabel').value.trim() || '📢 最新消息'; M.doc.speed = Number(o.querySelector('#mqSpeed').value) || 80;
      try { await M.save('跑馬燈：設定'); toast('✅ 已儲存'); } catch (x) { toast('存檔失敗：' + x.message); }
    };
  };
})();
