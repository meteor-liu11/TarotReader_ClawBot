#!/usr/bin/env node
/**
 * 独立仪式页（/play）的 UI 冒烟测试
 *
 *   node scripts/play-smoke.mjs
 *
 * 真的去：切换牌阵 → 往返推牌洗牌 → 五档厚度切牌 → 在固定牌扇窗口中拖动选牌并在最后一张后统一翻面。
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);
let chromium;
for (const p of [
  '/Users/byai/.local/lib/node_modules/openclaw/node_modules/playwright-core',
  'playwright-core', 'playwright',
]) { try { ({ chromium } = require(p)); break; } catch { /* next */ } }
if (!chromium) { console.error('  ✘ 找不到 playwright'); process.exit(1); }

const CHROME = [
  process.env.CHROME_EXECUTABLE_PATH,
  process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : null,
  process.platform === 'win32'
    ? `${process.env.PROGRAMFILES ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`
    : null,
  process.platform === 'win32'
    ? `${process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`
    : null,
].filter(Boolean).find(existsSync);
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8787';

const C = {
  pass: (s) => `\x1b[32m${s}\x1b[0m`,
  fail: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
let pass = 0; let fail = 0;
const check = (label, ok, detail = '') => {
  ok ? pass++ : fail++;
  console.log(`  ${ok ? C.pass('PASS') : C.fail('FAIL')}  ${label}`);
  if (detail) console.log(`        ${C.dim(detail)}`);
};

console.log(C.bold('\n  独立仪式页 · UI 冒烟测试\n'));

const launchOptions = { headless: true };
if (CHROME) launchOptions.executablePath = CHROME;
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
});

const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') { const l = m.location(); errors.push(`${m.text()} @ ${l?.url}:${l?.lineNumber}`); }
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`[HTTP ${r.status()}] ${r.url()}`); });

try {
  await page.goto(`${BASE}/play`, { waitUntil: 'networkidle' });

  // ── 阶段 0：只有牌阵 ──
  check('首屏显示“他的问题”与静心文案、开始按钮',
    (await page.locator('#spread-name').innerText()) === '他的问题'
    && (await page.locator('#spread-desc').innerText()).includes('静下心')
    && (await page.locator('#btn-main').innerText()) === '开始洗牌',
    `标题「${await page.locator('#spread-name').innerText()}」按钮「${await page.locator('#btn-main').innerText()}」`);

  // ── 切换牌阵 ──
  await page.locator('#btn-spread').click();
  await page.waitForTimeout(420);
  const optCount = await page.locator('.spread-opt').count();
  check('牌阵抽屉打开，列出常见牌阵', optCount >= 5, `${optCount} 个`);

  await page.locator('.spread-opt[data-id="celtic"]').click();
  await page.waitForTimeout(420);
  check('切换牌阵后顶部跟着变',
    (await page.locator('#spread-kind').innerText()).includes('凯尔特'),
    await page.locator('#spread-kind').innerText());

  // 换回四维，牌数少一点好测
  await page.locator('#btn-spread').click();
  await page.waitForTimeout(360);
  await page.locator('.spread-opt[data-id="dim4"]').click();
  await page.waitForTimeout(360);

  // ── 阶段 1：往返推牌洗牌 ──
  await page.locator('#btn-main').click();
  await page.waitForTimeout(500);
  check('进入洗牌阶段时按钮先锁住（还没转）',
    await page.locator('#btn-main').isDisabled(),
    await page.locator('#stat').innerText());
  check('洗牌阶段已收起牌堆跟手的两排提示',
    (await page.locator('#float-top').innerText()) === ''
    && (await page.locator('#float-bottom').innerText()) === '',
    '提示层为空');

  const cv = await page.locator('#table').boundingBox();

  // 真的用手在牌堆上来回推 —— 不是画圈，是「搅」
  await page.mouse.move(cv.x + cv.width * 0.5, cv.y + cv.height * 0.5);
  await page.mouse.down();
  for (let pass = 0; pass < 6; pass++) {
    const y = cv.y + cv.height * (pass % 2 ? 0.36 : 0.64);
    for (let k = 0; k <= 14; k++) {
      const x = cv.x + cv.width * (0.12 + 0.76 * (k / 14));
      await page.mouse.move(x, y);
    }
    for (let k = 14; k >= 0; k--) {
      const x = cv.x + cv.width * (0.12 + 0.76 * (k / 14));
      await page.mouse.move(x, y + (pass % 2 ? 26 : -26));
    }
  }
  await page.mouse.up();
  await page.waitForTimeout(300);

  const st1 = await page.evaluate(() => window.__play.debug());
  check('推牌手势真的被计成「搅动量」', st1.stir >= 900, `stir=${st1.stir}`);
  check('洗够了按钮解锁', await page.locator('#btn-main').isEnabled(),
    await page.locator('#btn-main').innerText());
  const edgeState = await page.locator('#stage').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cards = [...document.querySelectorAll('#table .tcard')].map((card) => card.getBoundingClientRect());
    return { count: cards.length, clipped: cards.filter((c) =>
      c.left < r.left - 1 || c.right > r.right + 1 || c.top < r.top - 1 || c.bottom > r.bottom + 1).length };
  });
  check('洗牌边沿整张牌保持可见，不被上下边界裁切',
    edgeState.count === 78 && edgeState.clipped === 0, JSON.stringify(edgeState));

  // ── 阶段 2：点击切牌 ──
  await page.locator('#btn-main').click();
  await page.waitForTimeout(500);
  check('进入切牌阶段，按钮先锁住',
    await page.locator('#btn-main').isDisabled(), await page.locator('#btn-main').innerText());

  const cv2 = await page.locator('#table').boundingBox();
  const orderBeforeCut = await page.evaluate(() => window.__play.debug().order);
  check('进入切牌前牌序已由本次洗牌手势生成且无重复',
    orderBeforeCut.length === 78 && new Set(orderBeforeCut).size === 78
      && orderBeforeCut.some((id, index) => id !== index),
    `牌序前 8 张 ${JSON.stringify(orderBeforeCut.slice(0, 8))}`);
  await page.mouse.click(cv2.x + cv2.width / 2, cv2.y + cv2.height / 2 - 33);
  await page.waitForTimeout(900);   // 等切牌动画演完
  const st2 = await page.evaluate(() => window.__play.debug());
  check('轻点牌堆只执行一次切牌', st2.cuts === 1, `cuts=${st2.cuts}`);
  check('切牌提供五档牌摞厚度',
    st2.cutChoices.join(',') === '12,24,39,54,66' && st2.cutChoices.includes(st2.cutAt[0]),
    `可选 ${st2.cutChoices.join('/')} 张，上移 ${st2.cutAt.join('/')} 张`);

  // 切牌必须让原本较低的牌进入上层，而非只播放位移动画。
  const orderAfter = await page.evaluate(() => {
    const d = window.__play.debug();
    return d;
  });
  check('切牌后原下摞确实移动到上层',
    orderAfter.order.indexOf(orderBeforeCut[0]) === 78 - st2.cutAt[0],
    `原下摞首张的新层位 ${orderAfter.order.indexOf(orderBeforeCut[0])}`);

  // ── 阶段 3：固定窗口内的重叠牌扇 + 选齐后统一翻面 ──
  await page.locator('#btn-main').click();
  await page.waitForTimeout(650);   // 等牌扇窗口与横向轨道完成布局

  const st3 = await page.evaluate(() => window.__play.debug());
  check('确定性牌序包含 78 张且无重复',
    st3.order.length === 78 && new Set(st3.order).size === 78,
    `牌序长度 ${st3.order.length}，唯一牌数 ${new Set(st3.order).size}`);
  check('起牌阶段沿用切牌后的牌序，不再二次洗牌',
    st3.order.every((id, index) => id === orderAfter.order[index])
      && st3.finalDeck?.every((id, index) => id === orderAfter.order[index]),
    `切牌后与起牌牌序一致：${JSON.stringify(st3.order.slice(0, 8))}`);
  const fan = await page.locator('#fan-viewport').evaluate((viewport) => {
    const table = viewport.querySelector('#table');
    const cards = [...table.querySelectorAll('.tcard.fan-card:not(.clone)')];
    const frame = viewport.getBoundingClientRect();
    const stage = document.querySelector('#stage').getBoundingClientRect();
    const slots = document.querySelector('#slots').getBoundingClientRect();
    const labels = [...document.querySelectorAll('#fan-label-layer .fan-index')];
    const labelValues = labels.map((label) => label.textContent.trim());
    const visible = cards.filter((card) => {
      const r = card.getBoundingClientRect();
      return getComputedStyle(card).display !== 'none' && Number(getComputedStyle(card).opacity) > 0.99
        && r.right > frame.left && r.left < frame.right && r.bottom > frame.top && r.top < frame.bottom;
    });
    const cardStyle = getComputedStyle(cards[0]);
    const before = getComputedStyle(cards[0], '::before');
    const plain = cardStyle.opacity === '1' && cardStyle.filter === 'none'
      && cardStyle.backgroundColor === 'rgb(79, 101, 77)'
      && cardStyle.backgroundImage.includes('ritual-botanical-mark.svg')
      && !cardStyle.backgroundImage.includes('gradient')
      && cardStyle.maskImage === 'none' && cardStyle.webkitMaskImage === 'none'
      && before.content === 'none' && parseFloat(cardStyle.borderTopWidth) >= 0.9;
    return {
      count: cards.length,
      numbered: cards.every((card) => /^\d{2}$/.test(card.dataset.position ?? '')),
      uniqueNumbers: new Set(cards.map((card) => card.dataset.position)).size === 78,
      singleStrip: table.classList.contains('card-fan-strip')
        && cards.every((card) => getComputedStyle(card).position === 'absolute'),
      visible: visible.length,
      scrollable: viewport.scrollWidth > viewport.clientWidth + 1,
      trackWidth: table.scrollWidth,
      clientWidth: viewport.clientWidth,
      scrollHeight: viewport.scrollHeight,
      clientHeight: viewport.clientHeight,
      overflowX: getComputedStyle(viewport).overflowX,
      overflowY: getComputedStyle(viewport).overflowY,
      frameBorder: parseFloat(getComputedStyle(viewport).borderTopWidth),
      frameInsideStage: frame.left >= stage.left - 1 && frame.right <= stage.right + 1
        && frame.top >= stage.top - 1 && frame.bottom <= stage.bottom + 1,
      slotsInsideStage: slots.left >= stage.left - 1 && slots.right <= stage.right + 1,
      slotsBelowFrame: frame.bottom < slots.top,
      labelCount: labels.length,
      labelNumbers: labels.every((label) => /^\d{2}$/.test(label.textContent.trim()))
        && new Set(labelValues).size === 78,
      plain,
      slotNumbers: [...document.querySelectorAll('.draw-slot-card .slot-number')].map((n) => n.textContent.trim()),
      touchAction: getComputedStyle(viewport).touchAction,
    };
  });
  check('78 张绿底白草牌组成固定窗口内的重叠单道牌扇，不使用网格排布',
    fan.count === 78 && fan.numbered && fan.uniqueNumbers && fan.singleStrip
      && fan.trackWidth > fan.clientWidth * 2 && fan.scrollable
      && fan.overflowX === 'auto' && fan.overflowY === 'hidden'
      && fan.scrollHeight <= fan.clientHeight + 1
      && fan.visible > 0 && fan.visible < 78 && fan.frameBorder >= 1
      && fan.frameInsideStage && fan.slotsInsideStage && fan.slotsBelowFrame && fan.plain,
    JSON.stringify(fan));
  check('78 个序号在牌扇上层独立显示，不被相邻重叠牌背遮住',
    fan.labelCount === 78 && fan.labelNumbers,
    JSON.stringify({labels:fan.labelCount,unique:fan.labelNumbers}));
  check('下层牌位显示按抽牌顺序排列的数字',
    fan.slotNumbers.join(',') === '1,2,3,4', JSON.stringify(fan.slotNumbers));
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  check('手机端允许在牌扇框内横向浏览并捏合缩放查看牌号',
    viewport.includes('initial-scale=1') && fan.touchAction.includes('pan-x'),
    `${viewport}; touch-action=${fan.touchAction}`);
  check('抽牌阶段不显示起牌数量统计',
    await page.locator('#stat').isHidden() && await page.locator('#float-bottom').isHidden(),
    '张数统计与底部浮字均隐藏');

  const fanBox = await page.locator('#fan-viewport').boundingBox();
  const dragX = fanBox.x + fanBox.width / 2;
  const dragY = fanBox.y + fanBox.height * 0.52;
  const stackBefore = await page.locator('#fan-viewport .tcard.fan-card').first().evaluate((card) => ({
    transform: card.style.transform, zIndex: card.style.zIndex,
  }));
  await page.mouse.move(fanBox.x + 24, dragY);
  const stackAfterHover = await page.locator('#fan-viewport .tcard.fan-card').first().evaluate((card) => ({
    transform: card.style.transform, zIndex: card.style.zIndex,
  }));
  check('悬停不会把单张牌抬到队列最上层或改乱层序',
    stackBefore.transform === stackAfterHover.transform && stackBefore.zIndex === stackAfterHover.zIndex,
    `${JSON.stringify(stackBefore)} → ${JSON.stringify(stackAfterHover)}`);

  const fanBefore = st3.fanScrollLeft;
  await page.mouse.move(dragX, dragY);
  await page.mouse.down();
  await page.mouse.move(dragX - 130, dragY, { steps: 10 });
  await page.waitForTimeout(100);
  const fanDuring = await page.evaluate(() => window.__play.debug());
  check('在牌框内横向拖动时只浏览牌扇内容',
    fanDuring.fanScrollLeft > fanBefore + 60 && fanDuring.fanScrollWidth > fanDuring.fanClientWidth,
    `scrollLeft ${fanBefore} → ${fanDuring.fanScrollLeft}`);
  await page.mouse.up();
  await page.waitForTimeout(1300);
  const fanAfter = await page.evaluate(() => window.__play.debug());
  check('框内横向浏览具有平滑惯性并在窗口边界收敛',
    fanAfter.fanScrollLeft > fanBefore + 100 && fanAfter.visibleCards > 0
      && fanAfter.visibleCards < 78 && fanAfter.fanVelocity === 0,
    `scrollLeft=${fanAfter.fanScrollLeft}, visible=${fanAfter.visibleCards}, v=${fanAfter.fanVelocity}`);
  const shapeAfterScroll = await page.locator('#fan-viewport .tcard.fan-card').first().evaluate((card) => card.style.transform);
  check('牌扇弧线随整条牌列的浏览平滑变化', shapeAfterScroll !== stackBefore.transform,
    `${stackBefore.transform} → ${shapeAfterScroll}`);

  for (let k = 0; k < 4; k++) {
    const selectable = await page.evaluate(() => window.__play.debug().selectableCards[0]);
    if (!selectable) throw new Error('牌框中没有可见可选牌');
    const hitBefore = await page.evaluate(({x, y}) => {
      const card = document.elementFromPoint(x, y)?.closest('.tcard.fan-card');
      return card ? { id: Number(card.dataset.cardId), transform: card.style.transform, zIndex: card.style.zIndex } : null;
    }, selectable);
    await page.mouse.click(selectable.x, selectable.y);
    const preview = await page.evaluate(() => {
      const state = window.__play.debug();
      const candidate = state.pendingPick === null ? null
        : document.querySelector(`#fan-viewport .tcard.fan-card[data-card-id="${state.pendingPick}"]`);
      return {
        state,
        candidateMarked: Boolean(candidate?.classList.contains('is-pending')),
        candidateStillInFan: Boolean(candidate && getComputedStyle(candidate).display !== 'none'),
        candidateTransform: candidate?.style.transform,
        candidateZIndex: candidate?.style.zIndex,
        confirmVisible: !document.querySelector('#btn-main').hidden,
        cancelVisible: !document.querySelector('#btn-cancel-pick').hidden,
      };
    });
    check(`第 ${k + 1} 次点击只预选，不提前落位`,
      preview.state.pendingPick !== null && preview.state.picks.length === k
        && preview.state.seatCount === k && !preview.state.revealed
        && preview.candidateMarked && preview.candidateStillInFan
        && preview.state.pendingPick === hitBefore?.id
        && preview.candidateTransform === hitBefore?.transform
        && preview.candidateZIndex === hitBefore?.zIndex
        && preview.confirmVisible && preview.cancelVisible,
      `候选=${preview.state.pendingPick}，已落位=${preview.state.seatCount}`);
    if (k === 0) {
      await page.locator('#btn-cancel-pick').click();
      const cancelled = await page.evaluate((cardId) => ({
        state: window.__play.debug(),
        cardStillInFan: Boolean(document.querySelector(`#fan-viewport .tcard.fan-card[data-card-id="${cardId}"]`)),
        candidateCleared: !document.querySelector(`#fan-viewport .tcard.fan-card[data-card-id="${cardId}"]`)?.classList.contains('is-pending'),
        confirmHidden: document.querySelector('#btn-main').hidden,
        cancelHidden: document.querySelector('#btn-cancel-pick').hidden,
      }), preview.state.pendingPick);
      check('撤回后候选回到原队列且没有占用牌位',
        cancelled.state.pendingPick === null && cancelled.state.picks.length === 0
          && cancelled.state.seatCount === 0 && cancelled.cardStillInFan
          && cancelled.candidateCleared && cancelled.confirmHidden && cancelled.cancelHidden,
        `候选=${cancelled.state.pendingPick}，仍在牌列=${cancelled.cardStillInFan}`);
      await page.mouse.click(selectable.x, selectable.y);
      await page.waitForTimeout(80);
      check('撤回后可以重新预选牌背',
        (await page.evaluate(() => window.__play.debug())).pendingPick !== null,
        '重新出现候选牌');
    }
    await page.locator('#btn-main').click();
    await page.waitForTimeout(760);
    if (k < 3) {
      const down = await page.evaluate(() => ({
        state: window.__play.debug(),
        faceUp: document.querySelectorAll('#transit-layer .ritual-picked.is-revealed').length,
      }));
      check(`第 ${k + 1} 张落位后仍保持牌背朝上`,
        down.state.picks.length === k + 1 && down.state.seatCount === k + 1
          && !down.state.revealed && down.faceUp === 0,
        `已选 ${down.state.picks.length}，翻开 ${down.faceUp}`);
      if (k === 0) {
        check('首张抽出后余牌沿原弧形轨道压紧补位',
          down.state.fanTrackWidth < st3.fanTrackWidth - 10
            && down.state.fanLayout === 'overlap-strip' && down.state.fanRows === 1,
          `轨道宽度 ${st3.fanTrackWidth} → ${down.state.fanTrackWidth}`);
      }
    }
  }
  await page.waitForFunction(() => window.__play.debug().revealed, undefined, { timeout: 10000 });
  const st3done = await page.evaluate(() => window.__play.debug());
  check('牌框选择不同牌背并按牌位顺序落位',
    st3done.picks.length === st3done.spreadN && new Set(st3done.picks).size === st3done.spreadN,
    `选中 ${st3done.picks.length} 张（牌序号 ${JSON.stringify(st3done.picks)}）`);
  const faceState = await page.locator('#transit-layer').evaluate((el) => {
    const seats = [...el.querySelectorAll('.ritual-picked')];
    const images = seats.map((seat) => seat.querySelector('img'));
    return {
      count: seats.length,
      allRevealed: seats.length === 4 && seats.every((seat) => seat.classList.contains('is-revealed')),
      allImagesLoaded: images.every((img) => img?.naturalWidth > 0),
      minNaturalWidth: Math.min(...images.map((img) => img?.naturalWidth ?? 0)),
      imageFit: images.every((img) => getComputedStyle(img).objectFit === 'contain'),
      orientations: seats.map((seat) => ({
        cardId: Number(seat.dataset.cardId),
        reversed: seat.classList.contains('is-reversed'),
      })),
      numbered: seats.map((seat) => seat.querySelector('.ritual-picked-index')?.textContent.trim()).join(',') === '1,2,3,4',
    };
  });
  check('第 4 张落位后四张牌同一轮翻开并加载真实牌面',
    faceState.count === 4 && faceState.allRevealed && faceState.allImagesLoaded && faceState.numbered,
    JSON.stringify(faceState));
  check('牌面保留原图清晰度并按完整比例显示',
    faceState.minNaturalWidth >= 700 && faceState.imageFit,
    `最小原图宽度 ${faceState.minNaturalWidth}px；contain=${faceState.imageFit}`);
  check('每张牌的正逆位与洗牌时生成的内部方向绑定，界面不额外标注',
    faceState.orientations.every(({ cardId, reversed }) => reversed === st3done.reversalFlags[cardId])
      && st3done.reversalFlags.length === 78 && st3done.reversalCount > 0,
    JSON.stringify(faceState.orientations));
  check('起齐后按钮变成「重新开始」',
    (await page.locator('#btn-main').innerText()).includes('重新开始'),
    await page.locator('#btn-main').innerText());

  // ── 手势 → 牌序 的函数连接 ──
  const finalGesture = await page.evaluate(() => window.__play.debug());
  check('洗牌轨迹生成内部种子，切牌动作也已进入最终记录',
    /^[0-9a-f]{16}$/.test(finalGesture.seed ?? '')
      && finalGesture.shuffleTracePoints > 0
      && finalGesture.gestureCuts === finalGesture.cutAt.length,
    `seed=${finalGesture.seed}; 轨迹点=${finalGesture.shuffleTracePoints}; 切牌=${finalGesture.gestureCuts}`);

} catch (err) {
  check(`执行出错：${err.message.split('\n')[0]}`, false);
} finally {
  await browser.close();
}

console.log('');
if (errors.length) {
  console.log(C.fail(`  浏览器报了 ${errors.length} 个错误：`));
  for (const e of errors.slice(0, 6)) console.log(C.dim(`    · ${e.slice(0, 180)}`));
  fail += 1;
} else {
  console.log(C.pass('  浏览器控制台无报错'));
}

console.log('\n' + '-'.repeat(58));
console.log(C.bold(`  通过 ${pass}   失败 ${fail}\n`));
process.exit(fail === 0 ? 0 : 1);
