/**
 * 小球脆雷達 — 貼文分析（網頁與雷達共用）
 * 1. 意向等級：高／中／低（附理由）
 * 2. 角色：賣方／買方／同業
 * 3. 重點擷取：地區、行政區、店型、設備、電話、LINE、價格、坪數、租金
 * 4. 回覆類型：頂讓／收店／設備／出清／買方／一般
 * 全部用規則判斷，免費、即時。
 */
(function (root) {
  'use strict';
  const CITY = /(台北|新北|基隆|桃園|新竹|苗栗|台中|彰化|南投|雲林|嘉義|台南|高雄|屏東|宜蘭|花蓮|台東|澎湖|金門)/;
  const DIST = /([一-龥]{1,2}區)/g;
  const NOT_DIST = /^(市區|社區|園區|地區|學區|山區|景區|全區|各區|本區|該區|此區|這區|那區|災區|分區|小區|郊區|業區)$/;
  const SHOP = /(火鍋|咖啡|早午餐|早餐|便當|手搖|飲料|茶飲|拉麵|麵店|麵館|熱炒|燒烤|燒肉|小吃|餐酒館|居酒屋|烘焙|麵包|甜點|冰店|滷味|炸物|鹽酥雞|牛排|日式料理|韓式|義式|泰式|越式|自助餐|快餐|酒吧|鐵板燒|壽司|丼飯|水餃|鍋貼|豆花|蛋糕|披薩|漢堡|餐廳|小館|食堂|美髮|美甲|服飾)/;
  const EQUIP = /(冷凍櫃|冷藏櫃|冰箱|製冰機|咖啡機|磨豆機|蒸烤箱|烤箱|快速爐|爐具|炸爐|煮麵機|工作台|排油煙機|洗碗機|封口機|飲料機|蒸飯箱|冰淇淋機|果汁機|微波爐|保溫櫃|展示櫃|收銀機|桌椅|冷氣|招牌)/g;
  const PHONE = /(09\d{2}[-\s]?\d{3}[-\s]?\d{3})/;
  const LINE = /(?:line|LINE|Line|賴)\s*(?:id|ID|Id)?\s*[:：@]?\s*([A-Za-z0-9._\-@]{3,30})/;
  const PRICE = /((?:頂讓金|頂讓費|頂讓價|轉讓金|售價|價格|帶走價|一口價|只要|總價)\s*[:：]?\s*\$?\s*\d+(?:\.\d+)?\s*(?:萬|元|k|K)?|\d+(?:\.\d+)?\s*萬(?:元)?|\$\s?\d{3,}|\d{4,}\s*元)/;
  const AREA = /(\d+(?:\.\d+)?\s*坪)/;
  const RENT = /(?:租金|月租)\s*[:：]?\s*(\d+(?:\.\d+)?\s*(?:萬|元|k|K)?)/;

  const RX_PEER = /(高價收購|專業收購|收購各式|回收各式|大量收購|到府估價|到府收購|現金收購|專業回收|二手設備回收|免費估價|歡迎詢問收購)/;
  const RX_BUYER = /(徵求|徵店|求頂|想頂|想接手|想承接|找店面|找店|想找.{0,4}(店面|店|點)|尋找.{0,4}(店面|店)|求購|想買|有人要頂讓嗎|誰要頂讓|預算.{0,6}萬)/;
  const RX = {
    頂讓: /頂讓|盤讓|頂店|讓渡|店面轉讓|店鋪轉讓|店舖轉讓|整店轉讓|免頂讓/,
    收店: /收店|結束營業|歇業|關店|收攤|退租|不做了|熄燈|停業/,
    設備: /設備|生財|器具|冰箱|冷凍|冷藏|製冰|蒸烤箱|烤箱|爐|咖啡機|工作台|排油煙|洗碗機|炸鍋|煮麵/,
    出清: /出清|清倉|便宜賣|帶走價|低價|整批|拍賣/
  };
  const RX_URGENT = /(急|盡快|儘快|月底|本月|這個月|限時|馬上|立即|即可交接|隨時可|可立即|最後|倒數|前搬走|前要|趕快)/;

  function uniq(a) { return [...new Set(a)]; }

  function analyzePost(p, opts) {
    opts = opts || {};
    const raw = String((p && p.text) || '');
    const s = raw.replace(/臺/g, '台');
    const now = opts.now || Date.now();

    /* 重點擷取 */
    const city = (p.regions && p.regions[0]) || (s.match(CITY) || [])[1] || '';
    const district = (s.match(DIST) || []).find((d) => !NOT_DIST.test(d) && !NOT_DIST.test(d.slice(-2))) || '';
    const shopM = s.match(SHOP);
    let shop = shopM ? shopM[1] : '';
    if (shop && !/店|餐廳|小館|食堂|酒吧|居酒屋|餐酒館|館/.test(shop)) shop += '店';
    const equip = uniq(s.match(EQUIP) || []).slice(0, 6);
    const phone = (s.match(PHONE) || [])[1] || '';
    const line = (s.match(LINE) || [])[1] || '';
    const price = ((s.match(PRICE) || [])[1] || '').replace(/\s+/g, '');
    const area = ((s.match(AREA) || [])[1] || '').replace(/\s+/g, '');
    const rent = ((s.match(RENT) || [])[1] || '').replace(/\s+/g, '');
    const info = { city, district, shop, equip, phone, line, price, area, rent };

    /* 角色 */
    let role = '賣方';
    if (RX_PEER.test(s)) role = '同業';
    else if (RX_BUYER.test(s)) role = '買方';

    /* 回覆類型 */
    let cat = '一般';
    if (role === '買方') cat = '買方';
    else for (const c of ['頂讓', '收店', '設備', '出清']) if (RX[c].test(s + ' ' + (p.keywords || []).join(' '))) { cat = c; break; }

    /* 意向分數 */
    const reasons = [];
    let score = 0;
    if (phone || line || /私訊|私聊|聯絡|聯繫|洽|來電|電話|加賴|加line/i.test(s)) { score += 3; reasons.push(phone || line ? '有留聯絡方式' : '請人私訊聯絡'); }
    if (RX_URGENT.test(s)) { score += 2; reasons.push('時間急迫'); }
    if (price) { score += 2; reasons.push('有開價'); }
    if (area || rent || district) { score += 1; reasons.push('有地點／坪數細節'); }
    if (equip.length >= 2) { score += 1; reasons.push('設備清單明確'); }
    const t = Date.parse(p.time || p.foundAt || '');
    if (t && now - t < 24 * 3600e3) { score += 1; reasons.push('24 小時內發文'); }
    if (s.length < 15) { score -= 1; reasons.push('內容很短'); }
    if (role === '同業') { score = Math.min(score, 1); reasons.unshift('疑似同業（收購／回收廣告）'); }
    const level = score >= 5 ? '高' : score >= 3 ? '中' : '低';

    return { role, cat, intent: { level, score, reasons }, info };
  }

  const api = { analyzePost };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RadarAnalyze = api;
})(typeof self !== 'undefined' ? self : this);
