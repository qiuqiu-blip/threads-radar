'use strict';
// 每 5 分鐘被叫醒一次，判斷「現在要不要掃」。不需要安裝任何套件，幾秒鐘就結束。
const fs = require('fs');
const core = require('./core');
const cfg = core.loadConfig();
const doc = new core.FileStore().getDoc();
// 手動按「立即掃描」＝馬上掃；外部鬧鐘叫醒（mode=auto）＝照排程判斷
const force = process.env.EVENT === 'workflow_dispatch' && process.env.MODE !== 'auto';
const r = core.shouldScan(cfg, doc, new Date(), force);
console.log(r.due ? `▶ 開始掃描：${r.reason}` : `⏭ 這次跳過：${r.reason}`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `due=${r.due}\n`);
