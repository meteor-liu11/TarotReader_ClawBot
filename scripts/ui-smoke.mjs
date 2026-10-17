#!/usr/bin/env node
/**
 * ClawBot 正式抽卡会话 UI 冒烟测试：打开 /s/:token，走完仪式 UI，
 * 验证实际洗牌与抽牌 API；仅将解读回调替换为 mock，避免测试向真实微信投递。
 *
 *   node scripts/ui-smoke.mjs
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
let chromium;
for (const p of [
  '/Users/byai/.local/lib/node_modules/openclaw/node_modules/playwright-core',
  'playwright-core', 'playwright',
]) { try { ({ chromium } = require(p)); break; } catch { /* try next */ } }
if (!chromium) { console.error('  ✘ 找不到 playwright'); process.exit(1); }

const CHROME = [
  process.env.CHROME_EXECUTABLE_PATH,
  process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null,
  process.platform === 'win32' ? `${process.env.PROGRAMFILES ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe` : null,
  process.platform === 'win32' ? `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe` : null,
].filter(Boolean).find(existsSync);
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';
const passColor = (s) => `\x1b[32m${s}\x1b[0m`;
const failColor = (s) => `\x1b[31m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? passColor('PASS') : failColor('FAIL')}  ${label}`);
  if (detail) console.log(`        ${detail}`);
};

const post = async (path, body) => {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  return { ok: response.ok, status: response.status, data: await response.json().catch(() => ({})) };
};

const peerId = `wx_ritual_smoke_${Date.now()}`;
await post('/api/agent/whitelist', { peerId });
const inbound = await post('/api/agent/inbound', {
  text: '抽塔罗，我和他异地冷战两周了还有可能吗', peerId,
});
const token = inbound.data.sessionToken;
if (!token) {
  console.error('  ✘ 创建 ClawBot 会话失败：', JSON.stringify(inbound.data));
  process.exit(1);
}
const sessionResponse = await fetch(`${BASE}/api/session/${encodeURIComponent(token)}`);
const sessionData = await sessionResponse.json().catch(() => ({}));
if (!sessionResponse.ok || !sessionData.spread) {
  console.error('  ✘ 读取会话牌阵失败：', JSON.stringify(sessionData));
  process.exit(1);
}
const expectedCount = Number(sessionData.spread.count);
console.log(bold(`\n  ClawBot 正式抽卡会话 · UI 冒烟测试\n  ${BASE}/s/${token.slice(0, 10)}…\n`));

const launchOptions = { headless: true };
if (CHROME) launchOptions.executablePath = CHROME;
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
});
const errors = [];
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', (error) => errors.push(`[pageerror] ${error.message}`));
page.on('response', (response) => { if (response.status() >= 400) errors.push(`[HTTP ${response.status()}] ${response.url()}`); });

try {
  // 真实执行抽牌与 ClawBot 牌阵/牌义逻辑；只 mock 解读回调，避免此 UI 测试发送外部消息。
  await page.route(`**/api/callback/${token}`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, readingId: 'ui-smoke-reading', mode: 'template',
      content: '## 测试解读\n\n正式会话已经把牌面交给 ClawBot。', gatewayMode: 'mock' }),
  }));
  await page.goto(`${BASE}/s/${token}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#stage[data-stage="1"]', { timeout: 10000 });
  check('正式 token 链接载入共享仪式页并套用服务端牌阵',
    await page.locator('#ritual-shell').isVisible()
      && (await page.locator('#spread-kind').innerText()).includes(sessionData.spread.name)
      && (await page.evaluate(() => window.__CLAWBOT_RITUAL?.session?.spread?.count)) === expectedCount,
    `牌阵 ${inbound.data.spreadId}，${expectedCount} 张`);
  check('正式页直接进入洗牌，牌阵不可在会话中途更换',
    await page.locator('#btn-spread').isHidden()
      && await page.locator('#table .tcard').count() === 78,
    '78 张 DOM 牌背已创建');

  const stageBox = await page.locator('#stage').boundingBox();
  await page.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
  await page.mouse.down();
  for (let passIndex = 0; passIndex < 3; passIndex++) {
    const y = stageBox.y + stageBox.height * (passIndex % 2 ? 0.36 : 0.64);
    for (let i = 0; i <= 16; i++) {
      const x = stageBox.x + stageBox.width * (0.12 + 0.76 * (i / 16));
      await page.mouse.move(x, y);
    }
    for (let i = 16; i >= 0; i--) {
      const x = stageBox.x + stageBox.width * (0.12 + 0.76 * (i / 16));
      await page.mouse.move(x, y + 20);
    }
  }
  await page.mouse.up();
  await page.waitForFunction(() => window.__play?.debug().stir >= 700, null, { timeout: 4000 });
  await page.locator('#btn-main').click();
  await page.waitForSelector('#stage[data-stage="2"]', { timeout: 5000 });
  check('真实拖动洗牌达到解锁阈值并进入切牌', true);

  const cutBox = await page.locator('#stage').boundingBox();
  await page.mouse.click(cutBox.x + cutBox.width / 2, cutBox.y + cutBox.height / 2 - 33);
  await page.waitForFunction(() => window.__play?.debug().cuts > 0, null, { timeout: 3000 });
  await page.waitForTimeout(800);
  const shuffleResponsePromise = page.waitForResponse((response) =>
    response.url().includes(`/api/shuffle/${token}`) && response.request().method() === 'POST');
  await page.locator('#btn-main').click();
  const shuffleResponse = await shuffleResponsePromise;
  const shuffleBody = JSON.parse(shuffleResponse.request().postData() ?? '{}');
  await page.waitForSelector('#stage[data-stage="3"]', { timeout: 8000 });
  check('切牌结束后服务端收到洗牌轨迹、耗时和切牌厚度',
    shuffleResponse.ok() && shuffleBody.entropy?.durationMs > 0
      && shuffleBody.entropy?.rounds >= 1 && shuffleBody.entropy?.cutPile > 0
      && Array.isArray(shuffleBody.entropy?.picks), JSON.stringify(shuffleBody.entropy));
  check('抽牌阶段仍是固定窗口内重叠牌扇，保留服务端牌阵的牌位数',
    await page.locator('#fan-viewport .tcard.fan-card:not(.clone)').count() === 78
      && await page.locator('.draw-slot').count() === expectedCount,
    `牌位 ${expectedCount} 张`);

  let drawResponse = null;
  for (let index = 0; index < expectedCount; index++) {
    const selectable = await page.evaluate(() => window.__play.debug().selectableCards[0]);
    if (!selectable) throw new Error('固定牌框中没有可选牌');
    await page.mouse.click(selectable.x, selectable.y);
    await page.waitForFunction(() => window.__play?.debug().pendingPick !== null, null, { timeout: 3000 });
    check(`第 ${index + 1} 张点击后只是预选，可确认或撤回`,
      (await page.evaluate(() => window.__play.debug().picks.length)) === index);
    if (index === expectedCount - 1) {
      drawResponse = page.waitForResponse((response) =>
        response.url().includes(`/api/draw/${token}`) && response.request().method() === 'POST');
    }
    await page.locator('#btn-main').click();
    await page.waitForTimeout(720);
  }
  const actualDrawResponse = await drawResponse;
  const drawBody = JSON.parse(actualDrawResponse.request().postData() ?? '{}');
  const drawData = await actualDrawResponse.json();
  check('正式抽牌调用 ClawBot `/api/draw/:token`，提交唯一牌序而非本地假牌面',
    actualDrawResponse.ok() && drawBody.picks?.length === expectedCount
      && new Set(drawBody.picks).size === expectedCount
      && drawData.cards?.length === expectedCount,
    `选牌序号 ${JSON.stringify(drawBody.picks)}`);

  await page.waitForFunction(() => window.__play?.debug().revealed, null, { timeout: 15000 });
  await page.waitForSelector('#result:not(.hidden)', { timeout: 8000 });
  await page.waitForFunction(() => document.querySelector('#reading')?.innerText
    .includes('正式会话已经把牌面交给 ClawBot'), null, { timeout: 8000 });
  const officialReversals = drawData.cards.map((card) => Boolean(card.reversed));
  const shownReversals = await page.locator('#transit-layer .ritual-picked').evaluateAll((seats) =>
    seats.map((seat) => seat.classList.contains('is-reversed')));
  check('服务端真实牌面与正逆位统一翻开，并继续进入 ClawBot 解读回调',
    shownReversals.length === officialReversals.length
      && shownReversals.every((value, index) => value === officialReversals[index])
      && (await page.locator('#reading').innerText()).includes('正式会话已经把牌面交给 ClawBot'),
    `正逆位 ${JSON.stringify(officialReversals)}`);
} catch (error) {
  check(`正式会话测试中断：${error.message.split('\n')[0]}`, false);
} finally {
  await browser.close();
}

if (errors.length) {
  console.log(failColor(`\n  浏览器错误 ${errors.length} 项：`));
  for (const error of errors.slice(0, 8)) console.log(`    · ${error.slice(0, 180)}`);
  fail++;
} else {
  console.log(passColor('\n  浏览器控制台无错误'));
}
console.log(`\n${'-'.repeat(58)}\n${bold(`  通过 ${pass}   失败 ${fail}`)}\n`);
process.exit(fail === 0 ? 0 : 1);
