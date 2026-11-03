'use strict';
// 方案 A 入口：GitHub Actions 每次執行一次就結束
// 方案 B 時會另外新增 server.js，這個檔案可以保留給手動測試用
const core = require('./core');

(async () => {
  const mode = (process.env.MODE || process.argv[2] || 'scan').replace(/^--/, '');
  if (mode === 'test') {
    await core.sendTestNotification();
    console.log('測試通知已送出');
    return;
  }
  const { chromium } = require('playwright');
  await core.runScan({ chromium });
  try { core.sealAll(); } catch (e) { console.warn('補加密失敗：' + e.message); }
  try { await core.handleOutbox({ cfg: core.loadConfig(), store: new core.FileStore() }); } catch (e) { console.warn('發文排程處理失敗：' + e.message); }
})().catch((e) => {
  if (e instanceof core.VaultError) { console.error('🔒 ' + e.message); process.exitCode = 1; return; }
  console.error(process.env.DATA_KEY ? String(e && e.message || e).split('\n')[0].replace(/https?:\/\/\S+/g, '（網址已隱藏）') : e);
  process.exitCode = 1;
});
