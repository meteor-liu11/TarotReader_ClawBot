#!/usr/bin/env node
/**
 * 微信登录二维码 · 持续刷新器
 *
 *   node scripts/wechat-login-qr.mjs
 *
 * 为什么需要它：插件的二维码约 1 分钟过期，内部最多重刷 3 次就整个退出
 * （MAX_QR_REFRESH_COUNT = 3）。人在忙别的很容易错过，所以这里：
 *   1. 循环调用 openclaw channels login，失败就重开
 *   2. 从输出里抓最新的二维码链接
 *   3. 每次刷新都重渲染 wechat-login-qr.png，并更新 wechat-login.html
 *   4. 扫码成功后自动停止
 *
 * 用浏览器打开 wechat-login.html，页面每 3 秒自动换图 —— 永远是最新的码。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(ROOT, '..');
const PNG = resolve(REPO, 'wechat-login-qr.png');
const CHANNEL = process.env.CHANNEL ?? 'openclaw-weixin';
const OPENCLAW_ROOT = process.env.OPENCLAW_ROOT ?? 'D:/law/OpenClaw';
const OPENCLAW_ENTRY = process.env.OPENCLAW_ENTRYPOINT
  ?? resolve(OPENCLAW_ROOT, 'node_modules/openclaw/openclaw.mjs');
const OPENCLAW_HOME = process.env.OPENCLAW_HOME
  ?? resolve(OPENCLAW_ROOT, 'state');
const OPENCLAW_ENV = { ...process.env, OPENCLAW_HOME };

// Resolve the bundled QR renderer from the actual OpenClaw installation.
const require = createRequire(OPENCLAW_ENTRY);
let QR;
try { QR = require('qrcode'); } catch { /* checked below */ }
if (!existsSync(OPENCLAW_ENTRY)) {
  console.error(`OpenClaw CLI entry not found: ${OPENCLAW_ENTRY}`);
  process.exit(1);
}
if (!QR) {
  console.error(`qrcode module not found from OpenClaw installation: ${OPENCLAW_ROOT}`);
  process.exit(1);
}

let currentUrl = '';
let scanCount = 0;

function runLogin() {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [OPENCLAW_ENTRY, 'channels', 'login', '--channel', CHANNEL], {
      stdio: ['inherit', 'pipe', 'pipe'],
      cwd: OPENCLAW_ROOT,
      env: OPENCLAW_ENV,
    });

    let buf = '';
    const onData = (chunk) => {
      const s = chunk.toString();
      process.stdout.write(s.replace(/https:\/\/liteapp\.weixin\.qq\.com\/[^\s]+/g, '[扫码链接已隐藏]'));
      buf += s.replace(/\x1b\[[0-9;]*m/g, '');
      const all = [...buf.matchAll(/https:\/\/liteapp\.weixin\.qq\.com\/[^\s]+/g)].map((m) => m[0].trim());
      const latest = all[all.length - 1];
      if (latest && latest !== currentUrl) {
        currentUrl = latest;
        render(latest);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', rej);
    child.on('close', (code) => res(code === 0));
  });
}

function render(url) {
  scanCount++;
  QR.toFile(PNG, url, { width: 640, margin: 2, color: { dark: '#000000', light: '#ffffff' } })
    .then(() => {
      process.stdout.write(`\n  \x1b[32m▸ 二维码已更新（第 ${scanCount} 张）\x1b[0m  ${PNG}\n\n`);
    })
    .catch((e) => process.stderr.write(`  渲染二维码失败: ${e.message}\n`));
}

(async function main() {
  console.log('');
  console.log('  ══════════════════════════════════════════════════');
  console.log('   微信登录 · 二维码持续刷新');
  console.log('  ══════════════════════════════════════════════════');
  console.log(`   二维码图片   ${PNG}`);
  console.log('   扫码页面     http://127.0.0.1:8787/qr');
  console.log('   扫不上不要紧 —— 会自动重新生成，一直扫到成功为止。');
  console.log('  ══════════════════════════════════════════════════');

  let attempt = 0;
  for (;;) {
    attempt++;
    console.log(`\n\x1b[1m── 第 ${attempt} 轮 ──\x1b[0m\n`);
    if (await runLogin()) {
      console.log('\n  \x1b[32m✅ 微信登录成功，凭证已保存。\x1b[0m');
      console.log(String.raw`  下一步：Set-Location 'D:\law\OpenClaw'; $env:OPENCLAW_HOME='D:\law\OpenClaw\state'; npm exec openclaw -- channels status --probe`);
      try {
        mkdirSync(resolve(REPO, '.secrets'), { recursive: true });
        writeFileSync(resolve(REPO, '.secrets/wechat-login-ok'), new Date().toISOString());
      } catch { /* 非关键 */ }
      process.exit(0);
    }
    console.log('\n  \x1b[33m二维码失效，3 秒后重新生成…（Ctrl+C 退出）\x1b[0m');
    await new Promise((r) => setTimeout(r, 3000));
  }
})().catch((err) => {
  console.error(`OpenClaw login process failed: ${err.message}`);
  process.exitCode = 1;
});
