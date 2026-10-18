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
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
