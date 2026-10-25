/* 小球脆雷達｜官網跑馬燈
 * 在官網 <body> 裡任何地方貼這一行就好：
 *   <script src="https://你的帳號.github.io/threads-radar/marquee.js"></script>
 * 可選設定（寫在 script 標籤上）：
 *   data-fixed="1"   固定在畫面最上方（預設：放在網頁最上面，跟著網頁捲動）
 *   data-speed="80"  每秒移動幾個像素（預設 80）
 */
(function () {
  'use strict';
  var me = document.currentScript;
  var SRC = new URL('data/marquee.json', me && me.src ? me.src : location.href).href;
  var fixed = me && me.getAttribute('data-fixed') === '1';
  var speedAttr = me && Number(me.getAttribute('data-speed'));
  var box, track, lastKey = '';

  function css() {
    if (document.getElementById('qqmq-css')) return;
    var s = document.createElement('style'); s.id = 'qqmq-css';
    s.textContent =
      '#qqmq{' + (fixed ? 'position:fixed;top:0;left:0;right:0;z-index:450;' : 'position:relative;z-index:1;') + 'overflow:hidden;height:44px;display:flex;align-items:center;' +
      'background:linear-gradient(180deg,#1d150a,#0b0906);border-bottom:2px solid #d4af37;box-shadow:0 2px 12px rgba(0,0,0,.35);font:600 17px/1 "Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif}' +
      '#qqmq .qqmq-lb{flex:none;height:100%;display:flex;align-items:center;padding:0 14px;background:linear-gradient(180deg,#ffd95a,#d4a017);color:#2a1a00;font-weight:900;letter-spacing:.05em;position:relative;z-index:2}' +
      '#qqmq .qqmq-vp{flex:1;overflow:hidden;height:100%;position:relative;-webkit-mask:linear-gradient(90deg,transparent,#000 4%,#000 96%,transparent);mask:linear-gradient(90deg,transparent,#000 4%,#000 96%,transparent)}' +
      '#qqmq .qqmq-tr{position:absolute;top:0;left:0;height:100%;display:flex;align-items:center;white-space:nowrap;will-change:transform;animation:qqmq-run var(--d,30s) linear infinite}' +
      '#qqmq:hover .qqmq-tr{animation-play-state:paused}' +
      '#qqmq .qqmq-it{color:#ffe9a8;text-decoration:none;padding:0 6px}' +
      '#qqmq a.qqmq-it:hover{color:#fff;text-decoration:underline}' +
      '#qqmq .qqmq-sp{color:#d4af37;padding:0 22px}' +
      '#qqmq .qqmq-x{flex:none;background:none;border:0;color:#a8945e;font-size:20px;padding:0 12px;cursor:pointer;height:100%}' +
      '@keyframes qqmq-run{from{transform:translateX(0)}to{transform:translateX(-50%)}}' +
      '@media (max-width:600px){#qqmq{height:38px;font-size:15px}#qqmq .qqmq-lb{padding:0 10px}}' +
      '@media (prefers-reduced-motion:reduce){#qqmq .qqmq-tr{animation-duration:calc(var(--d,30s)*2)}}';
    document.head.appendChild(s);
  }
  function esc(t) { return String(t).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function render(doc) {
    var now = Date.now();
    var items = ((doc && doc.items) || []).filter(function (x) { return x && x.on !== false && x.text && (!x.until || x.until > now); });
    var key = JSON.stringify([items, doc && doc.label, doc && doc.speed]);
    if (key === lastKey) return; lastKey = key;
    if (!items.length) { if (box) { box.remove(); box = null; } if (fixed) document.body.style.paddingTop = ''; return; }
    try { if (sessionStorage.getItem('qqmq-hide') === key) return; } catch (e) { /* 略過 */ }
    css();
    if (!box) {
      box = document.createElement('div'); box.id = 'qqmq'; box.setAttribute('role', 'marquee');
      box.innerHTML = '<div class="qqmq-lb"></div><div class="qqmq-vp"><div class="qqmq-tr"></div></div><button class="qqmq-x" aria-label="關閉">✕</button>';
      document.body.insertBefore(box, document.body.firstChild);
      box.querySelector('.qqmq-x').onclick = function () { try { sessionStorage.setItem('qqmq-hide', lastKey); } catch (e) { /* 略過 */ } box.remove(); box = null; if (fixed) document.body.style.paddingTop = ''; };
      track = box.querySelector('.qqmq-tr');
    }
    box.querySelector('.qqmq-lb').textContent = (doc && doc.label) || '📢 最新消息';
    var one = items.map(function (x) {
      var t = esc(x.text.replace(/\s+/g, ' '));
      return x.link ? '<a class="qqmq-it" href="' + esc(x.link) + '" target="_blank" rel="noopener">' + t + '</a>' : '<span class="qqmq-it">' + t + '</span>';
    }).join('<span class="qqmq-sp">★</span>') + '<span class="qqmq-sp">★</span>';
    track.innerHTML = one;
    var vw = box.querySelector('.qqmq-vp').clientWidth || window.innerWidth;
    // 內容不夠長時重複幾次，確保跑起來不會有空白
    var rep = 1; while (track.scrollWidth * rep < vw * 1.2 && rep < 12) rep++;
    track.innerHTML = new Array(rep * 2 + 1).join(one);
    var speed = speedAttr || Number(doc && doc.speed) || 80;
    track.style.setProperty('--d', Math.max(8, (track.scrollWidth / 2) / speed) + 's');
    if (fixed) document.body.style.paddingTop = box.offsetHeight + 'px';
  }
  function load() {
    fetch(SRC + '?_=' + Math.floor(Date.now() / 60000), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(render).catch(function () { /* 沒網路就不顯示 */ });
  }
  function start() { load(); setInterval(load, 5 * 60 * 1000); }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
